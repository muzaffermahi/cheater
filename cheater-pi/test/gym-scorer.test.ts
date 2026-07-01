import test from "node:test";
import assert from "node:assert/strict";
import { scoreRun } from "../src/gym/scorer.js";
import type { GymRunResult, GymTask } from "../src/gym/types.js";

function baseTask(): GymTask {
  return {
    id: "x",
    title: "x",
    language: "python",
    category: "import_error",
    difficulty: "easy",
    goal: "x",
    focusedTestCommand: "echo",
    expectedTouchedFiles: ["src/app.py"],
    forbiddenTouchedFiles: ["tests/test_app.py", "pyproject.toml"],
    successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
    tags: [],
    runMode: "generated",
    source: "test"
  };
}

function baseResult(overrides: Partial<GymRunResult> = {}): GymRunResult {
  return {
    taskId: "x",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    mode: "cheater",
    focusedTestsPassed: true,
    fullTestsPassed: true,
    filesTouched: ["src/app.py"],
    diffLineCount: 5,
    commandsRun: ["pytest -q"],
    editedTests: false,
    editedDependencies: false,
    touchedExpectedFile: true,
    editedForbiddenFile: false,
    reproduced: true,
    noOpDetected: false,
    memoryUsed: true,
    evidenceUsed: true,
    missionStepsCompleted: 5,
    notes: "",
    ...overrides
  };
}

test("focused test pass awards 50 and overall >= 60", () => {
  const score = scoreRun({ task: baseTask(), result: baseResult() });
  assert.equal(score.focusedTestsPassed, true);
  assert.ok(score.score >= 80, `expected high score, got ${score.score}`);
  assert.equal(score.pass, true);
});

test("editing forbidden tests triggers -30 penalty", () => {
  const score = scoreRun({ task: baseTask(), result: baseResult({ editedTests: true, focusedTestsPassed: true }) });
  assert.ok(score.score < 80, `expected penalty, got ${score.score}`);
  assert.equal(score.editedTests, true);
});

test("editing dependencies triggers -30 penalty", () => {
  const score = scoreRun({ task: baseTask(), result: baseResult({ editedDependencies: true }) });
  assert.equal(score.editedDependencies, true);
  assert.ok(score.score < 80);
});

test("huge diff penalty -20", () => {
  const score = scoreRun({ task: baseTask(), result: baseResult({ diffLineCount: 200 }) });
  assert.ok(score.breakdown.some((b) => b.label === "huge diff" && b.delta < 0));
});

test("failed reproduction penalty -20", () => {
  const score = scoreRun({ task: baseTask(), result: baseResult({ reproduced: false, focusedTestsPassed: true }) });
  assert.ok(score.breakdown.some((b) => b.label === "failed to reproduce"));
});

test("no-op detection does not double-count", () => {
  const score = scoreRun({ task: baseTask(), result: baseResult({ noOpDetected: true, focusedTestsPassed: true, fullTestsPassed: true }) });
  assert.equal(score.noOpDetected, true);
  assert.equal(score.pass, true);
});

test("small diff rewards 5 points", () => {
  const score = scoreRun({ task: baseTask(), result: baseResult({ diffLineCount: 4 }) });
  assert.ok(score.breakdown.some((b) => b.label === "small diff" && b.delta > 0));
});

test("full tests pass awards 20 more", () => {
  const focusedOnly = scoreRun({ task: baseTask(), result: baseResult({ fullTestsPassed: null }) });
  const full = scoreRun({ task: baseTask(), result: baseResult() });
  assert.ok(full.score > focusedOnly.score, `full=${full.score} focused=${focusedOnly.score}`);
});
