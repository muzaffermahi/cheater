// Kitten Core — sequential best-of-N (the owned-engine lever). Research: repeated sampling lifts a
// WEAK model's coverage the most (Large Language Monkeys), but the model can't PICK the winner — so
// the SELECTOR must be execution, never the model's opinion. We own the inference engine, so each
// attempt gets real temperature jitter (Pi could not do this).
//
// Two selectors, in order of strength:
//   1. CONSENSUS (synthtest.ts): when the task is a single python function, the sidecar invents probe
//      inputs and every attempt is run on them; the attempt that best matches the per-input plurality
//      output (and crashes least) wins. This catches a subtly-wrong-but-self-verified attempt that the
//      finish gate alone would pass — the CodeT/Agentless lever, and the sidecar's biggest job.
//   2. VERIFIED (fallback): keep the first attempt whose finish gate actually verified. Used when the
//      task isn't a clean single-function target (class/multi-file), so probes don't apply.
//
// Sequential because LM Studio serves one request at a time; a clean-workspace reset between attempts
// stops a failed attempt poisoning the next. Gated to hard tasks by the caller (k=1 = a plain single
// run, zero overhead on easy work).

import { cpSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReliableAgent, type ReliableParams } from "./reliable.js";
import type { AgentRunResult } from "./agent.js";
import { extractAcceptanceContract } from "../runstate/contract.js";
import { generateFnProbes, runFnProbes, selectByConsensus, isCleanOutcome, type FnProbe, type ProbeOutcome } from "./synthtest.js";

/** Temperature per attempt: attempt 1 deterministic, later attempts warm up to diversify coverage. */
export function attemptTemp(attempt: number): number {
  return [0, 0.4, 0.8, 1.0][Math.min(attempt - 1, 3)] ?? 1.0;
}

export interface BestOfNResult extends AgentRunResult {
  attempts: number;
  appliedAttempt: number;
  contractTargets: string[];
  selector: "consensus" | "verified" | "fallback" | "single";
  probeCount?: number;
}

type Attempt = AgentRunResult & { contractTargets: string[] };

/**
 * Run up to `k` reliable attempts from a clean base each time. If the task is a single python function,
 * select the winner by execution consensus over sidecar-generated probes; otherwise keep the first
 * attempt that verified. The winning attempt's files are the ones left in `cwd`.
 */
export async function runBestOfN(params: ReliableParams, k: number): Promise<BestOfNResult> {
  if (k <= 1) {
    const r = await runReliableAgent({ ...params, temperature: 0 });
    return { ...r, attempts: 1, appliedAttempt: 1, selector: "single" };
  }

  // Probe target (sidecar, cheap, parallel on CPU). Null => not a single-fn task => verified-selector path.
  const contract = extractAcceptanceContract(params.task);
  const probe = await generateFnProbes(params.llm, params.task, contract);

  const base = snapshot(params.cwd);
  const attemptSnaps: string[] = [];
  const attempts: Attempt[] = [];
  const outcomes: (ProbeOutcome | null)[] = [];
  try {
    for (let attempt = 1; attempt <= k; attempt++) {
      if (attempt > 1) restore(params.cwd, base);
      const r = await runReliableAgent({ ...params, temperature: attemptTemp(attempt) });
      attempts.push(r);
      // Score this attempt's produced workspace on the probes BEFORE snapshotting/restoring.
      const outcome = probe ? runFnProbes(params.cwd, probe) : null;
      outcomes.push(outcome);
      attemptSnaps.push(snapshot(params.cwd));

      // Fast path (no probes / verified-selector): first verified attempt wins, no need to sample more.
      if (!probe && r.finished) {
        return finalize(params.cwd, attemptSnaps, attempt - 1, attempts, "verified", probe);
      }
      // Fast path (probes): attempt 1 verified AND crashes on nothing => trust it, skip extra samples.
      if (probe && attempt === 1 && r.finished && isCleanOutcome(outcome)) {
        return finalize(params.cwd, attemptSnaps, 0, attempts, "consensus", probe);
      }
    }

    // Select the winner.
    if (probe) {
      const pick = selectByConsensus(outcomes);
      if (pick && pick.discriminating) {
        return finalize(params.cwd, attemptSnaps, pick.index, attempts, "consensus", probe);
      }
    }
    // Verified fallback: first finished attempt, else the first attempt.
    const firstFinished = attempts.findIndex((a) => a.finished);
    const idx = firstFinished >= 0 ? firstFinished : 0;
    return finalize(params.cwd, attemptSnaps, idx, attempts, probe ? "fallback" : "verified", probe);
  } finally {
    cleanup(base);
    for (const s of attemptSnaps) cleanup(s);
  }
}

/** Restore the winning attempt's files to cwd and build the result record. */
function finalize(cwd: string, snaps: string[], idx: number, attempts: Attempt[], selector: BestOfNResult["selector"], probe: FnProbe | null): BestOfNResult {
  if (snaps[idx]) restore(cwd, snaps[idx]);
  const win = attempts[idx];
  return { ...win, attempts: attempts.length, appliedAttempt: idx + 1, selector, probeCount: probe?.inputs.length };
}

function snapshot(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kitten-bon-"));
  try { cpSync(cwd, dir, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git|__pycache__)([\\/]|$)/.test(s) }); } catch { /* best-effort */ }
  return dir;
}
function restore(cwd: string, snap: string): void {
  try {
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
