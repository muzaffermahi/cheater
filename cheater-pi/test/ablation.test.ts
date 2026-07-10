import test from "node:test";
import assert from "node:assert/strict";
import { computeAblation, renderAblation, best1AtMaxK, runAblation, type AblatableLever } from "../src/core/ablation.js";
import { ALL_LEVERS, NO_LEVERS, type AscentLevers } from "../src/core/ascent.js";
import type { RigSample } from "../src/core/measure.js";

test("computeAblation: marginal = allOn − leaveOneOut, sorted by contribution", () => {
  const rows = computeAblation(0.8, { diversity: 0.6, orm: 0.7, skills: 0.79, web: 0.82 });
  assert.equal(rows[0].lever, "diversity", "the biggest contributor sorts first");
  assert.ok(Math.abs(rows[0].marginal - 0.2) < 1e-9);
  const web = rows.find((r) => r.lever === "web")!;
  assert.ok(web.marginal < 0, "a lever whose removal IMPROVES Best@1 has a negative marginal (not earning keep)");
});

test("best1AtMaxK reads Best@1 at the largest k", () => {
  const samples: RigSample[] = [
    { taskId: "t", k: 1, candidates: [{ index: 1, oracleSolved: false }], verifierPick: 1 },
    { taskId: "t", k: 8, candidates: [{ index: 1, oracleSolved: false }, { index: 2, oracleSolved: true }], verifierPick: 2 }
  ];
  assert.equal(best1AtMaxK(samples), 1.0, "at k=8 the verifier picked the solving candidate");
});

test("renderAblation flags levers that are not earning their keep", () => {
  const out = renderAblation(computeAblation(0.8, { diversity: 0.6, web: 0.81 }), 0.8);
  assert.match(out, /diversity/);
  assert.match(out, /not earning its keep/);
});

test("runAblation drives leave-one-out via the injected measure, skipping already-off levers", async () => {
  const calls: string[] = [];
  // A fake measure: Best@1 is 0.9 with all levers, but drops 0.2 when diversity is off, 0.05 when orm is off.
  const measure = async (levers: AscentLevers): Promise<RigSample[]> => {
    const off = (Object.keys(levers) as AblatableLever[]).filter((k) => !levers[k]);
    calls.push(off.join(",") || "all-on");
    let best1 = 0.9;
    if (!levers.diversity) best1 -= 0.2;
    if (!levers.orm) best1 -= 0.05;
    return [{ taskId: "t", k: 16, candidates: [{ index: 1, oracleSolved: best1 > 0.85 }], verifierPick: 1 }];
  };
  const allOn: AscentLevers = { ...ALL_LEVERS, cloudBurst: false };
  const { rows, allOnBest1 } = await runAblation({ measure, allLevers: allOn, levers: ["diversity", "orm", "cloudBurst"] });
  assert.equal(allOnBest1, 1, "all-on: Best@1 read from the max-k sample");
  // cloudBurst was already off in allOn, so it is skipped (can't ablate an off lever): 1 baseline + 2 LOO.
  assert.equal(calls.length, 3, "one baseline + diversity-off + orm-off (cloudBurst skipped)");
  assert.equal(rows.find((r) => r.lever === "cloudBurst"), undefined, "an already-off lever produces no ablation row");
  assert.ok(rows.find((r) => r.lever === "diversity") && rows.find((r) => r.lever === "orm"));
});
