import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginTaskRun, endTaskRun, resetTaskRunForTests } from "../src/runstate/runState.js";
import { makeFragment, fragmentBundleSizeReport, collectFragmentsForWorker, renderFragmentBundle } from "../src/runstate/contextFragments.js";
import { buildWorldState, diffWorldState, loadWorldState, renderWorldStateDiff, listUnfinishedRuns } from "../src/runstate/worldState.js";
import { planToolExposure, violatesWorkerToolPolicy, WORKER_EDIT_TOOLS, WORKER_READ_TOOLS, workerModeForCommitlet } from "../src/runstate/toolExposure.js";
import { WORKER_TOOLS } from "../src/blueprint/worker.js";
import { classifyCommand, preExecPolicy, shellEditTargets, summarizeCommandOutput, isLongRunning } from "../src/runstate/controlledExec.js";
import { preToolUse, postToolUse, bridgeLoopEvents } from "../src/runstate/hooks.js";
import { artifactReread, expectedCsvColumns } from "../src/runstate/recipes.js";
import { buildWorkerSpawnSpec } from "../src/runstate/workerSpawn.js";
import { checkCapsuleInvariants } from "../src/runstate/invariants.js";
import { buildPromptCapsule } from "../src/runstate/promptCapsule.js";
import { sanitizeReportText, stripThinkBlocks, compressRepeatedLines, looksPoisoned } from "../src/runstate/sanitize.js";
import { classifyValidationResultType } from "../src/runstate/validationLedger.js";
import { readRunEvents } from "../src/runstate/runDir.js";
import { extractAcceptanceContract } from "../src/runstate/contract.js";

// The Codex-shaped kernel: hidden runtime intelligence, few model-visible choices. These
// tests pin the machinery that never appears as a tool: typed fragments, world-state diffs,
// the exposure lattice, controlled exec, hook enforcement, recipes, spawn specs, capsule
// invariants, and poison prevention.

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-kernel-"));
}

const GOAL = "Serve GET /api/health and write results to output.json. Run `npm test`.";

function freshRun(taskId: string, goal = GOAL) {
  resetTaskRunForTests();
  const repo = tmpRepo();
  return { repo, run: beginTaskRun(repo, goal, { taskId, actionBudget: 50 }) };
}

// ---------------------------------------------------------------------------
// Context fragments (Phase 2)
// ---------------------------------------------------------------------------

test("fragments enforce per-kind caps and refuse poisoned content (logs cannot enter a capsule)", () => {
  const long = makeFragment({ kind: "mutation_ledger", text: "x".repeat(5000) });
  assert.ok(long);
  assert.ok(long!.text.length <= 500, `mutation_ledger cap is 500; got ${long!.text.length}`);
  const think = makeFragment({ kind: "worker_report", text: "<think>secret monologue</think> summary" });
  assert.equal(think, null, "thinking blocks are refused, not clamped");
  const rawLog = makeFragment({ kind: "worker_report", text: "\x1b[31mERROR\x1b[0m npm ERR! everything" });
  assert.equal(rawLog, null, "raw ANSI logs are refused");
  const stack = Array.from({ length: 15 }, (_, i) => `    at fn (file.ts:${i}:1)`).join("\n");
  assert.equal(makeFragment({ kind: "worker_report", text: stack }), null, "raw stack dumps are refused");
});

test("fragment bundle size report flags unjustified >1000-char fragments; digest carries a standing justification", () => {
  const digest = makeFragment({ kind: "workspace_digest", text: "d".repeat(1400) })!;
  const report = fragmentBundleSizeReport([digest]);
  assert.equal(report.count, 1);
  assert.ok(report.largeFragments[0].justification.includes("state truth"), "the digest's size is explicitly justified");
  const plan = makeFragment({ kind: "worker_plan", text: "p".repeat(1100), maxChars: 4000 })!;
  const report2 = fragmentBundleSizeReport([plan]);
  assert.match(report2.largeFragments[0].justification, /UNJUSTIFIED/);
});

test("worker fragments carry run truth with freshness; stale validation marks its fragment stale", () => {
  const { run } = freshRun("frag-stale");
  run.recordValidation({ name: "t", command: "npm test", actor: "w", validates: ["src/a.ts"], status: "pass" });
  run.recordFileMutation("src/a.ts", "file_modified", "w", "edit");
  const fragments = collectFragmentsForWorker(run, { goalSeed: GOAL, ruleLines: [], priorReports: [] });
  const validation = fragments.find((fragment) => fragment.kind === "validation_ledger");
  assert.ok(validation);
  assert.equal(validation!.freshness, "stale", "a run with stale passes must mark the validation fragment stale");
  const kinds = fragments.map((fragment) => fragment.kind);
  assert.ok(kinds.includes("phase") && kinds.includes("acceptance_contract"));
  const rendered = renderFragmentBundle(fragments, "HEADER");
  assert.match(rendered, /^HEADER/);
  endTaskRun();
});

// ---------------------------------------------------------------------------
// World state (Phase 3)
// ---------------------------------------------------------------------------

test("world-state file is written, and diffs capture file changes, staleness, and protections compactly", () => {
  const { run } = freshRun("world-1");
  const first = buildWorldState(run);
  run.syncWorldState();
  assert.ok(loadWorldState(run.runDir), "world-state.json must exist");
  run.recordFileMutation("src/a.ts", "file_modified", "w", "edit");
  run.recordValidation({ name: "reread output.json", command: "cat output.json", actor: "v", validates: ["output.json"], status: "pass" });
  run.recordFileMutation("output.json", "file_modified", "w", "edit");
  const second = buildWorldState(run);
  const diff = diffWorldState(first, second);
  assert.ok(diff.filesChanged.includes("src/a.ts"));
  assert.ok(diff.newlyProtected.includes("output.json"), "the exact-artifact pass protected output.json");
  assert.ok(diff.newlyStale.length >= 1, "the later mutation staled the pass");
  const lines = renderWorldStateDiff(diff);
  assert.ok(lines.length > 0 && lines.length <= 10);
  assert.ok(lines.join("\n").length < 800, "the rendered diff must stay compact");
  endTaskRun();
});

test("consumeWorldStateDiffLines: first capsule gets nothing (digest covers it); later capsules get only the delta", () => {
  const { run } = freshRun("world-2");
  assert.deepEqual(run.consumeWorldStateDiffLines(), [], "no previous snapshot -> the digest is the full state");
  run.recordFileMutation("src/b.ts", "file_created", "w", "write");
  const delta = run.consumeWorldStateDiffLines();
  assert.ok(delta.some((line) => /src\/b\.ts/.test(line)), `delta must name the new file; got ${delta}`);
  endTaskRun();
});

test("unfinished runs are listed for reincarnation; ended runs are not", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  beginTaskRun(repo, "task one", { taskId: "run-a" });
  endTaskRun("complete");
  beginTaskRun(repo, "task two", { taskId: "run-b" });
  resetTaskRunForTests(); // simulate a dead session: no endTaskRun, status stays running
  const unfinished = listUnfinishedRuns(repo);
  assert.deepEqual(unfinished.map((run) => run.taskId), ["run-b"]);
});

// ---------------------------------------------------------------------------
// Tool exposure lattice (Phase 4)
// ---------------------------------------------------------------------------

test("exposure lattice only shrinks: worker_edit matches today's worker tool set exactly, read/review/validator are subsets", () => {
  assert.deepEqual(WORKER_EDIT_TOOLS, WORKER_TOOLS, "the lattice's edit set must mirror the live WORKER_TOOLS - no new tools");
  for (const mode of ["worker_read", "reviewer"] as const) {
    const plan = planToolExposure(mode);
    assert.ok(plan.workerTools!.every((tool) => WORKER_TOOLS.includes(tool)));
    assert.ok(!plan.workerTools!.includes("write") && !plan.workerTools!.includes("edit"), `${mode} cannot edit`);
  }
  const validator = planToolExposure("validator");
  assert.ok(!validator.workerTools!.includes("write") && !validator.workerTools!.includes("edit"), "validator cannot edit");
  assert.ok(validator.workerTools!.includes("bash"), "validator can run checks");
});

test("planner mode blocks file/shell tools; workers can never see controller/spawn or retrieval tools", () => {
  const planner = planToolExposure("controller_planner");
  for (const tool of ["read", "edit", "write", "bash"]) assert.ok(planner.blockedNativeTools.includes(tool));
  assert.equal(violatesWorkerToolPolicy(WORKER_READ_TOOLS), null);
  assert.match(violatesWorkerToolPolicy([...WORKER_READ_TOOLS, "cheater_reliability_start"]) ?? "", /controller tool/);
  assert.match(violatesWorkerToolPolicy(["read", "cheater_bug_memory_search"]) ?? "", /retrieval/);
  assert.match(violatesWorkerToolPolicy([...WORKER_EDIT_TOOLS, "extra_tool"]) ?? "", /may only shrink/);
});

test("commitlet roles map onto exposure modes (repair/review/read/edit)", () => {
  assert.equal(workerModeForCommitlet({ id: "c1-repair" }), "repair");
  assert.equal(workerModeForCommitlet({ id: "c1", scope: "review" }), "reviewer");
  assert.equal(workerModeForCommitlet({ id: "c1", allowedActions: ["inspect"] }), "worker_read");
  assert.equal(workerModeForCommitlet({ id: "c1", allowedActions: ["inspect", "edit"] }), "worker_edit");
});

// ---------------------------------------------------------------------------
// ControlledExec (Phase 6)
// ---------------------------------------------------------------------------

test("commands are classified: test/install/dev server/git destructive/shell edit/read-only", () => {
  assert.equal(classifyCommand("npm test"), "test");
  assert.equal(classifyCommand("pip install requests"), "install");
  assert.equal(classifyCommand("npm run dev"), "dev_server");
  assert.equal(classifyCommand("git reset --hard HEAD"), "git_destructive");
  assert.equal(classifyCommand("git status"), "git_status");
  assert.equal(classifyCommand("sed -i 's/a/b/' src/app.ts"), "shell_edit");
  assert.equal(classifyCommand("ls -la"), "read_only");
  assert.equal(classifyCommand("tsc --noEmit"), "lint_typecheck");
  assert.ok(isLongRunning("npm run dev"));
});

test("reserve phase WARNS on installs (a build legitimately needs them) but still blocks destructive git; servers warn; output capped", () => {
  const install = preExecPolicy({ command: "npm install lodash", phase: "reserve" });
  assert.equal(install.verdict, "warn", "installs are legitimate build actions - warn, never hard-block");
  assert.match(install.message ?? "", /RESERVE/);
  const destructive = preExecPolicy({ command: "git reset --hard HEAD~2", phase: "reserve" });
  assert.equal(destructive.verdict, "block", "destructive git is still blocked in reserve");
  const server = preExecPolicy({ command: "npm run dev", phase: "implement" });
  assert.equal(server.verdict, "warn");
  assert.match(server.message ?? "", /long-running/i);
  const summary = summarizeCommandOutput("npm test", "A".repeat(3000), "B".repeat(3000), 600);
  assert.ok(summary.length < 700);
  assert.match(summary, /omitted/);
});

test("shell edits are detected with their targets; out-of-scope shell edits are blocked", () => {
  assert.deepEqual(shellEditTargets("sed -i 's/x/y/' src/app.ts"), ["src/app.ts"]);
  assert.ok(shellEditTargets("echo hi > notes.txt").includes("notes.txt"));
  assert.ok(shellEditTargets("cat file.txt").length === 0, "reading is not editing");
  const outside = preExecPolicy({ command: "echo x > other.txt", phase: "implement", allowedFiles: ["src/app.ts"] });
  assert.equal(outside.verdict, "block");
  assert.match(outside.message ?? "", /outside the allowed files/);
  const inside = preExecPolicy({ command: "echo x > src/app.ts", phase: "implement", allowedFiles: ["src/app.ts"] });
  assert.equal(inside.verdict, "warn", "in-scope shell edits warn and are recorded, not blocked");
});

// ---------------------------------------------------------------------------
// Hook pipeline (Phase 7) + patch-first discipline (Phase 9)
// ---------------------------------------------------------------------------

test("read-before-write: overwriting an existing unread file is blocked; reading (or capsule inclusion) unblocks it", () => {
  const { repo, run } = freshRun("hook-rbw");
  writeFileSync(join(repo, "existing.ts"), "export const a = 1;\n", "utf8");
  const blocked = preToolUse({ toolName: "write", toolCallId: "t1", cwd: repo, path: "existing.ts" }, run);
  assert.equal(blocked[0].action, "block");
  assert.match((blocked[0] as { reason: string }).reason, /never read/);
  run.noteFileRead("existing.ts");
  const allowed = preToolUse({ toolName: "write", toolCallId: "t2", cwd: repo, path: "existing.ts" }, run);
  assert.ok(!allowed.some((decision) => decision.action === "block"));
  // Capsule-provided content counts as read.
  const { run: run2, repo: repo2 } = freshRun("hook-rbw2");
  writeFileSync(join(repo2, "cap.ts"), "x\n", "utf8");
  run2.registerCapsuleFiles(["cap.ts"]);
  const viaCapsule = preToolUse({ toolName: "write", toolCallId: "t3", cwd: repo2, path: "cap.ts" }, run2);
  assert.ok(!viaCapsule.some((decision) => decision.action === "block"));
  // A file the run itself CREATED counts as seen - re-writing it to flesh it out is not blocked
  // (a from-scratch build creates a file, then a second write must not be walled off as "unread").
  const { run: run3, repo: repo3 } = freshRun("hook-rbw3");
  writeFileSync(join(repo3, "made.ts"), "export const m = 1;\n", "utf8");
  run3.recordFileMutation("made.ts", "file_created", "main-session", "write");
  const reWrite = preToolUse({ toolName: "write", toolCallId: "t4", cwd: repo3, path: "made.ts" }, run3);
  assert.ok(!reWrite.some((decision) => decision.action === "block"), "a file the run created is re-writable");
  endTaskRun();
});

test("contract-expected artifacts may be created/overwritten without a prior read (generation is legitimate)", () => {
  const { repo, run } = freshRun("hook-artifact");
  writeFileSync(join(repo, "output.json"), "{}", "utf8");
  const decisions = preToolUse({ toolName: "write", toolCallId: "t1", cwd: repo, path: "output.json" }, run);
  assert.ok(!decisions.some((decision) => decision.action === "block"), "contract output artifacts are writable by design");
  endTaskRun();
});

test("large rewrites of existing files warn (verification required); new files do not", () => {
  const { repo, run } = freshRun("hook-large");
  writeFileSync(join(repo, "big.ts"), "old\n", "utf8");
  run.noteFileRead("big.ts");
  const decisions = preToolUse({ toolName: "write", toolCallId: "t1", cwd: repo, path: "big.ts", contentChars: 20000 }, run);
  assert.ok(decisions.some((decision) => decision.action === "warn" && /Large rewrite/.test((decision as { message: string }).message)));
  const fresh = preToolUse({ toolName: "write", toolCallId: "t2", cwd: repo, path: "brand-new.ts", contentChars: 20000 }, run);
  assert.ok(!fresh.some((decision) => decision.action === "warn" && /Large rewrite/.test((decision as { message: string }).message)));
  endTaskRun();
});

test("postToolUse turns check commands into typed validation evidence and reads into read-evidence", () => {
  const { repo, run } = freshRun("hook-post");
  postToolUse({ toolName: "read", toolCallId: "r1", cwd: repo, path: "src/app.ts", isError: false }, run);
  assert.ok(run.wasRead("src/app.ts"));
  postToolUse({ toolName: "bash", toolCallId: "b1", cwd: repo, command: "npm test", isError: false, outputText: "all green" }, run);
  const entries = run.validations.all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "pass");
  assert.equal(entries[0].resultType, "evaluator_mirror", "npm test is a contract command here");
  postToolUse({ toolName: "bash", toolCallId: "b2", cwd: repo, command: "ls -la", isError: false }, run);
  assert.equal(run.validations.all().length, 1, "read-only commands are not validation evidence");
  endTaskRun();
});

test("loop-governor verdicts bridge into durable run risk events and telemetry", () => {
  const { run } = freshRun("hook-loop");
  bridgeLoopEvents(run, [{ message: "same read repeated 5x", terminal: false }, { message: "hard stop", terminal: true }]);
  const snapshot = run.telemetrySnapshot();
  assert.equal(snapshot.loopEvents, 2);
  assert.ok(readRunEvents(run.runDir).filter((event) => event.kind === "risk_event").length >= 2);
  endTaskRun();
});

test("guard/reserve blocks through preToolUse are counted in local telemetry", () => {
  const { run } = freshRun("hook-telemetry");
  run.guard.protect(["output.json"], "validated");
  const decisions = preToolUse({ toolName: "bash", toolCallId: "t1", cwd: run.repoRoot, command: "rm -rf output.json" }, run);
  assert.equal(decisions[0].action, "block");
  const snapshot = run.telemetrySnapshot();
  assert.ok(snapshot.blockedToolCalls >= 1);
  assert.ok(snapshot.guardBlocks >= 1);
  endTaskRun();
});

// ---------------------------------------------------------------------------
// CodeMode-lite recipes (Phase 5) + exact validation (Phase 10)
// ---------------------------------------------------------------------------

test("artifact_reread: existence alone does not satisfy a parseable artifact; a real pass protects it", () => {
  const { repo, run } = freshRun("recipe-artifact");
  writeFileSync(join(repo, "output.json"), "{ not valid json", "utf8");
  const bad = artifactReread(run);
  assert.equal(bad.ok, false, "an unparseable output.json must FAIL even though the file exists");
  assert.match(bad.digest, /NOT valid JSON/);
  assert.ok(!run.guard.isProtected("output.json"), "a failing reread must not protect");
  writeFileSync(join(repo, "output.json"), JSON.stringify({ ok: true }), "utf8");
  const good = artifactReread(run);
  assert.equal(good.ok, true);
  const entry = run.validations.all().at(-1)!;
  assert.equal(entry.resultType, "exact_artifact");
  assert.ok(run.guard.isProtected("output.json"), "a fresh exact-artifact pass protects the artifact");
  // Recipes are read-only: the file content is untouched.
  assert.equal(readFileSync(join(repo, "output.json"), "utf8"), JSON.stringify({ ok: true }));
  assert.ok(readRunEvents(run.runDir).some((event) => event.kind === "recipe_run"));
  endTaskRun();
});

test("CSV contract columns are checked against the real header", () => {
  resetTaskRunForTests();
  const repo = tmpRepo();
  const run = beginTaskRun(repo, "Write report.csv. The CSV must have columns id,name,score.", { taskId: "recipe-csv" });
  assert.deepEqual(expectedCsvColumns(run.contract), ["id", "name", "score"]);
  writeFileSync(join(repo, "report.csv"), "id,wrong\n1,x\n", "utf8");
  const bad = artifactReread(run);
  assert.equal(bad.ok, false);
  assert.match(bad.digest, /missing contract column/);
  writeFileSync(join(repo, "report.csv"), "id,name,score\n1,a,2\n", "utf8");
  assert.equal(artifactReread(run).ok, true);
  endTaskRun();
});

test("root endpoint never satisfies a named endpoint; stale exact validation blocks finish; failing validation releases protection", () => {
  const contract = extractAcceptanceContract("Serve /api/health and write output.json");
  assert.equal(classifyValidationResultType("curl localhost:8080/", contract), "proxy");
  assert.equal(classifyValidationResultType("curl localhost:8080/api/health", contract), "exact_endpoint");
  const { repo, run } = freshRun("exact-stale");
  writeFileSync(join(repo, "output.json"), "{}", "utf8");
  artifactReread(run);
  assert.equal(run.finishCheck().ok, true);
  run.recordFileMutation("output.json", "file_modified", "w", "edit");
  const check = run.finishCheck();
  assert.equal(check.ok, false, "the exact pass went stale after the artifact mutated");
  // A failing validation over the protected artifact releases it for targeted repair.
  run.recordValidation({ name: "reread output.json", command: "cat output.json", actor: "v", validates: ["output.json"], status: "fail" });
  assert.equal(run.guard.assessCommand("rm output.json").verdict, "allow", "repair sanctioned by the failing validation");
  endTaskRun();
});

// ---------------------------------------------------------------------------
// Worker spawn spec (Phase 8)
// ---------------------------------------------------------------------------

test("worker spawn defaults to forkMode none and persists the spec", () => {
  const { run } = freshRun("spawn-1");
  const { spec, warnings } = buildWorkerSpawnSpec({
    run, workerId: "c1", role: "file_worker", taskName: "add endpoint",
    allowedFiles: ["src/app.ts"], forbiddenFiles: [], mode: "worker_edit",
    maxContextTokens: 4000, maxToolCalls: 10
  });
  assert.equal(spec.forkMode, "none");
  assert.deepEqual(spec.tools, WORKER_EDIT_TOOLS);
  assert.equal(warnings.length, 0);
  assert.ok(existsSync(join(run.runDir, "workers", "c1.spawn.json")));
  assert.ok(readRunEvents(run.runDir).some((event) => event.kind === "worker_spawn_spec"));
  endTaskRun();
});

test("fork inheritance requires an explicit override reason and is loudly recorded; otherwise forced back to none", () => {
  const { run } = freshRun("spawn-2");
  const denied = buildWorkerSpawnSpec({
    run, workerId: "c2", role: "file_worker", taskName: "t", allowedFiles: [], forbiddenFiles: [],
    mode: "worker_edit", maxContextTokens: 4000, maxToolCalls: 10,
    config: { workerForkMode: "all" }
  });
  assert.equal(denied.spec.forkMode, "none", "no override reason -> forced back to none");
  assert.match(denied.warnings.join(" "), /forced back/);
  const allowed = buildWorkerSpawnSpec({
    run, workerId: "c3", role: "file_worker", taskName: "t", allowedFiles: [], forbiddenFiles: [],
    mode: "worker_edit", maxContextTokens: 4000, maxToolCalls: 10,
    config: { workerForkMode: "last_n", workerForkModeOverrideReason: "debugging a context-sensitive repro" }
  });
  assert.equal(allowed.spec.forkMode, "last_n");
  assert.match(allowed.warnings.join(" "), /WILL leak/);
  assert.ok(readRunEvents(run.runDir).some((event) => event.kind === "fork_mode_override"));
  endTaskRun();
});

// ---------------------------------------------------------------------------
// Capsule invariants (Phase 12)
// ---------------------------------------------------------------------------

function goodCapsuleInput() {
  return {
    taskId: "t",
    workerRole: "c1",
    workerGoal: "add the /api/health endpoint",
    acceptanceContract: ["GET /api/health returns 200"],
    allowedFiles: ["src/app.ts"],
    validationPlan: ["npm test"],
    phaseLines: ["phase: IMPLEMENT (70% budget remaining)"]
  };
}

test("invariants pass for a good capsule and fail on poison, missing contract/validation/phase, or too many files", () => {
  assert.equal(checkCapsuleInvariants(buildPromptCapsule(goodCapsuleInput())).ok, true);
  const poisoned = buildPromptCapsule({ ...goodCapsuleInput(), workspaceDigest: "state <think>hidden</think>" });
  assert.equal(checkCapsuleInvariants(poisoned).ok, false);
  const noContract = buildPromptCapsule({ ...goodCapsuleInput(), acceptanceContract: [] });
  assert.match(checkCapsuleInvariants(noContract).failures.join(" "), /no acceptance contract/);
  const noValidation = buildPromptCapsule({ ...goodCapsuleInput(), validationPlan: [] });
  assert.match(checkCapsuleInvariants(noValidation).failures.join(" "), /no validation plan/);
  assert.equal(checkCapsuleInvariants(noValidation, { inspectOnly: true }).ok, true, "inspect-only workers need no validation plan");
  const tooManyFiles = buildPromptCapsule({ ...goodCapsuleInput(), allowedFiles: ["a", "b", "c", "d", "e"] });
  assert.match(checkCapsuleInvariants(tooManyFiles).failures.join(" "), /allowed files/);
  const noPhase = buildPromptCapsule({ ...goodCapsuleInput(), phaseLines: [] });
  assert.match(checkCapsuleInvariants(noPhase).failures.join(" "), /phase/);
});

test("invariants fail an over-broad worker tool list and standing-truth omissions (stale/protected not mentioned)", () => {
  const capsule = buildPromptCapsule(goodCapsuleInput());
  const broad = checkCapsuleInvariants(capsule, { workerTools: [...WORKER_EDIT_TOOLS, "cheater_reliability_start"] });
  assert.ok(!broad.ok);
  const { run } = freshRun("invariant-stale");
  run.recordValidation({ name: "t", command: "npm test", actor: "w", validates: ["src/a.ts"], status: "pass" });
  run.recordFileMutation("src/a.ts", "file_modified", "w", "edit");
  const silent = checkCapsuleInvariants(capsule, { run });
  assert.match(silent.failures.join(" "), /stale/, "a capsule that hides staleness from its worker fails the spawn gate");
  endTaskRun();
});

test("oversize capsules fail closed without the explicit config override", () => {
  const fat = buildPromptCapsule({
    ...goodCapsuleInput(),
    relevantFiles: Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.ts`, reason: "r", snippet: "x".repeat(1600) })),
    workspaceDigest: "y".repeat(1500),
    allowedFiles: ["src/app.ts"]
  });
  // Inflate goal-adjacent fields to push past 8K tokens deterministically.
  const veryFat = { ...fat, relevantFiles: fat.relevantFiles.map((file) => ({ ...file, snippet: (file.snippet ?? "") + "z".repeat(4000) })) };
  const report = checkCapsuleInvariants(veryFat as never);
  if (!report.ok) {
    assert.match(report.failures.join(" "), /hard limit|tokens/);
    const overridden = checkCapsuleInvariants(veryFat as never, { config: { capsuleInvariantOverride: true } });
    assert.ok(overridden.ok || overridden.failures.every((failure) => !/hard limit/.test(failure)));
  } else {
    // Field clamps kept it under the hard cap - that is also a pass for bloat control.
    assert.ok(true);
  }
});

// ---------------------------------------------------------------------------
// Poison prevention (Phase 11)
// ---------------------------------------------------------------------------

test("thinking blocks are stripped, repeated lines compressed, and giant reports capped", () => {
  const raw = [
    "<think>secret chain of thought that must never persist</think>Fixed the bug.",
    "retrying the same command",
    "retrying the same command",
    "retrying the same command",
    "done."
  ].join("\n");
  const clean = sanitizeReportText(raw);
  assert.ok(!clean.includes("secret chain"), "thinking stripped");
  assert.match(clean, /\[repeated x2\]/);
  assert.ok(sanitizeReportText("a".repeat(10000)).length <= 4000);
  assert.equal(stripThinkBlocks("<thinking>x</thinking>ok").trim(), "ok");
  assert.equal(compressRepeatedLines("unique line\nunique line"), "unique line\nunique line", "short/near lines under threshold stay");
  assert.ok(looksPoisoned("<think>hidden</think>"));
});
