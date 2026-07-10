// Kitten Ascent D3 — the ablation ledger. Per lever (A1 diversity, A2 web, A3 experience, A4 skills,
// B3 ORM, C1 cascade), record its MARGINAL contribution to Best@1 on the held-out set (leave-one-out:
// all-on minus this-lever-off). This tells the user which mechanisms are real and which to cut — the
// shareable scorecard. A lever whose held-out marginal is ~0 or negative is not earning its keep.
//
// Pure aggregation + render here; the driver runs the machine all-on and once-per-lever-off via the D1
// measurement rig on the held-out set.

import type { AscentLevers } from "./ascent.js";
import { curveFromSamples, type RigSample } from "./measure.js";

export type AblatableLever = keyof AscentLevers;

export const ABLATABLE_LEVERS: AblatableLever[] = ["diversity", "web", "experience", "skills", "orm", "cascade", "cloudBurst"];

export interface AblationRow {
  lever: AblatableLever;
  allOnBest1: number;
  leaveOneOutBest1: number;
  /** allOn − leaveOneOut: positive ⇒ the lever helps; ~0/negative ⇒ it isn't earning its keep. */
  marginal: number;
}

/** Best@1 at the largest k in a sample set (the fullest coverage the curve saw). */
export function best1AtMaxK(samples: RigSample[]): number {
  const curve = curveFromSamples(samples);
  if (!curve.length) return 0;
  return curve[curve.length - 1].bestAt1;
}

/** Build the ledger: marginal = all-on Best@1 minus leave-one-out Best@1, per lever. */
export function computeAblation(allOnBest1: number, leaveOneOut: Partial<Record<AblatableLever, number>>): AblationRow[] {
  const rows: AblationRow[] = [];
  for (const lever of ABLATABLE_LEVERS) {
    if (!(lever in leaveOneOut)) continue;
    const loo = leaveOneOut[lever]!;
    rows.push({ lever, allOnBest1, leaveOneOutBest1: loo, marginal: allOnBest1 - loo });
  }
  return rows.sort((a, b) => b.marginal - a.marginal);
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

export function renderAblation(rows: AblationRow[], allOnBest1: number): string {
  const lines = [
    "── Ablation ledger — held-out Best@1, leave-one-out ──────",
    `  all levers ON: Best@1 = ${pct(allOnBest1)}`,
    "  lever         off→Best@1    marginal",
  ];
  for (const r of rows) {
    const sign = r.marginal > 0.0005 ? "+" : r.marginal < -0.0005 ? "" : "±";
    lines.push(`  ${r.lever.padEnd(12)}  ${pct(r.leaveOneOutBest1).padStart(7)}      ${sign}${pct(r.marginal)}${r.marginal <= 0.0005 ? "   (not earning its keep — consider cutting)" : ""}`);
  }
  lines.push("─".repeat(58));
  return lines.join("\n");
}

export interface AblationDriverOpts {
  /** The D1 measurement runner: given levers, returns the RigSamples on the HELD-OUT set. */
  measure: (levers: AscentLevers) => Promise<RigSample[]>;
  allLevers: AscentLevers;
  levers?: AblatableLever[];
}

/** Run the leave-one-out ablation on the held-out set and build the ledger. */
export async function runAblation(opts: AblationDriverOpts): Promise<{ rows: AblationRow[]; allOnBest1: number }> {
  const allOnSamples = await opts.measure(opts.allLevers);
  const allOnBest1 = best1AtMaxK(allOnSamples);
  const leaveOneOut: Partial<Record<AblatableLever, number>> = {};
  for (const lever of opts.levers ?? ABLATABLE_LEVERS) {
    if (!opts.allLevers[lever]) continue; // can't ablate a lever that's already off
    const samples = await opts.measure({ ...opts.allLevers, [lever]: false });
    leaveOneOut[lever] = best1AtMaxK(samples);
  }
  return { rows: computeAblation(allOnBest1, leaveOneOut), allOnBest1 };
}
