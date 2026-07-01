import test from "node:test";
import assert from "node:assert/strict";
import { inMemoryMissionStore } from "../src/mission/store.js";

test("store create + update + active", () => {
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const mission = store.create({ userGoal: "fix x", missionType: "bug_fix", repoRoot: process.cwd() });
  assert.equal(mission.status, "planning");
  const updated = store.setStatus(mission.id, "orienting", "started");
  assert.equal(updated.status, "orienting");
  assert.equal(updated.currentStep, "started");
  const active = store.active();
  assert.ok(active);
  assert.equal(active.id, mission.id);
});

test("store appendLog + list", () => {
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const mission = store.create({ userGoal: "fix x", missionType: "bug_fix", repoRoot: process.cwd() });
  store.appendLog(mission.id, "repro", "running pytest");
  store.appendLog(mission.id, "evidence", "found 2 hits");
  const list = store.list();
  assert.equal(list.length, 1);
});

test("setRepro marks no_change_needed when alreadyPassing", () => {
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const mission = store.create({ userGoal: "fix x", missionType: "bug_fix", repoRoot: process.cwd() });
  const updated = store.setRepro(mission.id, { reproduced: false, alreadyPassing: true, environmentFailure: false, command: "pytest -q", exitCode: 0, failureKind: "none", failingTests: [], errorType: "", topStackFiles: [], summary: "passed" });
  assert.equal(updated.status, "no_change_needed");
});

test("setRepro marks waiting_for_user when nothing reproduces", () => {
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const mission = store.create({ userGoal: "fix x", missionType: "bug_fix", repoRoot: process.cwd() });
  const updated = store.setRepro(mission.id, { reproduced: false, alreadyPassing: false, environmentFailure: false, command: "", exitCode: -1, failureKind: "no_command", failingTests: [], errorType: "", topStackFiles: [], summary: "no command" });
  assert.equal(updated.status, "waiting_for_user");
});

test("addFilesTouched + addTestsRun dedupe", () => {
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const mission = store.create({ userGoal: "fix x", missionType: "bug_fix", repoRoot: process.cwd() });
  store.addFilesTouched(mission.id, ["a.ts", "b.ts"]);
  store.addFilesTouched(mission.id, ["a.ts", "c.ts"]);
  store.addTestsRun(mission.id, ["t1"]);
  store.addTestsRun(mission.id, ["t1", "t2"]);
  const fresh = store.get(mission.id);
  assert.deepEqual(fresh?.filesTouched, ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(fresh?.testsRun, ["t1", "t2"]);
});
