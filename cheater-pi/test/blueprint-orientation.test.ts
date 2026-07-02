import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOrientation } from "../src/blueprint/orientation.js";

// Deterministic repo orientation feeds every blueprint plan's RepoOrientation - it must read
// real manifests, not guess. (Moved from the deleted Mission Control subsystem; the scanner
// was the one piece the live path actually used.)

test("scanOrientation detects node+ts repos with test/typecheck commands and frameworks", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-orient-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: { test: "node --test", lint: "eslint .", build: "tsc -p ." },
    dependencies: { react: "^18.0.0" }
  }), "utf8");
  writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
  mkdirSync(join(dir, "src"), { recursive: true });
  const facts = scanOrientation(dir);
  assert.ok(facts.languages.includes("javascript"));
  assert.ok(facts.languages.includes("typescript"));
  assert.ok(facts.testCommands.includes("npm test"));
  assert.ok(facts.typecheckCommands.includes("npx tsc --noEmit"));
  assert.ok(facts.frameworks.includes("react"));
  assert.ok(facts.entrypoints.includes("src/"));
  assert.ok(facts.doNotTouch.includes("node_modules"));
});

test("scanOrientation detects python repos via pyproject and picks pytest", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-orient-py-"));
  writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = \"-q\"\n", "utf8");
  mkdirSync(join(dir, "tests"), { recursive: true });
  const facts = scanOrientation(dir);
  assert.ok(facts.languages.includes("python"));
  assert.ok(facts.testCommands.includes("pytest -q"));
  assert.ok(facts.importantPaths.includes("pyproject.toml"));
});

test("scanOrientation is calm on an empty directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-orient-empty-"));
  const facts = scanOrientation(dir);
  assert.deepEqual(facts.languages, []);
  assert.deepEqual(facts.testCommands, []);
});
