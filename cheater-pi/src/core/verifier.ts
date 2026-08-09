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
//   B2b dual agreement (CodeT): the same executions read JOINTLY — cluster candidates by whole
//       behaviour and score √(agreeing candidates × probes they agree on), so a coherent minority
//       beats an incoherent plurality. Free: it re-reads outcomes B2 already paid for. On a genuine
//       tie between two behaviours, S*-style adjudication puts the one concrete disagreement to the
//       model ("same input, two answers, which does the spec say?"). See dualAgreement.ts.
//   B3 ORM (optional, top-end): a trained 2B outcome reward model scores P(solved); off unless a
//       checkpoint exists — B1+B2 already beat naive selection.
//
// Fusion (B4): eligible = passed B1; order by (consensus, agreement, ORM); winner = top; the finish
// gate refuses "done" unless the winner has a green execution receipt. The slate is recorded for audit.
//
// Everything is spawnSync-guarded with timeouts and never throws into a run; an absent signal is "n/a",
// not a failure.

import { spawnSync } from "node:child_process";
import type { KittenLLM } from "./llm.js";
import type { AcceptanceContract } from "../runstate/contract.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runFnProbes, selectByConsensus, type FnProbe, type ProbeOutcome } from "./synthtest.js";
import { dualAgreement, firstDisagreement, renderDisagreement, readVerdict, type Disagreement } from "./dualAgreement.js";
import { screenReproScript, runReproScript, type ReproScript } from "./reproTest.js";
import { reviewerConfidence } from "./selfCertainty.js";
import { runExampleTest, type WorkedExample } from "./workedExamples.js";
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
  /** GROUND TRUTH: does the candidate satisfy the prompt's own worked examples? The strongest signal —
   *  real I/O, not model-generated. "fail" ⇒ ineligible no matter what consensus says. */
  groundTruth?: Signal;
  /** Passed every APPLICABLE execution signal (B1) → eligible to be final (Law 1). */
  executionEligible: boolean;
  /** True when no execution signal was available at all — eligibility fell back to the finish gate. */
  weaklyEligible: boolean;
  consensusRank?: number;      // 0 = best consensus agreement
  consensusCrashes?: number;
  /** B2b CodeT dual agreement: √(agreeing candidates × probes they agree on). Higher is better. */
  agreementScore?: number;
  /** How many candidates share this one's exact behaviour. */
  agreementCluster?: number;
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
  /** A generated reproduction script for a repo-shaped task: the only red-then-green source when the
   *  repo's own suite already passes on the unfixed code. SCREENED against the base before it counts —
   *  a script that passes there reproduces nothing and is discarded. See reproTest.ts. */
  reproScript?: ReproScript | null;
  /** B3 outcome reward model. Off (null) unless a trained checkpoint is loaded. */
  orm?: OrmScorer | null;
  /** P1: run a bounded reviewer self-certainty pass per candidate (owned-engine tiebreaker). */
  confidence?: boolean;
  /** P1: the py module to read each candidate's code from (for the confidence pass). */
  module?: string | null;
  /** Ground-truth worked examples from the prompt (real I/O) + the module they call. When present, a
   *  candidate that fails them is execution-INELIGIBLE regardless of consensus — real beats model-voted. */
  workedExamples?: WorkedExample[];
  workedModule?: string | null;
  setupVars?: string[];
  /** Per-command timeout for execution signals. */
  timeoutMs?: number;
  /** Live check reporting: each executed signal (repo tests / smoke / ground truth) per candidate, as
   *  it runs, so a UI can show verification progress instead of a silent multi-minute pause. */
  onCheck?: (e: { index: number; check: string; passed: boolean; durationMs: number }) => void;
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

    // A generated reproduction script is believed ONLY if it is red on the unchanged base. A model
    // asked for a failing test will happily write one that passes everywhere (vacuous) or fails
    // everywhere (broken); the first would credit every candidate, the second none. Screening once
    // against the base is what separates evidence from noise. No base to screen against ⇒ no signal.
    let repro: ReproScript | null = null;
    let reproNote = "";
    if (this.opts.reproScript && this.opts.baseWorkspace) {
      const screen = screenReproScript(this.opts.baseWorkspace, this.opts.reproScript, this.timeoutMs);
      reproNote = screen.reason;
      if (screen.usable) repro = this.opts.reproScript;
    } else if (this.opts.reproScript) {
      reproNote = "reproduction script discarded: no base snapshot to screen it against";
    }

    for (const c of candidates) {
      const receipt: string[] = [];
      let reproduction: Signal = "n/a", regression: Signal = "n/a", smoke: Signal = "n/a";

      if (this.opts.testCommand) {
        const t0 = Date.now();
        const r = runCmd(this.opts.testCommand, c.workspace, this.timeoutMs);
        regression = r.ok ? "pass" : "fail";
        receipt.push(`repo tests: ${regression}`);
        this.opts.onCheck?.({ index: c.index, check: `repo tests (${this.opts.testCommand})`, passed: r.ok, durationMs: Date.now() - t0 });
        if (baseRedFailed) { reproduction = r.ok ? "pass" : "fail"; receipt.push(`red-then-green: ${reproduction} (base was red)`); }
      }

      // The generated reproduction, when it survived the base screen. This is the ONLY red-then-green
      // available on a repo-shaped task whose existing suite already passes on the unfixed code — the
      // case where eligibility otherwise collapses to "did not break anything", which every candidate
      // satisfies including one that changed nothing of consequence.
      if (repro) {
        const t0 = Date.now();
        const r = runReproScript(c.workspace, repro, this.timeoutMs);
        if (r.ran) {
          // It is red on the base by construction, so passing here IS the red-then-green screen. A
          // candidate that leaves it red has not fixed the reported behaviour.
          reproduction = r.passed ? "pass" : "fail";
          receipt.push(`reproduction script: ${reproduction} (red on base)`);
          this.opts.onCheck?.({ index: c.index, check: "reproduction script", passed: r.passed, durationMs: Date.now() - t0 });
        } else {
          receipt.push("reproduction script: n/a (did not run in this candidate's workspace)");
        }
      } else if (reproNote) {
        receipt.push(reproNote);
      }

      if (this.opts.behavioralChecks?.length) {
        let allOk = true;
        const t0 = Date.now();
        for (const cmd of this.opts.behavioralChecks) {
          if (!/[a-z]/i.test(cmd)) continue;
          const r = runCmd(cmd, c.workspace, this.timeoutMs);
          if (!r.ok) { allOk = false; break; }
        }
        smoke = allOk ? "pass" : "fail";
        receipt.push(`behavioral smoke: ${smoke}`);
        this.opts.onCheck?.({ index: c.index, check: "behavioral smoke", passed: allOk, durationMs: Date.now() - t0 });
      }

      // GROUND TRUTH — the prompt's own worked examples (real I/O, not model-generated). The strongest
      // execution signal: fail here ⇒ definitely wrong, whatever consensus votes.
      let groundTruth: Signal = "n/a";
      if (this.opts.workedExamples?.length && this.opts.workedModule) {
        const t0 = Date.now();
        const r = runExampleTest(c.workspace, this.opts.workedModule, this.opts.workedExamples, this.opts.setupVars ?? []);
        if (r.ran) {
          groundTruth = r.failures.length ? "fail" : "pass";
          receipt.push(`worked examples: ${groundTruth}${r.failures.length ? ` (${r.failures.length} fail)` : ""}`);
          this.opts.onCheck?.({ index: c.index, check: "worked examples (ground truth)", passed: !r.failures.length, durationMs: Date.now() - t0 });
        }
      }

      // Eligibility (B1): pass every APPLICABLE signal. If none applied, fall back to the finish gate
      // but flag it weak (Law 1: no non-execution signal may be the SOLE reason a candidate is final).
      const applied = [regression, reproduction, smoke, groundTruth].filter((s) => s !== "n/a");
      const anyApplied = applied.length > 0;
      const executionEligible = anyApplied ? applied.every((s) => s === "pass") : c.finished;
      const weaklyEligible = !anyApplied;
      if (weaklyEligible) receipt.push(`no execution signal available → eligibility from finish gate (${c.finished ? "finished" : "unfinished"})`);

      slate.push({ index: c.index, reproduction, regression, smoke, groundTruth, executionEligible, weaklyEligible, receipt });
    }

    // B2 consensus over the probe, run on every candidate's workspace (eligible or not, so a candidate
    // that fails a thin repo test but agrees with the plurality is still visible for tie-breaking).
    if (this.opts.probe) {
      const outcomes: (ProbeOutcome | null)[] = candidates.map((c) => runFnProbes(c.workspace, this.opts.probe!));

      // B2b — CodeT dual agreement over the same outcomes, at no extra execution cost. Per-probe
      // plurality asks each probe independently and can crown an incoherent candidate: one that
      // matched the majority on probe 1 under one theory of the problem and on probe 3 under a
      // contradictory one. Clustering by whole-behaviour and scoring √(candidates × probes) rewards
      // agreement that holds together. See dualAgreement.ts.
      const dual = dualAgreement(outcomes);
      for (const cluster of dual.clusters) {
        for (const m of cluster.members) {
          if (!slate[m]) continue;
          slate[m].agreementScore = cluster.score;
          slate[m].agreementCluster = cluster.members.length;
          slate[m].receipt.push(`dual agreement ${cluster.score.toFixed(2)} (${cluster.members.length} candidate${cluster.members.length === 1 ? "" : "s"} × ${cluster.cleanProbes} clean probe${cluster.cleanProbes === 1 ? "" : "s"})`);
        }
      }

      // S* disambiguation — only on a GENUINE tie between the two leading behaviours, and only when
      // they actually differ on some probe. One short model call, adjudicating one concrete input:
      // "same input, two answers, which does the spec say?". A tie that cannot be phrased as a
      // question is left to the deterministic ordering rather than paid for.
      if (dual.tied && this.opts.confidence) {
        const d = firstDisagreement(dual);
        const input = d ? this.opts.probe.inputs[d.probeIndex] : undefined;
        if (d && input !== undefined) {
          const verdict = await this.adjudicate(this.opts.task, input, d);
          if (verdict !== "undecided") {
            const winner = verdict === "a" ? d.a.candidate : d.b.candidate;
            const loser = verdict === "a" ? d.b.candidate : d.a.candidate;
            // A nudge, not an override: it breaks the tie the execution signals could not, and it
            // can never promote a candidate that failed a real check.
            if (slate[winner]) { slate[winner].agreementScore = (slate[winner].agreementScore ?? 0) + 1e-3; slate[winner].receipt.push("distinguishing input: judged correct"); }
            if (slate[loser]) slate[loser].receipt.push("distinguishing input: judged incorrect");
          }
        }
      }

      const pick = selectByConsensus(outcomes);
      if (pick) {
        for (let i = 0; i < slate.length; i++) {
          slate[i].consensusRank = pick.scores.map((s, j) => ({ s: s - pick.crashes[j] * 0.5, j })).sort((a, b) => b.s - a.s).findIndex((x) => x.j === i);
          slate[i].consensusCrashes = pick.crashes[i];
          slate[i].receipt.push(`consensus score ${pick.scores[i]} / crashes ${pick.crashes[i]}`);
          // Fold the self-probe into execution eligibility. For a single-function task the probe is
          // usually the ONLY execution evidence: a candidate that CRASHES on its own probe is broken
          // (drop it); one that runs clean carries a real execution receipt, not the "weak" fallback.
          // A candidate whose MODULE never loaded (outcome null) has NO probe signal — crashes[i] stays 0
          // there, so folding it as "pass" would falsely credit un-loadable code with a green probe and
          // mark it strongly execution-eligible. Leave such a candidate's B1 eligibility untouched.
          if (outcomes[i] == null) {
            slate[i].receipt.push("self-probe execution: n/a (module did not load)");
          } else {
            const probe: Signal = pick.crashes[i] > 0 ? "fail" : "pass";
            slate[i].probe = probe;
            const applied = [slate[i].regression, slate[i].reproduction, slate[i].smoke, slate[i].groundTruth ?? "n/a", probe].filter((s) => s !== "n/a");
            slate[i].executionEligible = applied.every((s) => s === "pass");
            slate[i].weaklyEligible = false; // a real execution signal now exists for this candidate
            slate[i].receipt.push(`self-probe execution: ${probe}`);
          }
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

    // P1 — bounded reviewer self-certainty as a TIEBREAKER. It's a full main-model judgment call per
    // candidate, so only pay for it when it can actually change the outcome: ≥2 execution-eligible
    // candidates that ground truth + consensus + ORM left indistinguishable. With those signals now
    // robust, most tasks have a decided winner and skip this entirely (a big latency save on slow local
    // inference). Only the genuinely-tied eligible candidates are scored, not the whole slate.
    if (this.opts.confidence && this.opts.module && this.tieAmongEligible(slate)) {
      for (let i = 0; i < candidates.length; i++) {
        if (!slate[i].executionEligible) continue; // an ineligible candidate can't win — don't score it
        let code = "";
        try { code = readFileSync(join(candidates[i].workspace, this.opts.module), "utf8"); } catch { /* no code */ }
        const sc = candidates[i].selfCertainty ?? (code ? await reviewerConfidence(this.opts.llm, this.opts.task, code) : 0.5);
        slate[i].selfCertainty = sc;
        slate[i].receipt.push(`self-certainty ${sc.toFixed(3)}`);
      }
    }

    return this.fuse(slate);
  }

  /**
   * S* adjudication: put ONE concrete disagreement to the model and read a single-character verdict.
   * Bounded (one short call, small token cap) and failure-tolerant — anything that is not a clean
   * A/B answer is "undecided", which leaves the deterministic ordering in charge. A judge that is
   * allowed to be vague is a judge that decides by coin flip.
   */
  private async adjudicate(spec: string, input: unknown[], d: Disagreement): Promise<"a" | "b" | "undecided"> {
    try {
      const r = await this.opts.llm.chat({
        messages: [{ role: "user", content: renderDisagreement(spec, input, d) }],
        maxTokens: 8, temperature: 0, timeoutMs: 45000,
      });
      return r.ok ? readVerdict(r.content) : "undecided";
    } catch {
      return "undecided";
    }
  }

  /** Do the top execution-eligible candidates tie on (consensus rank, ORM)? Only then does the P1
   *  self-certainty tiebreaker change anything — otherwise it's pure latency. */
  private tieAmongEligible(slate: CandidateSignals[]): boolean {
    const elig = slate.filter((s) => s.executionEligible);
    if (elig.length <= 1) return false;
    const key = (s: CandidateSignals): string => `${s.consensusRank ?? 99}|${s.ormScore ?? -1}`;
    const sorted = [...elig].sort((a, b) => (a.consensusRank ?? 99) - (b.consensusRank ?? 99) || (b.ormScore ?? -1) - (a.ormScore ?? -1));
    return key(sorted[0]) === key(sorted[1]);
  }

  /** B4 fusion: eligible = passed B1; order by (consensus rank, ORM), winner = top. */
  private fuse(slate: CandidateSignals[]): VerifierResult {
    const eligible = slate.filter((s) => s.executionEligible);
    const pool = eligible.length ? eligible : slate;

    // Order: execution consensus first, then ORM, then P1 self-certainty (the owned-engine tiebreaker
    // for the "all candidates agree but are wrong / a thin test can't separate them" case — where
    // consensusRank is tied and there's no ORM, the more DECISIVE generation wins instead of arbitrary
    // index order). Self-certainty is never the sole reason: eligibility (B1 execution) gates the pool.
    const ranked = [...pool].sort((a, b) => {
      // A candidate with a real execution signal always outranks a merely-finished (weak) one — else a
      // weakly-eligible candidate could win on index order alone and be applied over a verified one.
      const we = (a.weaklyEligible ? 1 : 0) - (b.weaklyEligible ? 1 : 0);
      if (we !== 0) return we;
      const cr = (a.consensusRank ?? 99) - (b.consensusRank ?? 99);
      if (cr !== 0) return cr;
      // B2b dual agreement sits directly under per-probe consensus: it reads the SAME executions, so
      // it costs nothing, and it is the signal that separates candidates whose per-probe scores tied.
      const agree = (b.agreementScore ?? -1) - (a.agreementScore ?? -1);
      if (Math.abs(agree) > 1e-9) return agree;
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

    // The receipt must reflect the WINNER's OWN execution evidence — not merely that some OTHER candidate
    // had a signal. A weakly-eligible winner (finish-gate fallback) is honestly NOT a green receipt.
    const winnerHasExecutionReceipt = !!win && win.executionEligible && !win.weaklyEligible;
    return { slate, winner, selector, winnerHasExecutionReceipt };
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
