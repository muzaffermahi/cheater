// Kitten Ascent Part B — the multi-signal verifier. Twenty kittens came back with twenty mice; the
// handler must know, WITHOUT asking them, which mouse is real. That knowing is the entire product.
//
// SWE-Gym's definitive datapoint: Best@16 (a mediocre verifier picks) = 32.0 vs pass@16 (oracle) = 42.8
// — a mediocre verifier leaves 10.8 points ON THE TABLE, already inside the samples generated. Closing
// that gap is the single highest-leverage build. This verifier ranks candidates by GROUNDED evidence,
// strongest signal first, and the generator never grades itself as final (Design Laws 1 & 3):
//
//   B1 execution (the floor, must exist to be eligible):
//       - reproduction: a red-then-green screen — the check FAILS on the pre-change base and PASSES on
//         the candidate (proves the change does something real, not that a vacuous check passes).
//       - regression: the repo's existing tests still pass (Agentless's +6.3 came largely from this).
//       - behavioral smoke: run the contract command / a family check; assert the END STATE, never a
//         stdout format (the 29th-pass lesson: format-brittle oracles manufacture fake fails).
//   B2 consensus (generalise synthtest): execution vote across eligible candidates — the plurality
//       output with fewest crashes wins ties; catches the subtly-wrong-but-self-verified attempt.
//   B3 ORM (optional, top-end): a trained 2B outcome reward model scores P(solved); off unless a
//       checkpoint exists — B1+B2 already beat naive selection.
//
// Fusion (B4): eligible = passed B1; order by (consensus, ORM); winner = top; the finish gate refuses
// "done" unless the winner has a green execution receipt. The full slate is recorded for audit.
//
// Everything is spawnSync-guarded with timeouts and never throws into a run; an absent signal is "n/a",
// not a failure.

import { spawnSync } from "node:child_process";
import type { KittenLLM } from "./llm.js";
import type { AcceptanceContract } from "../runstate/contract.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runFnProbes, selectByConsensus, type FnProbe, type ProbeOutcome } from "./synthtest.js";
import { reviewerConfidence } from "./selfCertainty.js";
import type { OrmScorer } from "./orm.js";

export type Signal = "pass" | "fail" | "n/a";

export interface Candidate {
  index: number;           // 1-based attempt index
  workspace: string;       // path to the candidate's produced workspace
  finished: boolean;       // its in-session finish gate passed
  summary: string;
  /** For the ORM: a compact trajectory string (diff + test output + reasoning). Optional. */
  trajectory?: string;
  /** P1: aggregated self-certainty of this candidate's generation (owned-engine tiebreaker signal). */
  selfCertainty?: number;
}

export interface CandidateSignals {
  index: number;
  reproduction: Signal;
  regression: Signal;
  smoke: Signal;
  /** Self-generated consensus probe outcome folded into eligibility: "fail" ⇒ crashed on its own probe
   *  (demonstrably broken), "pass" ⇒ ran clean (a real execution receipt for a single-function task). */
  probe?: Signal;
  /** Passed every APPLICABLE execution signal (B1) → eligible to be final (Law 1). */
  executionEligible: boolean;
  /** True when no execution signal was available at all — eligibility fell back to the finish gate. */
  weaklyEligible: boolean;
  consensusRank?: number;      // 0 = best consensus agreement
  consensusCrashes?: number;
  ormScore?: number;           // B3 P(solved) in [0,1]
  selfCertainty?: number;      // P1 tiebreaker: how decisive the generation was
  receipt: string[];
}

export interface VerifierResult {
  slate: CandidateSignals[];
  winner: number | null;       // chosen candidate index (1-based), null if nothing eligible
  selector: "execution+consensus" | "execution+orm" | "execution" | "consensus-only" | "finished-fallback" | "none";
  /** Does the winner carry a green execution receipt (finish-gate precondition, Law 1)? */
  winnerHasExecutionReceipt: boolean;
}

export interface VerifierOpts {
  llm: KittenLLM;
  task: string;
  contract: AcceptanceContract;
  /** Pre-change snapshot for the red-then-green screen + regression baseline. */
  baseWorkspace?: string;
  /** The repo's test command (regression + repro), if any. */
  testCommand?: string | null;
  /** Behavioral smoke commands (from the A4 playbook verification hints / contract commands). */
  behavioralChecks?: string[];
  /** B2 consensus target for single-function tasks. */
  probe?: FnProbe | null;
  /** B3 outcome reward model. Off (null) unless a trained checkpoint is loaded. */
  orm?: OrmScorer | null;
  /** P1: run a bounded reviewer self-certainty pass per candidate (owned-engine tiebreaker). */
  confidence?: boolean;
  /** P1: the py module to read each candidate's code from (for the confidence pass). */
  module?: string | null;
  /** Per-command timeout for execution signals. */
  timeoutMs?: number;
}

function runCmd(cmd: string, cwd: string, timeoutMs: number): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    return { ok: (r.status ?? 1) === 0, out: ((r.stdout ?? "") + "\n" + (r.stderr ?? "")).slice(-3000) };
  } catch {
    return { ok: false, out: "spawn error" };
  }
}

export class Verifier {
  private timeoutMs: number;
  constructor(private opts: VerifierOpts) {
    this.timeoutMs = opts.timeoutMs ?? 120000;
  }

  /** Score and rank every candidate; select the winner by execution → consensus → ORM. */
  async verify(candidates: Candidate[]): Promise<VerifierResult> {
    const slate: CandidateSignals[] = [];
    // Screen the base ONCE for red-then-green: if the repo test already fails on base, a candidate that
    // makes it pass is a true reproduction. If base passes (or no test), reproduction can't be screened.
    const baseRedFailed = this.opts.testCommand && this.opts.baseWorkspace
      ? !runCmd(this.opts.testCommand, this.opts.baseWorkspace, this.timeoutMs).ok
      : false;

    for (const c of candidates) {
      const receipt: string[] = [];
      let reproduction: Signal = "n/a", regression: Signal = "n/a", smoke: Signal = "n/a";

      if (this.opts.testCommand) {
        const r = runCmd(this.opts.testCommand, c.workspace, this.timeoutMs);
        regression = r.ok ? "pass" : "fail";
        receipt.push(`repo tests: ${regression}`);
        if (baseRedFailed) { reproduction = r.ok ? "pass" : "fail"; receipt.push(`red-then-green: ${reproduction} (base was red)`); }
      }

      if (this.opts.behavioralChecks?.length) {
        let allOk = true;
        for (const cmd of this.opts.behavioralChecks) {
          if (!/[a-z]/i.test(cmd)) continue;
          const r = runCmd(cmd, c.workspace, this.timeoutMs);
          if (!r.ok) { allOk = false; break; }
        }
        smoke = allOk ? "pass" : "fail";
        receipt.push(`behavioral smoke: ${smoke}`);
      }

      // Eligibility (B1): pass every APPLICABLE signal. If none applied, fall back to the finish gate
      // but flag it weak (Law 1: no non-execution signal may be the SOLE reason a candidate is final).
      const applied = [regression, reproduction, smoke].filter((s) => s !== "n/a");
      const anyApplied = applied.length > 0;
      const executionEligible = anyApplied ? applied.every((s) => s === "pass") : c.finished;
      const weaklyEligible = !anyApplied;
      if (weaklyEligible) receipt.push(`no execution signal available → eligibility from finish gate (${c.finished ? "finished" : "unfinished"})`);

      slate.push({ index: c.index, reproduction, regression, smoke, executionEligible, weaklyEligible, receipt });
    }

    // B2 consensus over the probe, run on every candidate's workspace (eligible or not, so a candidate
    // that fails a thin repo test but agrees with the plurality is still visible for tie-breaking).
    if (this.opts.probe) {
      const outcomes: (ProbeOutcome | null)[] = candidates.map((c) => runFnProbes(c.workspace, this.opts.probe!));
      const pick = selectByConsensus(outcomes);
      if (pick) {
        for (let i = 0; i < slate.length; i++) {
          slate[i].consensusRank = pick.scores.map((s, j) => ({ s: s - pick.crashes[j] * 0.5, j })).sort((a, b) => b.s - a.s).findIndex((x) => x.j === i);
          slate[i].consensusCrashes = pick.crashes[i];
          slate[i].receipt.push(`consensus score ${pick.scores[i]} / crashes ${pick.crashes[i]}`);
          // Fold the self-probe into execution eligibility. For a single-function task the probe is
          // usually the ONLY execution evidence: a candidate that CRASHES on its own probe is broken
          // (drop it); one that runs clean carries a real execution receipt, not the "weak" fallback.
          const probe: Signal = pick.crashes[i] > 0 ? "fail" : "pass";
          slate[i].probe = probe;
          const applied = [slate[i].regression, slate[i].reproduction, slate[i].smoke, probe].filter((s) => s !== "n/a");
          slate[i].executionEligible = applied.every((s) => s === "pass");
          slate[i].weaklyEligible = false; // a real execution signal now exists for this candidate
          slate[i].receipt.push(`self-probe execution: ${probe}`);
        }
      }
    }

    // B3 ORM (optional): score each candidate's trajectory. Never the sole reason (fused after execution).
    if (this.opts.orm) {
      for (let i = 0; i < candidates.length; i++) {
        const traj = candidates[i].trajectory ?? candidates[i].summary;
        try { const p = await this.opts.orm.score(traj, this.opts.task); slate[i].ormScore = p; slate[i].receipt.push(`ORM P(solved)=${p.toFixed(2)}`); } catch { /* orm best-effort */ }
      }
    }

    // P1 — bounded reviewer self-certainty per candidate (owned-engine tiebreaker; needs logprobs).
    if (this.opts.confidence && this.opts.module) {
      for (let i = 0; i < candidates.length; i++) {
        let code = "";
        try { code = readFileSync(join(candidates[i].workspace, this.opts.module), "utf8"); } catch { /* no code */ }
        const sc = candidates[i].selfCertainty ?? (code ? await reviewerConfidence(this.opts.llm, this.opts.task, code) : 0.5);
        slate[i].selfCertainty = sc;
        slate[i].receipt.push(`self-certainty ${sc.toFixed(3)}`);
      }
    }

    return this.fuse(slate);
  }

  /** B4 fusion: eligible = passed B1; order by (consensus rank, ORM), winner = top. */
  private fuse(slate: CandidateSignals[]): VerifierResult {
    const eligible = slate.filter((s) => s.executionEligible);
    const pool = eligible.length ? eligible : slate;
    const usedExecution = eligible.length > 0 && eligible.some((s) => !s.weaklyEligible);

    // Order: execution consensus first, then ORM, then P1 self-certainty (the owned-engine tiebreaker
    // for the "all candidates agree but are wrong / a thin test can't separate them" case — where
    // consensusRank is tied and there's no ORM, the more DECISIVE generation wins instead of arbitrary
    // index order). Self-certainty is never the sole reason: eligibility (B1 execution) gates the pool.
    const ranked = [...pool].sort((a, b) => {
      const cr = (a.consensusRank ?? 99) - (b.consensusRank ?? 99);
      if (cr !== 0) return cr;
      const orm = (b.ormScore ?? -1) - (a.ormScore ?? -1);
      if (orm !== 0) return orm;
      const sc = (b.selfCertainty ?? -1) - (a.selfCertainty ?? -1);
      if (Math.abs(sc) > 1e-6) return sc;
      return a.index - b.index;
    });
    const winner = ranked[0]?.index ?? null;
    const win = ranked[0];

    let selector: VerifierResult["selector"] = "none";
    if (!win) selector = "none";
    else if (!eligible.length) selector = win.consensusRank !== undefined ? "consensus-only" : "finished-fallback";
    else if (win.ormScore !== undefined && win.consensusRank === undefined) selector = "execution+orm";
    else if (win.consensusRank !== undefined) selector = "execution+consensus";
    else selector = "execution";

    const winnerHasExecutionReceipt = !!win && win.executionEligible && !win.weaklyEligible;
    return { slate, winner, selector, winnerHasExecutionReceipt: winnerHasExecutionReceipt || (!!win && usedExecution && win.executionEligible) };
  }
}

/** Render the verifier slate for the run receipts (the full audit trail — Law of receipts). */
export function verifierReceiptLines(result: VerifierResult): string[] {
  const lines = [`verifier: winner=attempt ${result.winner ?? "none"} via ${result.selector}${result.winnerHasExecutionReceipt ? " (green execution receipt)" : " (NO execution receipt — weak)"}`];
  for (const s of result.slate) {
    lines.push(`  #${s.index}: repro=${s.reproduction} regr=${s.regression} smoke=${s.smoke}${s.probe ? ` probe=${s.probe}` : ""} elig=${s.executionEligible ? "Y" : "n"}${s.consensusRank !== undefined ? ` crank=${s.consensusRank}` : ""}${s.ormScore !== undefined ? ` orm=${s.ormScore.toFixed(2)}` : ""}`);
  }
  return lines;
}
