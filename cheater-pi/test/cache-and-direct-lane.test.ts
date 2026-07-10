import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPromptCapsule, renderCapsulePrompt, capsuleStablePrefix, type BuildCapsuleInput } from "../src/runstate/promptCapsule.js";
import { runClosedLoopCommitlets, directLaneEligible } from "../src/commitlet/closedLoop.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { resetTaskRunForTests } from "../src/runstate/runState.js";
import type { Commitlet, CommitletPlan } from "../src/commitlet/types.js";
import type { CheaterConfig } from "../src/types.js";

// --- cache-aware prompt prefix ---------------------------------------------------------------

function baseInput(): BuildCapsuleInput {
  return {
    taskId: "t1",
    workerRole: "c1",
    workerGoal: "add a --json flag",
    acceptanceContract: ["output valid JSON when --json is passed"],
    allowedFiles: ["src/export.ts"],
    relevantFiles: [{ path: "src/export.ts", reason: "target", snippet: "export function run() {}" }],
    repoFacts: ["node project, npm test"],
    constraints: ["do not change the CLI parser"],
    workspaceDigest: "phase: implement; budget 80%",
    validationPlan: ["npm test"]
  };
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

test("rendering the same capsule twice is byte-identical (deterministic)", () => {
  const capsule = buildPromptCapsule(baseInput());
  assert.equal(renderCapsulePrompt(capsule), renderCapsulePrompt(capsule));
});

test("two capsules differing only in observed failure share the whole stable prefix", () => {
  const a = buildPromptCapsule({ ...baseInput(), observedFailure: "FAILURE_ALPHA at line 3" });
  const b = buildPromptCapsule({ ...baseInput(), observedFailure: "FAILURE_BETA at line 9" });
  const prefix = commonPrefix(renderCapsulePrompt(a), renderCapsulePrompt(b));
  // The stable content is entirely inside the shared prefix...
  assert.match(prefix, /add a --json flag/);
  assert.match(prefix, /output valid JSON/);
  assert.match(prefix, /src\/export\.ts/);
  // ...and the volatile failure text is NOT (it comes after the divergence point).
  assert.ok(!prefix.includes("FAILURE_ALPHA"));
  assert.ok(!prefix.includes("FAILURE_BETA"));
});

test("two capsules differing only in attempt stance share a long prefix (resample cache reuse)", () => {
  const a = buildPromptCapsule({ ...baseInput(), attemptStance: "Approach: smallest change" });
  const b = buildPromptCapsule({ ...baseInput(), attemptStance: "Approach: root cause rewrite" });
  const prefix = commonPrefix(renderCapsulePrompt(a), renderCapsulePrompt(b));
  const full = renderCapsulePrompt(a);
  assert.ok(prefix.length > full.length * 0.6, `prefix should be most of the prompt (got ${prefix.length}/${full.length})`);
  assert.ok(!prefix.includes("smallest change"));
  assert.ok(!prefix.includes("root cause"));
});

test("capsuleStablePrefix excludes the volatile tail", () => {
  const capsule = buildPromptCapsule({ ...baseInput(), observedFailure: "BOOM_VOLATILE", worldDiff: ["created src/x.ts"] });
  const stable = capsuleStablePrefix(capsule);
  assert.match(stable, /output valid JSON/, "stable content is present");
  assert.ok(!stable.includes("BOOM_VOLATILE"), "the observed failure is in the volatile tail");
  assert.ok(!stable.includes("created src/x.ts"), "the world diff is in the volatile tail");
});

// --- direct lane -----------------------------------------------------------------------------

test("directLaneEligible triggers only on trivial, single-file, non-scaffold tasks", () => {
  const on = { fromScratch: false, singleCommitletInSession: true, filesInScope: 1 };
  assert.equal(directLaneEligible({ taskKind: "trivial", risk: "low" }, on), true);
  assert.equal(directLaneEligible({ taskKind: "docs", risk: "low" }, on), true);
  assert.equal(directLaneEligible({ taskKind: "bug_fix", risk: "low" }, on), false, "a bug fix is not trivial");
  assert.equal(directLaneEligible({ taskKind: "trivial", risk: "high" }, on), false, "high risk lifts it out of the direct lane");
  assert.equal(directLaneEligible({ taskKind: "trivial", risk: "low" }, { ...on, filesInScope: 3 }), false, "multi-file is not direct-lane");
  assert.equal(directLaneEligible({ taskKind: "trivial", risk: "low" }, { ...on, fromScratch: true }), false, "scaffold has its own path");
  assert.equal(directLaneEligible({ taskKind: "trivial", risk: "low" }, { ...on, singleCommitletInSession: false }), false, "respects the lane toggle");
});

function commitletFixture(id: string): Commitlet {
  return {
    id, title: "tiny tweak", purpose: "tiny tweak", status: "pending", scope: "code",
    allowedFiles: ["src/app.ts"], forbiddenFiles: [], allowedActions: ["edit"], forbiddenActions: [],
    maxFilesTouched: 1, maxDiffLines: 40, maxToolCalls: 10, maxModelCalls: 1,
    expectedFilesTouched: ["src/app.ts"], focusedVerification: [{ command: "npm test", purpose: "f", required: true }],
    broaderVerification: [], healthBudget: {} as Commitlet["healthBudget"],
    spec: { behaviorMustHold: [], behaviorMustNotChange: [], edgeCases: [], acceptanceCriteria: ["tiny tweak"], temporaryTestsAllowed: false, permanentTestsAllowed: false, nonGoals: [] },
    risk: "low"
  };
}

function planFixture(repoRoot: string): CommitletPlan {
  return {
    id: "p", createdAt: new Date().toISOString(), repoRoot, userGoal: "rename a label", summary: "1 commitlet",
    commitlets: [commitletFixture("c1")], currentIndex: 0, status: "planning", globalConstraints: [], finalVerification: [],
    finalReview: { accepted: false, summary: "", commitlets: [], finalVerification: [], health: { score: 100, passed: true, warnings: [], blockingIssues: [], metrics: { diffLines: 0, filesTouched: 0, duplicationDelta: 0, complexityDelta: 0, largeFunctionDelta: 0, assertionDelta: 0 } }, blockingIssues: [], warnings: [], suggestedFollowups: [] },
    risk: "low"
  };
}

test("the direct lane skips the blueprint model turn and hands off to an in-session edit", async () => {
  defaultCommitletState.clear();
  liveSessionState.reset();
  resetTaskRunForTests();
  const repo = mkdtempSync(join(tmpdir(), "direct-lane-"));
  const config: CheaterConfig = { runStateEnabled: false, telemetryEnabled: false };
  let blueprintCalled = false;
  // A trivial task that WOULD normally build a blueprint (needsBlueprint:true) - the direct lane must
  // skip it because the task is trivial + single-file.
  const trivialDecision = { executionMode: "vanilla_pi", executionDiscipline: "single_commitlet", taskKind: "trivial", risk: "low", confidence: 0.9, needsBlueprint: true, needsRepro: false, complexitySignals: [], reason: "t", userVisibleSummary: "t" } as any;
  const result = await runClosedLoopCommitlets({ cwd: repo, userGoal: "rename a label in src/app.ts", config }, {
    route: (() => trivialDecision) as any,
    createBlueprint: (async () => { blueprintCalled = true; return {} as any; }) as any,
    createPlan: (() => planFixture(repo)) as any,
    prepare: ((_cwd: string, c: Commitlet) => ({ ...c, status: "running" as const })) as any,
    resolveWorkerMode: (async (input: { spawnFreshWorker?: boolean }) => input?.spawnFreshWorker !== false) as any
  });
  assert.equal(blueprintCalled, false, "the direct lane never spends a blueprint model turn on a trivial task");
  assert.equal(result.freshWorkerMode, "simulated", "trivial work is edited in-session, not by a cold worker");
  assert.match(result.summary, /cheater_finish_gate/, "the in-session handoff still drives to the finish gate");
});
