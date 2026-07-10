// Kitten Core — the adaptive lane router. NO Pi.
//
// Given a user message, choose the execution lane and record WHY (Goal §3: the choice must be
// deterministic and inspectable). This Phase-A version is intentionally lean but honest — it already
// separates answer-only from change lanes. Phase B enriches it with the existing autopilot classifier
// (src/autopilot/classifier.ts) + computeBudget hardness so ambiguous/hard tasks escalate to Ascent
// k>=2 from real evidence, not a model-guessed difficulty number.

import type { Lane } from "./events.js";

export interface RouteDecision {
  lane: Lane;
  reasons: string[];
  k: number;
}

export interface RouteInput {
  /** Explicit lane override (advanced). When set, the router obeys it and records that. */
  lane?: Lane;
  /** Explicit sample count for bon/ascent. */
  k?: number;
}

/** Default k per lane. */
function defaultK(lane: Lane, override?: number): number {
  if (override && override > 0) return override;
  return lane === "ascent" ? 2 : lane === "bon" ? 2 : 1;
}

// A message that asks for understanding rather than a change: starts with an interrogative, or is
// clearly explanatory, and contains no imperative "change the code" verb. Deterministic, no model.
const QUESTION_LEAD = /^\s*(what|why|how|when|where|which|who|is|are|does|do|can|could|should|would|explain|describe|tell me|summar|walk me through)\b/i;
const CHANGE_VERB = /\b(add|fix|implement|refactor|rename|create|write|build|change|update|remove|delete|migrate|optimi[sz]e|make|convert|port|wire|patch|test|debug|handle|support|replace)\b/i;

export function routeMessage(text: string, input: RouteInput = {}): RouteDecision {
  if (input.lane) {
    return { lane: input.lane, reasons: [`explicit override → ${input.lane}`], k: defaultK(input.lane, input.k) };
  }
  const t = text.trim();

  // Answer-only: a question/explanation with no requested change gets no write tools (Goal §3).
  const asks = QUESTION_LEAD.test(t) || /\?\s*$/.test(t);
  const changes = CHANGE_VERB.test(t);
  if (asks && !changes) {
    return { lane: "answer", reasons: ["question/explanation with no requested change → answer-only (no write tools)"], k: 1 };
  }

  // Everything else is an ordinary change: the reliable lane (check-first, gates, finish evidence) at
  // k=1. Phase B escalates to Ascent k>=2 on ambiguity/hardness/candidate-disagreement signals.
  return { lane: "reliable", reasons: ["ordinary change → reliable lane (check-first + gates + finish evidence)"], k: 1 };
}
