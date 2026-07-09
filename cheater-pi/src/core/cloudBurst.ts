// Kitten Ascent C2 — cloud-burst generation. At 25 tok/s local, large-N is serial and slow: fifty
// diverse attempts one-at-a-time is hours. The unlock is the existing cloud substrate — the SAME weights
// (qwen3.6-35b-a3b on the Alibaba endpoint), just parallelisable. Generate N candidates concurrently in
// the cloud, verify them locally/deterministically. This is NOT "using a bigger model" — it is the
// identical model, parallelised, so the capability claim stays honest.
//
// Each attempt runs in its OWN isolated workspace (a copy of the base) so parallel agents don't corrupt
// each other's files. The winner is chosen by the local verifier; the orchestrator copies its workspace
// back. Local-only mode still works (pass a local llm + concurrency 1 = the old sequential path, smaller
// N, longer wall-clock). The runner is injectable so tests exercise the parallel orchestration + isolation
// without a live model.

import { cpSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KittenLLM, cloudModels } from "./llm.js";
import { runReliableAgent, type ReliableParams } from "./reliable.js";
import type { AgentRunResult } from "./agent.js";
import { rotateLocalization, type AttemptPlan } from "./diversity.js";
import { extractAcceptanceContract } from "../runstate/contract.js";

export interface CloudBurstConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;       // defaults to qwen3.6-35b-a3b (ornith's exact cloud twin)
  concurrency?: number; // parallel dispatch cap (default 6)
}

export interface BurstAttempt {
  index: number;
  workspace: string;    // isolated copy holding this attempt's produced files
  result: AgentRunResult & { contractTargets: string[] };
  plan: AttemptPlan;
}

export type RunOne = (params: ReliableParams) => Promise<AgentRunResult & { contractTargets: string[] }>;

/** Build a KittenLLM for the cloud endpoint (same weights). */
export function cloudLlm(config: CloudBurstConfig): KittenLLM {
  return new KittenLLM(cloudModels({ baseUrl: config.baseUrl, apiKey: config.apiKey, main: config.model }));
}

/** Bounded-concurrency map: run `fn` over items at most `limit` at a time, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function isolate(base: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kitten-burst-"));
  try { cpSync(base, dir, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git|__pycache__)([\\/]|$)/.test(s) }); } catch { /* best-effort */ }
  return dir;
}

export interface CloudBurstParams {
  task: string;
  cwd: string;                 // the base workspace (copied per attempt; never mutated here)
  llm: KittenLLM;              // the generation LLM (cloud or local)
  model?: string;
  maxTurns?: number;
  reasoningEffort?: "low" | "medium" | "high";
  experiencePrime?: string;    // A3 priming (same for all attempts)
  captureConfidence?: boolean; // P1: capture self-certainty for selection
  decode?: { logitBias?: Record<number, number>; topP?: number; topK?: number; minP?: number; dryMultiplier?: number; grammar?: string }; // P2 ban (global)
  banForbidden?: boolean;      // P2: run the finish-gate forbidden-construct scan
  signal?: AbortSignal;
}

export interface CloudBurstOpts {
  concurrency?: number;
  runOne?: RunOne;             // injectable (default runReliableAgent)
}

/**
 * Generate one isolated candidate per plan, concurrently (bounded). Returns each attempt's workspace +
 * result. Does not mutate `params.cwd`. The caller verifies, copies the winner back, and calls
 * cleanupBurst(). Never throws for a single failed attempt — that attempt's result carries its stopReason.
 */
export async function cloudBurstGenerate(params: CloudBurstParams, plans: AttemptPlan[], opts: CloudBurstOpts = {}): Promise<BurstAttempt[]> {
  const runOne = opts.runOne ?? runReliableAgent;
  const contract = extractAcceptanceContract(params.task);
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  return mapLimit(plans, concurrency, async (plan) => {
    const workspace = isolate(params.cwd);
    const localizationFiles = plan.localizationRotation > 0 ? rotateLocalization(contract.files, plan.localizationRotation) : undefined;
    let result: AgentRunResult & { contractTargets: string[] };
    try {
      result = await runOne({
        task: params.task, cwd: workspace, llm: params.llm, model: params.model,
        maxTurns: params.maxTurns, reasoningEffort: params.reasoningEffort, temperature: plan.temperature,
        extraDirective: plan.directive, localizationFiles, experiencePrime: params.experiencePrime,
        captureConfidence: params.captureConfidence,
        decode: { ...params.decode, ...plan.decode },
        banForbidden: params.banForbidden,
        signal: params.signal
      });
    } catch (e) {
      result = { finished: false, summary: `burst attempt error: ${(e as Error).message}`, turns: 0, toolCalls: 0, filesWritten: [], events: [], usage: { prompt: 0, completion: 0, reasoning: 0 }, wallMs: 0, stopReason: "error", contractTargets: [] };
    }
    return { index: plan.index, workspace, result, plan } as BurstAttempt;
  });
}

/** Copy a winning attempt's workspace back onto the real cwd (mirrors bestofn's restore). */
export function adoptWorkspace(cwd: string, workspace: string): void {
  try {
    for (const name of readdirSync(cwd)) {
      if (["node_modules", ".git", "__pycache__"].includes(name)) continue;
      rmSync(join(cwd, name), { recursive: true, force: true });
    }
    cpSync(workspace, cwd, { recursive: true });
  } catch { /* best-effort */ }
}

export function cleanupBurst(attempts: BurstAttempt[]): void {
  for (const a of attempts) { try { rmSync(a.workspace, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** Resolve cloud-burst config from env (KITTEN_CLOUD_BASE_URL + KITTEN_CLOUD_API_KEY), or null. */
export function cloudBurstConfigFromEnv(): CloudBurstConfig | null {
  const baseUrl = process.env.KITTEN_CLOUD_BASE_URL;
  const apiKey = process.env.KITTEN_CLOUD_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, model: process.env.KITTEN_CLOUD_MODEL || "qwen3.6-35b-a3b", concurrency: Number(process.env.KITTEN_CLOUD_CONCURRENCY || "6") };
}
