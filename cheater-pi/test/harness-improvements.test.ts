import test from "node:test";
import assert from "node:assert/strict";
import { compressCommandResult, renderFailureCard } from "../src/reliability/failureCompressor.js";
import { CompletionLedger, ledgerAllowsFinish } from "../src/reliability/lifecycle.js";
import { buildAutopilotInstruction, routeAutopilot } from "../src/autopilot/router.js";
import { relevantSymbolSlice } from "../src/reliability/symbolSlice.js";
import { createRollbackPoint, revertRollbackPoint } from "../src/commitlet/rollback.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("failure compressor extracts pytest failure with expected/got and a next action", () => {
  const raw = [
    "============================= test session starts ==============================",
    "collected 1 item",
    "tests/test_math.py::test_add FAILED",
    "=================================== FAILURES ===================================",
    "_________________________________ test_add ____________________________________",
    "    def test_add():",
    ">       assert add(2, 2) == 5",
    "E       assert 4 == 5",
    'File "tests/test_math.py", line 7, in test_add',
    "=========================== 1 failed in 0.03s ==============================="
  ].join("\n");
  const summary = compressCommandResult("pytest -q", raw, "", 1);
  assert.equal(summary.isTestFailure, true);
  assert.equal(summary.failures[0].test, "tests/test_math.py::test_add");
  assert.ok(summary.nextAction.length > 0, "must end with an imperative next action");
  const card = renderFailureCard(summary);
  assert.match(card, /NEXT:/);
  assert.match(card, /test_math\.py/);
});

test("failure compressor recognizes a tsc type error", () => {
  const summary = compressCommandResult("tsc --noEmit", "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.", "", 2);
  assert.equal(summary.errorType, "TS2322");
  assert.match(summary.nextAction, /type error/i);
});

test("failure compressor recognizes a missing module", () => {
  const summary = compressCommandResult("node app.js", "", "Error: Cannot find module 'left-pad'", 1);
  assert.equal(summary.isImportError, true);
  assert.match(summary.summary, /left-pad/);
});

test("finish gate recovers when an equivalent command later succeeds", () => {
  const ledger = new CompletionLedger("fix the thing");
  ledger.recordFileChange("src/a.ts");
  // A fumbled exploratory command latches a failure...
  ledger.recordCommandResult("pytest -q tests/a.py", false, "app_bug");
  assert.equal(ledger.get().unresolvedFailures.length, 1);
  // ...and an equivalent command (different flags) succeeding supersedes it.
  ledger.recordCommandResult("pytest -x tests/a.py", true);
  assert.equal(ledger.get().unresolvedFailures.length, 0, "equivalent command success must clear the latch");
});

test("a passing test stage clears stray exploratory failures so the gate is satisfiable", () => {
  const ledger = new CompletionLedger("fix the thing");
  ledger.recordFileChange("src/a.ts");
  ledger.recordCommandResult("ls nonexistent", false, "unknown"); // stage-less exploratory failure
  ledger.recordVerificationStage({ stage: "focused_tests", status: "ok", summary: "ok", failureClass: "unknown", artifacts: [], signals: {} });
  assert.equal(ledgerAllowsFinish(ledger).allowed, true, "a real passing test stage must clear stray exploratory failures");
});

test("symbol slice extracts the target function, not the import block", () => {
  const content = [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "",
    "export function unrelated() { return 1; }",
    "",
    "export function computeInvoiceTotal(items) {",
    "  let total = 0;",
    "  for (const item of items) total += item.price;",
    "  return total;",
    "}"
  ].join("\n");
  const slice = relevantSymbolSlice(content, ["fix the invoice total calculation"]);
  assert.ok(slice, "should find a matching symbol");
  assert.match(slice!, /computeInvoiceTotal/);
  assert.doesNotMatch(slice!, /readFileSync/, "must not just return the import block");
});

test("rollback restores modified files and deletes files created during the commitlet", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-rollback-"));
  writeFileSync(join(root, "existing.txt"), "original\n", "utf8");
  const commitlet: any = { id: "c1", allowedFiles: ["existing.txt", "created.txt"], forbiddenFiles: [] };
  const point = createRollbackPoint(root, commitlet);
  assert.deepEqual(point.existedFiles, ["existing.txt"], "only pre-existing files are recorded");
  // Simulate the commitlet's edits: modify one file, create another.
  writeFileSync(join(root, "existing.txt"), "BROKEN\n", "utf8");
  writeFileSync(join(root, "created.txt"), "new file\n", "utf8");
  const result = revertRollbackPoint(root, { ...commitlet, rollbackPoint: point });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(root, "existing.txt"), "utf8"), "original\n", "modified file must be restored");
  assert.equal(existsSync(join(root, "created.txt")), false, "created file must be removed on revert");
});

test("autopilot instruction is a short imperative block with no routing telemetry", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "add a /hello command with tests and docs" });
  const text = buildAutopilotInstruction(decision, "add a /hello command with tests and docs");
  assert.match(text, /cheater_reliability_start/);
  assert.doesNotMatch(text, /confidence:|executionDiscipline|taskKind:/);
});
