// Kitten Ascent A1 — the coverage engine. Don't ask one kitten to try harder; loose twenty kittens
// down twenty different alleys.
//
// pass@k rises with VARIANCE, not just sample count (Large Language Monkeys: repeated sampling lifts a
// weak model's coverage the most). A batch of N temperature re-rolls of the SAME trajectory is low
// variance — the model tends to make the same wrong decision at every temperature. Real coverage comes
// from sampling the CROSS-PRODUCT of orthogonal axes, so each attempt starts from a genuinely different
// stance/plan/localization:
//   - temperature: a low-discrepancy sweep (van der Corput) so any N is maximally spread, not clustered.
//   - stance: minimal-fix vs root-cause vs clean-rewrite — three different mental models of the bug.
//   - plan-vs-direct: plan-first suits a multi-step task, a straight edit suits a one-liner; try both.
//   - localization: rotate WHICH candidate files lead. A wrong-file attempt is a DIFFERENT attempt, not
//     a wasted one — and the right file is sometimes the second guess.
//   - decomposition (multi-file): different brick-cut orders, folded into the directive.
//
// Attempt 1 is always the deterministic baseline (temp 0, neutral) so easy tasks keep the fast path and
// zero overhead. Attempts 2..N spread. Between ROUNDS, the best failure seeds the next batch as a repair
// directive (repair-resampling compounds coverage: SWE-Gym's gains are per-trajectory, ours stack rounds).
//
// Pure and deterministic: given (n, ctx) the plans are fixed, so a run is reproducible and testable.

export type Stance = "baseline" | "minimal" | "root-cause" | "rewrite";

export interface AttemptPlan {
  /** 1-based attempt index within its round. */
  index: number;
  temperature: number;
  stance: Stance;
  planFirst: boolean;
  /** Which localization variant (0 = scout's default order; k = rotate the candidate list by k). */
  localizationRotation: number;
  /** The rendered system-prompt addendum for this attempt (stance + plan + repair grounding). */
  directive: string;
  /** Compact label for receipts, e.g. "t0.73/root-cause/plan/loc0". */
  label: string;
}

export interface DiversityContext {
  /** The task is known to span multiple files (enables the decomposition axis). */
  multiFile?: boolean;
  /** Number of distinct localization candidate sets scout produced (caps localizationRotation). */
  localizationVariants?: number;
  /** A repair directive from the previous round's best failure (round ≥ 2). */
  repairSeed?: string;
}

const STANCE_TEXT: Record<Stance, string> = {
  baseline: "",
  minimal: "Approach: make the SMALLEST change that satisfies the task. Do not refactor or rewrite surrounding code; touch as few lines as possible.",
  "root-cause": "Approach: fix the underlying ROOT CAUSE, not the surface symptom. Trace the failure to where it actually originates before you edit.",
  rewrite: "Approach: if the existing code is tangled, REWRITE the relevant unit cleanly from a correct mental model rather than patching around it."
};

const DECOMPOSITION_HINTS = [
  "If this spans multiple files, implement the core data/logic layer first, then wire the interface to it.",
  "If this spans multiple files, define the interface/contract first, then fill in the implementation behind it.",
  "If this spans multiple files, get one end-to-end slice working (thinnest vertical path) before broadening."
];

/** van der Corput low-discrepancy sequence in base 2: maximally-spread fractions in (0,1). */
export function vanDerCorput(n: number, base = 2): number {
  let q = 0, bk = 1 / base, i = n;
  while (i > 0) { q += (i % base) * bk; i = Math.floor(i / base); bk /= base; }
  return q;
}

/** Temperature for attempt i within a round: attempt 1 deterministic, the rest spread over [0.35,1.1]. */
export function attemptTemperature(i: number): number {
  if (i <= 1) return 0;
  const t = 0.35 + 0.75 * vanDerCorput(i - 1);
  return Math.round(Math.min(1.1, t) * 100) / 100;
}

const STANCE_CYCLE: Stance[] = ["minimal", "root-cause", "rewrite"];

/**
 * Produce `n` diverse attempt plans for one round. Attempt 1 is the deterministic baseline; attempts
 * 2..n sample the stance × plan × localization cross-product with a spread temperature. When a repair
 * seed is present (round ≥ 2) it is injected into every plan's directive so the whole batch learns from
 * the previous round's best failure.
 */
export function planAttempts(n: number, ctx: DiversityContext = {}): AttemptPlan[] {
  const plans: AttemptPlan[] = [];
  const locVariants = Math.max(1, ctx.localizationVariants ?? 1);
  for (let i = 1; i <= n; i++) {
    const isBaseline = i === 1 && !ctx.repairSeed; // a repair round has no "free" baseline — spend every sample
    const stance: Stance = isBaseline ? "baseline" : STANCE_CYCLE[(i - 2 + n) % STANCE_CYCLE.length];
    const planFirst = isBaseline ? false : Math.floor((i - 2) / STANCE_CYCLE.length) % 2 === 1;
    const localizationRotation = locVariants > 1 ? Math.floor((i - 1) / (STANCE_CYCLE.length * 2)) % locVariants : 0;
    const temperature = attemptTemperature(i);

    const parts: string[] = [];
    if (STANCE_TEXT[stance]) parts.push(STANCE_TEXT[stance]);
    if (planFirst) parts.push("Sketch a 2-3 step plan (in your reasoning) before implementing.");
    else if (!isBaseline) parts.push("This may be small — edit directly; don't over-plan.");
    if (ctx.multiFile && !isBaseline) parts.push(DECOMPOSITION_HINTS[(i - 2 + DECOMPOSITION_HINTS.length) % DECOMPOSITION_HINTS.length]);
    if (ctx.repairSeed) parts.push(ctx.repairSeed);

    plans.push({
      index: i,
      temperature,
      stance,
      planFirst,
      localizationRotation,
      directive: parts.join("\n"),
      label: `t${temperature}/${stance}${planFirst ? "/plan" : ""}${localizationRotation ? `/loc${localizationRotation}` : ""}`
    });
  }
  return plans;
}

/** Rotate a localization candidate list by k so a different file leads (the localization axis). */
export function rotateLocalization<T>(files: T[], rotation: number): T[] {
  if (!files.length || rotation <= 0) return files;
  const k = rotation % files.length;
  return [...files.slice(k), ...files.slice(0, k)];
}

/**
 * Build a repair directive from the best failure of a round: inject the tight failure grounding and
 * steer the next batch AWAY from the approach that just failed, so round N+1 explores new ground rather
 * than re-rolling the same dead end.
 */
export function repairDirective(failureGrounding: string, failedStance?: Stance): string {
  const alt = failedStance && failedStance !== "baseline"
    ? ` The previous best attempt used the ${failedStance} approach and still failed — try a genuinely different angle.`
    : "";
  const g = (failureGrounding || "").trim().slice(0, 800);
  return `A previous attempt got closest but did not pass.${alt}\nWhat went wrong last time (fix exactly this, don't repeat it):\n${g}`;
}

/** How many rounds to run for a hardness/budget: 1 for easy, up to `maxRounds` for hard. Bounded. */
export function roundsForBudget(samples: number, maxRounds = 3): number {
  if (samples <= 1) return 1;
  if (samples <= 4) return Math.min(2, maxRounds);
  return maxRounds;
}
