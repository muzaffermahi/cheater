import test from "node:test";
import assert from "node:assert/strict";
import { computeBudget, scoreHardness } from "../src/runtime/computeBudget.js";

test("computeBudget OFF path returns the static budget (byte-identical to today)", () => {
  const off = computeBudget({ taskKind: "bug_fix", risk: "high", filesInScope: 5, isRepair: true }, {});
  assert.equal(off.samples, 1, "no adaptive -> static commitletCandidateSamples (default 1)");
  assert.equal(off.maxDebugRounds, 1);
  assert.equal(off.localizationDepth, "shallow");
  const off3 = computeBudget({ taskKind: "bug_fix" }, { commitletCandidateSamples: 3 });
  assert.equal(off3.samples, 3, "off path passes commitletCandidateSamples through unchanged");
});

test("enabling inSessionResampleEnabled alone yields samples>1 (no coupling papercut)", () => {
  // Turning ON in-session best-of-N must not be a silent no-op: without adaptiveCompute and without an
  // explicit sample count, it defaults to 3 so best-of-N actually runs.
  const on = computeBudget({ taskKind: "feature", filesInScope: 1 }, { inSessionResampleEnabled: true });
  assert.equal(on.samples, 3, "inSessionResampleEnabled defaults to 3 samples");
  const explicit = computeBudget({ taskKind: "feature" }, { inSessionResampleEnabled: true, commitletCandidateSamples: 2 });
  assert.equal(explicit.samples, 2, "an explicit commitletCandidateSamples still wins");
  const offFlag = computeBudget({ taskKind: "feature" }, {});
  assert.equal(offFlag.samples, 1, "flag off -> still single attempt");
});

test("firstSampleVerified short-circuits to k=1 / no extra compute even if signals say hard", () => {
  const b = computeBudget(
    { taskKind: "feature_addition", risk: "high", filesInScope: 5, isRepair: true, firstSampleVerified: true },
    { adaptiveComputeEnabled: true }
  );
  assert.equal(b.samples, 1, "an already-verified first attempt is definitively easy");
  assert.equal(b.maxDebugRounds, 0);
});

test("a trivial commitlet gets k=1 even with adaptive on", () => {
  const b = computeBudget({ taskKind: "trivial", risk: "low", filesInScope: 1 }, { adaptiveComputeEnabled: true });
  assert.equal(b.samples, 1);
  assert.equal(b.localizationDepth, "shallow");
});

test("a moderately hard commitlet gets several samples + deep localization + 2 debug rounds", () => {
  const b = computeBudget({ taskKind: "bug_fix", risk: "medium", filesInScope: 1 }, { adaptiveComputeEnabled: true });
  assert.ok(b.samples >= 4 && b.samples <= 8, `expected k in [4,8], got ${b.samples}`);
  assert.equal(b.localizationDepth, "deep");
  assert.equal(b.maxDebugRounds, 2);
});

test("a very hard commitlet saturates at adaptiveMaxSamples and respects a lower cap", () => {
  const b = computeBudget(
    { taskKind: "feature_addition", risk: "high", filesInScope: 4, isRepair: true, priorFailures: 1 },
    { adaptiveComputeEnabled: true, adaptiveMaxSamples: 8 }
  );
  assert.equal(b.samples, 8, "saturates at the cap");
  const capped = computeBudget(
    { taskKind: "feature_addition", risk: "high", filesInScope: 4, isRepair: true },
    { adaptiveComputeEnabled: true, adaptiveMaxSamples: 4 }
  );
  assert.equal(capped.samples, 4, "respects a lower adaptiveMaxSamples cap");
});

test("scoreHardness rises with each of risk / scope / repair", () => {
  const base = scoreHardness({ taskKind: "bug_fix", risk: "low", filesInScope: 1 }).hardness;
  assert.ok(scoreHardness({ taskKind: "bug_fix", risk: "high", filesInScope: 1 }).hardness > base, "risk raises hardness");
  assert.ok(scoreHardness({ taskKind: "bug_fix", risk: "low", filesInScope: 3 }).hardness > base, "more files raise hardness");
  assert.ok(scoreHardness({ taskKind: "bug_fix", risk: "low", filesInScope: 1, isRepair: true }).hardness > base, "repair raises hardness");
});
