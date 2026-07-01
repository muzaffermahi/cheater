import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/gym/runner.js";
import { ZOO_TASKS } from "../src/gym/zoo.js";
import type { RunHookOutcome } from "../src/gym/runner.js";

const NOOP: RunHookOutcome = {
  focusedTestsPassed: null, fullTestsPassed: null, reproduced: false, noOpDetected: false,
  memoryUsed: false, evidenceUsed: false, missionStepsCompleted: 0
};

test("runner creates workspace and collects results", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-runner-"));
  const task = ZOO_TASKS.find((t) => t.id === "py_off_by_one_001")!;
  const report = await runTask({
    rootDir: cwd, task, mode: "cheater",
    outcomeOverride: { ...NOOP, focusedTestsPassed: true, fullTestsPassed: true, reproduced: true, evidenceUsed: true, memoryUsed: true, missionStepsCompleted: 4 },
    hooks: { runAgent: async () => NOOP, snapshotBaseline: async () => {} },
    keepWorkspaces: false
  });
  assert.equal(report.result.focusedTestsPassed, true);
  assert.equal(report.result.mode, "cheater");
  assert.ok(report.workspace.path);
  rmSync(cwd, { recursive: true, force: true });
});

test("runner captures a no-op as expected", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-runner-noop-"));
  const task = ZOO_TASKS[0];
  const report = await runTask({
    rootDir: cwd, task, mode: "cheater",
    outcomeOverride: { ...NOOP, focusedTestsPassed: true, fullTestsPassed: true, noOpDetected: true, reproduced: true, evidenceUsed: true },
    hooks: { runAgent: async () => ({ ...NOOP, noOpDetected: true }), snapshotBaseline: async () => {} }
  });
  assert.equal(report.result.noOpDetected, true);
  rmSync(cwd, { recursive: true, force: true });
});

test("runner records commands when provided", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-runner-cmd-"));
  const task = ZOO_TASKS[0];
  const report = await runTask({
    rootDir: cwd, task, mode: "cheater",
    outcomeOverride: { ...NOOP, focusedTestsPassed: true, fullTestsPassed: true, reproduced: true, commandsRun: ["pytest -q", "pytest -q tests/test_sum_range.py"] },
    hooks: { runAgent: async () => NOOP, snapshotBaseline: async () => {} }
  });
  assert.equal(report.result.commandsRun.length, 2);
  rmSync(cwd, { recursive: true, force: true });
});
