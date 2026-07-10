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
import { scoreHardness } from "../runtime/computeBudget.js";

export interface RouteDecision {
  lane: Lane;
  reasons: string[];
  k: number;
  /** The deterministic hardness score behind the choice (for receipts/telemetry). */
  hardness: number;
}

export interface RouteInput {
  /** Explicit lane override (advanced). When set, the router obeys it and records that. */
  lane?: Lane;
  /** Explicit sample count for bon/ascent. */
  k?: number;
  /** Project root, for the classifier's context (it does not read the filesystem). */
  cwd?: string;
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
    return { lane: input.lane, reasons: [`explicit override → ${input.lane}`], k: defaultK(input.lane, input.k), hardness: 0 };
  }

  const c = classifyAutopilotTask({ message: text, cwd: input.cwd ?? process.cwd() });
  const hardness = scoreHardness({ taskKind: c.taskKind, risk: c.risk }).hardness;

  // Answer-only: an explanation/orientation request gets no write tools.
  if (c.taskKind === "explanation_only") {
    return { lane: "answer", reasons: [c.reason || "explanation/orientation, no requested change → answer-only (no write tools)"], k: 1, hardness: 0 };
  }

  // Escalate to Ascent ONLY on real, deterministic evidence of hardness/ambiguity/scale — never merely
  // because the task KIND is labeled "hard" (that would send every ordinary bug fix through best-of-N,
  // paying latency for nothing). The signals that justify coverage + consensus + repair (Goal §3):
  const escalators: string[] = [];
  if (c.risk === "high") escalators.push("high-risk/destructive change");
  if (c.complexitySignals.length) escalators.push(`complexity: ${c.complexitySignals.join(", ")}`);
  if (c.confidence < 0.5) escalators.push("ambiguous request (low classification confidence)");
  if (LARGE_BUILD.test(text)) escalators.push("large/multi-part build (needs decomposition + per-piece verification)");

  const base = `${c.taskKind} (confidence ${c.confidence.toFixed(2)}, risk ${c.risk})`;
  if (escalators.length) {
    const k = Math.max(2, input.k ?? 2);
    return { lane: "ascent", reasons: [base, ...escalators, `→ Ascent k=${k}`], k, hardness };
  }

  // Ordinary change → the reliable lane (check-first, post-edit gates, finish evidence) at k=1.
  return { lane: "reliable", reasons: [base, "→ reliable k=1 (easy tasks don't pay best-of-N latency)"], k: 1, hardness };
}
