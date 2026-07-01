import test from "node:test";
import assert from "node:assert/strict";
import { playbookFor, allPlaybooks, getPlaybook } from "../src/mission/playbooks.js";

test("import_error selects import playbook", () => {
  const playbook = playbookFor("import_error", false);
  assert.equal(playbook.name, "import_error");
  assert.ok(playbook.steps.length > 0);
});

test("test_assertion_error selects test assertion playbook", () => {
  const playbook = playbookFor("test_failure", true);
  assert.equal(playbook.name, "test_assertion_error");
});

test("explanation_only forbids edits", () => {
  const playbook = playbookFor("explanation_only", false);
  assert.ok(playbook.forbiddenActions.some((a) => /edit/i.test(a)));
  assert.equal(playbook.allowedTools.includes("edit"), false);
});

test("refactor playbook forbids behavior change", () => {
  const playbook = playbookFor("refactor", false);
  assert.ok(playbook.forbiddenActions.some((a) => /behavior/i.test(a)));
});

test("all playbook names are unique", () => {
  const names = allPlaybooks().map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test("getPlaybook returns by name", () => {
  const playbook = getPlaybook("feature_addition");
  assert.ok(playbook);
  assert.equal(playbook.name, "feature_addition");
});
