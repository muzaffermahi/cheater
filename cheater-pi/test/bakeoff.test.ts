import test from "node:test";
import assert from "node:assert/strict";
import { buildBakeoffScorecard, formatBakeoffScorecard, type BakeoffPair, type ScoredResult } from "../src/gym/bakeoff.js";
import type { GymRunResult, GymScored, GymTask } from "../src/gym/types.js";

function task(id: string): GymTask {
  return {
    id, title: id, language: "python", category: "other", difficulty: "medium", goal: "fix it",
    focusedTestCommand: "pytest -q", expectedTouchedFiles: ["src/x.py"], forbiddenTouchedFiles: [],
    successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
    tags: [], runMode: "fixture", source: "test"
  };
}
function scored(pass: boolean): GymScored {
  return { score: pass ? 100 : 0, pass, focusedTestsPassed: pass, fullTestsPassed: pass, touchedExpectedFile: pass, editedForbiddenFile: false, editedTests: false, editedDependencies: false, diffLineCount: 5, filesTouchedCount: 1, commandsRunCount: 2, missionStepsCompleted: 5, memoryUsed: false, evidenceUsed: false, noOpDetected: false, breakdown: [] };
}
function result(mode: "vanilla" | "cheater", pass: boolean, ms: number, tools: number): ScoredResult {
  const base: GymRunResult = {
    taskId: "t", startedAt: "", finishedAt: "", durationMs: ms, mode,
    focusedTestsPassed: pass, fullTestsPassed: pass, filesTouched: ["src/x.py"], diffLineCount: 5,
    commandsRun: Array.from({ length: tools }, (_, i) => `cmd${i}`),
    editedTests: false, editedDependencies: false, touchedExpectedFile: pass, editedForbiddenFile: false,
    reproduced: false, noOpDetected: false, memoryUsed: false, evidenceUsed: false, missionStepsCompleted: 5, notes: ""
  };
  return { ...base, score: scored(pass) };
}

test("buildBakeoffScorecard aggregates pass/fail, wall-clock, and head-to-head wins", () => {
  const pairs: BakeoffPair[] = [
    { task: task("fix-import"), vanilla: result("vanilla", false, 5000, 4), kitten: result("cheater", true, 20000, 9) },
    { task: task("off-by-one"), vanilla: result("vanilla", true, 4000, 3), kitten: result("cheater", true, 18000, 7) }
  ];
  const card = buildBakeoffScorecard(pairs, "ornith-35b");
  assert.equal(card.totals.tasks, 2);
  assert.equal(card.totals.vanillaPassed, 1);
  assert.equal(card.totals.kittenPassed, 2);
  assert.equal(card.totals.kittenOnlyWins, 1, "kitten passed fix-import that vanilla failed");
  assert.equal(card.totals.vanillaOnlyWins, 0);
  assert.equal(card.totals.vanillaMsTotal, 9000);
  assert.equal(card.totals.kittenMsTotal, 38000);
  assert.equal(card.model, "ornith-35b");
});

test("formatBakeoffScorecard produces a shareable table with totals", () => {
  const pairs: BakeoffPair[] = [
    { task: task("fix-import"), vanilla: result("vanilla", false, 5000, 4), kitten: result("cheater", true, 20000, 9) }
  ];
  const text = formatBakeoffScorecard(buildBakeoffScorecard(pairs, "ornith-35b"));
  assert.match(text, /Kitten Code bakeoff/);
  assert.match(text, /ornith-35b/);
  assert.match(text, /fix-import/);
  assert.match(text, /FAIL/);
  assert.match(text, /PASS/);
  assert.match(text, /totals: vanilla 0\/1, kitten 1\/1/);
  assert.match(text, /kitten-only wins: 1/);
  assert.match(text, /wall-clock: vanilla 5\.0s, kitten 20\.0s/);
});

test("a missing side renders as -- and never crashes the scorecard", () => {
  const pairs: BakeoffPair[] = [{ task: task("only-kitten"), vanilla: null, kitten: result("cheater", true, 12000, 6) }];
  const card = buildBakeoffScorecard(pairs);
  assert.equal(card.rows[0].vanillaPass, null);
  assert.equal(card.rows[0].kittenPass, true);
  const text = formatBakeoffScorecard(card);
  assert.match(text, / -- /, "the un-run vanilla side shows as --");
  assert.match(text, /totals: vanilla 0\/1, kitten 1\/1/);
});
