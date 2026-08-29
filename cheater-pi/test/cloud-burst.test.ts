import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mapLimit, cloudLlm, cloudBurstGenerate, cleanupBurst, adoptWorkspace,
  cloudBurstConfigFromEnv, type RunOne
} from "../src/core/cloudBurst.js";
import { planAttempts } from "../src/core/diversity.js";

test("mapLimit respects the concurrency cap and preserves order", async () => {
  let active = 0, maxActive = 0;
  const items = [0, 1, 2, 3, 4, 5];
  const out = await mapLimit(items, 2, async (x) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return x * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50], "results are in input order");
  assert.ok(maxActive <= 2, `concurrency exceeded: ${maxActive}`);
});

test("cloudLlm builds a KittenLLM pointed at the cloud endpoint with the same-weights model", () => {
  const llm = cloudLlm({ baseUrl: "https://cloud.example/v1", apiKey: "sk-x", model: "qwen3.6-35b-a3b" });
  assert.equal(llm.models.main, "qwen3.6-35b-a3b");
  assert.equal(llm.models.apiKey, "sk-x");
  assert.equal(llm.models.baseUrl, "https://cloud.example/v1");
});

test("cloudBurstGenerate isolates a workspace per attempt and never mutates the base", async () => {
  const base = mkdtempSync(join(tmpdir(), "burst-base-"));
  writeFileSync(join(base, "seed.txt"), "BASE");
  const plans = planAttempts(3);
  // Injected runner: each attempt writes a unique marker into ITS workspace.
  const runOne: RunOne = async (p) => {
    writeFileSync(join(p.cwd, "marker.txt"), `attempt @ ${p.temperature}`);
    return { finished: true, summary: "ok", turns: 1, toolCalls: 1, filesWritten: ["marker.txt"], events: [], usage: { prompt: 0, completion: 0, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  const attempts = await cloudBurstGenerate({ task: "do a thing", cwd: base, llm: cloudLlm({ baseUrl: "x", apiKey: "y" }) }, plans, { concurrency: 3, runOne });
  assert.equal(attempts.length, 3);
  const workspaces = new Set(attempts.map((a) => a.workspace));
  assert.equal(workspaces.size, 3, "each attempt got its own isolated workspace");
  for (const a of attempts) {
    assert.ok(existsSync(join(a.workspace, "seed.txt")), "base files copied into the isolated workspace");
    assert.ok(existsSync(join(a.workspace, "marker.txt")), "attempt's own output present");
  }
  // The base workspace is untouched.
  assert.deepEqual(readdirSync(base).sort(), ["seed.txt"], "base workspace was not mutated");

  // adoptWorkspace copies a winner back onto the base.
  adoptWorkspace(base, attempts[1].workspace);
  assert.ok(existsSync(join(base, "marker.txt")));
  assert.equal(readFileSync(join(base, "seed.txt"), "utf8"), "BASE");
  cleanupBurst(attempts);
  for (const a of attempts) assert.ok(!existsSync(a.workspace), "burst workspaces cleaned up");
});

test("a single failed attempt does not crash the burst", async () => {
  const base = mkdtempSync(join(tmpdir(), "burst-base-"));
  const runOne: RunOne = async (p) => { if (p.temperature && p.temperature > 0.5) throw new Error("boom"); return { finished: true, summary: "", turns: 1, toolCalls: 0, filesWritten: [], events: [], usage: { prompt: 0, completion: 0, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] }; };
  const attempts = await cloudBurstGenerate({ task: "t", cwd: base, llm: cloudLlm({ baseUrl: "x", apiKey: "y" }) }, planAttempts(4), { runOne });
  assert.equal(attempts.length, 4);
  assert.ok(attempts.some((a) => a.result.stopReason === "error"), "a thrown attempt is captured as an error result, not a crash");
});

test("cloudBurstConfigFromEnv returns null without env creds", () => {
  const saved = { u: process.env.KITTEN_CLOUD_BASE_URL, k: process.env.KITTEN_CLOUD_API_KEY };
  delete process.env.KITTEN_CLOUD_BASE_URL; delete process.env.KITTEN_CLOUD_API_KEY;
  assert.equal(cloudBurstConfigFromEnv(), null);
  process.env.KITTEN_CLOUD_BASE_URL = "https://c/v1"; process.env.KITTEN_CLOUD_API_KEY = "sk-1";
  const cfg = cloudBurstConfigFromEnv();
  assert.ok(cfg && cfg.model === "qwen3.6-35b-a3b");
  if (saved.u) process.env.KITTEN_CLOUD_BASE_URL = saved.u; else delete process.env.KITTEN_CLOUD_BASE_URL;
  if (saved.k) process.env.KITTEN_CLOUD_API_KEY = saved.k; else delete process.env.KITTEN_CLOUD_API_KEY;
});

// ── Live progress on the ascent lane ─────────────────────────────────────────────────────────────
//
// Observed live: an 8-minute Pac-Man run on the ascent lane showed "starting" for its whole duration
// and streamed not one token. Three causes, two of them here.

test("onStart fires while a candidate is still running, not after the burst resolves", async () => {
  const base = mkdtempSync(join(tmpdir(), "burst-start-"));
  const plans = planAttempts(3);
  const started: number[] = [];
  let running = 0, sawStartDuringRun = false;
  const runOne: RunOne = async () => {
    running++;
    // If onStart were called after the burst resolved, `started` would still be empty here.
    if (started.length > 0) sawStartDuringRun = true;
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return { finished: true, summary: "ok", turns: 1, toolCalls: 0, filesWritten: [], events: [], usage: { prompt: 0, completion: 0, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  await cloudBurstGenerate(
    { task: "t", cwd: base, llm: cloudLlm({ baseUrl: "x", apiKey: "y" }) },
    plans,
    { concurrency: 3, runOne, onStart: (p) => started.push(p.index) }
  );
  assert.equal(started.length, 3, "every candidate announced its start");
  assert.ok(sawStartDuringRun, "a start was announced while candidates were still in flight");
  assert.equal(running, 0);
});

test("exactly one candidate streams — the lead — so k token streams never interleave", async () => {
  const base = mkdtempSync(join(tmpdir(), "burst-lead-"));
  const plans = planAttempts(3);
  const streaming: Array<number | undefined> = [];
  const runOne: RunOne = async (p) => {
    streaming.push(p.streamDeltas ? p.temperature : undefined);
    p.onEvent?.({ turn: 1, kind: "reasoning_delta", detail: "thinking out loud" });
    return { finished: true, summary: "ok", turns: 1, toolCalls: 0, filesWritten: [], events: [], usage: { prompt: 0, completion: 0, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  const seen: string[] = [];
  await cloudBurstGenerate(
    { task: "t", cwd: base, llm: cloudLlm({ baseUrl: "x", apiKey: "y" }) },
    plans,
    { concurrency: 3, runOne, onLeadEvent: (e) => seen.push(e.kind) }
  );
  assert.equal(streaming.filter((s) => s !== undefined).length, 1, "only one candidate had streamDeltas set");
  assert.equal(seen.length, 1, "only the lead's events reached the sink");
  assert.equal(seen[0], "reasoning_delta");
});

test("without an onLeadEvent sink no candidate pays for streaming", async () => {
  const base = mkdtempSync(join(tmpdir(), "burst-nolead-"));
  let streamed = 0;
  const runOne: RunOne = async (p) => {
    if (p.streamDeltas) streamed++;
    return { finished: true, summary: "ok", turns: 1, toolCalls: 0, filesWritten: [], events: [], usage: { prompt: 0, completion: 0, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  await cloudBurstGenerate({ task: "t", cwd: base, llm: cloudLlm({ baseUrl: "x", apiKey: "y" }) }, planAttempts(2), { runOne });
  assert.equal(streamed, 0, "streaming without a sink is pointless work");
});
