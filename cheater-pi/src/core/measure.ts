// Kitten Ascent D1 — the measurement rig. The whole plan is a pass@k→pass@1 machine, so the whole
// proof is three curves per task set:
//   - pass@1  : the raw model's first-try solve rate (the floor).
//   - pass@k  : ANY of k diverse attempts solves — the ORACLE ceiling (coverage, Part A).
//   - Best@1  : the VERIFIER's single pick solves — what we actually ship (selection, Part B).
// The Best@1→pass@k GAP is the verifier's report card: SWE-Gym leaves 10.8 points in that gap, and
// shrinking it phase over phase is the core progress metric. Every number is oracle-grounded (a real
// test in a clean env), never self-report — so the benchmark number and the user-value number are one.
//
// This module is the pure aggregator (fully tested) plus a thin driver that runs a task set through
// runAscent at increasing N, oracle-scores EVERY candidate via the onVerified hook, and builds the
// curves. The oracle is injected (the hidden acceptance smoke), so the rig never sees it during a run.

export interface CandidateOutcome { index: number; oracleSolved: boolean; }

export interface RigSample {
  taskId: string;
  k: number;
  /** Oracle result for each generated candidate (the ground truth, hidden from the in-run verifier). */
  candidates: CandidateOutcome[];
  /** The index the verifier selected as final (Best@1), or null if it selected nothing. */
  verifierPick: number | null;
}

/** Did the deterministic baseline (candidate 1) solve? (pass@1) */
export function passAt1(sample: RigSample): boolean {
  const c = sample.candidates.find((c) => c.index === 1) ?? sample.candidates[0];
  return !!c?.oracleSolved;
}

/** Did ANY candidate solve? (pass@k — the oracle ceiling) */
export function passAtK(sample: RigSample): boolean {
  return sample.candidates.some((c) => c.oracleSolved);
}

/** Did the verifier's pick solve? (Best@1 — what we ship) */
export function bestAt1(sample: RigSample): boolean {
  if (sample.verifierPick === null) return false;
  return !!sample.candidates.find((c) => c.index === sample.verifierPick)?.oracleSolved;
}

export interface CurvePoint {
  k: number;
  tasks: number;
  passAt1: number;
  passAtK: number;
  bestAt1: number;
  /** pass@k − Best@1: the verifier's report card. Smaller is better. */
  gap: number;
  /** Best@1 − pass@1: how much the whole machine adds over the raw first try. */
  liftOverPass1: number;
}

/** Build the pass@1 / pass@k / Best@1 curve, grouped by k. */
export function curveFromSamples(samples: RigSample[]): CurvePoint[] {
  const byK = new Map<number, RigSample[]>();
  for (const s of samples) { const arr = byK.get(s.k) ?? []; arr.push(s); byK.set(s.k, arr); }
  const points: CurvePoint[] = [];
  for (const k of [...byK.keys()].sort((a, b) => a - b)) {
    const group = byK.get(k)!;
    const n = group.length || 1;
    const p1 = group.filter(passAt1).length / n;
    const pk = group.filter(passAtK).length / n;
    const b1 = group.filter(bestAt1).length / n;
    points.push({ k, tasks: group.length, passAt1: p1, passAtK: pk, bestAt1: b1, gap: pk - b1, liftOverPass1: b1 - p1 });
  }
  return points;
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

/** Render the curve as an aligned table. */
export function renderCurve(points: CurvePoint[], title = "measurement"): string {
  const lines = [
    `── ${title} — pass@k → Best@1 ${"─".repeat(Math.max(0, 34 - title.length))}`,
    `  k  tasks  pass@1   pass@k   Best@1    gap(verifier)  lift(Best@1-pass@1)`
  ];
  for (const p of points) {
    lines.push(
      `${String(p.k).padStart(3)}  ${String(p.tasks).padStart(5)}  ${pct(p.passAt1).padStart(6)}  ${pct(p.passAtK).padStart(6)}  ${pct(p.bestAt1).padStart(6)}   ${pct(p.gap).padStart(7)}        ${(p.liftOverPass1 >= 0 ? "+" : "") + pct(p.liftOverPass1)}`
    );
  }
  lines.push("─".repeat(58));
  return lines.join("\n");
}

// ── Rig driver (needs a model + oracles; the batteries are the user's post-session validation) ──────

export type Oracle = (taskId: string, workspace: string) => boolean | Promise<boolean>;

export interface MeasureTask {
  taskId: string;
  task: string;
  /** A factory that returns a FRESH workspace path for a run (so each k-run starts clean). */
  freshWorkspace: () => string;
}

export interface MeasureDriverOpts {
  ks: number[];                 // e.g. [1, 4, 16, 50]
  oracle: Oracle;
  /** runAscent-compatible runner (injected so this module doesn't hard-import the whole machine in tests). */
  runAscent: (params: any, config: any) => Promise<any>;
  config: any;                  // AscentConfig
  onSample?: (s: RigSample) => void;
}

/**
 * Drive a task set through the machine at each k and collect RigSamples. Oracle-scores every candidate
 * via the onVerified hook. Returns the raw samples; pass them to curveFromSamples for the curves.
 */
export async function runMeasurement(tasks: MeasureTask[], opts: MeasureDriverOpts): Promise<RigSample[]> {
  const samples: RigSample[] = [];
  for (const t of tasks) {
    for (const k of opts.ks) {
      const cwd = t.freshWorkspace();
      let candidates: CandidateOutcome[] = [];
      const config = {
        ...opts.config,
        onVerified: async (ctx: { attempts: Array<{ index: number; workspace: string }>; verdict: { winner: number | null } }) => {
          const scored: CandidateOutcome[] = [];
          for (const a of ctx.attempts) scored.push({ index: a.index, oracleSolved: !!(await opts.oracle(t.taskId, a.workspace)) });
          candidates = scored;
        }
      };
      const res = await opts.runAscent({ task: t.task, cwd, taskId: t.taskId, forceSamples: k }, config);
      const sample: RigSample = { taskId: t.taskId, k, candidates, verifierPick: res.winner ?? null };
      samples.push(sample);
      opts.onSample?.(sample);
    }
  }
  return samples;
}
