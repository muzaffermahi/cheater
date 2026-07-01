import test from "node:test";
import assert from "node:assert/strict";
import { inMemoryMissionStore } from "../src/mission/store.js";
import { buildMissionBugMemoryCard, missionBugMemoryPath, proposeLearning, saveMissionBugMemoryCard } from "../src/mission/learn.js";
import { searchBugMemories } from "../src/bug-memory.js";
import { classifyTask } from "../src/mission/classifier.js";
import { playbookFor } from "../src/mission/playbooks.js";
import { scanOrientation } from "../src/mission/orientation.js";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheaterConfig } from "../src/types.js";
import type { Mission } from "../src/mission/types.js";

function fixture(status: Mission["status"]): Mission {
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const mission = store.create({ userGoal: "fix pagination", missionType: "test_failure", repoRoot: process.cwd() });
  const repro = status === "complete" || status === "no_change_needed"
    ? { reproduced: status === "complete", alreadyPassing: status === "no_change_needed", environmentFailure: false, command: "pytest -q", exitCode: status === "complete" ? 1 : 0, failureKind: status === "complete" ? "test_assertion_error" : "none", failingTests: status === "complete" ? ["tests/test_pagination.py::test_offset"] : [], errorType: status === "complete" ? "AssertionError" : "", topStackFiles: status === "complete" ? ["src/pagination.ts"] : [], summary: status === "complete" ? "1 failed" : "passed" }
    : null;
  const orientation = scanOrientation(process.cwd());
  const withOrientation = store.setProjectOrientation(mission.id, orientation);
  const withPlaybook = store.setPlaybook(withOrientation.id, playbookFor("test_failure", !!repro?.reproduced));
  if (repro) store.setRepro(withPlaybook.id, repro);
  const withClass = store.setClassification(withPlaybook.id, classifyTask({ message: "fix pagination" }));
  return store.update(withClass.id, { status, patchSummary: status === "complete" ? "Use strict comparison" : "", filesTouched: status === "complete" ? ["src/pagination.ts"] : [] });
}

test("success offers memory/project/playbook save", () => {
  const mission = fixture("complete");
  const cwd = mkdtempSync(join(tmpdir(), "cheater-learn-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest" } }));
  const proposal = proposeLearning({ mission, cwd, config: { autoSaveLearning: false } as CheaterConfig });
  assert.ok(proposal.saveBugMemory, "should propose bug memory");
  assert.ok(proposal.saveProjectFact, "should propose project fact");
  assert.ok(proposal.savePlaybookNote, "should propose playbook note");
  rmSync(cwd, { recursive: true, force: true });
});

test("failure offers anti-pattern save", () => {
  const mission = fixture("failed");
  const proposal = proposeLearning({ mission, cwd: process.cwd(), config: {} as CheaterConfig });
  assert.ok(proposal.saveAntiPattern, "should propose anti-pattern");
  assert.ok(proposal.saveAvoidance, "should propose avoidance");
});

test("does not auto-save by default", () => {
  const mission = fixture("complete");
  const cwd = mkdtempSync(join(tmpdir(), "cheater-learn-auto-"));
  const config = { autoSaveLearning: false } as CheaterConfig;
  const proposal = proposeLearning({ mission, cwd, config });
  assert.ok(proposal.saveBugMemory);
});

test("successful mission becomes a searchable workflow bug-memory card", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-learn-card-"));
  const mission = { ...fixture("complete"), repoRoot: cwd };
  const card = buildMissionBugMemoryCard(mission);
  assert.ok(card);
  assert.equal(card!.bug_type, "test_failure");
  assert.ok(card!.workflow_steps.some((step) => /pytest -q/.test(step)));
  const saved = saveMissionBugMemoryCard(cwd, mission);
  assert.equal(saved.saved, true);
  assert.equal(saved.path, missionBugMemoryPath(cwd));
  assert.match(readFileSync(saved.path, "utf8"), /workflow_steps/);
  const result = await searchBugMemories({ cwd, query: "pagination AssertionError pytest", topK: 1 });
  assert.equal(result.hits[0].id, `mission-${mission.id}`);
  assert.ok(result.hits[0].workflowSteps?.length);
  rmSync(cwd, { recursive: true, force: true });
});
