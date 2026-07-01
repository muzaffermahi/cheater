import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../src/gym/runner.js";
import type { GymTask } from "../src/gym/types.js";

function baseTask(): GymTask {
  return {
    id: "py_x", title: "X", language: "python", category: "import_error", difficulty: "easy",
    goal: "Fix it", focusedTestCommand: "pytest -q", fullTestCommand: "pytest -q",
    expectedTouchedFiles: ["src/app.py"],
    forbiddenTouchedFiles: ["tests/test_app.py"],
    successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
    tags: ["python"], runMode: "generated", source: "zoo"
  };
}

test("buildPrompt for cheater mode includes mission control hints", () => {
  const prompt = buildPrompt(baseTask(), "/tmp/ws", "cheater");
  assert.match(prompt, /Cheater Mission Control/);
  assert.match(prompt, /cheater_mission_classify/);
  assert.match(prompt, /Do not edit tests/);
});

test("buildPrompt for vanilla mode does not mention cheater tools", () => {
  const prompt = buildPrompt(baseTask(), "/tmp/ws", "vanilla");
  assert.match(prompt, /vanilla mode/);
  assert.equal(/cheater_mission_classify/.test(prompt), false);
});
