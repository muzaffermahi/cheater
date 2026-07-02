import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isBackendError,
  noteWorkerBackend,
  probeWorkerBackend,
  resetWorkerBackendLatch,
  workerBackendState,
  type FreshAgentPacketRunner
} from "../src/blueprint/worker.js";
import { wantsRealWorker } from "../src/commitlet/tools.js";
import { attemptStance, attemptThinkingLevel, buildCommitletExecutionPrompt, observedFailureForAttempt } from "../src/commitlet/executor.js";
import { runResampledWorker } from "../src/commitlet/resampling.js";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import { createCommitletPlan, createRepairCommitlet } from "../src/commitlet/planner.js";
import { routeAutopilot } from "../src/autopilot/router.js";
import { CompletionLedger } from "../src/reliability/lifecycle.js";
import { buildCompletionReceipt } from "../src/extension.js";
import type { Commitlet, CommitletPlan } from "../src/commitlet/types.js";

// Production contract for the pass@k engine: fresh workers auto-enable only from VERIFIED
// backend evidence, attempts are meaningfully diverse and start from clean state, selection
// stays deterministic, and the receipt reports what actually happened.

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-prod-resample-"));
  writeFileSync(join(cwd, "target.txt"), "original\n", "utf8");
  return cwd;
}

const CHECK = `node -e "process.exit(require('fs').readFileSync('target.txt','utf8').includes('good')?0:1)"`;

function makeCommitlet(cwd: string, allowedFiles = ["target.txt"]): Commitlet {
  const commitlet: Commitlet = {
    id: "c1", title: "edit target", purpose: "make target good", status: "running", scope: "edit",
    allowedFiles, forbiddenFiles: [], allowedActions: ["edit"], forbiddenActions: [],
    maxFilesTouched: allowedFiles.length, maxDiffLines: 200, maxToolCalls: 5, maxModelCalls: 1,
    expectedFilesTouched: allowedFiles,
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

// --- fresh-worker auto-enable: verified evidence only -------------------------------------

test("probe latches AVAILABLE only when a model actually resolved; heuristic default follows", async () => {
  resetWorkerBackendLatch();
  assert.equal(wantsRealWorker({}, {}, { model: { id: "m" } }), false, "unknown latch means simulated, even with a live session model");
  const probe = await probeWorkerBackend("C:/anywhere", async () => ({ session: { model: { id: "qwen-35b" }, dispose() {} } }));
  assert.equal(probe.ok, true);
  assert.match(probe.reason, /verified: model qwen-35b/);
  assert.equal(workerBackendState(), "available");
  assert.equal(wantsRealWorker({}, {}, {}), true, "verified probe evidence enables real workers by default");
  resetWorkerBackendLatch();
});

test("probe latches UNAVAILABLE when the session has no resolvable model (auth missing)", async () => {
  resetWorkerBackendLatch();
  // Pi creates a session even with nothing configured; only session.model proves the backend.
  const probe = await probeWorkerBackend("C:/anywhere", async () => ({ session: { model: undefined, dispose() {} } }));
  assert.equal(probe.ok, false);
  assert.equal(workerBackendState(), "unavailable");
  assert.equal(wantsRealWorker({}, {}, { model: { id: "m" } }), false);
  resetWorkerBackendLatch();
});

test("probe latches UNAVAILABLE on session-creation failure and runs at most once", async () => {
  resetWorkerBackendLatch();
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error("no provider configured"); };
  const first = await probeWorkerBackend("C:/anywhere", failing);
  assert.equal(first.ok, false);
  const second = await probeWorkerBackend("C:/anywhere", failing);
  assert.match(second.reason, /already latched/);
  assert.equal(calls, 1, "a latched outcome must not re-probe");
  resetWorkerBackendLatch();
});

test("explicit config and explicit param always beat the latch", () => {
  resetWorkerBackendLatch();
  noteWorkerBackend(true);
  assert.equal(wantsRealWorker({}, { commitletFreshWorkerDefault: false }, {}), false, "config off wins over an available backend");
  noteWorkerBackend(false);
  assert.equal(wantsRealWorker({ spawnFreshWorker: true }, {}, {}), true, "explicit request wins and resets the latch for retry");
  assert.equal(workerBackendState(), "unknown");
  resetWorkerBackendLatch();
});

test("prompt-time backend errors are recognized as backend failures, not packet failures", () => {
  assert.equal(isBackendError("Error: No model selected.\n\nUse /login..."), true);
  assert.equal(isBackendError("No API key found for openai"), true);
  assert.equal(isBackendError("No models available. Use /login to log into a provider"), true);
  assert.equal(isBackendError("AssertionError: expected 3 got 4"), false);
  assert.equal(isBackendError("SyntaxError: unexpected token"), false);
});

// --- attempt diversity ---------------------------------------------------------------------

test("attempts differ on three axes: stance, thinking level, and evidence strategy", () => {
  assert.equal(attemptStance(1), "");
  assert.match(attemptStance(2), /smallest possible correct change/);
  assert.match(attemptStance(3), /root cause/);
  assert.notEqual(attemptStance(2), attemptStance(3));

  assert.equal(attemptThinkingLevel(1), undefined, "attempt 1 keeps the session default (byte-identical single-sample behavior)");
  assert.equal(attemptThinkingLevel(2), "high");
  assert.equal(attemptThinkingLevel(3), "off");

  const failure = "=== FAILURE SUMMARY ===\nAssertionError: boom\n=== CHEATER CHEAT SHEET (evidence = hypotheses, not truth) ===\n[1] experience/high: x";
  assert.equal(observedFailureForAttempt(failure, 1), failure, "attempt 1 sees the full evidence");
  assert.equal(observedFailureForAttempt(failure, 2), failure);
  assert.doesNotMatch(observedFailureForAttempt(failure, 3)!, /CHEAT SHEET/, "the root-cause attempt re-derives without the evidence");
  assert.match(observedFailureForAttempt(failure, 3)!, /AssertionError: boom/, "the raw failure card is always kept");
});

test("repair packets differ per attempt: evidence present on attempt 1, withheld on attempt 3", () => {
  const cwd = makeRepo();
  const decision = routeAutopilot({ cwd, message: "fix target" });
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "fix target", autopilotDecision: decision });
  const failed = { ...plan.commitlets[0], allowedFiles: ["target.txt"], expectedFilesTouched: ["target.txt"] };
  const repair = createRepairCommitlet(failed, "AssertionError: boom\n=== CHEATER CHEAT SHEET (evidence = hypotheses, not truth) ===\n[1] experience/high: prior fix");
  const attempt1 = buildCommitletExecutionPrompt({ ...plan, repoRoot: cwd }, repair, [], "real", 1).prompt;
  const attempt3 = buildCommitletExecutionPrompt({ ...plan, repoRoot: cwd }, repair, [], "real", 3).prompt;
  assert.match(attempt1, /CHEAT SHEET/);
  assert.doesNotMatch(attempt3, /CHEAT SHEET/);
  assert.match(attempt3, /AssertionError: boom/);
  assert.notEqual(attempt1, attempt3);
});

test("the runner receives a different thinking level per resample attempt", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  const seen: Array<string | undefined> = [];
  const runner: FreshAgentPacketRunner = {
    async runPacket(params) {
      seen.push(params.thinkingLevel);
      return { ok: true, summary: "attempt done (no edit)" };
    }
  };
  await runResampledWorker(plan, commitlet, { commitletCandidateSamples: 3 }, runner);
  assert.deepEqual(seen, [undefined, "high", "off"]);
});

// --- clean state between attempts ------------------------------------------------------------

test("a file CREATED by a failing attempt is removed before the next attempt (no poisoning)", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd, ["target.txt", "scratch.txt"]);
  const plan = makePlan(cwd, commitlet);
  const observedScratch: boolean[] = [];
  let call = 0;
  const runner: FreshAgentPacketRunner = {
    async runPacket() {
      call += 1;
      observedScratch.push(existsSync(join(cwd, "scratch.txt")));
      if (call === 1) {
        // Failing attempt: wrong edit plus a NEW file inside the allowed scope.
        writeFileSync(join(cwd, "target.txt"), "wrong\n", "utf8");
        writeFileSync(join(cwd, "scratch.txt"), "leftover debris\n", "utf8");
      } else {
        writeFileSync(join(cwd, "target.txt"), "good v2\n", "utf8");
      }
      return { ok: true, summary: `attempt ${call}` };
    }
  };
  const outcome = await runResampledWorker(plan, commitlet, { commitletCandidateSamples: 2 }, runner);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.appliedAttempt, 2);
  assert.deepEqual(observedScratch, [false, false], "attempt 2 must not see attempt 1's created file");
  assert.equal(existsSync(join(cwd, "scratch.txt")), false, "the winning candidate does not include the loser's debris");
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /good v2/);
});

// --- receipts -------------------------------------------------------------------------------

test("the completion receipt truthfully reports resampling, worker mode, and evidence use", () => {
  const ledger = new CompletionLedger("fix target");
  ledger.recordFileChange("target.txt");
  ledger.recordCommand("pytest -q");
  ledger.recordVerificationStage({ stage: "focused_tests", status: "ok", summary: "ok", failureClass: "unknown", artifacts: [], signals: {} });
  ledger.addEntry("resample", "verified resampling: attempt 2/3 passed", {
    attemptsRun: 2, samplesRequested: 3, appliedAttempt: 2, passed: true, freshWorkerMode: "real"
  });
  ledger.addEntry("cheat_evidence", "trigger library_api_error", { sources: ["experience", "api_oracle"] });
  const receipt = buildCompletionReceipt(ledger);
  assert.match(receipt, /resampling: attempt 2\/2 applied \(verified pass\); workers: real/);
  assert.match(receipt, /evidence: cheat sheet used \(experience, api_oracle\)/);
});

test("the receipt reports a degraded worker mode and a best-failing-candidate outcome honestly", () => {
  const ledger = new CompletionLedger("fix target");
  ledger.recordFileChange("target.txt");
  ledger.addEntry("resample", "backend unavailable", {
    attemptsRun: 1, samplesRequested: 3, appliedAttempt: 1, passed: false, freshWorkerMode: "unavailable"
  });
  const receipt = buildCompletionReceipt(ledger);
  assert.match(receipt, /resampling: attempt 1\/1 applied \(best failing candidate\); workers: unavailable/);
});

test("a receipt with no resample entries claims nothing about resampling", () => {
  const ledger = new CompletionLedger("simple edit");
  ledger.recordFileChange("a.ts");
  const receipt = buildCompletionReceipt(ledger);
  assert.doesNotMatch(receipt, /resampling:/);
  assert.doesNotMatch(receipt, /evidence:/);
});
