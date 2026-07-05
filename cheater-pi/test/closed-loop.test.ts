import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClosedLoopCommitlets, type ClosedLoopDeps } from "../src/commitlet/closedLoop.js";
import { buildCommitletExecutionPrompt } from "../src/commitlet/executor.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { steeringControl } from "../src/runstate/steering.js";
import { beginTaskRun, endTaskRun, resetTaskRunForTests } from "../src/runstate/runState.js";
import { checkCapsuleInvariants } from "../src/runstate/invariants.js";
import type { Commitlet, CommitletPlan } from "../src/commitlet/types.js";
import type { CheaterConfig } from "../src/types.js";

// The closed-loop executor is the architecture change that removes the model from the
// orchestration bus: the harness prepares, spawns, grades, repairs, advances, finalizes, and
// gates - the model only implements inside bounded workers. These tests prove the state
// machine (multi-commitlet advance, stop-on-failure, automatic repair, honest degradation)
// with injected deps; the DEFAULT deps are the one real kernel, pinned by the existing
// commitlet-kernel/live-wiring suites.

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-closed-loop-"));
}

const CONFIG: CheaterConfig = { runStateEnabled: false, telemetryEnabled: false };

function commitletFixture(id: string, title: string): Commitlet {
  return {
    id,
    title,
    purpose: title,
    status: "pending",
    scope: "code",
    allowedFiles: ["src/app.ts"],
    forbiddenFiles: [],
    allowedActions: ["inspect", "edit", "run_test", "stop_blocked"],
    forbiddenActions: [],
    maxFilesTouched: 1,
    maxDiffLines: 120,
    maxToolCalls: 10,
    maxModelCalls: 1,
    expectedFilesTouched: ["src/app.ts"],
    focusedVerification: [{ command: "npm test", purpose: "focused", required: true }],
    broaderVerification: [],
    healthBudget: {
      maxComplexityIncrease: 5,
      maxDuplicationIncrease: 5,
      maxFunctionLengthIncrease: 30,
      allowNewLargeFunction: false,
      allowTestEdits: false,
      allowDependencyEdits: false,
      allowLockfileEdits: false
    },
    spec: {
      behaviorMustHold: [title],
      behaviorMustNotChange: [],
      edgeCases: [],
      acceptanceCriteria: [title],
      temporaryTestsAllowed: false,
      permanentTestsAllowed: false,
      nonGoals: []
    },
    risk: "low"
  };
}

function planFixture(repoRoot: string, commitlets: Commitlet[]): CommitletPlan {
  return {
    id: "closed-loop-plan",
    createdAt: new Date().toISOString(),
    repoRoot,
    userGoal: "fix the widget",
    summary: `${commitlets.length} commitlet(s)`,
    commitlets,
    currentIndex: 0,
    status: "planning",
    globalConstraints: [],
    finalVerification: [],
    finalReview: {
      accepted: false,
      summary: "",
      commitlets: [],
      finalVerification: [],
      health: { score: 100, passed: true, warnings: [], blockingIssues: [], metrics: { diffLines: 0, filesTouched: 0, duplicationDelta: 0, complexityDelta: 0, largeFunctionDelta: 0, assertionDelta: 0 } },
      blockingIssues: [],
      warnings: [],
      suggestedFollowups: []
    },
    risk: "low"
  };
}

const CODE_DECISION = {
  executionMode: "vanilla_pi",
  executionDiscipline: "single_commitlet",
  taskKind: "bug_fix",
  risk: "low",
  confidence: 0.9,
  needsBlueprint: false,
  needsRepro: false,
  complexitySignals: [],
  reason: "test",
  userVisibleSummary: "test"
} as any;

interface FakeKernel {
  deps: Partial<ClosedLoopDeps>;
  workerRuns: string[];
  gradeCalls: string[];
}

/**
 * A fake kernel that mimics the REAL kernel's state transitions (grade marks statuses in
 * defaultCommitletState; finalize sets the plan terminal) without filesystem diffs or a
 * model backend. gradeBehavior decides per-commitlet what the grader observed.
 */
function fakeKernel(repoRoot: string, commitlets: Commitlet[], opts: {
  realWorkers?: boolean;
  workerResult?: (commitlet: Commitlet) => { ok: boolean; summary: string; error?: string };
  gradeBehavior?: (commitlet: Commitlet) => "pass" | "fail_stop" | "fail_create_repair";
  finishAllowed?: boolean;
} = {}): FakeKernel {
  const workerRuns: string[] = [];
  const gradeCalls: string[] = [];
  const gradeBehavior = opts.gradeBehavior ?? (() => "pass");
  const deps: Partial<ClosedLoopDeps> = {
    route: (() => CODE_DECISION) as any,
    createPlan: (() => planFixture(repoRoot, commitlets)) as any,
    prepare: ((_cwd: string, commitlet: Commitlet) => ({ ...commitlet, status: "running" as const })) as any,
    // Model the REAL resolveWorkerMode: spawnFreshWorker:false forces in-session (no worker), which is
    // how the scaffold lane and the #3 single-commitlet fix run the main model instead of a cold worker.
    resolveWorkerMode: (async (input: { spawnFreshWorker?: boolean }) => opts.realWorkers !== false && input?.spawnFreshWorker !== false) as any,
    runWorker: (async (_plan: CommitletPlan, commitlet: Commitlet) => {
      workerRuns.push(commitlet.id);
      const result = opts.workerResult?.(commitlet) ?? { ok: true, summary: `worker done: ${commitlet.id}` };
      return { workerResult: result, attemptsRun: 1, samplesRequested: 1, appliedAttempt: 1, passed: result.ok, note: `resample note ${commitlet.id}` };
    }) as any,
    grade: (async (_cwd: string, commitlet: Commitlet) => {
      gradeCalls.push(commitlet.id);
      const behavior = gradeBehavior(commitlet);
      if (behavior === "pass") {
        defaultCommitletState.updateCommitlet(commitlet.id, "passed", "verified");
        return { advance: true, message: `Commitlet ${commitlet.id} passed guard, health, and focused verification.`, details: {} };
      }
      if (behavior === "fail_create_repair") {
        const repair = { ...commitletFixture(`${commitlet.id}-repair`, `repair ${commitlet.title}`), spec: { ...commitletFixture(`${commitlet.id}-repair`, "r").spec!, observedFailure: "TypeError: boom" } };
        const plan = defaultCommitletState.get().currentPlan!;
        defaultCommitletState.setPlan({
          ...plan,
          commitlets: plan.commitlets.flatMap((item) => item.id === commitlet.id ? [{ ...item, status: "failed" as const }, repair] : [item])
        });
        return { advance: true, message: `focused verification failed\nCreated bounded repair commitlet: ${commitlet.id}-repair`, details: {} };
      }
      defaultCommitletState.updateCommitlet(commitlet.id, "failed", "guard blocked");
      return { advance: false, message: `Commitlet ${commitlet.id} blocked by guard/health/test audit.`, details: {} };
    }) as any,
    finalize: ((_cwd: string, plan: CommitletPlan) => {
      const review = { ...plan.finalReview, accepted: true, summary: "accepted", commitlets: plan.commitlets.map((c) => c.id) };
      const updated = { ...plan, finalReview: review, status: "complete" as const };
      defaultCommitletState.setPlan(updated);
      return { text: "final review accepted", details: { review, plan: updated } };
    }) as any,
    finish: (() => (opts.finishAllowed === false
      ? { allowed: false, reason: "verification missing", lines: ["Cheater Finish Gate: BLOCKED"], ledgerState: liveSessionState.getLedger()!.get() }
      : { allowed: true, reason: "verified", lines: ["Cheater Finish Gate: ALLOWED"], ledgerState: liveSessionState.getLedger()!.get() })) as any
  };
  return { deps, workerRuns, gradeCalls };
}

function reset(): void {
  defaultCommitletState.clear();
  liveSessionState.reset();
  resetTaskRunForTests();
}

test("closed loop executes a multi-commitlet chain with ZERO model orchestration calls", async () => {
  reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first"), commitletFixture("c2", "second")]);
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: CONFIG }, kernel.deps);
  assert.equal(result.status, "complete");
  assert.equal(result.ok, true);
  assert.equal(result.freshWorkerMode, "real");
  assert.deepEqual(kernel.workerRuns, ["c1", "c2"], "the harness ran BOTH workers itself - no cheater_commitlet_next call existed anywhere");
  assert.deepEqual(kernel.gradeCalls, ["c1", "c2"], "every worker output was graded in code before advancing");
  assert.equal(result.steps.filter((step) => step.outcome === "passed").length, 2);
  assert.ok(result.receipt, "a finish-gate-approved run produces the deterministic receipt");
  assert.match(result.summary, /Cheater Closed Loop: COMPLETE/);
  assert.equal(defaultCommitletState.get().currentPlan?.status, "complete");
});

test("steering channel queues corrections and a stop, and resets cleanly", () => {
  steeringControl.reset();
  assert.equal(steeringControl.stopRequested(), false);
  steeringControl.pushCorrection("use library X not Y");
  steeringControl.pushCorrection("");                       // empty is ignored
  assert.equal(steeringControl.pendingCount(), 1);
  assert.deepEqual(steeringControl.drainCorrections(), ["use library X not Y"]);
  assert.equal(steeringControl.pendingCount(), 0);
  assert.equal(steeringControl.appliedCount(), 1);
  steeringControl.requestStop();
  assert.equal(steeringControl.stopRequested(), true);
  steeringControl.reset();
  assert.equal(steeringControl.stopRequested(), false);
});

test("mid-run /steer stop halts the closed loop with preserved (non-complete) state", async () => {
  reset();
  steeringControl.reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first"), commitletFixture("c2", "second")]);
  // Simulate the user typing /steer stop mid-run: request it right after c1 is graded.
  const origGrade = kernel.deps.grade!;
  kernel.deps.grade = (async (cwd: string, c: Commitlet, cfg: CheaterConfig, o: any) => {
    const r = await (origGrade as any)(cwd, c, cfg, o);
    if (c.id === "c1") steeringControl.requestStop();
    return r;
  }) as any;
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: CONFIG }, kernel.deps);
  assert.equal(result.status, "partial");
  assert.match(result.summary, /Stopped by \/steer stop/);
  assert.notEqual(defaultCommitletState.get().currentPlan?.status, "complete", "state is preserved, not finalized");
  steeringControl.reset();
});

test("mid-run /steer <correction> folds into the plan's global constraints for upcoming commitlets", async () => {
  reset();
  steeringControl.reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first"), commitletFixture("c2", "second")]);
  const origGrade = kernel.deps.grade!;
  kernel.deps.grade = (async (cwd: string, c: Commitlet, cfg: CheaterConfig, o: any) => {
    const r = await (origGrade as any)(cwd, c, cfg, o);
    if (c.id === "c1") steeringControl.pushCorrection("always handle the empty input case");
    return r;
  }) as any;
  await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: CONFIG }, kernel.deps);
  assert.ok(
    (defaultCommitletState.get().currentPlan?.globalConstraints ?? []).some((g) => /always handle the empty input case/.test(g)),
    "the mid-run correction became a global constraint the later commitlets see"
  );
  steeringControl.reset();
});

test("RESILIENCE: a grade failure on one file does NOT abort the build - it records the failure and keeps building", async () => {
  reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first"), commitletFixture("c2", "second")], {
    gradeBehavior: (commitlet) => (commitlet.id === "c1" ? "fail_stop" : "pass")
  });
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: CONFIG }, kernel.deps);
  assert.equal(result.status, "partial", "one file's failure yields partial, not a whole-build abort");
  assert.deepEqual(kernel.workerRuns, ["c1", "c2"], "the build CONTINUED to c2 after c1 failed");
  assert.equal(defaultCommitletState.get().currentPlan?.commitlets.find((c) => c.id === "c2")?.status, "passed", "c2 was built");
  assert.deepEqual(((result.details as { failedCommitlets?: Array<{ id: string }> }).failedCommitlets ?? []).map((f) => f.id), ["c1"], "the failed file is recorded");
  assert.match(result.summary, /could not be completed/, "the report names what still needs fixing");
});

test("repair commitlets queued by grading are picked up and executed automatically", async () => {
  reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first")], {
    gradeBehavior: (commitlet) => (/-repair$/.test(commitlet.id) ? "pass" : "fail_create_repair")
  });
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: { ...CONFIG, singleCommitletInSession: false } }, kernel.deps);
  assert.equal(result.status, "complete");
  assert.deepEqual(kernel.workerRuns, ["c1", "c1-repair"], "the loop automatically continued into the repair worker");
  const outcomes = result.steps.map((step) => `${step.commitletId}:${step.outcome}`);
  assert.ok(outcomes.includes("c1:repair_created"));
  assert.ok(outcomes.includes("c1-repair:passed"));
});

test("repair budget is bounded: an exhausted repair is skipped and the build finishes partial, never loops", async () => {
  reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first")], {
    gradeBehavior: (commitlet) => (/-repair$/.test(commitlet.id) ? "pass" : "fail_create_repair")
  });
  // Explicit maxRepairRounds:0 forces the budget-exhausted path on the very first repair.
  // singleCommitletInSession:false keeps the single-commitlet WORKER path under test (#3 default is in-session).
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: { ...CONFIG, singleCommitletInSession: false }, maxRepairRounds: 0 }, kernel.deps);
  assert.equal(result.status, "partial", "budget exhausted -> partial, not a whole-build abort");
  assert.deepEqual(kernel.workerRuns, ["c1"], "the repair worker did not run past the budget");
  assert.ok(result.steps.some((step) => step.outcome === "skipped_repair_budget"), "the skipped repair is recorded");
  assert.match(result.summary, /could not be completed/);
});

test("simulated fallback is honest: no backend means partial + handoff prompt, never a fake completion", async () => {
  reset();
  const repo = tmpRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n", "utf8");
  // MULTI-commitlet so it exercises the fresh-worker path (a single commitlet now runs in-session by
  // design - see the #3 test below); with no backend that path degrades to the honest handoff.
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first"), commitletFixture("c2", "second")], { realWorkers: false });
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget in two places", config: CONFIG }, kernel.deps);
  assert.equal(result.status, "partial");
  assert.equal(result.ok, false);
  assert.equal(result.freshWorkerMode, "simulated");
  assert.equal(kernel.workerRuns.length, 0, "no worker was (or could be) spawned");
  assert.ok(result.handoffPrompt, "the session gets the first worker prompt to execute via the classic flow");
  assert.match(result.handoffPrompt!, /Cheater Reliability Kernel commitlet/);
  assert.match(result.summary, /simulated handoff required/);
  assert.ok(!result.receipt, "no verification happened, so no receipt may exist");
});

test("#3: a single-commitlet task runs IN-SESSION (main model), never a cold fresh worker", async () => {
  // The dominant hard-task friction: a cold fresh worker handed a single terminal/surgical commitlet
  // lacked the main model's exploration context, hallucinated paths, recorded no change, and graded
  // "blocked" -> the model thrashed. Even with a worker backend AVAILABLE, a single commitlet must run
  // in-session so the main model (which just explored) does it directly.
  reset();
  const repo = tmpRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n", "utf8");
  const kernel = fakeKernel(repo, [commitletFixture("c1", "build the thing")], { realWorkers: true });
  const result = await runClosedLoopCommitlets(
    { cwd: repo, userGoal: "build the C extension and install it", config: CONFIG, spawnFreshWorker: true },
    kernel.deps
  );
  assert.equal(kernel.workerRuns.length, 0, "a single-commitlet task must NOT spawn a fresh worker");
  assert.equal(result.freshWorkerMode, "simulated", "it degrades to the in-session flow");
  assert.ok(result.handoffPrompt, "the main model gets the step to do in-session");
  assert.match(result.summary, /runs IN-SESSION/);
});

test("in-session best-of-N (flag on) pre-builds a single-file commitlet before the simulated handoff", async () => {
  // The local best-of-N path: on a single-GPU box fresh-worker resampling is unavailable, so for a
  // single-file commitlet with samples>1 the harness itself runs k direct completions and leaves the
  // winner on disk BEFORE the handoff; the existing cheater_commitlet_next then grades it.
  reset();
  const repo = tmpRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n", "utf8");
  const kernel = fakeKernel(repo, [commitletFixture("c1", "build the thing")], { realWorkers: true });
  // prepare must yield a rollback snapshot so shouldResampleInSession engages (single-file commitlet).
  kernel.deps.prepare = ((_cwd: string, c: Commitlet) => ({ ...c, status: "running" as const, rollbackPoint: { id: "rb", createdAt: "t", snapshotDir: join(repo, ".snap"), description: "snap" } })) as any;
  const calls: Array<{ id: string; samples: number }> = [];
  kernel.deps.runInSession = (async (_plan: CommitletPlan, c: Commitlet, _cfg: CheaterConfig, _ctx: unknown, samples: number) => {
    calls.push({ id: c.id, samples });
    return { attemptsRun: samples, samplesRequested: samples, appliedAttempt: 2, passed: true, note: `in-session best-of-N: sample 2/${samples} passed guard+health+verification` };
  }) as any;
  const result = await runClosedLoopCommitlets(
    { cwd: repo, userGoal: "build a glob matcher", config: { ...CONFIG, inSessionResampleEnabled: true, commitletCandidateSamples: 3 }, spawnFreshWorker: true },
    kernel.deps
  );
  assert.equal(result.freshWorkerMode, "simulated", "a single commitlet runs in-session");
  assert.deepEqual(calls, [{ id: "c1", samples: 3 }], "in-session best-of-N ran k=3 for the single-file commitlet");
  assert.match(result.summary, /PRE-BUILT/, "the pre-built note is prepended to the handoff so the model grades, not rewrites");
  assert.ok(result.steps.some((step) => /best-of-N/.test(step.note)), "the pre-build is recorded as a step");
});

test("in-session best-of-N (flag off) never runs - byte-identical to today's simulated handoff", async () => {
  reset();
  const repo = tmpRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n", "utf8");
  const kernel = fakeKernel(repo, [commitletFixture("c1", "build the thing")], { realWorkers: true });
  kernel.deps.prepare = ((_cwd: string, c: Commitlet) => ({ ...c, status: "running" as const, rollbackPoint: { id: "rb", createdAt: "t", snapshotDir: join(repo, ".snap"), description: "snap" } })) as any;
  let called = false;
  kernel.deps.runInSession = (async () => { called = true; return { attemptsRun: 0, samplesRequested: 0, appliedAttempt: 0, passed: false, note: "" }; }) as any;
  const result = await runClosedLoopCommitlets(
    // flag OFF but samples would be >1: must still not engage.
    { cwd: repo, userGoal: "build a glob matcher", config: { ...CONFIG, commitletCandidateSamples: 3 }, spawnFreshWorker: true },
    kernel.deps
  );
  assert.equal(called, false, "flag off -> no in-session best-of-N, classic single in-session handoff");
  assert.doesNotMatch(result.summary, /PRE-BUILT/);
});

test("#3 off: with singleCommitletInSession disabled, a single commitlet still uses a fresh worker", async () => {
  reset();
  const repo = tmpRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n", "utf8");
  const kernel = fakeKernel(repo, [commitletFixture("c1", "build the thing")], { realWorkers: true });
  await runClosedLoopCommitlets(
    { cwd: repo, userGoal: "build the C extension", config: { ...CONFIG, singleCommitletInSession: false }, spawnFreshWorker: true },
    kernel.deps
  );
  assert.equal(kernel.workerRuns.length, 1, "flag off restores the fresh-worker path (reversible)");
});

test("mid-run backend loss degrades honestly instead of faking progress", async () => {
  reset();
  const repo = tmpRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n", "utf8");
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first")], {
    workerResult: () => ({ ok: false, summary: "backend gone", error: "worker_backend_unavailable" })
  });
  // singleCommitletInSession:false keeps the single-commitlet WORKER path so the backend-loss path is reachable.
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: { ...CONFIG, singleCommitletInSession: false } }, kernel.deps);
  assert.equal(result.status, "partial");
  assert.equal(result.freshWorkerMode, "simulated");
  assert.ok(result.handoffPrompt);
  assert.equal(result.error, "fresh worker backend became unavailable");
  assert.ok(!result.receipt);
});

test("a failed worker (no verified candidate) is recorded and the build continues to the next file", async () => {
  reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first"), commitletFixture("c2", "second")], {
    workerResult: (commitlet) => (commitlet.id === "c1" ? { ok: false, summary: "worker timed out", error: "worker_timeout" } : { ok: true, summary: "done" })
  });
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: CONFIG }, kernel.deps);
  assert.equal(result.status, "partial", "one worker's failure does not abort the whole build");
  assert.deepEqual(kernel.workerRuns, ["c1", "c2"], "c1's worker failure did not stop c2 from building");
  assert.ok(result.steps.some((step) => step.outcome === "worker_failed"));
  assert.deepEqual(((result.details as { failedCommitlets?: Array<{ id: string }> }).failedCommitlets ?? []).map((f) => f.id), ["c1"]);
  assert.equal(defaultCommitletState.get().currentPlan?.commitlets.find((c) => c.id === "c1")?.status, "failed");
});

test("answer-only routes return a no-edit result without planning anything", async () => {
  reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first")]);
  kernel.deps.route = (() => ({ ...CODE_DECISION, executionMode: "answer_only", executionDiscipline: "none" })) as any;
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "what does this repo do?", config: CONFIG }, kernel.deps);
  assert.equal(result.status, "complete");
  assert.equal(result.freshWorkerMode, "none");
  assert.equal(kernel.workerRuns.length, 0);
  // The no-orchestration guidance must be action-imperative (do it now with tools), NOT the old
  // passive "answer the user directly" - small/mid models took that literally and produced a chat
  // reply while doing zero work. It still plans nothing (asserted above); it just tells the model
  // to perform any required actions itself.
  assert.match(result.summary, /no build\/orchestration harness is needed/i);
  assert.match(result.summary, /perform them NOW yourself/i);
});

test("finish gate blocking downgrades an accepted final review to PARTIAL - the model may not claim done", async () => {
  reset();
  const repo = tmpRepo();
  const kernel = fakeKernel(repo, [commitletFixture("c1", "first")], { finishAllowed: false });
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "fix the widget", config: CONFIG }, kernel.deps);
  assert.equal(result.status, "partial");
  assert.equal(result.ok, false);
  assert.ok(!result.receipt, "no receipt when the finish gate blocks");
  assert.match(result.summary, /finish gate is not satisfied|BLOCKED/i);
});

// ---------------------------------------------------------------------------
// Part B proof: the capsule is the canonical worker context, including repairs.
// ---------------------------------------------------------------------------

test("repair worker prompts carry the observed failure as a typed capsule field", () => {
  reset();
  const repo = tmpRepo();
  beginTaskRun(repo, "fix the widget", { taskId: "closed-loop-capsule" });
  const repair = {
    ...commitletFixture("c1-repair", "repair first"),
    spec: { ...commitletFixture("c1-repair", "repair first").spec!, observedFailure: "TypeError: boom at parser.ts:12\n=== CHEATER CHEAT SHEET (evidence) ===\ncard: prior fix" }
  };
  const plan = planFixture(repo, [repair]);
  const result = buildCommitletExecutionPrompt(plan, repair, [], "real", 1, "qwen-2.5-32b-instruct");
  assert.ok(result.capsule, "a run is active, so the capsule must exist");
  assert.equal(typeof result.capsule!.observedFailure, "string");
  assert.match(result.capsule!.observedFailure!, /TypeError: boom/);
  assert.match(result.prompt, /Observed failure \(fix exactly this\):/);
  assert.match(result.prompt, /TypeError: boom/);
  // Attempt 3 (root-cause stance) withholds the cheat sheet so attempts stay diverse.
  const attempt3 = buildCommitletExecutionPrompt(plan, repair, [], "real", 3, "qwen-2.5-32b-instruct");
  assert.ok(!/CHEATER CHEAT SHEET/.test(attempt3.capsule!.observedFailure ?? ""), "attempt 3 re-derives from the raw failure");
  assert.match(attempt3.capsule!.attemptStance ?? "", /root cause/i);
  // The capsule invariants still hold: no logs, contract/phase/validation present.
  const invariants = checkCapsuleInvariants(result.capsule!);
  assert.equal(invariants.ok, true, invariants.failures.join("; "));
  endTaskRun();
});

test("in-session capsule says KEEP GOING and drops the contradicting nonGoal; isolated-worker capsule says STOP", () => {
  // B1: the "stop / do not continue into another file" language is correct for an ISOLATED worker but
  // makes a weak model end its turn after one file when the model IS the whole in-session build. The
  // capsule must flip its closer and drop that nonGoal when freshWorkerMode === "simulated".
  reset();
  const repo = tmpRepo();
  beginTaskRun(repo, "fix the widget", { taskId: "insession-capsule" });
  const base = commitletFixture("c1", "first");
  const commitlet = { ...base, spec: { ...base.spec!, nonGoals: ["Do not touch files outside allowedFiles.", "Do not continue into another commitlet or another file after this scope is complete."] } };
  const plan = planFixture(repo, [commitlet]);

  const inSession = buildCommitletExecutionPrompt(plan, commitlet, [], "simulated", 1, "qwen-2.5-32b-instruct");
  assert.match(inSession.prompt, /Finish this file, then call cheater_commitlet_next/, "in-session closer is keep-going");
  assert.doesNotMatch(inSession.prompt, /Stop when your narrow goal is done or blocked/, "in-session drops the stop closer");
  assert.doesNotMatch(inSession.prompt, /Do not continue into another commitlet or another file/, "in-session drops the contradicting nonGoal");
  assert.match(inSession.prompt, /Do not touch files outside allowedFiles/, "other nonGoals are preserved");

  const isolated = buildCommitletExecutionPrompt(plan, commitlet, [], "real", 1, "qwen-2.5-32b-instruct");
  assert.match(isolated.prompt, /Stop when your narrow goal is done or blocked/, "an isolated worker keeps the stop/hand-off framing");
  endTaskRun();
});
