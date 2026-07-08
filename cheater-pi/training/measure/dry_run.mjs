#!/usr/bin/env node
// Kitten Ascent D — measurement-rig DRY RUN (proves the aggregation end-to-end, no model needed).
//
// Builds synthetic RigSamples for a plausible pass@k→Best@1 story and prints the three deliverables:
//   D1 the pass@1 / pass@k / Best@1 curve (with the verifier gap),
//   D3 the ablation ledger (per-lever marginal Best@1),
//   D2 the held-out transfer line.
// The NUMBERS here are ILLUSTRATIVE synthetic — they only prove the rig produces the right shapes. The
// REAL numbers come from run_curve.mjs against the batteries (see README). Deterministic (no Math.random).

import { curveFromSamples, renderCurve } from "../../dist/src/core/measure.js";
import { computeAblation, renderAblation } from "../../dist/src/core/ablation.js";
import { renderTransfer } from "../../dist/src/core/heldout.js";

function rng(seed) { let x = (seed * 2654435761) % 2 ** 31; return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }

// 40 synthetic tasks, each with a latent per-attempt solve probability (a 35B on hard tasks).
const TASKS = 40;
const KS = [1, 4, 16, 50];
const VERIFIER_QUALITY = 0.82; // P(the verifier picks a solving candidate when one exists)

function buildSamples(quality) {
  const samples = [];
  for (let t = 0; t < TASKS; t++) {
    const r = rng(t + 1);
    const pSolve = 0.06 + 0.22 * r(); // latent difficulty: 6%..28% per attempt (a 35B on HARD tasks)
    for (const k of KS) {
      const rr = rng((t + 1) * 100 + k);
      const candidates = Array.from({ length: k }, (_, i) => ({ index: i + 1, oracleSolved: rr() < pSolve }));
      const solved = candidates.filter((c) => c.oracleSolved);
      // The verifier picks a solving candidate with prob `quality`; otherwise a (likely wrong) one.
      let verifierPick = candidates[0].index;
      if (solved.length && rng((t + 1) * 999 + k)() < quality) verifierPick = solved[Math.floor(rng(t * 7 + k)() * solved.length)].index;
      else if (!solved.length) verifierPick = candidates[0].index;
      else verifierPick = candidates[Math.floor(rng(t * 3 + k)() * candidates.length)].index;
      samples.push({ taskId: `syn-${t}`, k, candidates, verifierPick });
    }
  }
  return samples;
}

console.log("NOTE: numbers below are ILLUSTRATIVE synthetic — proof of the rig's shape, not a capability claim.\n");

const evalSamples = buildSamples(VERIFIER_QUALITY);
console.log(renderCurve(curveFromSamples(evalSamples), "eval set (synthetic)"));
console.log();

// D3 ablation: simulate each lever's removal as a drop in effective coverage/verifier quality.
const best1 = (s) => { const c = curveFromSamples(s); return c[c.length - 1].bestAt1; };
const allOn = best1(evalSamples);
const loo = {
  diversity: best1(buildSamples(VERIFIER_QUALITY).map((s) => ({ ...s, candidates: s.candidates.slice(0, 1) }))), // no diversity → k=1
  orm: best1(buildSamples(0.70)),        // weaker verifier
  experience: best1(buildSamples(0.85)), // slightly weaker priming
  skills: best1(buildSamples(0.86)),
  web: best1(buildSamples(0.875)),
  cascade: best1(buildSamples(0.875))
};
console.log(renderAblation(computeAblation(allOn, loo), allOn));
console.log();

// D2 transfer: held-out Best@1 close to eval Best@1 ⇒ the lift transfers (no leakage).
const heldOut = best1(buildSamples(VERIFIER_QUALITY - 0.03));
console.log(renderTransfer(allOn, heldOut));
