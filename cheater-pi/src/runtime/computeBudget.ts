// Adaptive test-time-compute allocation (roadmap P5).
//
// The research-#1 "adaptive engagement" lever: forced test-time compute buys ~+9pts on HARD tasks
// but only ~+2.2 on EASY ones, and always-on best-of-N is >4x less compute-efficient than spending
// per-task-difficulty. So instead of a single static `commitletCandidateSamples` for every commitlet,
// this module scores a commitlet's hardness from cheaply-known signals and returns a budget: how many
// best-of-N samples (k), how many self-debug rounds, how deep to localize, and whether to consult
// skill memory. Easy commitlets get k=1 / no extra rounds (near-vanilla speed - also the fix for the
// measured ~2x easy-task overhead); hard commitlets get the full budget, bounded so a hard commitlet
// still fits the ~15-min wall-clock target at ~25 tok/s.
//
// When `adaptiveComputeEnabled` is OFF (the default), computeBudget returns the STATIC budget
// (samples = commitletCandidateSamples, one debug lane), byte-identical to today's behavior.

/**
 * The five knobs computeBudget actually reads. A lean structural type instead of the 261-field legacy
 * CheaterConfig, so Kitten Core can call this without dragging the dead Pi-era config along — every
 * existing CheaterConfig caller remains structurally assignable.
 */
export interface ComputeBudgetOptions {
  adaptiveComputeEnabled?: boolean;
  commitletCandidateSamples?: number;
  inSessionResampleEnabled?: boolean;
  adaptiveMaxSamples?: number;
  adaptiveMaxDebugRounds?: number;
}

/** The test-time-compute budget for one commitlet. */
export interface ComputeBudget {
  /** best-of-N sample count (k). */
  samples: number;
  /** max bounded-repair / self-debug rounds after the samples. */
  maxDebugRounds: number;
  /** how aggressively to localize + slice context. */
  localizationDepth: "shallow" | "deep";
  /** hardness score and a human-readable reason, for receipts/telemetry. */
  hardness: number;
  reason: string;
}

/**
 * The per-commitlet signal the budget derives from. All fields optional so a caller supplies only
 * what it cheaply knows; missing fields are treated as neutral/unknown.
 */
export interface HardnessSignal {
  /** autopilot decision.taskKind (e.g. "bug_fix", "feature_addition", "trivial"). */
  taskKind?: string;
  /** autopilot decision.risk ("low" | "medium" | "high"). */
  risk?: string;
  /** number of files the commitlet may touch (impact-size proxy). */
  filesInScope?: number;
  /** the commitlet is a bounded-repair commitlet (it already failed once). */
  isRepair?: boolean;
  /** a first cheap attempt already passed verification -> definitively easy, stop spending. */
  firstSampleVerified?: boolean;
  /** how many times this commitlet has already failed verification this run. */
  priorFailures?: number;
}

const HARD_TASK_KINDS = new Set(["bug_fix", "bugfix", "feature_addition", "feature", "refactor", "debug", "careful_repro"]);
const TRIVIAL_TASK_KINDS = new Set(["trivial", "answer_only", "doc", "docs", "config", "chore"]);

/** Score a commitlet's hardness from its signal. Higher = spend more test-time compute. */
export function scoreHardness(signal: HardnessSignal): { hardness: number; factors: string[] } {
  let hardness = 0;
  const factors: string[] = [];
  const kind = (signal.taskKind ?? "").toLowerCase();
  if (HARD_TASK_KINDS.has(kind)) { hardness += 2; factors.push(`kind=${kind}`); }
  else if (TRIVIAL_TASK_KINDS.has(kind)) { hardness -= 1; factors.push(`kind=${kind}`); }
  const risk = (signal.risk ?? "").toLowerCase();
  if (risk === "high") { hardness += 2; factors.push("risk=high"); }
  else if (risk === "medium") { hardness += 1; factors.push("risk=medium"); }
  const files = signal.filesInScope ?? 1;
  if (files >= 3) { hardness += 2; factors.push(`files=${files}`); }
  else if (files === 2) { hardness += 1; factors.push("files=2"); }
  if (signal.isRepair) { hardness += 2; factors.push("repair"); }
  const priorFails = signal.priorFailures ?? 0;
  if (priorFails > 0) { hardness += Math.min(3, priorFails); factors.push(`priorFailures=${priorFails}`); }
  return { hardness, factors };
}

/**
 * Compute the test-time-compute budget for a commitlet. OFF path (default) = today's static budget.
 */
export function computeBudget(signal: HardnessSignal, config: ComputeBudgetOptions = {}): ComputeBudget {
  // Enabling in-session best-of-N must not be a silent no-op: with no explicit sample count (and
  // adaptive compute off), turning ON inSessionResampleEnabled defaults to 3 samples so best-of-N
  // actually runs. An explicit commitletCandidateSamples always wins. (The coupling where you had to
  // set BOTH inSessionResampleEnabled and adaptiveComputeEnabled to get any resampling was a papercut.)
  const staticSamples = Math.max(1, Math.trunc(config.commitletCandidateSamples ?? (config.inSessionResampleEnabled === true ? 3 : 1)));
  if (config.adaptiveComputeEnabled !== true) {
    return { samples: staticSamples, maxDebugRounds: 1, localizationDepth: "shallow", hardness: 0, reason: "adaptive compute off (static budget)" };
  }
  const maxSamples = Math.max(1, Math.trunc(config.adaptiveMaxSamples ?? 8));
  const maxDebug = Math.max(0, Math.trunc(config.adaptiveMaxDebugRounds ?? 2));

  // A first cheap attempt that already verified means this commitlet is definitively easy - never
  // spend more compute on it, whatever the static hardness signals say.
  if (signal.firstSampleVerified) {
    return { samples: 1, maxDebugRounds: 0, localizationDepth: "shallow", hardness: 0, reason: "first sample verified - no extra compute" };
  }

  const { hardness, factors } = scoreHardness(signal);
  // Map hardness -> samples in [1, maxSamples]: each point buys ~1.5 samples, so a moderately hard
  // commitlet (~3) lands near k=6, a very hard one saturates at maxSamples, a trivial one at k=1.
  const samples = Math.max(1, Math.min(maxSamples, 1 + Math.round(hardness * 1.5)));
  const localizationDepth: "shallow" | "deep" = hardness >= 3 ? "deep" : "shallow";
  const maxDebugRounds = hardness >= 2 ? maxDebug : Math.min(1, maxDebug);
  return {
    samples,
    maxDebugRounds,
    localizationDepth,
    hardness,
    reason: `hardness ${hardness}${factors.length ? ` (${factors.join(", ")})` : ""} -> k=${samples}, debug=${maxDebugRounds}, ${localizationDepth}`
  };
}
