import test from "node:test";
import assert from "node:assert/strict";
import { collectTasks, runGymCli } from "../src/gym/cli.js";
import { ZOO_TASKS } from "../src/gym/zoo.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("collectTasks includes the 25 zoo tasks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-"));
  const { tasks, warnings } = collectTasks(cwd);
  assert.ok(tasks.length >= 25, `expected at least 25 tasks, got ${tasks.length}`);
  assert.equal(warnings.length, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test("cheater gym list works as a CLI subcommand", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-list-"));
  const lines: string[] = [];
  const code = runGymCli(["list"], { cwd, stdout: (t) => lines.push(t) });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("Cheater Gym - ")));
  assert.ok(lines.some((l) => l.includes("py_import_error_001")));
  rmSync(cwd, { recursive: true, force: true });
});

test("cheater gym show prints one task card", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-show-"));
  const lines: string[] = [];
  const code = runGymCli(["show", "py_off_by_one_001"], { cwd, stdout: (t) => lines.push(t) });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("py_off_by_one_001")));
  assert.ok(lines.some((l) => l.includes("expected: src/sum_range.py")));
  rmSync(cwd, { recursive: true, force: true });
});

test("cheater gym show missing id returns 1", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-miss-"));
  const code = runGymCli(["show", "does_not_exist"], { cwd, stdout: () => {}, stderr: () => {} });
  assert.equal(code, 1);
  rmSync(cwd, { recursive: true, force: true });
});

test("cheater gym run prepares workspace and prints prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-run-"));
  const lines: string[] = [];
  const code = runGymCli(["run", "py_off_by_one_001"], { cwd, stdout: (t) => lines.push(t) });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("Cheater Gym task ready")));
  assert.ok(lines.some((l) => l.includes("Cheater Reliability task py_off_by_one_001")));
  rmSync(cwd, { recursive: true, force: true });
});

test("cheater gym report with no runs returns 1", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-rep-"));
  const code = runGymCli(["report"], { cwd, stdout: () => {}, stderr: () => {} });
  assert.equal(code, 1);
  rmSync(cwd, { recursive: true, force: true });
});

test("cheater gym help lists subcommands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-help-"));
  const lines: string[] = [];
  const code = runGymCli(["help"], { cwd, stdout: (t) => lines.push(t) });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("Subcommands:")));
  rmSync(cwd, { recursive: true, force: true });
});

test("zoo has at least 18 python tasks and 7 javascript tasks", () => {
  const python = ZOO_TASKS.filter((t) => t.language === "python");
  const js = ZOO_TASKS.filter((t) => t.language === "javascript" || t.language === "typescript");
  assert.ok(python.length >= 18, `python=${python.length}`);
  assert.ok(js.length >= 7, `js=${js.length}`);
});
