import test from "node:test";
import assert from "node:assert/strict";
import { formatMissionDashboard, formatPlaybook, formatOrientation, formatClassification } from "../src/mission/ui.js";
import { classifyTask } from "../src/mission/classifier.js";
import { playbookFor } from "../src/mission/playbooks.js";
import { scanOrientation } from "../src/mission/orientation.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission } from "../src/mission/types.js";

function fixtureMission(): Mission {
  return {
    id: "abc-123",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    repoRoot: "/tmp/repo",
    userGoal: "Fix failing pagination test",
    missionType: "test_failure",
    status: "patching",
    currentStep: "evidence_gathered",
    evidence: null,
    projectOrientation: null,
    playbook: playbookFor("test_failure", true),
    repro: { reproduced: true, alreadyPassing: false, environmentFailure: false, command: "pytest -q", exitCode: 1, failureKind: "test_assertion_error", failingTests: ["tests/test_pagination.py::test_offset"], errorType: "AssertionError", topStackFiles: ["src/pagination.ts"], summary: "1 failed" },
    classification: classifyTask({ message: "Fix failing pagination test" }),
    commandsRun: ["pytest -q"],
    filesTouched: ["src/pagination.ts"],
    testsRun: ["tests/test_pagination.py::test_offset"],
    patchSummary: "Use strict comparison in cursor",
    verification: null,
    learned: ["cursor comparison bug pattern"],
    riskFlags: []
  };
}

test("mission status renders", () => {
  const text = formatMissionDashboard(fixtureMission());
  assert.match(text, /mission abc-123/);
  assert.match(text, /type: test_failure/);
  assert.match(text, /status: patching/);
  assert.match(text, /playbook: test_assertion_error/);
});

test("mission dashboard shows current step", () => {
  const text = formatMissionDashboard(fixtureMission());
  assert.match(text, /step: evidence_gathered/);
});

test("playbook format", () => {
  const text = formatPlaybook(playbookFor("refactor", false));
  assert.match(text, /playbook: refactor/);
  assert.match(text, /steps:/);
  assert.match(text, /verification:/);
});

test("classification format", () => {
  const text = formatClassification(classifyTask({ message: "Refactor the pagination module" }));
  assert.match(text, /mission:/);
  assert.match(text, /why:/);
  assert.match(text, /next:/);
});

test("orientation format", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-orient-fmt-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e 'process.exit(0)'" } }));
  const facts = scanOrientation(cwd);
  const text = formatOrientation(facts);
  assert.match(text, /languages:/);
  assert.match(text, /test commands:/);
  rmSync(cwd, { recursive: true, force: true });
});
