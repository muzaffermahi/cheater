// Kitten Core — the adaptive lane router. NO Pi.
//
// Given a user message, choose the execution lane and record WHY (Goal §3: the choice must be
// deterministic and inspectable). We reuse the existing, tested, regex-based autopilot classifier
// (src/autopilot/classifier.ts — Pi-free, type-only imports) and the deterministic hardness score
// (src/runtime/computeBudget.ts). Crucially the hardness is derived from cheap DETERMINISTIC evidence
// (task kind, risk, complexity signals, classifier confidence) — never a model-estimated difficulty
// number — so an easy task never pays hard-task best-of-N latency (Goal §3 last bullet).
//
// Policy (Goal §3):
//   • explanation/orientation, no requested change            → answer lane  (no write tools)
//   • ordinary bug fix / feature / test failure               → reliable k=1 (check-first + gates)
//   • hard / risky / ambiguous (high risk, multi-signal,      → ascent  k=2 (coverage + execution
//     from-scratch build, or low-confidence classification)     consensus + repair resampling)
//
// Dynamic escalation from RUN signals (failed verification, candidate disagreement, repeated failure)
// is handled inside the Ascent engine's repair rounds; the router only makes the initial choice.

import type { Lane } from "./events.js";
import { classifyAutopilotTask } from "../autopilot/classifier.js";
import { scoreHardness, type HardnessSignal } from "../runtime/computeBudget.js";
import { EFFORT_PROFILES, type EffortLevel } from "./effort.js";

export interface RouteDecision {
  lane: Lane;
  reasons: string[];
  k: number;
  /** The deterministic hardness score behind the choice (for receipts/telemetry). */
  hardness: number;
  /** The raw signal the score came from, so downstream budgets (ascent) see the same evidence the
   *  router did instead of re-deriving from nothing. */
  signal: HardnessSignal;
}

export interface RouteInput {
  /** Explicit lane override (advanced). When set, the router obeys it and records that. */
  lane?: Lane;
  /** Explicit sample count for bon/ascent. */
  k?: number;
  /** Project root, for the classifier's context (it does not read the filesystem). */
  cwd?: string;
  /** The user's effort level. Bounds, not decisions: "fast" caps auto-routing at reliable;
   *  "think-hard" floors non-trivial changes into ascent; the middle levels clamp k. */
  effort?: EffortLevel;
}

/** Default k per lane. */
function defaultK(lane: Lane, override?: number): number {
  if (override && override > 0) return override;
  return lane === "ascent" ? 2 : lane === "bon" ? 2 : 1;
}

// A large/multi-part build is the case Ascent's decomposition + per-piece verification actually wins on
// (a single-thread run ships a broken piece; Ascent verifies each). Deterministic phrasing proxy; Phase
// B+ can refine with real repo signals (files-in-scope). Ordinary single-file work never matches this.
const LARGE_BUILD = /\bfrom scratch\b|\b(complete|full|entire)\s+(web ?app|app|application|project|system|dashboard|game)\b|\bbackend\b[\s\S]*\bfrontend\b|\bmulti[- ]?file\b/i;

export function routeMessage(text: string, input: RouteInput = {}): RouteDecision {
  if (input.lane) {
    return { lane: input.lane, reasons: [`explicit override → ${input.lane}`], k: defaultK(input.lane, input.k), hardness: 0, signal: {} };
  }

  const c = classifyAutopilotTask({ message: text, cwd: input.cwd ?? process.cwd() });
  const signal: HardnessSignal = { taskKind: c.taskKind, risk: c.risk };
  const hardness = scoreHardness(signal).hardness;

  // Answer-only: an explanation/orientation request gets no write tools.
  if (c.taskKind === "explanation_only") {
    return { lane: "answer", reasons: [c.reason || "explanation/orientation, no requested change → answer-only (no write tools)"], k: 1, hardness: 0, signal: {} };
  }

  // Escalate to Ascent ONLY on real, deterministic evidence of hardness/ambiguity/scale — never merely
  // because the task KIND is labeled "hard" (that would send every ordinary bug fix through best-of-N,
  // paying latency for nothing). The signals that justify coverage + consensus + repair (Goal §3):
  const escalators: string[] = [];
  if (c.risk === "high") escalators.push("high-risk/destructive change");
  // TWO or more complexity signals — one lone generic signal ("test"→tests-expected, "config"→config-
  // change) is not evidence of hardness and would send an ordinary bug fix / test failure through
  // best-of-N for nothing. `>= 2` matches the "high complexity" threshold the classifier and policy use.
  if (c.complexitySignals.length >= 2) escalators.push(`multiple complexity signals: ${c.complexitySignals.join(", ")}`);
  if (c.confidence < 0.5) escalators.push("ambiguous request (low classification confidence)");
  if (LARGE_BUILD.test(text)) escalators.push("large/multi-part build (needs decomposition + per-piece verification)");

  const base = `${c.taskKind} (confidence ${c.confidence.toFixed(2)}, risk ${c.risk})`;
  const profile = input.effort ? EFFORT_PROFILES[input.effort] : null;

  if (escalators.length) {
    // "fast" caps auto-routing below ascent — but the cap is RECORDED, never silent, so the user can
    // see the router wanted more and chose speed on their instruction.
    if (profile?.laneCap && profile.laneCap !== "ascent") {
      return { lane: profile.laneCap, reasons: [base, ...escalators, `fast effort capped the lane at ${profile.laneCap} (router chose ascent)`], k: 1, hardness, signal };
    }
    const k = clampK(Math.max(2, input.k ?? 2), input.k, profile);
    return { lane: "ascent", reasons: [base, ...escalators, `→ Ascent k=${k}`], k, hardness, signal };
  }

  // "think-hard" floors non-explanation changes into ascent even without escalators — the user asked
  // for coverage, and coverage means candidates to select between.
  if (profile?.forceAscent) {
    const k = clampK(Math.max(profile.kFloor, input.k ?? profile.kFloor), input.k, profile);
    return { lane: "ascent", reasons: [base, `think-hard effort → Ascent k=${k} (coverage requested)`], k, hardness, signal };
  }

  // Ordinary change → the reliable lane (check-first, post-edit gates, finish evidence) at k=1.
  return { lane: "reliable", reasons: [base, "→ reliable k=1 (easy tasks don't pay best-of-N latency)"], k: 1, hardness, signal };
}

/** Clamp an ascent k into the effort profile's [floor, cap]; an explicit user k is never raised. */
function clampK(k: number, explicit: number | undefined, profile: { kFloor: number; kCap: number } | null): number {
  if (!profile) return k;
  const floored = explicit && explicit > 0 ? k : Math.max(k, profile.kFloor);
  return Math.min(floored, profile.kCap);
}
