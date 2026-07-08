import test from "node:test";
import assert from "node:assert/strict";
import {
  planAttempts, attemptTemperature, vanDerCorput, rotateLocalization,
  repairDirective, roundsForBudget
} from "../src/core/diversity.js";

test("attempt 1 is the deterministic baseline (temp 0, neutral, no directive)", () => {
  const plans = planAttempts(5);
  assert.equal(plans[0].index, 1);
  assert.equal(plans[0].temperature, 0);
  assert.equal(plans[0].stance, "baseline");
  assert.equal(plans[0].planFirst, false);
  assert.equal(plans[0].directive, "", "baseline carries no extra directive → zero overhead on easy tasks");
});

test("attempts 2..N spread across stances and warm up in temperature", () => {
  const plans = planAttempts(6);
  const stances = new Set(plans.slice(1).map((p) => p.stance));
  assert.ok(stances.has("minimal") && stances.has("root-cause") && stances.has("rewrite"), "all three stances appear");
  for (const p of plans.slice(1)) assert.ok(p.temperature > 0, "non-baseline attempts have a nonzero temperature");
  // Temperatures are spread, not clustered: at least 4 distinct values among 5 non-baseline attempts.
  const temps = new Set(plans.slice(1).map((p) => p.temperature));
  assert.ok(temps.size >= 4, `expected a spread of temperatures, got ${[...temps].join(",")}`);
});

test("vanDerCorput produces a low-discrepancy spread in (0,1)", () => {
  assert.equal(vanDerCorput(1), 0.5);
  assert.equal(vanDerCorput(2), 0.25);
  assert.equal(vanDerCorput(3), 0.75);
  for (let i = 1; i < 20; i++) { const v = vanDerCorput(i); assert.ok(v > 0 && v < 1); }
});

test("attemptTemperature caps at 1.1 and stays in range", () => {
  for (let i = 1; i <= 50; i++) {
    const t = attemptTemperature(i);
    assert.ok(t >= 0 && t <= 1.1, `temp ${t} out of range at i=${i}`);
  }
  assert.equal(attemptTemperature(1), 0);
});

test("a repair seed makes attempt 1 spend a real sample (no free baseline) and injects grounding", () => {
  const plans = planAttempts(3, { repairSeed: "previous attempt crashed on empty input" });
  assert.notEqual(plans[0].stance, "baseline", "repair round spends every sample, no free baseline");
  for (const p of plans) assert.match(p.directive, /previous attempt crashed on empty input/);
});

test("multiFile enables decomposition hints in non-baseline attempts", () => {
  const plans = planAttempts(4, { multiFile: true });
  const withDecomp = plans.slice(1).filter((p) => /multiple files/.test(p.directive));
  assert.ok(withDecomp.length >= 1, "multi-file tasks get decomposition-order hints");
  const single = planAttempts(4, { multiFile: false });
  assert.equal(single.slice(1).filter((p) => /multiple files/.test(p.directive)).length, 0);
});

test("localization rotation rotates the candidate file order", () => {
  const files = ["a.py", "b.py", "c.py"];
  assert.deepEqual(rotateLocalization(files, 0), files);
  assert.deepEqual(rotateLocalization(files, 1), ["b.py", "c.py", "a.py"]);
  assert.deepEqual(rotateLocalization(files, 3), files, "full rotation is identity");
  assert.deepEqual(rotateLocalization([], 2), []);
});

test("planAttempts uses localization variants to rotate leads across attempts", () => {
  const plans = planAttempts(12, { localizationVariants: 3 });
  const rotations = new Set(plans.map((p) => p.localizationRotation));
  assert.ok(rotations.size >= 2, "with several localization variants, attempts explore different leads");
});

test("repairDirective steers away from the failed stance and carries the grounding", () => {
  const d = repairDirective("AssertionError: expected 5 got 4", "minimal");
  assert.match(d, /minimal approach/);
  assert.match(d, /AssertionError: expected 5 got 4/);
});

test("roundsForBudget scales rounds with sample budget, bounded", () => {
  assert.equal(roundsForBudget(1), 1);
  assert.equal(roundsForBudget(3), 2);
  assert.equal(roundsForBudget(20), 3);
  assert.equal(roundsForBudget(50, 2), 2, "maxRounds caps it");
});
