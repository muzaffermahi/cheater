import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGymTaskFile, loadGymTasks, validateGymTask } from "../src/gym/taskLoader.js";

const validTask = {
  id: "py_test_001",
  title: "Demo",
  language: "python",
  category: "import_error",
  difficulty: "easy",
  goal: "Fix the import",
  focusedTestCommand: "python -m pytest -q",
  expectedTouchedFiles: ["src/app.py"],
  forbiddenTouchedFiles: ["tests/test_app.py"],
  successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
  tags: ["python"],
  runMode: "generated",
  source: "zoo",
  generated: { files: { "src/app.py": "x = 1\n" } }
};

function writeTask(dir: string, name: string, body: object): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

test("task.json parsing succeeds for valid task", () => {
  const dir = mkdtempSync(join(tmpdir(), "gym-task-ok-"));
  const path = writeTask(dir, "task.json", validTask);
  const task = parseGymTaskFile(path);
  assert.ok(!("error" in task));
  assert.equal(task.id, "py_test_001");
  rmSync(dir, { recursive: true, force: true });
});

test("invalid task schema is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "gym-task-bad-"));
  const path = writeTask(dir, "task.json", { id: "x" });
  const result = parseGymTaskFile(path);
  assert.ok("error" in result);
  rmSync(dir, { recursive: true, force: true });
});

test("validateGymTask rejects missing fields", () => {
  const result = validateGymTask({ id: "x" }, "task.json");
  assert.ok("error" in result);
});

test("validateGymTask rejects invalid language", () => {
  const result = validateGymTask({ ...validTask, language: "rust" }, "task.json");
  assert.ok("error" in result);
});

test("validateGymTask rejects invalid category", () => {
  const result = validateGymTask({ ...validTask, category: "made-up" }, "task.json");
  assert.ok("error" in result);
});

test("validateGymTask rejects invalid runMode", () => {
  const result = validateGymTask({ ...validTask, runMode: "remote" }, "task.json");
  assert.ok("error" in result);
});

test("loadGymTasks reads on-disk tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "gym-load-"));
  const taskDir = join(dir, ".cheater", "gym", "tasks", "py_disk_001");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify(validTask));
  const result = loadGymTasks({ rootDir: dir, includeGenerated: true });
  assert.equal(result.errors.length, 0);
  assert.equal(result.tasks.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("loadGymTasks reports malformed entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "gym-load-bad-"));
  const taskDir = join(dir, ".cheater", "gym", "tasks", "py_broken_001");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), "{not json");
  const result = loadGymTasks({ rootDir: dir, includeGenerated: true });
  assert.equal(result.tasks.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].reason, /invalid JSON/);
  rmSync(dir, { recursive: true, force: true });
});
