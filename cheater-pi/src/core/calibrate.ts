// Measure this machine instead of guessing about it.
//
// planTuning() gets within a layer or two of the optimum from physics alone, which is worth a great
// deal and is not the same as being right. On the reference machine it proposes 32 where the measured
// optimum is 30 — about 8% of throughput — and it cannot do better, because the exact position of the
// cliff depends on the driver version, what else is holding VRAM, and how the desktop compositor feels
// today. None of that is in the GGUF header.
//
// So: walk toward the cliff one layer at a time, keep the best, stop at the collapse, and remember the
// answer. The cost is a handful of model loads once per machine-and-model; the payoff is the real
// optimum rather than a safe approximation of it.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectHardware, detectServerFlags, buildLaunchPlan, kvBytesPerToken, readGgufKvMeta, isMixtureOfExperts, spawnManagedRuntime, cleanRuntimeLog } from "./modelRuntime.js";
import { bestSample, calibrationFingerprint, calibrationLadder, fellOffCliff, planTuning, type CalibrationRecord, type CalibrationSample } from "./autoTune.js";
import { kittenHome } from "./paths.js";

/** A prompt with the shape of real agent work: enough context to prefill, enough output to decode. */
const PROBE_PROMPT = `You are a careful software engineer reviewing this code:

${`function parseLedger(lines) {
  const entries = [];
  for (const line of lines) {
    const [date, description, amount] = line.split(",");
    if (!date || !amount) continue;
    entries.push({ date, description: (description ?? "").trim(), amount: Number(amount) });
  }
  return entries;
}
`.repeat(8)}

Explain what happens when the amount is not a number, and the smallest change that would reject that
line instead. Be specific and complete.`;

export interface CalibrationProgress {
  phase: "starting" | "measuring" | "done" | "failed";
  /** Which rung of the ladder, 1-based, and how many there are in total. */
  step: number;
  total: number;
  cpuMoeLayers: number;
  decodeTokensPerSecond?: number;
  promptTokensPerSecond?: number;
  note?: string;
}

export interface CalibrationRequest {
  executable: string;
  modelPath: string;
  /** Where the winner is written when the run succeeds. */
  projectRoot: string;
  /** Bounded by default: each rung costs a full model load, and a user is waiting. */
  maxRungs?: number;
  generatedTokens?: number;
  port?: number;
  onProgress?: (progress: CalibrationProgress) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Where a measured result is remembered, so the cost is paid once rather than every launch. */
export function calibrationStorePath(): string {
  return join(kittenHome(), "calibration.json");
}

export function readCalibration(fingerprint: string): CalibrationRecord | null {
  try {
    const path = calibrationStorePath();
    if (!existsSync(path)) return null;
    const all = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as CalibrationRecord[];
    if (!Array.isArray(all)) return null;
    return all.find((record) => record.fingerprint === fingerprint) ?? null;
  } catch { return null; }
}

export function writeCalibration(record: CalibrationRecord): void {
  const path = calibrationStorePath();
  let all: CalibrationRecord[] = [];
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
      if (Array.isArray(parsed)) all = parsed as CalibrationRecord[];
    }
  } catch { /* a corrupt store is replaced, never allowed to block a measurement */ }
  const next = [record, ...all.filter((existing) => existing.fingerprint !== record.fingerprint)].slice(0, 24);
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

/**
 * Run the ladder. Each rung is a cold launch, because a warm server keeps the weights resident and
 * would hand later rungs a head start they do not have in real use.
 */
export async function calibrateRuntime(request: CalibrationRequest): Promise<CalibrationRecord> {
  const { executable, modelPath, projectRoot } = request;
  if (!existsSync(executable)) throw new Error("no llama-server to calibrate with");
  if (!existsSync(modelPath)) throw new Error("the weights to calibrate against do not exist");

  const hardware = detectHardware();
  const gpu = hardware.gpus.find((device) => device.backend !== "unknown" && device.vramBytes);
  const meta = readGgufKvMeta(modelPath);
  const modelBytes = statSync(modelPath).size;
  const fingerprint = calibrationFingerprint({ modelPath, modelBytes, gpuName: gpu?.name, vramBytes: gpu?.vramBytes });

  const estimate = planTuning({
    modelBytes,
    vramBytes: gpu?.vramBytes,
    ramBytes: hardware.ramBytes,
    meta,
    kvBytesPerToken: meta ? kvBytesPerToken(meta) : undefined,
    mixtureOfExperts: isMixtureOfExperts(meta),
  });
  const layers = meta?.blockCount ?? 0;
  if (estimate.cpuMoeLayers === null || estimate.cpuMoeLayers <= 0 || layers <= 0) {
    throw new Error("there is nothing to calibrate: this model does not need a partial expert split on this machine");
  }

  const ladder = calibrationLadder(estimate.cpuMoeLayers, layers, Math.max(1, Math.min(8, request.maxRungs ?? 4)));
  const capability = detectServerFlags(executable);
  const port = request.port ?? 8137;
  const samples: CalibrationSample[] = [];

  for (const [index, cpuMoeLayers] of ladder.entries()) {
    if (request.signal?.aborted) break;
    request.onProgress?.({ phase: "measuring", step: index + 1, total: ladder.length, cpuMoeLayers });

    const plan = buildLaunchPlan({
      mainModel: modelPath,
      contextTokens: estimate.contextTokens,
      tuning: { cpuMoe: "on", cpuMoeLayers, gpuLayers: "auto" },
      supportedFlags: capability.flags,
      supportedFlagsHelp: capability.helpText,
    });
    const args = [...plan.args, "--host", "127.0.0.1", "--port", String(port), "--no-warmup"];
    const server = spawnManagedRuntime(executable, args, projectRoot);
    try {
      const ready = await waitForServer(port, 420_000, () => server.process.exitCode === null && !request.signal?.aborted);
      if (!ready) {
        // A rung that will not even load is information: it is past the edge, and so is everything
        // below it. Stop rather than burning minutes proving the same thing again.
        request.onProgress?.({ phase: "measuring", step: index + 1, total: ladder.length, cpuMoeLayers, note: cleanRuntimeLog(server.stderr(), 3) || "did not load" });
        break;
      }
      // One warm pass, then three measured ones, keeping the median.
      //
      // Adjacent rungs differ by a few percent and run-to-run variance is about the same size, so a
      // single sample cannot tell them apart — a first attempt at this picked 31 over 30 on one run
      // and the reverse on another. The median of three is what makes the answer mean something.
      await runProbe(port, 32);
      const passes = [] as Array<{ decodeTokensPerSecond: number; promptTokensPerSecond: number }>;
      for (let pass = 0; pass < 3; pass++) {
        const probe = await runProbe(port, request.generatedTokens ?? 96);
        if (probe) passes.push(probe);
      }
      const sample = passes.length > 0 ? {
        decodeTokensPerSecond: median(passes.map((x) => x.decodeTokensPerSecond)),
        promptTokensPerSecond: median(passes.map((x) => x.promptTokensPerSecond)),
      } : null;
      if (sample) {
        const measured: CalibrationSample = { ...sample, cpuMoeLayers, contextTokens: estimate.contextTokens };
        samples.push(measured);
        request.onProgress?.({ phase: "measuring", step: index + 1, total: ladder.length, cpuMoeLayers, decodeTokensPerSecond: measured.decodeTokensPerSecond, promptTokensPerSecond: measured.promptTokensPerSecond });
        const best = bestSample(samples);
        // The collapse is unmistakable — a third of the throughput, not a few percent — so once it
        // happens there is nothing further down the ladder worth paying a model load for.
        if (best && measured !== best && fellOffCliff(measured, best)) break;
      }
    } finally {
      server.stop();
      await sleep(2500);
    }
  }

  if (samples.length === 0) throw new Error("no configuration completed a measurement");
  const winner = bestSample(samples)!;
  const record: CalibrationRecord = {
    fingerprint,
    cpuMoeLayers: winner.cpuMoeLayers,
    contextTokens: winner.contextTokens,
    batchSize: estimate.batchSize,
    decodeTokensPerSecond: winner.decodeTokensPerSecond,
    promptTokensPerSecond: winner.promptTokensPerSecond,
    measuredAt: Date.now(),
    samples,
  };
  writeCalibration(record);
  request.onProgress?.({ phase: "done", step: ladder.length, total: ladder.length, cpuMoeLayers: winner.cpuMoeLayers, decodeTokensPerSecond: winner.decodeTokensPerSecond, promptTokensPerSecond: winner.promptTokensPerSecond });
  return record;
}

/** The middle value, which is what survives one slow pass caused by something else on the machine. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
}

async function waitForServer(port: number, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!alive()) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch { /* still loading */ }
    await sleep(500);
  }
  return false;
}

/** llama-server reports its own timings; trust those over wall-clock arithmetic here. */
async function runProbe(port: number, tokens: number): Promise<{ decodeTokensPerSecond: number; promptTokensPerSecond: number } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: PROBE_PROMPT, n_predict: tokens, temperature: 0, cache_prompt: false }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { timings?: { predicted_per_second?: number; prompt_per_second?: number } };
    const timings = body.timings ?? {};
    return {
      decodeTokensPerSecond: Number(timings.predicted_per_second ?? 0),
      promptTokensPerSecond: Number(timings.prompt_per_second ?? 0),
    };
  } catch { return null; }
}
