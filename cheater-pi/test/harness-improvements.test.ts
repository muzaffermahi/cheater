import test from "node:test";
import assert from "node:assert/strict";
import { compressCommandResult, renderFailureCard } from "../src/reliability/failureCompressor.js";
import { CompletionLedger, ledgerAllowsFinish } from "../src/reliability/lifecycle.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
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

// Re-entry ledger preservation: the fix for the finish-gate false "no work was done" loop. A weak
// model blocked at the finish gate loops back and re-calls the planning tools with the SAME goal;
// reset() used to mint a fresh empty ledger and erase the record of work already done, so the gate
// reported "no work" forever. reset() must now PRESERVE the ledger on same-goal re-entry.
test("reset preserves the completion ledger on a same-goal re-entry that already has work", () => {
  liveSessionState.reset("Create stats.py with a median function");
  const first = liveSessionState.getLedger();
  assert.ok(first, "reset(goal) must create a ledger");
  first!.recordFileChange("stats.py");
  first!.recordCommand("python -m pytest -q");
  assert.ok(first!.get().changedFiles.length > 0 && first!.get().commandsRun.length > 0);

  // Model loops back and re-plans the SAME goal (rephrased/punctuated): work must survive.
  liveSessionState.reset("create stats py with a median function!!");
  const after = liveSessionState.getLedger();
  assert.equal(after, first, "same-goal re-entry must keep the SAME ledger instance");
  assert.deepEqual(after!.get().changedFiles, ["stats.py"], "the recorded file change must be preserved");
  assert.equal(after!.get().commandsRun.length, 1, "the recorded command must be preserved");
});

test("reset mints a fresh ledger for a genuinely new goal", () => {
  liveSessionState.reset("Create stats.py with a median function");
  liveSessionState.getLedger()!.recordFileChange("stats.py");
  liveSessionState.reset("Add a slugify function to slug.py");
  const fresh = liveSessionState.getLedger();
  assert.equal(fresh!.get().changedFiles.length, 0, "a new goal must not inherit the old goal's work");
  assert.match(fresh!.get().userGoal, /slugify/);
});

test("isReentryGoal is false without work and false once the ledger is finalized", () => {
  liveSessionState.reset("Fix the parser bug");
  assert.equal(liveSessionState.isReentryGoal("Fix the parser bug"), false, "no work yet -> not a preserving re-entry");
  liveSessionState.getLedger()!.recordFileChange("parser.ts");
  assert.equal(liveSessionState.isReentryGoal("Fix the parser bug"), true, "same goal + work -> preserve");
  assert.equal(liveSessionState.isReentryGoal("Write a totally different feature"), false, "different goal -> fresh");
  liveSessionState.getLedger()!.finalize(true, "done");
  assert.equal(liveSessionState.isReentryGoal("Fix the parser bug"), false, "a finalized task is not an open re-entry");
});

test("a passing test stage clears stray exploratory failures so the gate is satisfiable", () => {
  const ledger = new CompletionLedger("fix the thing");
  ledger.recordFileChange("src/a.ts");
  ledger.recordCommandResult("ls nonexistent", false, "unknown"); // stage-less exploratory failure
  ledger.recordVerificationStage({ stage: "focused_tests", status: "ok", summary: "ok", failureClass: "unknown", artifacts: [], signals: {} });
  assert.equal(ledgerAllowsFinish(ledger).allowed, true, "a real passing test stage must clear stray exploratory failures");
});

test("a failed read-only inspection probe never latches a finish-blocking failure", () => {
  // The model probes state BEFORE it creates the artifact: `openssl x509 -in server.crt` and
  // `git show <hash>` fail because the file/commit is not there yet. Those are precondition probes,
  // not task failures, so they must not wedge the finish gate on a phantom the model then wastes
  // turns fighting (this is what failed the openssl-cert task and forced a waiver finish).
  const ledger = new CompletionLedger("create a self-signed cert");
  ledger.recordFileChange("app/ssl/server.crt");
  ledger.recordCommandResult("openssl x509 -in /app/ssl/server.crt -noout -subject", false, "dependency");
  ledger.recordCommandResult("git show 650dba4 --stat", false, "unknown");
  assert.equal(ledger.get().unresolvedFailures.length, 0, "read-only probes must not latch a finish blocker");
  // With the phantom probe-failures gone, a passing verification stage now satisfies the gate
  // (before the fix, the latched probe failure blocked finish and forced a waiver).
  ledger.recordVerificationStage({ stage: "full_tests", status: "ok", summary: "ok", failureClass: "unknown", artifacts: [], signals: {} });
  assert.equal(ledgerAllowsFinish(ledger).allowed, true);
});

test("a failed WRITING command (openssl genrsa / git commit) still latches - not a probe", () => {
  // The probe relaxation must not swallow a real mutation failure: generating a key or committing
  // are writes, so a genuine failure must still block the gate.
  const ledger = new CompletionLedger("create a self-signed cert");
  ledger.recordFileChange("app/ssl/server.key");
  ledger.recordCommandResult("openssl genrsa -out /app/ssl/server.key 2048", false, "command_invocation");
  assert.equal(ledger.get().unresolvedFailures.length, 1, "a failed mutation must still latch");
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
