import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import { runDiffGuard } from "../src/commitlet/guard.js";
import { runResampledWorker, scoreCandidate, captureCandidate, applyCandidate, rankAttempt } from "../src/commitlet/resampling.js";
import type { Commitlet, CommitletPlan } from "../src/commitlet/types.js";
import type { FreshAgentPacketRunner } from "../src/blueprint/worker.js";

// Verification passes iff target.txt contains "good".
const CHECK = `node -e "process.exit(require('fs').readFileSync('target.txt','utf8').includes('good')?0:1)"`;

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-resample-"));
  writeFileSync(join(cwd, "target.txt"), "original\n", "utf8");
  return cwd;
}

function makeCommitlet(cwd: string): Commitlet {
  const commitlet: Commitlet = {
    id: "c1", title: "edit target", purpose: "make target good", status: "running", scope: "edit",
    allowedFiles: ["target.txt"], forbiddenFiles: [], allowedActions: ["edit"], forbiddenActions: [],
    maxFilesTouched: 1, maxDiffLines: 200, maxToolCalls: 5, maxModelCalls: 1,
    expectedFilesTouched: ["target.txt"],
    focusedVerification: [{ command: CHECK, purpose: "content check", required: true }],
    broaderVerification: [],
    healthBudget: { maxComplexityIncrease: 5, maxDuplicationIncrease: 5, maxFunctionLengthIncrease: 5, allowNewLargeFunction: false, allowTestEdits: false, allowDependencyEdits: false, allowLockfileEdits: false },
    risk: "low"
  };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  return commitlet;
}

function makePlan(cwd: string, commitlet: Commitlet): CommitletPlan {
  return {
    id: "plan1", createdAt: new Date().toISOString(), repoRoot: cwd, userGoal: "make target good",
    summary: "test plan", status: "running", currentIndex: 0, commitlets: [commitlet],
    globalConstraints: []
  } as unknown as CommitletPlan;
}

/** Fake runner: each call runs the next scripted edit against the repo. */
function scriptedRunner(cwd: string, edits: Array<(attempt: number) => void>, observed: string[] = []): FreshAgentPacketRunner {
  let call = 0;
  return {
    async runPacket() {
      observed.push(readFileSync(join(cwd, "target.txt"), "utf8").trim());
      const edit = edits[Math.min(call, edits.length - 1)];
      call += 1;
      edit(call);
      return { ok: true, summary: `attempt ${call} done` };
    }
  };
}

test("first verified pass accepts immediately with no wasted samples", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  const runner = scriptedRunner(cwd, [() => writeFileSync(join(cwd, "target.txt"), "good v1\n", "utf8")]);
  const outcome = await runResampledWorker(plan, commitlet, { commitletCandidateSamples: 3 }, runner);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.attemptsRun, 1, "early exit: no resample after a verified pass");
  assert.equal(outcome.appliedAttempt, 1);
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /good v1/);
});

test("adaptive compute (P1a) raises the sample count for a HARD commitlet", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = { ...makePlan(cwd, commitlet), risk: "high", autopilotDecision: { taskKind: "bug_fix" } } as unknown as CommitletPlan;
  const runner = scriptedRunner(cwd, [() => writeFileSync(join(cwd, "target.txt"), "bad\n", "utf8")]); // never passes -> runs every sample
  const outcome = await runResampledWorker(plan, commitlet, { adaptiveComputeEnabled: true, adaptiveMaxSamples: 8 }, runner);
  assert.ok(outcome.samplesRequested >= 4, `hard commitlet should request several samples, got ${outcome.samplesRequested}`);
  assert.equal(outcome.attemptsRun, outcome.samplesRequested, "all samples run when none pass");
});

test("adaptive compute (P1a) keeps k=1 for a trivial commitlet; OFF path ignores hardness", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const trivialPlan = { ...makePlan(cwd, commitlet), risk: "low", autopilotDecision: { taskKind: "trivial" } } as unknown as CommitletPlan;
  const runner = scriptedRunner(cwd, [() => writeFileSync(join(cwd, "target.txt"), "bad\n", "utf8")]);
  const adaptive = await runResampledWorker(trivialPlan, commitlet, { adaptiveComputeEnabled: true }, runner);
  assert.equal(adaptive.samplesRequested, 1, "trivial commitlet -> k=1 even with adaptive on");

  const cwd2 = makeRepo();
  const c2 = makeCommitlet(cwd2);
  const hardOffPlan = { ...makePlan(cwd2, c2), risk: "high", autopilotDecision: { taskKind: "bug_fix" } } as unknown as CommitletPlan;
  const runner2 = scriptedRunner(cwd2, [() => writeFileSync(join(cwd2, "target.txt"), "bad\n", "utf8")]);
  const off = await runResampledWorker(hardOffPlan, c2, { commitletCandidateSamples: 2 }, runner2);
  assert.equal(off.samplesRequested, 2, "adaptive OFF -> static commitletCandidateSamples, hardness ignored");
});

test("failed attempt is reverted and a later fresh sample wins", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  const observed: string[] = [];
  const runner = scriptedRunner(cwd, [
    () => writeFileSync(join(cwd, "target.txt"), "bad attempt\n", "utf8"),
    () => writeFileSync(join(cwd, "target.txt"), "good v2\n", "utf8")
  ], observed);
  const outcome = await runResampledWorker(plan, commitlet, { commitletCandidateSamples: 3 }, runner);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.attemptsRun, 2);
  assert.equal(outcome.appliedAttempt, 2);
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /good v2/);
  // Independent samples: attempt 2 must have started from the CLEAN snapshot, not attempt 1's
  // failure (context/state poisoning is exactly what resampling avoids).
  assert.equal(observed[1], "original", "second worker must see the reverted original file");
});

test("the liveness heartbeat callback is threaded down to the worker runner", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  let received: ((ms: number) => void) | undefined;
  const runner: FreshAgentPacketRunner = {
    async runPacket(params: { onHeartbeat?: (ms: number) => void }) {
      received = params.onHeartbeat;
      params.onHeartbeat?.(21_000); // simulate a mid-stream tick
      writeFileSync(join(cwd, "target.txt"), "good hb\n", "utf8");
      return { ok: true, summary: "done" };
    }
  };
  const beats: number[] = [];
  await runResampledWorker(plan, commitlet, {}, runner, undefined, undefined, (ms) => beats.push(ms));
  assert.equal(typeof received, "function", "the worker runner must receive an onHeartbeat callback so a streaming local run never looks hung");
  assert.deepEqual(beats, [21_000], "the heartbeat forwards elapsed ms to the caller's spinner updater");
});

test("when nothing passes, the best-ranked candidate stays applied for the repair path", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  // Attempt 1: small failing edit (better health/diff). Attempt 2: no edit at all (worse).
  const runner = scriptedRunner(cwd, [
    () => writeFileSync(join(cwd, "target.txt"), "close but wrong\n", "utf8"),
    () => { /* worker does nothing */ }
  ]);
  const outcome = await runResampledWorker(plan, commitlet, { commitletCandidateSamples: 2 }, runner);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.attemptsRun, 2);
  assert.equal(outcome.appliedAttempt, 1, "an actual failing edit outranks a no-op attempt");
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /close but wrong/, "best candidate re-applied to disk");
  assert.match(outcome.note, /kept best candidate/);
});

test("default of one sample preserves today's single-attempt behavior", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  const runner = scriptedRunner(cwd, [() => writeFileSync(join(cwd, "target.txt"), "still wrong\n", "utf8")]);
  const outcome = await runResampledWorker(plan, commitlet, {}, runner);
  assert.equal(outcome.attemptsRun, 1);
  assert.equal(outcome.passed, false);
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /still wrong/, "single attempt left in place for repair");
});

test("scoreCandidate skips verification when the guard rejects the diff", () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  // Edit a file outside allowedFiles -> guard failure, verification must not run.
  writeFileSync(join(cwd, "target.txt"), "good but oversized\n".repeat(300), "utf8");
  const score = scoreCandidate(cwd, { ...commitlet, maxDiffLines: 5 }, {});
  assert.equal(score.guardPassed, false);
  assert.equal(score.verifyPassed, false);
  assert.equal(score.passed, false);
});

test("capture/apply round-trips file bytes including deletion", () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  writeFileSync(join(cwd, "target.txt"), "candidate content\n", "utf8");
  const snap = captureCandidate(cwd, commitlet);
  writeFileSync(join(cwd, "target.txt"), "overwritten\n", "utf8");
  applyCandidate(cwd, snap);
  assert.equal(readFileSync(join(cwd, "target.txt"), "utf8"), "candidate content\n");
});

test("guard allows editing a source file named in the verification command, blocks test files", () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  // Source file named in the verification command (CHECK reads target.txt): editable.
  const srcGuard = runDiffGuard(commitlet, { touchedFiles: ["target.txt"], diffText: "-a\n+b" });
  assert.equal(srcGuard.passed, true, "repro-command commitlets must not false-block their own edit target");
  // A test file named in the command stays protected without allowTestEdits.
  const testCommitlet = {
    ...commitlet,
    allowedFiles: ["tests/test_target.py"],
    focusedVerification: [{ command: "pytest tests/test_target.py", purpose: "focused", required: true }]
  };
  const testGuard = runDiffGuard(testCommitlet, { touchedFiles: ["tests/test_target.py"], diffText: "-a\n+b" });
  assert.equal(testGuard.passed, false, "the test the commitlet is graded by must stay locked");
  assert.match(testGuard.blockingIssues.join(" "), /verification target/i);
});

test("ranking prefers edits, then guard-passing, then fewer failures, then health", () => {
  const base = { index: 1, workerResult: { ok: true, summary: "" }, snapshot: new Map() };
  const mk = (over: Partial<any>) => ({ ...base, score: { touchedFiles: ["x"], diffLines: 10, guardPassed: true, healthPassed: true, healthScore: 90, verifyPassed: false, verifyFailureCount: 1, passed: false, summary: "", ...over } }) as any;
  assert.ok(rankAttempt(mk({}))[0] === 1);
  assert.ok(rankAttempt(mk({ touchedFiles: [] }))[0] === 0, "no-op attempts rank last");
  const guardFail = rankAttempt(mk({ guardPassed: false }));
  const guardPass = rankAttempt(mk({}));
  assert.ok(guardPass[1] > guardFail[1]);
});
