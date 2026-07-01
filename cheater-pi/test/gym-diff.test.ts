import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { diffWorkspace } from "../src/gym/diff.js";
import type { GymTask } from "../src/gym/types.js";

function writeFile(dir: string, rel: string, text: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, "utf8");
}

function baseTask(): GymTask {
  return {
    id: "x",
    title: "x",
    language: "python",
    category: "import_error",
    difficulty: "easy",
    goal: "x",
    focusedTestCommand: "echo",
    expectedTouchedFiles: ["src/app.py"],
    forbiddenTouchedFiles: ["tests/test_app.py", "pyproject.toml"],
    successCriteria: { focusedTestsPass: true, fullTestsPass: true, noTestEdits: true, noDependencyEdits: true },
    tags: [],
    runMode: "generated",
    source: "test"
  };
}

test("diff detects edited tests", () => {
  const baseline = mkdtempSync(join(tmpdir(), "gym-diff-base-"));
  const after = mkdtempSync(join(tmpdir(), "gym-diff-after-"));
  writeFile(baseline, "tests/test_app.py", "a\n");
  writeFile(after, "tests/test_app.py", "a\nb\n");
  const diff = diffWorkspace(baseline, after, baseTask());
  assert.equal(diff.editedTests, true);
  assert.equal(diff.diffLineCount >= 1, true);
  rmSync(baseline, { recursive: true, force: true });
  rmSync(after, { recursive: true, force: true });
});

test("diff detects edited dependencies", () => {
  const baseline = mkdtempSync(join(tmpdir(), "gym-diff-base2-"));
  const after = mkdtempSync(join(tmpdir(), "gym-diff-after2-"));
  writeFile(baseline, "pyproject.toml", "name='x'\n");
  writeFile(after, "pyproject.toml", "name='x'\nversion='0.2.0'\n");
  const diff = diffWorkspace(baseline, after, baseTask());
  assert.equal(diff.editedDependencies, true);
  rmSync(baseline, { recursive: true, force: true });
  rmSync(after, { recursive: true, force: true });
});

test("diff reports huge diff lines", () => {
  const baseline = mkdtempSync(join(tmpdir(), "gym-diff-base3-"));
  const after = mkdtempSync(join(tmpdir(), "gym-diff-after3-"));
  const big = Array.from({ length: 200 }, (_, i) => `line_${i}`).join("\n");
  writeFile(baseline, "src/app.py", "");
  writeFile(after, "src/app.py", big + "\n");
  const diff = diffWorkspace(baseline, after, baseTask());
  assert.ok(diff.diffLineCount > 80);
  assert.equal(diff.touchedExpected.length, 1);
  rmSync(baseline, { recursive: true, force: true });
  rmSync(after, { recursive: true, force: true });
});

test("diff reports touched expected file", () => {
  const baseline = mkdtempSync(join(tmpdir(), "gym-diff-base4-"));
  const after = mkdtempSync(join(tmpdir(), "gym-diff-after4-"));
  writeFile(baseline, "src/app.py", "x=1\n");
  writeFile(after, "src/app.py", "x=2\n");
  const diff = diffWorkspace(baseline, after, baseTask());
  assert.equal(diff.touchedExpected.length, 1);
  assert.equal(diff.editedTests, false);
  rmSync(baseline, { recursive: true, force: true });
  rmSync(after, { recursive: true, force: true });
});

test("diff detects forbidden file edit", () => {
  const baseline = mkdtempSync(join(tmpdir(), "gym-diff-base5-"));
  const after = mkdtempSync(join(tmpdir(), "gym-diff-after5-"));
  writeFile(baseline, "tests/test_app.py", "x\n");
  writeFile(after, "tests/test_app.py", "x\ny\n");
  const diff = diffWorkspace(baseline, after, baseTask());
  assert.equal(diff.editedForbidden.length, 1);
  rmSync(baseline, { recursive: true, force: true });
  rmSync(after, { recursive: true, force: true });
});
