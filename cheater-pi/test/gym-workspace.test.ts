import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../src/gym/workspace.js";
import { ZOO_TASKS } from "../src/gym/zoo.js";

test("generated repo creation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-ws-gen-"));
  const task = ZOO_TASKS.find((t) => t.id === "py_off_by_one_001")!;
  const ws = createWorkspace(task, { rootDir: cwd, keep: true });
  assert.ok(existsSync(join(ws.path, "src", "sum_range.py")));
  assert.ok(existsSync(join(ws.path, "tests", "test_sum_range.py")));
  assert.equal(ws.source, "generated");
  rmSync(ws.path, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("fixture repo copy from tasks/<id>/repo", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-ws-fix-"));
  const taskDir = join(cwd, ".cheater", "gym", "tasks", "fx_001");
  const repoDir = join(taskDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "hello");
  const ws = createWorkspace({
    id: "fx_001",
    title: "fx",
    language: "python",
    category: "other",
    difficulty: "easy",
    goal: "fix fixture",
    focusedTestCommand: "echo ok",
    expectedTouchedFiles: ["src/app.py"],
    forbiddenTouchedFiles: ["tests/test_app.py"],
    successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
    tags: [],
    runMode: "fixture",
    source: "test",
    fixturePath: "repo"
  }, { rootDir: cwd, keep: true });
  assert.ok(existsSync(join(ws.path, "README.md")));
  assert.equal(ws.source, "fixture");
  rmSync(ws.path, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("workspace cleanup by default", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-ws-clean-"));
  const task = ZOO_TASKS[0];
  const ws = createWorkspace(task, { rootDir: cwd });
  ws.cleanup();
  assert.equal(existsSync(ws.path), false);
  rmSync(cwd, { recursive: true, force: true });
});
