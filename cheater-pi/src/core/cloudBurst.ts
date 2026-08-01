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
  contextPreamble?: string;    // conversation context (same for all attempts) — multi-turn/resume
  captureConfidence?: boolean; // P1: capture self-certainty for selection
  decode?: { logitBias?: Record<number, number>; topP?: number; topK?: number; minP?: number; dryMultiplier?: number; grammar?: string }; // P2 ban (global)
  banForbidden?: boolean;      // P2: run the finish-gate forbidden-construct scan
  disableThinking?: boolean;   // iter-1: no-think fast forward pass (re-enabled on repair)
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
        contextPreamble: params.contextPreamble,
        captureConfidence: params.captureConfidence,
        // Self-certainty only decides between candidates, and per-token probabilities cost real decode
        // throughput — so a single-plan round does not pay for them.
        candidateCount: plans.length,
        decode: { ...params.decode, ...plan.decode },
        banForbidden: params.banForbidden,
        disableThinking: params.disableThinking,
        signal: params.signal
      });
    } catch (e) {
      result = { finished: false, summary: `burst attempt error: ${(e as Error).message}`, turns: 0, toolCalls: 0, filesWritten: [], events: [], usage: { prompt: 0, completion: 0, reasoning: 0 }, wallMs: 0, stopReason: "error", contractTargets: [] };
    }
    return { index: plan.index, workspace, result, plan } as BurstAttempt;
  });
}

/** Copy a winning attempt's workspace back onto the real cwd (mirrors bestofn's restore). */
/**
 * Adopt a candidate workspace into `cwd`, returning the repository-relative files it brought in.
 *
 * The return value is not a convenience — it is the only honest source of "what changed" when the
 * workspace is NOT a git repository. Ascent derives changed files from `git diff` against a pre-run
 * snapshot, and a non-git workspace has no snapshot, so a run that wrote four correct files reported
 * `filesChanged: []`. That silently disables `/undo`, shows an empty diff, and skips postflight
 * review — the receipt claims nothing happened while the work sits on disk. Observed live: a
 * from-scratch build scored 13/13 on a hidden oracle and reported zero changed files.
 */
export function adoptWorkspace(cwd: string, workspace: string): string[] {
  try {
    for (const name of readdirSync(cwd)) {
      if (["node_modules", ".git", "__pycache__"].includes(name)) continue;
      rmSync(join(cwd, name), { recursive: true, force: true });
    }
    cpSync(workspace, cwd, { recursive: true });
    return listAdoptedFiles(workspace);
  } catch {
    return []; // best-effort: a failed adoption reports nothing rather than guessing
  }
}

/** Repository-relative, `/`-separated files in an adopted workspace, excluding tooling noise. */
function listAdoptedFiles(root: string, prefix = "", depth = 0): string[] {
  if (depth > 8) return [];
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (["node_modules", ".git", "__pycache__", ".venv", "dist", "build"].includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listAdoptedFiles(join(root, entry.name), relative, depth + 1));
    else if (entry.isFile()) out.push(relative);
    if (out.length > 400) break; // a receipt listing thousands of files helps nobody
  }
  return out;
}

export function cleanupBurst(attempts: BurstAttempt[]): void {
  for (const a of attempts) { try { rmSync(a.workspace, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** Where an interrupted run leaves its candidates for the user to find. */
export const CHECKPOINT_DIR = ".kitten-candidates";

/**
 * Copy finished candidates into `<cwd>/.kitten-candidates/` so an interrupted run keeps its work.
 *
 * Ascent builds each candidate in an isolated workspace and adopts the winner into `cwd` only at
 * the very end. In the bakeoff, `json_patch` ran two candidates for fifteen minutes, was killed
 * before adoption, and left a workspace containing nothing at all — the oracle then reported
 * `ModuleNotFoundError`, indistinguishable from an agent that never tried.
 *
 * This is deliberately NON-DESTRUCTIVE. Adopting provisionally into `cwd` would be more convenient,
 * but `adoptWorkspace` clears `cwd` first — so an interrupt landing after a provisional adoption
 * would leave the user holding an unverified loser's edits *instead of their own files*. Losing
 * fifteen minutes of the agent's work is bad; quietly replacing someone's repository with a
 * candidate that never won is worse. The checkpoint sits beside the work, and the winner still
 * adopts normally.
 */
export function checkpointCandidates(cwd: string, attempts: BurstAttempt[], round: number): string[] {
  const saved: string[] = [];
  for (const a of attempts) {
    if (!a.result.finished) continue;                 // unfinished candidates aren't worth the copy
    const dest = join(cwd, CHECKPOINT_DIR, `round${round}-candidate${a.index}`);
    try {
      rmSync(dest, { recursive: true, force: true });
      cpSync(a.workspace, dest, {
        recursive: true,
        filter: (src) => !/[\\/](node_modules|\.git|__pycache__|\.venv|dist|build|\.kitten-candidates)$/i.test(src),
      });
      saved.push(dest);
    } catch { /* best effort: a failed checkpoint must never fail the run */ }
  }
  return saved;
}

/** Remove the checkpoints once the winner is safely adopted — a clean run leaves no litter. */
export function clearCheckpoints(cwd: string): void {
  try { rmSync(join(cwd, CHECKPOINT_DIR), { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Resolve cloud-burst config from env (KITTEN_CLOUD_BASE_URL + KITTEN_CLOUD_API_KEY), or null. */
export function cloudBurstConfigFromEnv(): CloudBurstConfig | null {
  const baseUrl = process.env.KITTEN_CLOUD_BASE_URL;
  const apiKey = process.env.KITTEN_CLOUD_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, model: process.env.KITTEN_CLOUD_MODEL || "qwen3.6-35b-a3b", concurrency: Number(process.env.KITTEN_CLOUD_CONCURRENCY || "6") };
}
