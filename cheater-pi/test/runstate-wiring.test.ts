import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginTaskRun, endTaskRun, resetTaskRunForTests, activeTaskRun } from "../src/runstate/runState.js";
import { readRunEvents } from "../src/runstate/runDir.js";
import { reconstructRunState, renderReincarnationBrief } from "../src/runstate/workerPlans.js";
import { buildCommitletExecutionPrompt } from "../src/commitlet/executor.js";
import type { Commitlet, CommitletPlan } from "../src/commitlet/types.js";

// Integration tests for the durable-run layer: the run directory IS the controller's memory.
// A controller (or a human) killed mid-task must be able to reconstruct the plot from
// .cheater/runs/<taskId>/ alone - contract, digest, ledgers, worker plans, reports, events.

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-runstate-"));
}

const GOAL = "Fix the API: GET /api/health must return 200 and write results to output.json. Run `npm test` to verify.";

function sampleCommitlet(): Commitlet {
  return {
    id: "c1",
    title: "add health endpoint",
    purpose: "expose GET /api/health",
    status: "pending",
    scope: "code",
    allowedFiles: ["src/app.ts"],
    forbiddenFiles: ["src/legacy.ts"],
    allowedActions: ["inspect", "edit", "run_test", "stop_blocked"],
    forbiddenActions: [],
    maxFilesTouched: 1,
    maxDiffLines: 120,
    maxToolCalls: 10,
    maxModelCalls: 1,
    expectedFilesTouched: ["src/app.ts"],
    focusedVerification: [{ command: "npm test", purpose: "focused tests", required: true }],
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
      behaviorMustHold: ["GET /api/health returns 200"],
      behaviorMustNotChange: ["other routes"],
      edgeCases: [],
      acceptanceCriteria: ["GET /api/health returns 200"],
      temporaryTestsAllowed: false,
      permanentTestsAllowed: true,
      nonGoals: ["do not restructure the server"]
    },
    risk: "low"
  };
}

function samplePlan(repoRoot: string): CommitletPlan {
  return {
    id: "plan-test",
    createdAt: new Date().toISOString(),
    repoRoot,
    userGoal: GOAL,
    summary: "one commitlet: add health endpoint",
    commitlets: [sampleCommitlet()],
    currentIndex: 0,
    status: "running",
    globalConstraints: ["keep diffs small"],
    finalVerification: [],
    finalReview: {
      accepted: false,
      summary: "",
      commitlets: [],
      finalVerification: [],
      health: {
        score: 100,
        passed: true,
        warnings: [],
        blockingIssues: [],
        metrics: { diffLines: 0, filesTouched: 0, duplicationDelta: 0, complexityDelta: 0, largeFunctionDelta: 0, assertionDelta: 0 }
      },
      blockingIssues: [],
      warnings: [],
      suggestedFollowups: []
    },
    risk: "low"
  };
}

test("beginTaskRun creates the run directory with contract.json, workspace digest, and event log", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "run-birth" });
  assert.ok(existsSync(join(run.runDir, "contract.json")));
  assert.ok(existsSync(join(run.runDir, "workspace-digest.md")));
  assert.ok(existsSync(join(run.runDir, "events.jsonl")));
  const contract = JSON.parse(readFileSync(join(run.runDir, "contract.json"), "utf8"));
  assert.ok(contract.endpoints.includes("/api/health"), "the literal endpoint must land in the persisted contract");
  assert.ok(contract.outputPaths.includes("output.json"));
  const events = readRunEvents(run.runDir);
  assert.equal(events[0]?.kind, "run_started");
  endTaskRun();
});

test("building a worker prompt with an active run persists the capsule + worker plan and logs its size (context-size metric)", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "run-capsule" });
  const plan = samplePlan(repo);
  const result = buildCommitletExecutionPrompt(plan, sampleCommitlet(), [], "real", 1, "test-model");
  assert.ok(result.capsule, "an active run must produce a persisted capsule");
  // Prompt Capsule is the canonical worker context: the prompt IS the capsule render (plus
  // the thin kernel header), never a second ad hoc context format.
  assert.match(result.prompt, /You are a focused c1 worker for Cheater/, "the worker prompt must be rendered from the capsule");
  assert.match(result.prompt, /phase: EXPLORE/i);
  assert.doesNotMatch(result.prompt, /Cheater Reliability Mode fresh-call packet/, "the nested packet prompt format is gone");
  assert.ok(existsSync(join(run.runDir, "capsules", "c1-capsule.json")), "the capsule must be persisted for reincarnation");
  assert.ok(existsSync(join(run.runDir, "workers", "c1.md")), "the durable worker plan must be written");
  const planMd = readFileSync(join(run.runDir, "workers", "c1.md"), "utf8");
  assert.match(planMd, /add health endpoint/);
  assert.match(planMd, /src\/app\.ts/);
  const capsuleEvents = readRunEvents(run.runDir).filter((event) => event.kind === "capsule_built");
  assert.ok(capsuleEvents.length >= 1, "every worker spawn context must be size-logged");
  const logged = capsuleEvents[0] as { estimatedTokens?: number; fullLogsIncluded?: boolean; digestIncluded?: boolean };
  assert.ok((logged.estimatedTokens ?? 0) > 0, "the log must carry the estimated token size");
  assert.equal(logged.fullLogsIncluded, false, "the metric must prove no full logs were included");
  assert.equal(logged.digestIncluded, true);
  endTaskRun();
});

test("the capsule prompt never contains parent-session content, only run-state truth", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  beginTaskRun(repo, GOAL, { taskId: "run-isolation" });
  const plan = samplePlan(repo);
  const result = buildCommitletExecutionPrompt(plan, sampleCommitlet(), ["c0: earlier packet summary"], "real", 1, "test-model");
  // The only cross-worker context allowed is compact summaries: prior packet one-liners and
  // ledger digests. Raw transcripts/logs have no path into this prompt.
  assert.match(result.prompt, /Changes so far:\n- no mutations recorded/);
  assert.ok(result.prompt.length < 40_000, "the whole worker prompt stays bounded");
  endTaskRun();
});

test("integrateWorkerReport writes the report file and refreshes the workspace digest (digest updates after a worker report)", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "run-report" });
  const before = readFileSync(join(run.runDir, "workspace-digest.md"), "utf8");
  assert.ok(!/backend finished/.test(before));
  run.integrateWorkerReport({
    workerRole: "backend",
    summary: "backend finished the endpoint",
    filesChanged: ["src/app.ts"],
    commandsRun: ["npm test"],
    validationResults: ["focused verification: pass"],
    problems: ["flaky socket teardown in CI"],
    recommendedNextAction: "spawn the test worker for regression coverage",
    contractSatisfied: "yes"
  });
  const reportPath = join(run.runDir, "reports", "backend-report.md");
  assert.ok(existsSync(reportPath), "worker reports must be durable files");
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /contract satisfied: yes/);
  assert.match(report, /src\/app\.ts/);
  const digest = readFileSync(join(run.runDir, "workspace-digest.md"), "utf8");
  assert.match(digest, /spawn the test worker/, "the digest must absorb the report's next action");
  assert.match(digest, /flaky socket teardown/, "the digest must surface reported blockers");
  const words = digest.split(/\s+/).length;
  assert.ok(words <= 620, `the digest must stay brutally compressed (<=600 words); got ${words}`);
  endTaskRun();
});

test("end-to-end staleness: a validated pass goes stale after the file mutates again, and the finish check says so", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "run-stale" });
  run.recordFileMutation("src/app.ts", "file_modified", "worker-c1", "edit");
  run.recordValidation({ name: "focused_verification:c1", command: "npm test", actor: "c1", validates: ["src/app.ts"], status: "pass" });
  assert.equal(run.finishCheck().ok, true, "a fresh pass finishes cleanly");
  run.recordFileMutation("src/app.ts", "file_modified", "main-session", "edit");
  const check = run.finishCheck();
  assert.equal(check.ok, false, "the pass depended on src/app.ts which mutated afterwards");
  assert.match(check.warnings.join("\n"), /stale/i);
  const persisted = JSON.parse(readFileSync(join(run.runDir, "validation-ledger.json"), "utf8"));
  assert.equal(persisted.entries[0].stale, true, "staleness must be durable, not in-memory only");
  endTaskRun();
});

test("an evaluator-mirroring pass protects the contract artifacts; destructive commands are then blocked", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "run-protect" });
  run.recordValidation({ name: "artifact check", command: "cat output.json", actor: "verifier", validates: ["output.json"], status: "pass" });
  assert.ok(run.guard.isProtected("output.json"), "a fresh evaluator-mirroring pass must protect its artifact");
  assert.equal(run.assessCommand("rm -rf output.json").verdict, "block");
  assert.ok(existsSync(join(run.runDir, "guards", "protected-artifacts.json")), "protections must be durable");
  // The standing warning rides into risk hints for later actions.
  const hints = run.riskHints({ toolName: "bash", command: "rm output.json" });
  assert.ok(hints.some((hint) => /protected/i.test(hint)));
  endTaskRun();
});

test("context reincarnation: a fresh controller reconstructs contract, digest, ledgers, and reports from disk alone", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "run-rebirth" });
  run.recordFileMutation("src/app.ts", "file_modified", "worker-c1", "edit");
  run.recordValidation({ name: "focused_verification:c1", command: "npm test", actor: "c1", validates: ["src/app.ts"], status: "pass" });
  run.integrateWorkerReport({
    workerRole: "c1",
    summary: "endpoint added and verified",
    filesChanged: ["src/app.ts"],
    commandsRun: ["npm test"],
    validationResults: ["pass"],
    problems: [],
    recommendedNextAction: "final review",
    contractSatisfied: "yes"
  });
  endTaskRun("controller died");
  resetTaskRunForTests();
  assert.equal(activeTaskRun(), null, "the old controller context is gone");

  const rebuilt = reconstructRunState(repo, "run-rebirth");
  assert.ok(rebuilt.contract, "the contract survives the controller");
  assert.ok(rebuilt.contract!.endpoints.includes("/api/health"));
  assert.ok(rebuilt.workspaceDigest && /Workspace digest/.test(rebuilt.workspaceDigest));
  assert.equal(rebuilt.mutations.all().length, 1);
  assert.equal(rebuilt.validations.all().length, 1);
  assert.deepEqual(rebuilt.reportFiles, ["c1-report.md"]);
  const brief = renderReincarnationBrief(rebuilt);
  assert.match(brief, /run-rebirth/);
  assert.match(brief, /previous controller context is gone/);
  assert.ok(brief.length <= 4000, "the reincarnation brief itself must be capsule-sized");
});

test("run-state phase budget: reads stay cheap (no premature RESERVE); state-changing work drives the phase (H1/H2)", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "run-phase", actionBudget: 10 });
  // H1: a read-heavy exploration must NOT drain the budget into RESERVE - reads are how the model
  // earns the right to act. 9 reads at 0.25 each = ~22% of budget, still EXPLORE.
  for (let i = 0; i < 9; i++) run.noteAction("read", "inspect");
  assert.notEqual(run.currentPhase(), "reserve", "reads alone do not force RESERVE (H1)");
  assert.equal(run.currentPhase(), "explore");
  // State-changing actions drive the phase forward to RESERVE.
  for (let i = 0; i < 10; i++) run.noteAction("state_changing", "edit");
  assert.equal(run.currentPhase(), "reserve");
  // H2: in RESERVE a destructive command blocks, but an install only warns (blocking installs was a
  // top "never finishes" cause).
  assert.equal(run.noteAction("state_changing", "rm -rf dist && git reset --hard").verdict, "block", "reserve blocks destructive work");
  assert.equal(run.noteAction("state_changing", "npm install something").verdict, "warn", "reserve only warns on installs (H2)");
  assert.match(run.phase.capsuleLines().join("\n"), /RESERVE/);
  endTaskRun();
});

test("read-before-write treats a file the run itself created as seen (H3: no false block on a shell-made file)", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, GOAL, { taskId: "h3", actionBudget: 50 });
  assert.equal(run.wasMutated("config.json"), false, "a never-touched file is not marked mutated");
  // A file the run creates via ANY actor (incl. a shell command recorded in the mutation ledger) is
  // "seen" - overwriting it later is not destroying unseen pre-existing code.
  run.recordFileMutation("config.json", "file_created", "model", "shell edit");
  assert.equal(run.wasMutated("config.json"), true, "a run-created file is seen for read-before-write");
  endTaskRun();
});
