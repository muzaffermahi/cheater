// Kitten Core — the effort dial. One user-facing slider (fast → think hard), one profile object,
// and every compute lever in the engine reads from it instead of a scattered constant.
//
// Design principle: EFFORT SETS BOUNDS, HARDNESS DECIDES. The deterministic router/hardness signals
// still choose the lane and shape per task; the effort level moves the ceilings and floors those
// decisions operate under. An easy task stays fast even on "careful" — it just gets more headroom if
// it starts failing. Only "think-hard" actively forces coverage (ascent, decomposition, web).
//
// Wall-clock honesty (measured on the dev box, ornith-35B on an 8 GB card): one ascent candidate is
// Token budgets still bound runaway multi-candidate work, but there is deliberately NO wall-clock
// ceiling. A local model may spend longer than ten minutes prefilling or reasoning; elapsed time is
// not evidence that the task should be killed.

import type { Lane } from "./events.js";
import type { ComputeCeiling } from "./budget.js";

export type EffortLevel = "fast" | "balanced" | "careful" | "think-hard";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["fast", "balanced", "careful", "think-hard"];

export interface EffortProfile {
  level: EffortLevel;
  /** Cap auto-routing at this lane ("fast" never pays best-of-N latency). Null = no cap. */
  laneCap: Lane | null;
  /** Route non-trivial edit-shaped tasks into ascent even without escalators (think-hard only). */
  forceAscent: boolean;
  /** Ascent sample-count clamp, applied AFTER the hardness budget (the governor still wins downward). */
  kFloor: number;
  kCap: number;
  /** Repair-round bound for ascent (replaces the hardcoded samples<=1?1:2). */
  maxRepairRounds: number;
  /** Agent loop turn cap. */
  maxTurns: number;
  /** llama.cpp reasoning_budget (thinking tokens/turn). undefined = model default (never 0 — 0 disables thinking). */
  reasoningBudget?: number;
  /** Sidecar-tier subagent fan-out for task plans. Main-tier stays serialized at 1 (one GPU). */
  subagentMaxConcurrent: number;
  /** Revive decomposeCompiledTask: split a decomposable contract into a verified subagent DAG. */
  autoDecompose: boolean;
  /** Reliable-lane scout localization width (files sliced into the first message). */
  scoutFiles: number;
  /** Whether the model gets the web_search/web_fetch tools (ANDed with settings.webAccess + agent permission). */
  webEnabled: boolean;
  /** Hard compute ceiling (BudgetGovernor). */
  ceiling: ComputeCeiling;
  /** Fraction of the context window the harness preamble budget may use (fast trims history). */
  contextWindowFraction: number;
}

export const EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
  fast: {
    level: "fast",
    laneCap: "reliable",
    forceAscent: false,
    kFloor: 1, kCap: 1,
    maxRepairRounds: 1,
    maxTurns: 18,
    reasoningBudget: 512,
    subagentMaxConcurrent: 1,
    autoDecompose: false,
    scoutFiles: 2,
    webEnabled: false,
    // Three minutes was a hard stop, not a useful fast target: the observed Fast run spent its
    // opening ten turns on Windows cwd probes and was killed at exactly 180s before its first write.
    // Keep Fast bounded, but give one local generation enough time to recover from a cold/prefill
    // stall and finish a real small build. Balanced remains the next escalation level.
    ceiling: { maxTokens: 60_000 },
    contextWindowFraction: 0.5,
  },
  balanced: {
    level: "balanced",
    laneCap: null,
    forceAscent: false,
    kFloor: 1, kCap: 2,
    maxRepairRounds: 2,
    maxTurns: 40,
    reasoningBudget: 2048,
    subagentMaxConcurrent: 2,
    autoDecompose: false,
    scoutFiles: 4,
    webEnabled: true,
    ceiling: { maxTokens: 250_000 },
    contextWindowFraction: 1,
  },
  careful: {
    level: "careful",
    laneCap: null,
    forceAscent: false,
    kFloor: 2, kCap: 3,
    maxRepairRounds: 3,
    maxTurns: 60,
    reasoningBudget: 8192,
    subagentMaxConcurrent: 2,
    autoDecompose: false,
    scoutFiles: 4,
    webEnabled: true,
    ceiling: { maxTokens: 500_000 },
    contextWindowFraction: 1,
  },
  "think-hard": {
    level: "think-hard",
    laneCap: null,
    forceAscent: true,
    kFloor: 3, kCap: 4,
    maxRepairRounds: 4,
    maxTurns: 80,
    reasoningBudget: undefined, // model default = unlimited thinking; role profiles apply an explicit ceiling when selected
    subagentMaxConcurrent: 3,
    autoDecompose: true,
    scoutFiles: 6,
    webEnabled: true,
    ceiling: { maxTokens: 1_200_000 },
    contextWindowFraction: 1,
  },
};

/** Parse anything a client/store sends into a valid level; unknown values fall to "balanced". */
export function resolveEffort(value: unknown): EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value) ? value as EffortLevel : "balanced";
}

/**
 * Resolve the profile. Wall-clock ceilings are intentionally ignored: Kitten must not terminate a
 * user session because a local model crossed an elapsed-time threshold.
 */
export function effortProfile(value: unknown, env: NodeJS.ProcessEnv = process.env): EffortProfile {
  const base = EFFORT_PROFILES[resolveEffort(value)];
  void env;
  return base;
}

/** One-line human description per level (surfaced as a hint next to the control). */
export const EFFORT_HINTS: Record<EffortLevel, string> = {
  fast: "single pass, light verification — quickest",
  balanced: "standard routing and verification",
  careful: "more candidates and repair rounds, deeper verification",
  "think-hard": "multiple candidates, subagent decomposition, web search — up to ~45 min",
};
