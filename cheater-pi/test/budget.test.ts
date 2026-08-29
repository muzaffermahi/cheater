import test from "node:test";
import assert from "node:assert/strict";
import { BudgetGovernor, defaultCeiling } from "../src/core/budget.js";

test("records spend and reports tokens/wall/usd", () => {
  const g = new BudgetGovernor({ maxTokens: 10000, maxWallMs: 60000, maxUsd: 1, usdPerMTokens: 100 });
  g.record(2000, 5000);
  g.record(3000, 4000);
  assert.equal(g.spentTokens(), 5000);
  assert.equal(g.spentWallMs(), 9000);
  assert.ok(Math.abs(g.spentUsd() - 0.5) < 1e-9, "5000 tok @ $100/M = $0.50");
});

test("exhausted() trips on any dimension", () => {
  const gTok = new BudgetGovernor({ maxTokens: 1000 });
  gTok.record(1000, 0);
  assert.equal(gTok.exhausted(), true);
  const gWall = new BudgetGovernor({ maxWallMs: 1000 });
  gWall.record(0, 1000);
  assert.equal(gWall.exhausted(), true);
});

test("canAfford projects the next sample against the ceiling", () => {
  const g = new BudgetGovernor({ maxTokens: 10000 });
  g.record(8000, 0);
  assert.equal(g.canAfford(1500), true);
  assert.equal(g.canAfford(3000), false, "would exceed the token ceiling");
});

test("capSamples reduces N to fit the remaining budget, floor of 1", () => {
  const g = new BudgetGovernor({ maxTokens: 10000 });
  g.record(4000, 0);
  // 6000 tokens left, ~2000/sample => 3 affordable, requested 8 => capped to 3.
  assert.equal(g.capSamples(8, 2000), 3);
  // Exhausted budget still allows the one first sample (bounds escalation, never refuses the task).
  g.record(6000, 0);
  assert.equal(g.capSamples(8, 2000), 1);
});

test("capSamples respects a dollar ceiling", () => {
  const g = new BudgetGovernor({ maxUsd: 0.1, usdPerMTokens: 100 }); // $0.10 budget, $100/M => 1000 tok
  assert.equal(g.capSamples(10, 400), 2, "1000 tok / 400 per sample => 2 samples");
});

test("receiptLines render spend vs ceiling and flag exhaustion", () => {
  const g = new BudgetGovernor({ maxTokens: 1000, usdPerMTokens: 100, maxUsd: 1 });
  g.record(1000, 0);
  const lines = g.receiptLines();
  assert.match(lines[0], /tokens 1000\/1000/);
  assert.match(lines[0], /EXHAUSTED/);
});

test("defaultCeiling has a token bound and no wall-clock stop", () => {
  const c = defaultCeiling(60);
  assert.ok(c.maxTokens && c.maxTokens > 0);
  assert.equal(c.maxWallMs, undefined);
  assert.equal(c.usdPerMTokens, 60);
});
