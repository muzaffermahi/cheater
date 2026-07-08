// Kitten Ascent — best-of-N orchestrator: diverse coverage (A1) + rounds of repair-resampling, with
// execution-grounded selection. Research: repeated sampling lifts a WEAK model's coverage the most
// (Large Language Monkeys), but the model can't PICK the winner — so the SELECTOR is execution, never
// the model's opinion. We own the inference engine, so each attempt gets real temperature + stance +
// localization diversity (Pi could not do this).
//
// Structure:
//   - Round = a batch of `k` diverse attempts (planAttempts: temperature × stance × plan × localization).
//   - Between rounds, the best failure seeds the next batch as a repair directive (repair-resampling
//     compounds coverage; SWE-Gym's gains are per-trajectory, ours stack rounds). Hard tasks get more
//     rounds; easy tasks get k=1 = a single deterministic run, zero overhead.
//   - Selection: CONSENSUS (synthtest execution vote) when the task is a single python function; else
//     VERIFIED (first attempt whose finish gate actually passed). Part B replaces this core with the
//     full multi-signal verifier; the slate it records here is the audit trail either way.
//
// Sequential because LM Studio serves one request at a time; a clean-workspace reset between attempts
// stops a failed attempt poisoning the next. The winning attempt's files are the ones left in `cwd`.

import { cpSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReliableAgent, type ReliableParams } from "./reliable.js";
import type { AgentRunResult } from "./agent.js";
import { extractAcceptanceContract } from "../runstate/contract.js";
import { generateFnProbes, runFnProbes, selectByConsensus, isCleanOutcome, type FnProbe, type ProbeOutcome } from "./synthtest.js";
import { planAttempts, rotateLocalization, repairDirective, roundsForBudget, type AttemptPlan, type Stance } from "./diversity.js";

/** Back-compat temperature schedule (attempt 1 deterministic). New code uses diversity.attemptTemperature. */
export function attemptTemp(attempt: number): number {
  return [0, 0.4, 0.8, 1.0][Math.min(attempt - 1, 3)] ?? 1.0;
}

/** One row of the audit slate: what each attempt was and how it scored. */
export interface SlateEntry {
  round: number;
  attempt: number;          // global 1-based index across all rounds
  label: string;            // diversity plan label, e.g. "t0.73/root-cause/plan"
  finished: boolean;
  stopReason: string;
  cleanProbe?: boolean;     // passed all synthtest probes without crashing
}

export interface BestOfNResult extends AgentRunResult {
  attempts: number;
  rounds: number;
  appliedAttempt: number;
  contractTargets: string[];
  selector: "consensus" | "verified" | "fallback" | "single";
  probeCount?: number;
  slate: SlateEntry[];
}

export interface BestOfNOptions {
  /** Repair-resampling rounds. Default derived from k (roundsForBudget). */
  rounds?: number;
  /** Enable the decomposition axis. Default: inferred from the contract (multi-file task). */
  multiFile?: boolean;
  /** Receipts hook: called for every attempt with its slate row. */
  onSlateEntry?: (e: SlateEntry) => void;
}

type Attempt = AgentRunResult & { contractTargets: string[]; plan: AttemptPlan };

/**
 * Run up to `k` diverse attempts per round, across up to R rounds of repair-resampling. Select the
 * winner by execution consensus (single-fn tasks) or the first verified attempt. Returns the full
 * slate for auditability. k<=1 short-circuits to a single deterministic run.
 */
export async function runBestOfN(params: ReliableParams, k: number, options: BestOfNOptions = {}): Promise<BestOfNResult> {
  if (k <= 1) {
    const r = await runReliableAgent({ ...params, temperature: 0 });
    return { ...r, attempts: 1, rounds: 1, appliedAttempt: 1, selector: "single", slate: [] };
  }

  const contract = extractAcceptanceContract(params.task);
  const probe = await generateFnProbes(params.llm, params.task, contract);
  const multiFile = options.multiFile ?? contract.files.length > 1;
  const localizationVariants = Math.max(1, Math.min(4, contract.files.length));
  const rounds = Math.max(1, options.rounds ?? roundsForBudget(k));

  const base = snapshot(params.cwd);
  const attemptSnaps: string[] = [];
  const attempts: Attempt[] = [];
  const outcomes: (ProbeOutcome | null)[] = [];
  const slate: SlateEntry[] = [];
  let global = 0;

  const record = (round: number, plan: AttemptPlan, r: AgentRunResult, outcome: ProbeOutcome | null): void => {
    global++;
    const entry: SlateEntry = {
      round, attempt: global, label: plan.label, finished: r.finished, stopReason: r.stopReason,
      cleanProbe: probe ? isCleanOutcome(outcome) : undefined
    };
    slate.push(entry);
    options.onSlateEntry?.(entry);
  };

  try {
    let repairSeed: string | undefined;
    for (let round = 1; round <= rounds; round++) {
      const plans = planAttempts(k, { multiFile, localizationVariants, repairSeed });
      for (const plan of plans) {
        if (global > 0) restore(params.cwd, base);
        const localizationFiles = plan.localizationRotation > 0
          ? rotateLocalization(contract.files, plan.localizationRotation)
          : undefined;
        const r = await runReliableAgent({
          ...params,
          temperature: plan.temperature,
          extraDirective: plan.directive || params.extraDirective,
          localizationFiles
        });
        const withPlan: Attempt = { ...r, contractTargets: [...contract.files, ...contract.symbols], plan };
        attempts.push(withPlan);
        const outcome = probe ? runFnProbes(params.cwd, probe) : null;
        outcomes.push(outcome);
        attemptSnaps.push(snapshot(params.cwd));
        record(round, plan, r, outcome);

        // Fast path: the very first baseline attempt verified and (if probes) crashes on nothing.
        if (round === 1 && plan.index === 1 && r.finished && (!probe || isCleanOutcome(outcome))) {
          return finalize(params.cwd, attemptSnaps, 0, attempts, probe ? "consensus" : "verified", probe, rounds, slate);
        }
      }

      // Selection after this round. Consensus if it discriminates; else first verified.
      const pick = probe ? selectByConsensus(outcomes) : null;
      if (pick && pick.discriminating) {
        return finalize(params.cwd, attemptSnaps, pick.index, attempts, "consensus", probe, rounds, slate);
      }
      const firstFinished = attempts.findIndex((a) => a.finished);
      if (firstFinished >= 0 && !probe) {
        return finalize(params.cwd, attemptSnaps, firstFinished, attempts, "verified", probe, rounds, slate);
      }
      // Nothing decisive; seed a repair round from the best failure and try again.
      if (round < rounds) repairSeed = seedFromBestFailure(attempts, outcomes);
    }

    // Rounds exhausted: consensus (non-discriminating fallback), else first finished, else attempt 0.
    if (probe) {
      const pick = selectByConsensus(outcomes);
      if (pick) return finalize(params.cwd, attemptSnaps, pick.index, attempts, pick.discriminating ? "consensus" : "fallback", probe, rounds, slate);
    }
    const firstFinished = attempts.findIndex((a) => a.finished);
    const idx = firstFinished >= 0 ? firstFinished : 0;
    return finalize(params.cwd, attemptSnaps, idx, attempts, probe ? "fallback" : "verified", probe, rounds, slate);
  } finally {
    cleanup(base);
    for (const s of attemptSnaps) cleanup(s);
  }
}

/** Repair directive from the round's best failure: fewest-crash attempt (or the last), plus its grounding. */
function seedFromBestFailure(attempts: Attempt[], outcomes: (ProbeOutcome | null)[]): string {
  let bestIdx = attempts.length - 1;
  let bestCrashes = Infinity;
  for (let i = 0; i < attempts.length; i++) {
    const o = outcomes[i];
    const crashes = o ? o.results.filter((r) => !r.ok).length : (attempts[i].finished ? 0 : 99);
    if (crashes < bestCrashes) { bestCrashes = crashes; bestIdx = i; }
  }
  const a = attempts[bestIdx];
  const grounding = a.finished
    ? `The closest attempt finished but did not pass the checks. Summary: ${a.summary.slice(0, 200)}`
    : `The closest attempt stopped as "${a.stopReason}" without a passing verification. Summary: ${a.summary.slice(0, 200)}`;
  return repairDirective(grounding, a.plan.stance as Stance);
}

/** Restore the winning attempt's files to cwd and build the result record. */
function finalize(cwd: string, snaps: string[], idx: number, attempts: Attempt[], selector: BestOfNResult["selector"], probe: FnProbe | null, rounds: number, slate: SlateEntry[]): BestOfNResult {
  if (snaps[idx]) restore(cwd, snaps[idx]);
  const win = attempts[idx];
  return { ...win, attempts: attempts.length, rounds, appliedAttempt: idx + 1, selector, probeCount: probe?.inputs.length, slate };
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
