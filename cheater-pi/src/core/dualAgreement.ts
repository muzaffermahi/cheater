// Selection when there is no oracle: CodeT-style dual agreement, and S*-style disambiguation.
//
// The 30B-class literature is unanimous that SELECTION, not coverage, is what moves the number.
// R2E-Gym goes 34.4 → 51 and DeepSWE 42.2 → 59 on the same samples purely by choosing better among
// them; SWE-Gym measures the size of the prize directly (Best@16 = 32.0 against an oracle's 42.8 —
// ten points already inside the candidates you paid for). Kitten generates k candidates and probes
// them; what it lacked was a way to reason about them JOINTLY.
//
// **Dual agreement (CodeT, arXiv 2207.10397).** Existing per-probe plurality asks, for each probe
// independently, "who matched the majority?" and sums the answers. A candidate can win that while
// being incoherent — matching the plurality on probe 1 with one theory of the problem and on probe 3
// with a contradictory one, agreeing with nobody in particular overall. CodeT instead looks for
// CONSENSUS SETS: a group of candidates that behave identically across a set of probes. A set is
// scored by both of its dimensions — how many candidates agree (|Sx|) and how much they agree about
// (|Sy|) — because either alone is gameable. Two candidates agreeing on twelve probes is far stronger
// evidence than six agreeing on one.
//
// **Disambiguation (S*, arXiv 2502.14382).** When the two best clusters are genuinely tied, they by
// definition disagree somewhere, and that disagreement is a QUESTION: on this input, one of these
// answers is wrong. S* synthesizes exactly such a distinguishing input and adjudicates it — the step
// that let a 3B beat GPT-4o-mini on LiveCodeBench. Kitten already has the probe outputs, so the
// distinguishing input does not need synthesizing: it is already sitting in the outcome vectors. All
// that is missing is the adjudication, which is one short model call on a genuine tie and nothing at
// all otherwise.
//
// Both functions here are pure and deterministic given their inputs; the model call lives in the
// caller so this module stays testable offline.

import type { ProbeOutcome, ProbeResult } from "./synthtest.js";

/** Canonical key for a probe outcome: a returned value, or the exception type it raised.
 *  Raising is a legitimate behaviour candidates can agree on, so it keys like any other outcome. */
export function outcomeKey(res: ProbeResult | undefined): string | null {
  if (!res) return null;
  if (!res.ok) return `e:${res.err}`;
  const v = res.val;
  return `v:${typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : JSON.stringify(v)}`;
}

export interface ConsensusCluster {
  /** Candidate indices (0-based, into the outcomes array) that behave identically. */
  members: number[];
  /** The behaviour they share, probe by probe. */
  signature: string[];
  /** How many probes this cluster actually answered (a probe nobody could run says nothing). */
  answeredProbes: number;
  /** How many of those the cluster answered WITHOUT crashing. */
  cleanProbes: number;
  /** √(|members| × cleanProbes) — CodeT's dual score. Breadth and depth, neither alone. */
  score: number;
}

export interface DualAgreementResult {
  clusters: ConsensusCluster[];
  /** The winning candidate index (0-based), or null when nothing could be distinguished. */
  winner: number | null;
  /** True when at least two clusters exist — i.e. the probes actually separated the candidates. */
  discriminating: boolean;
  /** True when the top two clusters score equally: a real tie, and the case S* is for. */
  tied: boolean;
}

/**
 * Group candidates by identical probe behaviour and score each group by CodeT's dual criterion.
 *
 * Returns `winner: null` when fewer than two candidates produced any usable outcome — with one
 * opinion there is no agreement to measure, and inventing one would be worse than abstaining.
 */
export function dualAgreement(outcomes: (ProbeOutcome | null)[]): DualAgreementResult {
  const usable = outcomes.map((o, i) => ({ o, i })).filter((x) => x.o && x.o.results.length);
  if (usable.length < 2) return { clusters: [], winner: null, discriminating: false, tied: false };

  const nProbes = Math.max(...usable.map((x) => x.o!.results.length));
  const bySignature = new Map<string, ConsensusCluster>();

  for (const { o, i } of usable) {
    const signature: string[] = [];
    let answered = 0, clean = 0;
    for (let j = 0; j < nProbes; j++) {
      const key = outcomeKey(o!.results[j]);
      signature.push(key ?? "-");
      if (key !== null) {
        answered++;
        if (key.startsWith("v:")) clean++;
      }
    }
    const id = signature.join("|");
    const existing = bySignature.get(id);
    if (existing) existing.members.push(i);
    else bySignature.set(id, { members: [i], signature, answeredProbes: answered, cleanProbes: clean, score: 0 });
  }

  const clusters = [...bySignature.values()];
  for (const c of clusters) {
    // Breadth × depth, square-rooted so neither dimension can run away with it: six candidates
    // agreeing on one probe (√6 ≈ 2.4) must not beat two agreeing on twelve (√24 ≈ 4.9).
    c.score = Math.sqrt(c.members.length * Math.max(c.cleanProbes, 0));
  }
  clusters.sort((a, b) =>
    b.score - a.score
    || b.members.length - a.members.length
    || b.cleanProbes - a.cleanProbes
    // Deterministic last resort: the earliest candidate, which is the lowest-temperature attempt.
    || Math.min(...a.members) - Math.min(...b.members));

  const top = clusters[0];
  const tied = clusters.length > 1 && Math.abs(clusters[0].score - clusters[1].score) < 1e-9;
  return {
    clusters,
    // Within the winning cluster every member behaves identically, so the earliest (lowest
    // temperature, most conservative) attempt is the honest representative.
    winner: top ? Math.min(...top.members) : null,
    discriminating: clusters.length > 1,
    tied,
  };
}

export interface Disagreement {
  /** Index of the probe on which the two clusters differ. */
  probeIndex: number;
  /** The two candidate indices to adjudicate between (0-based), and what each produced. */
  a: { candidate: number; outcome: string };
  b: { candidate: number; outcome: string };
}

/**
 * The first probe on which the two top clusters disagree — the question worth asking a model.
 *
 * Returns null when they never disagree on a probe both answered, which happens when the tie is
 * about coverage rather than behaviour; there is nothing to adjudicate and the caller should keep
 * its deterministic ordering rather than pay for a model call that cannot decide anything.
 */
export function firstDisagreement(result: DualAgreementResult): Disagreement | null {
  if (result.clusters.length < 2) return null;
  const [x, y] = result.clusters;
  const n = Math.min(x.signature.length, y.signature.length);
  for (let j = 0; j < n; j++) {
    const a = x.signature[j], b = y.signature[j];
    if (a === "-" || b === "-" || a === b) continue;
    return {
      probeIndex: j,
      a: { candidate: Math.min(...x.members), outcome: a },
      b: { candidate: Math.min(...y.members), outcome: b },
    };
  }
  return null;
}

/** Render a disagreement as the question to put to a model: same input, two answers, which is right? */
export function renderDisagreement(spec: string, probeInput: unknown[], d: Disagreement): string {
  const show = (key: string): string => key.startsWith("e:") ? `raised ${key.slice(2)}` : `returned ${key.slice(2)}`;
  return [
    `Specification:\n"""${spec.slice(0, 1200)}"""`,
    ``,
    `Two implementations disagree on the input ${JSON.stringify(probeInput)}:`,
    `  A ${show(d.a.outcome)}`,
    `  B ${show(d.b.outcome)}`,
    ``,
    `Which is correct according to the specification? Answer with exactly one character: A or B. If the specification does not determine the answer, reply U.`,
  ].join("\n");
}

/** Read the adjudication back. Anything that is not a clean A/B verdict is "undecided", never a guess. */
export function readVerdict(reply: string): "a" | "b" | "undecided" {
  const m = /\b([AB])\b/.exec((reply ?? "").trim().slice(0, 200));
  if (!m) return "undecided";
  // A reply that names both is not a verdict.
  const text = reply.slice(0, 200);
  if (/\bA\b/.test(text) && /\bB\b/.test(text)) return "undecided";
  return m[1] === "A" ? "a" : "b";
}
