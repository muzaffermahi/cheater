import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { attributeErrors, detectTypecheckCommand, runTypeCheckGate } from "../src/reliability/typeCheckGate.js";
import { gradeCommitlet } from "../src/commitlet/kernel.js";
import { createCommitletPlan } from "../src/commitlet/planner.js";
import { routeAutopilot } from "../src/autopilot/router.js";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { defaultCommitletState } from "../src/commitlet/state.js";

const TS_ERR = "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.";
const OTHER_ERR = "src/other.ts(9,1): error TS2304: Cannot find name 'foo'.";

function fakeRun(stdout: string, returncode = 1, timedOut = false) {
  return () => ({ returncode, stdout, stderr: "", timedOut });
}

/** Write a fake local `tsc` bin that emits `stdout` and exits nonzero, for the current platform. */
function installFakeTsc(cwd: string, stdout: string): void {
  mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(cwd, "tsconfig.json"), "{}\n", "utf8");
  if (process.platform === "win32") {
    writeFileSync(join(cwd, "node_modules", ".bin", "tsc.cmd"), `@echo off\r\necho ${stdout}\r\nexit /b 1\r\n`, "utf8");
  } else {
    const bin = join(cwd, "node_modules", ".bin", "tsc");
    writeFileSync(bin, `#!/bin/sh\necho "${stdout.replace(/"/g, '\\"')}"\nexit 1\n`, "utf8");
    chmodSync(bin, 0o755);
  }
}

// --- pure policy ----------------------------------------------------------------------------

test("the typecheck gate runs by default", () => {
  const on = runTypeCheckGate({ cwd: process.cwd(), changedFiles: ["src/a.ts"], config: DEFAULT_CONFIG, run: fakeRun("", 0) });
  assert.equal(on.ran, true, "runs by default");
});

test("attributeErrors splits changed-file errors from pre-existing debt", () => {
  const { changedFileErrors, otherErrorCount } = attributeErrors(`${TS_ERR}\n${OTHER_ERR}`, ["src/a.ts"]);
  assert.equal(changedFileErrors.length, 1);
  assert.match(changedFileErrors[0], /TS2322/);
  assert.equal(otherErrorCount, 1);
});

test("detectTypecheckCommand returns null without a tsconfig", () => {
  const empty = mkdtempSync(join(tmpdir(), "cheater-tc-none-"));
  assert.equal(detectTypecheckCommand(empty), null);
});

test("gate hard-blocks a changed-file type error", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-tc-block-"));
  installFakeTsc(cwd, TS_ERR);
  const result = runTypeCheckGate({ cwd, changedFiles: ["src/a.ts"], config: { ...DEFAULT_CONFIG }, run: fakeRun(TS_ERR) });
  assert.equal(result.ran, true);
  assert.equal(result.ok, false);
  assert.equal(result.blocking, true);
  assert.match(result.summary, /error\(s\) in changed files/);
});

test("gate WARNS (never blocks) on pre-existing errors not caused by this change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-tc-warn-"));
  installFakeTsc(cwd, OTHER_ERR);
  const result = runTypeCheckGate({ cwd, changedFiles: ["src/a.ts"], config: { ...DEFAULT_CONFIG }, run: fakeRun(OTHER_ERR) });
  assert.equal(result.ran, true);
  assert.equal(result.ok, false);
  assert.equal(result.blocking, false, "pre-existing debt must not dead-end the change");
  assert.match(result.summary, /pre-existing/);
});

test("gate passes on a clean typecheck", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-tc-clean-"));
  installFakeTsc(cwd, "");
  const result = runTypeCheckGate({ cwd, changedFiles: ["src/a.ts"], config: { ...DEFAULT_CONFIG }, run: fakeRun("", 0) });
  assert.equal(result.ok, true);
  assert.equal(result.blocking, false);
});

test("a timeout is recorded but never blocks (no dead-end on a slow typecheck)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-tc-timeout-"));
  installFakeTsc(cwd, TS_ERR);
  const result = runTypeCheckGate({ cwd, changedFiles: ["src/a.ts"], config: { ...DEFAULT_CONFIG }, run: fakeRun("", 1, true) });
  assert.equal(result.ran, true);
  assert.equal(result.blocking, false);
  assert.match(result.summary, /timed out/);
});

test("blocking policy can be disabled (observe-only mode)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-tc-observe-"));
  installFakeTsc(cwd, TS_ERR);
  const result = runTypeCheckGate({ cwd, changedFiles: ["src/a.ts"], config: { ...DEFAULT_CONFIG, typeCheckGateBlocking: false }, run: fakeRun(TS_ERR) });
  assert.equal(result.ran, true);
  assert.equal(result.blocking, false);
});

test("non-TypeScript changes skip the gate honestly", () => {
  const result = runTypeCheckGate({ cwd: process.cwd(), changedFiles: ["README.md", "data.json"], config: { ...DEFAULT_CONFIG } });
  assert.equal(result.ran, false);
});

// --- LIVE WIRING: gradeCommitlet blocks a type-incorrect edit that the tests do NOT catch -----

test("gradeCommitlet fails a commitlet whose tests pass but whose changed file has a type error", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-tc-wire-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a: number = 1;\n", "utf8");
  installFakeTsc(root, TS_ERR); // fake tsc always reports a changed-file error

  const decision = routeAutopilot({ cwd: root, message: "change the value in a.ts" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "change the value in a.ts", autopilotDecision: decision });
  const base = {
    ...plan.commitlets[0],
    allowedFiles: ["src/a.ts"],
    expectedFilesTouched: ["src/a.ts"],
    // Focused verification PASSES - the only failure signal is the typecheck gate.
    focusedVerification: [{ command: "node -e \"process.exit(0)\"", purpose: "pass", required: true }]
  };
  const rollbackPoint = createRollbackPoint(root, base);
  writeFileSync(join(root, "src", "a.ts"), "export const a: number = \"oops\";\n", "utf8");

  defaultCommitletState.clear();
  liveSessionState.reset("change the value in a.ts");

  const grade = await gradeCommitlet(root, { ...base, rollbackPoint, status: "running" as const }, { ...DEFAULT_CONFIG });

  // Tests passed, but the type error in the changed file blocked the pass and queued a repair.
  assert.equal(grade.advance, true, "a blocked commitlet advances by queuing a bounded repair (escapable, not a dead-end)");
  const repair = (grade.details as { repair?: { spec: { observedFailure: string } } }).repair;
  assert.ok(repair, "a repair commitlet must be created for the type error");
  assert.match(repair.spec.observedFailure, /Typecheck failed|TS2322/);

  // The typecheck stage is recorded as failed in the ledger (finish gate stays blocked on it).
  const stages = liveSessionState.getLedger()!.get().verification;
  const typecheckStage = stages.find((stage) => stage.stage === "typecheck");
  assert.ok(typecheckStage, "a typecheck verification stage must be recorded");
  assert.equal(typecheckStage!.status, "failed");
  defaultCommitletState.clear();
});

// --- LIVE WIRING: an empty diff (claimed success, wrote nothing) never grades as "verified" ------

test("gradeCommitlet refuses to pass a commitlet that changed nothing on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-empty-diff-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

  const decision = routeAutopilot({ cwd: root, message: "change the value in a.ts" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "change the value in a.ts", autopilotDecision: decision });
  assert.ok(plan.commitlets[0]?.healthBudget, "sanity: the plan produced a real commitlet to grade");
  const base = {
    ...plan.commitlets[0],
    allowedFiles: ["src/a.ts"],
    expectedFilesTouched: ["src/a.ts"],
    // Focused verification would PASS vacuously - the ONLY reason this must not advance is the empty diff.
    focusedVerification: [{ command: "node -e \"process.exit(0)\"", purpose: "pass", required: true }]
  };
  const rollbackPoint = createRollbackPoint(root, base);
  // Deliberately do NOT modify src/a.ts: the worker/model "claimed" success but wrote nothing.

  defaultCommitletState.clear();
  liveSessionState.reset("change the value in a.ts");

  const grade = await gradeCommitlet(root, { ...base, rollbackPoint, status: "running" as const }, DEFAULT_CONFIG);
  assert.equal(grade.advance, false, "an empty diff is never a verified pass (this is the fake-progress hole)");
  assert.match(grade.message, /No file changes were recorded/i);
  defaultCommitletState.clear();
});
