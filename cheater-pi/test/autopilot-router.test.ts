import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeAutopilot } from "../src/autopilot/router.js";

function cwd(): string {
  return mkdtempSync(join(tmpdir(), "cheater-autopilot-"));
}

test("explanation goes answer_only", () => {
  const decision = routeAutopilot({ cwd: cwd(), message: "what does this repo do?" });
  assert.equal(decision.taskKind, "explanation_only");
  assert.equal(decision.executionMode, "answer_only");
  assert.equal(decision.needsBlueprint, false);
});

test("tiny edit goes fast path", () => {
  const decision = routeAutopilot({ cwd: cwd(), message: "fix a typo in the README quickly" });
  assert.equal(decision.taskKind, "tiny_edit");
  assert.equal(decision.executionMode, "vanilla_pi");
});

test("bug fix and test failures go to the careful repro route", () => {
  const bug = routeAutopilot({ cwd: cwd(), message: "fix this failing test" });
  assert.equal(bug.executionMode, "careful_repro");
  assert.equal(bug.needsRepro, true);

  const testFailure = routeAutopilot({ cwd: cwd(), message: "CI is broken", recentErrors: "FAILED test_example - AssertionError" });
  assert.equal(testFailure.taskKind, "test_failure");
  assert.equal(testFailure.executionMode, "careful_repro");
});

test("complex feature goes to blueprint without slash command", () => {
  const decision = routeAutopilot({ cwd: cwd(), message: "add a /hello command with tests and docs" });
  assert.equal(decision.executionMode, "blueprint_orchestrator");
  assert.equal(decision.needsBlueprint, true);
  assert.match(decision.userVisibleSummary, /Planning internally/);
});

test("failed fast path escalates to blueprint", () => {
  const decision = routeAutopilot({
    cwd: cwd(),
    message: "fix this failing test",
    repoHints: { previousFastPathFailed: true }
  });
  assert.equal(decision.executionMode, "blueprint_orchestrator");
});

test("low confidence code task chooses safe planning", () => {
  const decision = routeAutopilot({ cwd: cwd(), message: "wire the new behavior into the system" });
  assert.equal(decision.executionMode, "blueprint_orchestrator");
});
