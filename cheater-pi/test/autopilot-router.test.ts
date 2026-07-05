import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeAutopilot } from "../src/autopilot/router.js";
import { looksLikeNewGoal } from "../src/extension.js";

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

test("keyword-less symptom reports route to a fix mode, not answer_only", () => {
  // Before: these matched no bug_fix keyword -> unknown -> answer_only (the bug got explained,
  // never fixed). The verb-stemmed / symptom-broadened patterns now catch them.
  for (const message of ["the app crashes on startup", "the upload fails every time", "the modal never closes", "clicking save throws an exception"]) {
    const decision = routeAutopilot({ cwd: cwd(), message });
    assert.equal(decision.taskKind, "bug_fix", message);
    assert.notEqual(decision.executionMode, "answer_only", message);
  }
});

test("a zero-signal feature takes the fast single-commitlet path, not the blueprint engine", () => {
  for (const message of ["add a logout button", "implement a dark mode toggle", "create a sidebar component"]) {
    const decision = routeAutopilot({ cwd: cwd(), message });
    assert.equal(decision.taskKind, "feature_addition", message);
    assert.equal(decision.executionMode, "vanilla_pi", message);
    assert.equal(decision.needsBlueprint, false, message);
  }
});

test("migration/replacement requests route to a code mode, not answer_only", () => {
  for (const message of ["port the auth module from Express to Fastify", "swap the logging library for pino", "replace moment with date-fns", "convert the config to YAML"]) {
    const decision = routeAutopilot({ cwd: cwd(), message });
    assert.notEqual(decision.executionMode, "answer_only", message);
  }
});

test("a from-scratch app spec still routes to the blueprint engine (not the fast lane)", () => {
  const decision = routeAutopilot({ cwd: cwd(), message: "build a complete todo app from scratch" });
  assert.equal(decision.taskKind, "feature_addition");
  assert.equal(decision.executionMode, "blueprint_orchestrator");
});

test("an explicit read-only question stays answer_only even with an action verb in the negation", () => {
  const decision = routeAutopilot({ cwd: cwd(), message: "why does the parser drop trailing commas? just tell me, don't change anything" });
  assert.equal(decision.executionMode, "answer_only");
  // But a genuine explain-then-fix request must still route to a code mode.
  const fix = routeAutopilot({ cwd: cwd(), message: "explain why the login test is failing and fix it" });
  assert.notEqual(fix.executionMode, "answer_only");
});

test("looksLikeNewGoal: a short imperative naming a target is a NEW goal, not an ack", () => {
  // The core of the short-goal-hijack fix: these must NOT be treated as acknowledgements of a
  // prior plan (which re-issued the OLD goal to the model).
  for (const message of ["fix the parser", "add a logout button", "delete temp.txt", "refactor auth.ts", "make it dark mode"]) {
    assert.equal(looksLikeNewGoal(message), true, message);
  }
  // Genuine acknowledgements and bare verb+pronoun continuations stay acks.
  for (const message of ["ok", "yes", "proceed", "go ahead", "do it", "fix it", "run it", "test it again"]) {
    assert.equal(looksLikeNewGoal(message), false, message);
  }
});
