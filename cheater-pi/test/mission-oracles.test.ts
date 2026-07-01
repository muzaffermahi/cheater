import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracleStack } from "../src/mission/oracles.js";
import { scanOrientation } from "../src/mission/orientation.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "cheater-oracle-"));
}

test("runs focused command and reports status", () => {
  const cwd = freshDir();
  const report = runOracleStack({ cwd, orientation: null, focusedCommand: "node -e \"process.exit(0)\"", runBroadTests: "never" });
  assert.equal(report.focusedTestsOk, true);
  assert.equal(report.failures.length, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test("parses failure compactly and reports failure reason", () => {
  const cwd = freshDir();
  const report = runOracleStack({ cwd, orientation: null, focusedCommand: "node -e \"process.exit(1)\"", runBroadTests: "never" });
  assert.equal(report.focusedTestsOk, false);
  assert.ok(report.failures.length > 0);
  assert.match(report.summary, /focused/);
  rmSync(cwd, { recursive: true, force: true });
});

test("does not dump huge logs into the report summary", () => {
  const cwd = freshDir();
  const report = runOracleStack({ cwd, orientation: null, focusedCommand: "node -e \"process.exit(1)\"", runBroadTests: "never" });
  assert.ok(report.summary.length < 200);
  rmSync(cwd, { recursive: true, force: true });
});

test("broad tests are skipped by default with runBroadTests=ask", () => {
  const cwd = freshDir();
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(0)\"" } }));
  const orientation = scanOrientation(cwd);
  const report = runOracleStack({ cwd, orientation, focusedCommand: "node -e \"process.exit(0)\"", runBroadTests: "ask" });
  assert.equal(report.broadTestsOk, null);
  rmSync(cwd, { recursive: true, force: true });
});

test("broad tests run when userConfirmedBroad is true", () => {
  const cwd = freshDir();
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(0)\"" } }));
  const orientation = scanOrientation(cwd);
  const report = runOracleStack({
    cwd,
    orientation,
    focusedCommand: "node -e \"process.exit(0)\"",
    broadCommand: "node -e \"process.exit(0)\"",
    runBroadTests: "ask",
    userConfirmedBroad: true
  });
  assert.equal(report.broadTestsOk, true);
  assert.ok(report.checks.some((check) => check.name === "broad"));
  rmSync(cwd, { recursive: true, force: true });
});

test("all-check mode runs every discovered test command and html validation", () => {
  const cwd = freshDir();
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "x",
    scripts: {
      test: "node -e \"process.exit(0)\"",
      "test:unit": "node -e \"process.exit(0)\""
    }
  }));
  writeFileSync(join(cwd, "index.html"), "<main><h1>ok</h1></main>\n");
  const orientation = scanOrientation(cwd);
  const report = runOracleStack({
    cwd,
    orientation,
    focusedCommand: "node -e \"process.exit(0)\"",
    runBroadTests: "always",
    runAllChecks: true
  });
  assert.equal(report.broadTestsOk, true);
  assert.equal(report.syntaxOk, true);
  assert.ok(report.checks.filter((check) => check.name === "broad").length >= 1);
  assert.ok(report.checks.some((check) => check.name === "html-static-validation"));
  rmSync(cwd, { recursive: true, force: true });
});
