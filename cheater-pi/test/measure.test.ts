import test from "node:test";
import assert from "node:assert/strict";
import {
  passAt1, passAtK, bestAt1, curveFromSamples, renderCurve, runMeasurement,
  type RigSample, type MeasureTask
} from "../src/core/measure.js";

const sample = (over: Partial<RigSample>): RigSample => ({
  taskId: "t", k: 4,
  candidates: [{ index: 1, oracleSolved: false }, { index: 2, oracleSolved: true }, { index: 3, oracleSolved: false }, { index: 4, oracleSolved: false }],
  verifierPick: 2, ...over
});

test("passAt1 / passAtK / bestAt1 read the right signals", () => {
  const s = sample({});
  assert.equal(passAt1(s), false, "candidate 1 (baseline) did not solve");
  assert.equal(passAtK(s), true, "some candidate solved (oracle ceiling)");
  assert.equal(bestAt1(s), true, "the verifier picked the solving candidate");
  // A verifier that picks a losing candidate: Best@1 fails though pass@k succeeds (the 10.8-pt gap).
  assert.equal(bestAt1(sample({ verifierPick: 1 })), false);
  assert.equal(bestAt1(sample({ verifierPick: null })), false);
});

test("curveFromSamples groups by k and computes the verifier gap + lift", () => {
  const samples = [
    sample({ k: 1, candidates: [{ index: 1, oracleSolved: true }], verifierPick: 1 }),
    sample({ k: 1, candidates: [{ index: 1, oracleSolved: false }], verifierPick: 1 }),
    sample({ k: 4 }),                                   // pass@k yes, Best@1 yes (pick 2)
    sample({ k: 4, verifierPick: 1 })                   // pass@k yes, Best@1 no (bad pick → gap)
  ];
  const curve = curveFromSamples(samples);
  assert.equal(curve.length, 2);
  const k1 = curve.find((p) => p.k === 1)!;
  assert.equal(k1.passAt1, 0.5);
  const k4 = curve.find((p) => p.k === 4)!;
  assert.equal(k4.passAtK, 1.0, "both k=4 tasks had a solving candidate");
  assert.equal(k4.bestAt1, 0.5, "the verifier only picked the winner in one of the two");
  assert.equal(k4.gap, 0.5, "pass@k 1.0 − Best@1 0.5 = 0.5 gap");
});

test("renderCurve produces an aligned table", () => {
  const out = renderCurve(curveFromSamples([sample({ k: 4 })]), "local-battery");
  assert.match(out, /local-battery/);
  assert.match(out, /pass@1/);
  assert.match(out, /Best@1/);
});

test("runMeasurement oracle-scores every candidate via the onVerified hook", async () => {
  const tasks: MeasureTask[] = [{ taskId: "task-a", task: "do a", freshWorkspace: () => "/ws/a" }];
  // Injected machine: calls onVerified with k fake candidates, picks candidate 2.
  const runAscent = async (params: any, config: any) => {
    const k = params.forceSamples as number;
    const attempts = Array.from({ length: k }, (_, i) => ({ index: i + 1, workspace: `/w/${params.taskId}/${i + 1}` }));
    await config.onVerified({ attempts, verdict: { winner: 2, slate: attempts } });
    return { winner: 2 };
  };
  // Oracle: only candidates 1 and 2 solve.
  const oracle = (_id: string, ws: string) => ws.endsWith("/1") || ws.endsWith("/2");
  const samples = await runMeasurement(tasks, { ks: [1, 4], oracle, runAscent, config: {} });
  assert.equal(samples.length, 2, "one sample per (task, k)");
  const k4 = samples.find((s) => s.k === 4)!;
  assert.equal(k4.candidates.length, 4);
  assert.deepEqual(k4.candidates.filter((c) => c.oracleSolved).map((c) => c.index), [1, 2]);
  assert.equal(k4.verifierPick, 2);
  assert.equal(bestAt1(k4), true);
});
