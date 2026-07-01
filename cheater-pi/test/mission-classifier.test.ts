import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask } from "../src/mission/classifier.js";

test("explanation task does not patch", () => {
  const result = classifyTask({ message: "Explain how the orientation cache works in this repo" });
  assert.equal(result.missionType, "explanation_only");
  assert.equal(result.shouldPatch, false);
  assert.equal(result.needsRepro, false);
});

test("bug task requires repro", () => {
  const result = classifyTask({ message: "My tests are failing with ModuleNotFoundError" });
  assert.equal(result.missionType, "import_error");
  assert.equal(result.shouldPatch, true);
  assert.equal(result.needsRepro, true);
});

test("refactor task selects refactor playbook", () => {
  const result = classifyTask({ message: "Refactor the pagination module, behavior should stay the same" });
  assert.equal(result.missionType, "refactor");
  assert.equal(result.shouldPatch, true);
  assert.equal(result.needsRepro, false);
});

test("unknown task asks for missing info", () => {
  const result = classifyTask({ message: "help" });
  assert.equal(result.missionType, "unknown");
  assert.equal(result.shouldPatch, false);
  assert.ok(result.recommendedFirstSteps.some((step) => /smallest missing/i.test(step)));
});

test("test failure classified as test_failure via recent errors", () => {
  const result = classifyTask({ message: "CI is broken", recentErrors: "FAILED tests/test_pagination.py::test_offset - AssertionError" });
  assert.equal(result.missionType, "test_failure");
  assert.equal(result.needsRepro, true);
});

test("lint warning is low risk and does not need repro", () => {
  const result = classifyTask({ message: "Please run eslint and fix the warnings" });
  assert.equal(result.missionType, "lint_warning");
  assert.equal(result.shouldPatch, true);
  assert.equal(result.needsRepro, false);
  assert.equal(result.risk, "low");
});

test("type error classified and high-risk keywords escalate risk", () => {
  const base = classifyTask({ message: "TypeError: cannot read properties of undefined (reading 'map')" });
  assert.equal(base.missionType, "type_error");
  const elevated = classifyTask({ message: "TypeError: cannot read properties of undefined in auth middleware touching production" });
  assert.equal(elevated.risk, "high");
});
