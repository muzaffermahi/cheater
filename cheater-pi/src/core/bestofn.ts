// Kitten Core — sequential best-of-N (the owned-engine lever). Research: repeated sampling lifts a
// WEAK model's coverage the most (Large Language Monkeys), but the model can't PICK the winner — so
// the SELECTOR must be execution, never the model's opinion. We own the inference engine, so each
// attempt gets real temperature jitter (Pi could not do this).
//
// In an agentic loop, "best-of-N" = run the reliable agent up to N times from a clean workspace, each
// with a different temperature, and keep the FIRST attempt whose finish gate actually verified (the
// execution receipt IS the selector). Sequential because LM Studio serves one request at a time; the
// clean-workspace reset between attempts prevents a failed attempt from poisoning the next. Gated to
// hard tasks by the caller (k=1 is a plain single run — zero overhead on easy work).

import { cpSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReliableAgent, type ReliableParams } from "./reliable.js";
import type { AgentRunResult } from "./agent.js";

/** Temperature per attempt: attempt 1 deterministic, later attempts warm up to diversify coverage. */
export function attemptTemp(attempt: number): number {
  return [0, 0.4, 0.8, 1.0][Math.min(attempt - 1, 3)] ?? 1.0;
}

export interface BestOfNResult extends AgentRunResult {
  attempts: number;
  appliedAttempt: number;
  contractTargets: string[];
}

/**
 * Run up to `k` reliable attempts, each from the current workspace snapshot, keeping the first that
 * finished (its finish gate verified). If none verify, the last attempt's changes are left in place.
 * The workspace is snapshotted once and restored between attempts so each starts clean.
 */
export async function runBestOfN(params: ReliableParams, k: number): Promise<BestOfNResult> {
  if (k <= 1) {
    const r = await runReliableAgent({ ...params, temperature: 0 });
    return { ...r, attempts: 1, appliedAttempt: 1 };
  }
  const snap = snapshot(params.cwd);
  let best: (AgentRunResult & { contractTargets: string[] }) | null = null;
  let attemptsRun = 0;
  try {
    for (let attempt = 1; attempt <= k; attempt++) {
      if (attempt > 1) restore(params.cwd, snap); // clean base for this sample
      attemptsRun = attempt;
      const r = await runReliableAgent({ ...params, temperature: attemptTemp(attempt) });
      if (r.finished) return { ...r, attempts: attempt, appliedAttempt: attempt };
      if (!best) best = r; // keep the first as the fallback-on-disk
    }
  } finally {
    cleanup(snap);
  }
  // None verified — the last attempt's edits are on disk; report the best (first) for its metrics.
  return { ...(best as AgentRunResult & { contractTargets: string[] }), attempts: attemptsRun, appliedAttempt: attemptsRun };
}

function snapshot(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kitten-bon-"));
  try { cpSync(cwd, dir, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git|__pycache__)([\\/]|$)/.test(s) }); } catch { /* best-effort */ }
  return dir;
}
function restore(cwd: string, snap: string): void {
  try {
    // remove files the attempt created, then copy the snapshot back
    for (const name of readdirSync(cwd)) {
      if (["node_modules", ".git", "__pycache__"].includes(name)) continue;
      rmSync(join(cwd, name), { recursive: true, force: true });
    }
    if (existsSync(snap)) cpSync(snap, cwd, { recursive: true });
  } catch { /* best-effort */ }
}
function cleanup(snap: string): void {
  try { rmSync(snap, { recursive: true, force: true }); } catch { /* best-effort */ }
}
