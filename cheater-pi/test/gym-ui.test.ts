import test from "node:test";
import assert from "node:assert/strict";
import { formatTaskList, formatTaskCard, formatReportSummary, formatDeltaReport, formatLearningSuggestions } from "../src/gym/ui.js";
import type { GymTask, GymReport, GymDeltaReport, GymLearningSuggestion } from "../src/gym/types.js";

function baseTask(): GymTask {
  return {
    id: "py_x", title: "X", language: "python", category: "import_error", difficulty: "easy",
    goal: "Fix it", focusedTestCommand: "pytest -q", expectedTouchedFiles: ["src/app.py"],
    forbiddenTouchedFiles: ["tests/test_app.py"],
    successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
    tags: ["python"], runMode: "generated", source: "zoo"
  };
}

test("formatTaskList handles empty", () => {
  assert.match(formatTaskList([]), /No gym tasks/);
});

test("formatTaskList renders multiple tasks", () => {
  const text = formatTaskList([baseTask()]);
  assert.match(text, /py_x/);
  assert.match(text, /python\/import_error/);
});

test("formatTaskCard shows key fields", () => {
  const text = formatTaskCard(baseTask());
  assert.match(text, /title: X/);
  assert.match(text, /focused: pytest -q/);
  assert.match(text, /expected: src\/app.py/);
});

test("formatReportSummary includes pass count", () => {
  const report: GymReport = {
    id: "r", startedAt: "x", finishedAt: "y", suite: "cheater", vanillaAvailable: false,
    results: [], summary: { total: 0, passed: 0, failed: 0, averageScore: 0, averageDiff: 0 }
  };
  assert.match(formatReportSummary(report), /total: 0/);
});

test("formatDeltaReport explains vanilla unavailability", () => {
  const report: GymDeltaReport = {
    taskId: "x", model: null, vanilla: null, cheater: null,
    improvement: { scoreDelta: 0, toolCallsDelta: 0, diffLinesDelta: 0, passImproved: false, vanillaAvailable: false }
  };
  const text = formatDeltaReport(report);
  assert.match(text, /vanilla available: false/);
  assert.match(text, /\(no run recorded\)/);
});

test("formatLearningSuggestions handles empty", () => {
  assert.match(formatLearningSuggestions([]), /No learning/);
});

test("formatLearningSuggestions renders one suggestion", () => {
  const suggestions: GymLearningSuggestion[] = [
    { kind: "bug_memory", taskId: "x", summary: "fix x", details: "details", reason: "r" }
  ];
  const text = formatLearningSuggestions(suggestions);
  assert.match(text, /\[bug_memory\]/);
});
