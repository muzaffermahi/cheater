import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrientation, saveOrientation, scanOrientation } from "../src/mission/orientation.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "cheater-orient-"));
}

test("detects package.json with test command", () => {
  const cwd = freshDir();
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
  const facts = scanOrientation(cwd);
  assert.ok(facts.languages.includes("javascript"));
  assert.ok(facts.testCommands.includes("npm test"));
  assert.ok(facts.packageManagers.includes("npm"));
  rmSync(cwd, { recursive: true, force: true });
});

test("detects pyproject.toml with pytest", () => {
  const cwd = freshDir();
  writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q'\n");
  const facts = scanOrientation(cwd);
  assert.ok(facts.languages.includes("python"));
  assert.ok(facts.testCommands.includes("pytest -q"));
  rmSync(cwd, { recursive: true, force: true });
});

test("saves and loads orientation", () => {
  const cwd = freshDir();
  const facts = scanOrientation(cwd);
  const path = saveOrientation(cwd, facts);
  assert.match(path, /orientation\.json$/);
  const loaded = loadOrientation(cwd);
  assert.ok(loaded);
  assert.equal(loaded.repoRoot, facts.repoRoot);
  assert.deepEqual(loaded.testCommands, facts.testCommands);
  rmSync(cwd, { recursive: true, force: true });
});

test("keeps orientation compact (no README content)", () => {
  const cwd = freshDir();
  writeFileSync(join(cwd, "README.md"), "# Title\n" + "x".repeat(2000));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" } }));
  const facts = scanOrientation(cwd);
  const serialized = JSON.stringify(facts);
  assert.ok(serialized.length < 2000, `orientation too large: ${serialized.length}`);
  rmSync(cwd, { recursive: true, force: true });
});
