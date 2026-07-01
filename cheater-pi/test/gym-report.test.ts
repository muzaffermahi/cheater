import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, writeReport, writeMarkdownReport, listReports, readLatestReport, buildDeltaReport, buildLearningSuggestions, writeLearningSuggestions, listLearningSuggestions, buildGymBugMemoryCards, writeGymBugMemoryCards } from "../src/gym/report.js";
import type { GymRunResult, GymScored, GymTask } from "../src/gym/types.js";

function fixtureTask(): GymTask {
  return {
    id: "py_x",
    title: "x",
    language: "python",
    category: "import_error",
    difficulty: "easy",
    goal: "x",
    focusedTestCommand: "echo",
    expectedTouchedFiles: ["src/app.py"],
    forbiddenTouchedFiles: ["tests/test_app.py"],
    successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
    tags: [],
    runMode: "generated",
    source: "test"
  };
}

function fixtureScore(): GymScored {
  return {
    score: 80, pass: true, focusedTestsPassed: true, fullTestsPassed: true,
    touchedExpectedFile: true, editedForbiddenFile: false, editedTests: false,
    editedDependencies: false, diffLineCount: 5, filesTouchedCount: 1,
    commandsRunCount: 1, missionStepsCompleted: 4, memoryUsed: true,
    evidenceUsed: true, noOpDetected: false, breakdown: []
  };
}

function fixtureResult(): GymRunResult {
  return {
    taskId: "py_x", startedAt: "2024-01-01T00:00:00Z", finishedAt: "2024-01-01T00:00:01Z",
    durationMs: 1000, mode: "cheater", focusedTestsPassed: true, fullTestsPassed: true,
    filesTouched: ["src/app.py"], diffLineCount: 5, commandsRun: ["pytest -q"],
    editedTests: false, editedDependencies: false, touchedExpectedFile: true,
    editedForbiddenFile: false, reproduced: true, noOpDetected: false,
    memoryUsed: true, evidenceUsed: true, missionStepsCompleted: 4, notes: ""
  };
}

test("report JSON write/read", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-rep-"));
  const report = buildReport({
    id: "rep-1", startedAt: "2024-01-01", finishedAt: "2024-01-01",
    suite: "cheater", results: [{ ...fixtureResult(), task: fixtureTask(), score: fixtureScore() }],
    vanillaAvailable: false
  });
  const file = writeReport(cwd, report);
  const ids = listReports(cwd);
  assert.equal(ids.length, 1);
  const latest = readLatestReport(cwd);
  assert.ok(latest);
  assert.equal(latest.id, "rep-1");
  rmSync(cwd, { recursive: true, force: true });
});

test("markdown report generation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-md-"));
  const report = buildReport({
    id: "rep-md", startedAt: "x", finishedAt: "y", suite: "cheater",
    results: [{ ...fixtureResult(), task: fixtureTask(), score: fixtureScore() }],
    vanillaAvailable: false
  });
  const file = writeMarkdownReport(cwd, report);
  const text = readFileSync(file, "utf8");
  assert.match(text, /# Cheater Gym report rep-md/);
  assert.match(text, /py_x/);
  rmSync(cwd, { recursive: true, force: true });
});

test("delta report structure", () => {
  const vanilla = { ...fixtureResult(), task: fixtureTask(), score: { ...fixtureScore(), score: 50, pass: false } };
  const cheater = { ...fixtureResult(), task: fixtureTask(), score: { ...fixtureScore(), score: 80 } };
  const report = buildDeltaReport({ taskId: "py_x", model: "qwen", vanilla, cheater });
  assert.equal(report.improvement.scoreDelta, 30);
  assert.equal(report.improvement.passImproved, true);
  assert.equal(report.improvement.vanillaAvailable, true);
});

test("learning suggestion from successful run", () => {
  const passed = { ...fixtureResult(), task: fixtureTask(), score: { ...fixtureScore(), score: 90, pass: true } };
  const suggestions = buildLearningSuggestions([passed]);
  assert.ok(suggestions.some((s) => s.kind === "bug_memory"));
});

test("anti-pattern suggestion from failed run", () => {
  const failed = { ...fixtureResult(), task: { ...fixtureTask(), category: "off_by_one" as const }, score: { ...fixtureScore(), score: 30, pass: false } };
  const suggestions = buildLearningSuggestions([failed]);
  assert.ok(suggestions.some((s) => s.kind === "anti_pattern"));
});

test("learning suggestions persist and are listed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-learn-"));
  const passed = { ...fixtureResult(), task: fixtureTask(), score: { ...fixtureScore(), score: 90, pass: true } };
  const suggestions = buildLearningSuggestions([passed]);
  writeLearningSuggestions(cwd, suggestions);
  const listed = listLearningSuggestions(cwd);
  assert.equal(listed.length, suggestions.length);
  rmSync(cwd, { recursive: true, force: true });
});

test("high scoring gym runs become structured bug-memory workflow cards", () => {
  const passed = { ...fixtureResult(), task: fixtureTask(), score: { ...fixtureScore(), score: 90, pass: true } };
  const cards = buildGymBugMemoryCards([passed]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "gym-py_x");
  assert.equal(cards[0].repo, "cheater-gym");
  assert.deepEqual(cards[0].key_files, ["src/app.py"]);
  assert.ok(cards[0].workflow_steps.some((step) => /Reproduce with: echo/.test(step)));
  assert.ok(cards[0].do_not_do.some((step) => /do not edit tests/.test(step)));
  assert.match(cards[0].embedding_text, /Verify with: echo/);
});

test("gym bug-memory cards persist to the searchable project corpus", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-card-"));
  const passed = { ...fixtureResult(), task: fixtureTask(), score: { ...fixtureScore(), score: 90, pass: true } };
  const cards = buildGymBugMemoryCards([passed]);
  const path = writeGymBugMemoryCards(cwd, cards);
  assert.ok(path);
  const text = readFileSync(path!, "utf8");
  assert.match(text, /"id":"gym-py_x"/);
  assert.match(text, /"workflow_steps":/);
  assert.match(text, /"do_not_do":/);
  rmSync(cwd, { recursive: true, force: true });
});

test("report summary includes pass/fail counts", () => {
  const report = buildReport({
    id: "rep-x", startedAt: "x", finishedAt: "y", suite: "cheater",
    results: [
      { ...fixtureResult(), task: fixtureTask(), score: fixtureScore() },
      { ...fixtureResult(), task: { ...fixtureTask(), id: "py_y" }, score: { ...fixtureScore(), score: 20, pass: false } }
    ],
    vanillaAvailable: false
  });
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 1);
});
