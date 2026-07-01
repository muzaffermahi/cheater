import test from "node:test";
import assert from "node:assert/strict";
import { defaultMissionStore, inMemoryMissionStore } from "../src/mission/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("default store persists missions to disk", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-store-disk-"));
  const store = defaultMissionStore({ cwd });
  const mission = store.create({ userGoal: "fix x", missionType: "bug_fix", repoRoot: cwd });
  store.setStatus(mission.id, "orienting", "started");
  const reloaded = defaultMissionStore({ cwd });
  const list = reloaded.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "orienting");
  rmSync(cwd, { recursive: true, force: true });
});

test("truncateLog keeps summary compact", () => {
  const store = inMemoryMissionStore({ cwd: process.cwd(), rawLogCharLimit: 100 });
  const big = "x".repeat(500);
  const truncated = store.truncateLog(big);
  assert.ok(truncated.length < 200);
  assert.match(truncated, /truncated/);
});

test("in-memory store supports setActive", () => {
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const m1 = store.create({ userGoal: "a", missionType: "bug_fix", repoRoot: process.cwd() });
  const m2 = store.create({ userGoal: "b", missionType: "refactor", repoRoot: process.cwd() });
  store.setActive(m1.id);
  assert.equal(store.active()?.id, m1.id);
  store.setActive(m2.id);
  assert.equal(store.active()?.id, m2.id);
});
