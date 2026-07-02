import test from "node:test";
import assert from "node:assert/strict";
import { CHEATER_TOOL_MODES, pickAutoVerifyCommand } from "../src/extension.js";
import { commandHelp, startupCard } from "../src/ui.js";

// The tool mask is the single lever that keeps a weak model from drowning in the ~20 cheater
// tools. These tests pin the contract: the execute phase sees only the one-flow tools plus
// recovery/lookup, and no phase ever exposes a parallel-subsystem (mission_*/blueprint_*) tool.

test("execute mode exposes only the one-flow tools, not harness-provided redundancies", () => {
  const execute = CHEATER_TOOL_MODES.execute;
  for (const core of [
    "cheater_reliability_start",
    "cheater_commitlet_next",
    "cheater_verification_run",
    "cheater_finish_gate",
    "cheater_line_edit"
  ]) {
    assert.ok(execute.includes(core), `execute mode must expose ${core}`);
  }
  // Redundant with deterministic harness behavior (env block, diff guard, verification_run).
  for (const redundant of ["cheater_project_brief", "cheater_focus_test", "cheater_diff_safety_check"]) {
    assert.equal(execute.includes(redundant), false, `${redundant} is harness-provided; keep it out of the model's execute surface`);
  }
});

test("no tool mask leaks a parallel-subsystem tool", () => {
  for (const [mode, tools] of Object.entries(CHEATER_TOOL_MODES)) {
    for (const name of tools) {
      assert.equal(/^cheater_(mission|blueprint|orientation|repro|oracle|evidence|playbook)/.test(name), false, `${mode} mask leaks parallel-subsystem tool ${name}`);
    }
  }
});

test("every masked tool name is unique and cheater-namespaced", () => {
  for (const [mode, tools] of Object.entries(CHEATER_TOOL_MODES)) {
    assert.equal(new Set(tools).size, tools.length, `${mode} mask has duplicates`);
    for (const name of tools) assert.match(name, /^cheater_/, `${mode} exposes non-cheater tool ${name}`);
  }
});

test("auto-verify prefers a real test but falls back to typecheck then build", () => {
  assert.deepEqual(
    pickAutoVerifyCommand({ focusedTestCommand: "vitest run x", testCommand: "npm test", typecheckCommand: "tsc", buildCommand: "npm run build" }),
    { cmd: "vitest run x", stage: "focused_tests", kind: "test" }
  );
  assert.deepEqual(
    pickAutoVerifyCommand({ testCommand: "npm test", typecheckCommand: "tsc" }),
    { cmd: "npm test", stage: "focused_tests", kind: "test" }
  );
  // No tests: typecheck is still real, deterministic edit verification.
  assert.deepEqual(
    pickAutoVerifyCommand({ typecheckCommand: "tsc --noEmit", buildCommand: "npm run build" }),
    { cmd: "tsc --noEmit", stage: "smoke", kind: "typecheck_or_build" }
  );
  assert.deepEqual(
    pickAutoVerifyCommand({ buildCommand: "cargo build" }),
    { cmd: "cargo build", stage: "smoke", kind: "typecheck_or_build" }
  );
  // Nothing runnable -> null (finish gate falls through to nag/waiver, truthfully).
  assert.equal(pickAutoVerifyCommand({}), null);
});

test("command help and startup card hide Mission Control unless opted in", () => {
  const off = commandHelp();
  assert.doesNotMatch(off, /\/mission /, "Mission Control commands must be hidden by default");
  assert.doesNotMatch(off, /Start a Cheater Mission Control flow/);
  const on = commandHelp({ missionControlEnabled: true });
  assert.match(on, /Start a Cheater Mission Control flow/);

  const cardOff = startupCard("C:\\repo", "qwen-local").join("\n");
  assert.doesNotMatch(cardOff, /\/mission/);
  const cardOn = startupCard("C:\\repo", "qwen-local", { missionControlEnabled: true }).join("\n");
  assert.match(cardOn, /\/mission/);
});
