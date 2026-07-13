import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { routeAutopilot } from "../src/autopilot/router.js";
import { createCommitletPlan } from "../src/commitlet/planner.js";
import { forgeCommitletSpec } from "../src/commitlet/spec.js";
import { cleanupOldRollbackSnapshots, createRollbackPoint, revertRollbackPoint, rollbackAvailable } from "../src/commitlet/rollback.js";
import { runDiffGuard, countDiffLines, taskInvolvesDependency } from "../src/commitlet/guard.js";
import { scorePatchHealth } from "../src/commitlet/health.js";
import { auditTestChanges } from "../src/commitlet/testAudit.js";
import { runCommitletFinalReview } from "../src/commitlet/reviewer.js";
import { buildRepoConstraintGraph, queryConstraintFacts } from "../src/commitlet/constraintGraph.js";
import { classifyImpact, derivedVerificationForImpact } from "../src/commitlet/impact.js";
import { runReliabilityBenchmark } from "../src/reliability/bench.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { defaultBlueprintState } from "../src/blueprint/state.js";
import { blockCommitletScopeViolation } from "../src/extension.js";
import { runFocusedVerification } from "../src/commitlet/verification.js";
import { createCleanupCommitlet, createRepairCommitlet } from "../src/commitlet/planner.js";
import { registerCommitletTools } from "../src/commitlet/tools.js";
import { telemetryFromPlan } from "../src/commitlet/telemetry.js";
import { buildCommitletExecutionPrompt } from "../src/commitlet/executor.js";
import { beginTaskRun, endTaskRun, resetTaskRunForTests } from "../src/runstate/runState.js";

function makePi() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool(def: any) {
      tools.set(def.name, def);
    }
  };
  return { pi, tools };
}

function commitletToolCtx() {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-commitlet-tools-"));
  writeFileSync(join(cwd, "README.md"), "teh docs\n", "utf8");
  return { cwd };
}

test("router assigns commitlet execution discipline automatically", () => {
  assert.equal(routeAutopilot({ cwd: process.cwd(), message: "what does this repo do?" }).executionDiscipline, "none");
  assert.equal(routeAutopilot({ cwd: process.cwd(), message: "change one typo in README" }).executionDiscipline, "single_commitlet");
  assert.equal(routeAutopilot({ cwd: process.cwd(), message: "add a /hello command and docs" }).executionDiscipline, "blueprint_backed_commitlet_chain");
});

test("commitlet tools register automatic reliability start", () => {
  const { pi, tools } = makePi();
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  assert.ok(tools.has("cheater_reliability_start"));
});

test("automatic reliability start leaves answer-only messages plan-free", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const result = await tools.get("cheater_reliability_start").execute(
    "start-answer",
    { message: "what does this repo do?", userGoal: "what does this repo do?" },
    undefined,
    undefined,
    commitletToolCtx()
  );
  assert.equal(defaultCommitletState.get().currentPlan, null);
  assert.doesNotMatch(result.content[0].text, /Running commitlet/);
});

test("automatic reliability start prepares first tiny edit commitlet", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const result = await tools.get("cheater_reliability_start").execute(
    "start-edit",
    { message: "change one typo in README", userGoal: "change one typo in README" },
    undefined,
    undefined,
    commitletToolCtx()
  );
  const plan = defaultCommitletState.get().currentPlan;
  const first = plan?.commitlets[0];
  assert.ok(plan);
  assert.equal(plan.status, "running");
  assert.equal(first?.status, "running");
  assert.equal(first?.id, "c1-single");
  assert.equal(first?.allowedFiles[0], "README.md");
  assert.ok(first?.rollbackPoint);
  assert.match(result.content[0].text, /Cheater Reliability Start/);
  assert.match(result.content[0].text, /commitlets: 1/);
  assert.match(result.content[0].text, /rollback: rollback-/);
  assert.match(result.content[0].text, /fresh-call prompt:/);
  assert.match(result.content[0].text, /Cheater Reliability Kernel commitlet/);
  // Prompt Capsule is the canonical worker context: the capsule-rendered sections are
  // present and the old nested fresh-call packet format is GONE (one context format, not two).
  assert.match(result.content[0].text, /Acceptance contract \(literal/);
  assert.doesNotMatch(result.content[0].text, /Cheater Reliability Mode fresh-call packet/);
  assert.equal(result.details.commitlet.id, first?.id);
  assert.equal(result.details.prompt.commitletId, first?.id);
});

test("automatic reliability start creates blueprint-backed commitlets for complex tasks", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  defaultBlueprintState.clear();
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const result = await tools.get("cheater_reliability_start").execute(
    "start-blueprint",
    { userGoal: "add a /hello command and docs" },
    undefined,
    undefined,
    commitletToolCtx()
  );
  const blueprint = defaultBlueprintState.get().currentPlan;
  const plan = defaultCommitletState.get().currentPlan;
  assert.ok(blueprint);
  assert.equal(blueprint.candidates.length, 3);
  assert.ok(blueprint.scores.length >= 3);
  assert.ok(plan?.blueprintPlanId);
  assert.equal(plan?.blueprintPlanId, blueprint.id);
  assert.equal(plan?.status, "running");
  assert.match(result.content[0].text, /blueprint=blueprint-/);
});

test("commitlet fresh-call prompt includes bounded snippets and graph facts", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-commitlet-context-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const longTail = Array.from({ length: 80 }, (_, index) => `export const value${index} = ${index};`).join("\n");
  writeFileSync(join(root, "src", "commands.ts"), `export function register(pi:any){ pi.registerCommand('x', {}); }\n${longTail}\n`, "utf8");
  const decision = routeAutopilot({ cwd: root, message: "add a /hello command" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "add a /hello command", autopilotDecision: decision });
  const commitlet = { ...plan.commitlets[0], allowedFiles: ["src/commands.ts"], expectedFilesTouched: ["src/commands.ts"] };
  resetTaskRunForTests();
  beginTaskRun(root, "add a /hello command", { taskId: "kernel-prompt-facts" });
  const prompt = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, commitlet, ["one", "two", "three", "four"]).prompt;
  // Canonical capsule sections carry the same bounded context the old dual format did.
  assert.match(prompt, /Repo facts:/);
  assert.match(prompt, /src\/commands\.ts registers commands/);
  // Snippet is a symbol slice (or head fallback), labeled with the file path, inside the capsule.
  assert.match(prompt, /--- src\/commands\.ts \((?:relevant symbol|head)\) ---/);
  assert.match(prompt, /- two\n- three\n- four/);
  assert.doesNotMatch(prompt, /value79/);
  // One context format: no nested fresh-call packet, and the sliced file's code appears
  // exactly once (the old dual path embedded the same file twice in one prompt).
  assert.doesNotMatch(prompt, /Cheater Reliability Mode fresh-call packet/);
  assert.doesNotMatch(prompt, /--- src\/commands\.ts excerpt ---/);
  assert.equal(prompt.split("--- src/commands.ts (").length - 1, 1, "the target file's snippet must appear exactly once");
  endTaskRun();
});

test("buildCommitletExecutionPrompt resolves a real modelClass and unlocks its operating rules", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-commitlet-model-"));
  const decision = routeAutopilot({ cwd: root, message: "fix the bug" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "fix the bug", autopilotDecision: decision });
  resetTaskRunForTests();
  beginTaskRun(root, "fix the bug", { taskId: "kernel-model-rules" });
  const unknownPrompt = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, plan.commitlets[0]).prompt;
  assert.match(unknownPrompt, /Operating rules for this model class:/);
  assert.match(unknownPrompt, /Keep context narrow and execute only this packet/);

  const moePrompt = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, plan.commitlets[0], [], "simulated", 1, "qwen-2.5-32b-instruct").prompt;
  assert.match(moePrompt, /Run the focused verification command before broad tests/, "moe-class operating rules must ship once modelClass resolves");
  endTaskRun();
});

test("fresh-call packet renders the verification command as an explicit run-it-yourself instruction", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-commitlet-verify-instr-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const decision = routeAutopilot({ cwd: root, message: "update config" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "update config", autopilotDecision: decision });
  const commitlet = {
    ...plan.commitlets[0],
    allowedFiles: ["src/a.ts"],
    focusedVerification: [{ command: "npm test -- a.test.ts", purpose: "focused", required: true }]
  };
  resetTaskRunForTests();
  beginTaskRun(root, "update config", { taskId: "kernel-verify-imperative" });
  const prompt = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, commitlet).prompt;
  assert.match(prompt, /Run the focused verification YOURSELF with the bash tool before finishing and report its real output: npm test -- a\.test\.ts/);
  endTaskRun();
});

test("fresh-call packet no longer tells the worker to use Pi-native tools only, contradicting cheater_line_edit", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-commitlet-tool-contradiction-"));
  const decision = routeAutopilot({ cwd: root, message: "fix the bug" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "fix the bug", autopilotDecision: decision });
  resetTaskRunForTests();
  beginTaskRun(root, "fix the bug", { taskId: "kernel-tool-guidance" });
  const prompt = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, plan.commitlets[0]).prompt;
  assert.doesNotMatch(prompt, /Use Pi native tools only/);
  assert.match(prompt, /cheater_line_edit/);
  endTaskRun();
});

test("simulated/in-session packet tells the DRIVER to continue (call cheater_commitlet_next), not stop after one file", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-continuation-"));
  const decision = routeAutopilot({ cwd: root, message: "build a todo app from scratch" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "build a todo app from scratch", autopilotDecision: decision });
  resetTaskRunForTests();
  beginTaskRun(root, "build a todo app from scratch", { taskId: "continuation" });
  // Simulated mode: the MAIN model IS the whole build, so it must be told to keep going.
  const simulated = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, plan.commitlets[0], [], "simulated").prompt;
  assert.match(simulated, /IN-SESSION MODE/);
  assert.match(simulated, /cheater_commitlet_next/);
  assert.match(simulated, /do NOT end your turn/i);
  assert.match(simulated, /NOT done until every planned commitlet is built/i);
  // Real-worker mode: an outer loop drives continuation, so the override is (correctly) absent.
  const real = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, plan.commitlets[0], [], "real").prompt;
  assert.doesNotMatch(real, /IN-SESSION MODE/);
  endTaskRun();
});

test("commitlet planner creates specs and converts blueprint-free tasks", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "add a /hello command and docs" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "add a /hello command and docs", autopilotDecision: decision });
  assert.ok(plan.commitlets.length >= 2);
  assert.ok(plan.commitlets.every((commitlet) => commitlet.spec));
  assert.match(plan.summary, /commitlet/);
});

test("spec forge emphasizes refactor behavior preservation", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "refactor this module without behavior change" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "refactor this module without behavior change", autopilotDecision: decision });
  const spec = forgeCommitletSpec(plan.commitlets[0], "refactor", plan.userGoal);
  assert.ok(spec.behaviorMustNotChange.some((item) => /Observable behavior/.test(item)));
});

test("rollback snapshots allowed files without touching unrelated files", () => {
  const root = join(tmpdir(), `cheater-commitlet-${Date.now().toString(36)}`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const decision = routeAutopilot({ cwd: root, message: "update config" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "update config", autopilotDecision: decision });
  const commitlet = { ...plan.commitlets[0], allowedFiles: ["src/a.ts"], expectedFilesTouched: ["src/a.ts"] };
  const rollback = createRollbackPoint(root, commitlet);
  assert.equal(rollbackAvailable(rollback), true);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  const restored = revertRollbackPoint(root, { ...commitlet, rollbackPoint: rollback });
  assert.equal(restored.ok, true);
  assert.equal(readFileSync(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n");
  const cleanup = cleanupOldRollbackSnapshots(root, 1);
  assert.ok(cleanup.kept.length <= 1);
});

test("diff guard blocks forbidden files, too many files, deps, tests, generated artifacts", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "update config" });
  const commitlet = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "update config", autopilotDecision: decision }).commitlets[0];
  const report = runDiffGuard(commitlet, {
    touchedFiles: ["src/config.ts", "package-lock.json", "tests/config.test.ts", "dist/app.js"],
    diffText: "+x\n".repeat(250)
  });
  assert.equal(report.passed, false);
  assert.ok(report.blockingIssues.length >= 3);
});

test("diff guard blocks broad formatting churn, large deletion, and edited verification target", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "change one typo in README" });
  const commitlet = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "change one typo in README", autopilotDecision: decision }).commitlets[0];
  const churnDiff = Array.from({ length: 40 }, (_, index) => `-const value${index}=true;\n+const value${index} = true;`).join("\n");
  // Single-file churn is usually a real refactor, so it is a warning, not a hard block.
  const singleFileChurn = runDiffGuard(commitlet, { touchedFiles: ["README.md"], diffText: churnDiff });
  assert.match(singleFileChurn.warnings.join("; "), /formatting-only churn/);
  // Broad churn across multiple files still hard-blocks.
  const formatting = runDiffGuard(commitlet, { touchedFiles: ["README.md", "src/a.ts"], diffText: churnDiff });
  assert.match(formatting.blockingIssues.join("; "), /formatting-only churn/);
  const deletion = runDiffGuard(commitlet, {
    touchedFiles: ["README.md"],
    diffText: "-old line\n".repeat(55) + "+new summary\n"
  });
  assert.match(deletion.blockingIssues.join("; "), /Large deletion requires explicit approval/);
  const verificationEdit = runDiffGuard(
    { ...commitlet, allowedFiles: ["test/readme.test.ts"], focusedVerification: [{ command: "npm test -- test/readme.test.ts", purpose: "focused", required: true }] },
    { touchedFiles: ["test/readme.test.ts"], diffText: "+test('x', () => {})\n" }
  );
  assert.match(verificationEdit.blockingIssues.join("; "), /Focused verification target was edited/);
});

test("lifecycle scope guard blocks edits outside running commitlet allowed files", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "update config" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "update config", autopilotDecision: decision });
  defaultCommitletState.setPlan({
    ...plan,
    commitlets: [{ ...plan.commitlets[0], status: "running", allowedFiles: ["src/config.ts"] }]
  });
  assert.equal(blockCommitletScopeViolation({ toolName: "edit", input: { path: "src/config.ts" } }), undefined);
  assert.match(blockCommitletScopeViolation({ toolName: "edit", input: { path: "src/other.ts" } })?.reason ?? "", /outside allowed/);
  defaultCommitletState.clear();
});

test("patch health and test auditor catch slop", () => {
  const health = scorePatchHealth({
    filesTouched: ["src/a.ts", "src/b.ts", "src/c.ts"],
    diffText: `${"+if (a && b) {\n".repeat(30)}+// TODO fix later\n`
  });
  assert.ok(health.score < 100);
  assert.equal(auditTestChanges("-expect(actual).toEqual(expected)\n+test.skip('x', () => {})\n").passed, false);
});

test("test auditor weighs weakened, mock-only, and unexplained snapshot changes", () => {
  const weakenedStrictAssertion = auditTestChanges(`
-  assert.equal(result.status, "accepted");
+  assert.ok(result.status);
-  expect(user.email).toBe("ada@example.test");
+  expect(user.email).toBeDefined();
`);
  assert.equal(weakenedStrictAssertion.passed, false);
  assert.match(weakenedStrictAssertion.blockingIssues.join("; "), /assert|weaken|truthy|defined|strict/i);

  const mockOnlyChange = auditTestChanges(`
+test("loads the account", async () => {
+  accountClient.fetch.mockResolvedValue({ id: "acct-1" });
+  await loadAccount("acct-1");
+});
`);
  assert.equal(mockOnlyChange.passed, false);
  assert.match(mockOnlyChange.blockingIssues.join("; "), /mock/i);

  const unexplainedSnapshotChange = auditTestChanges(`
diff --git a/test/__snapshots__/invoice.test.ts.snap b/test/__snapshots__/invoice.test.ts.snap
-exports[\`renders invoice summary 1\`] = "Balance: $10";
+exports[\`renders invoice summary 1\`] = "Balance: $0";
`);
  assert.equal(unexplainedSnapshotChange.passed, false);
  assert.match(unexplainedSnapshotChange.blockingIssues.join("; "), /snapshot|golden/i);
});

test("test auditor accepts regression tests mapped to acceptance criteria", () => {
  const report = auditTestChanges(
    `
+test("regression: retries transient payment failures", async () => {
+  const gateway = fakeGateway({ failuresBeforeSuccess: 1 });
+  const result = await collectPayment({ gateway, invoiceId: "inv-1" });
+  assert.equal(result.status, "paid");
+  assert.equal(gateway.attempts, 2);
+});
`,
    ["Retry transient payment failures before marking invoices failed"]
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.blockingIssues, []);
  assert.deepEqual(report.warnings, []);
});

test("focused verification passes, fails compactly, and creates bounded repair commitlet", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "change one typo in README" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "change one typo in README", autopilotDecision: decision });
  const passing = { ...plan.commitlets[0], focusedVerification: [{ command: "node -e \"process.exit(0)\"", purpose: "pass", required: true }] };
  assert.equal(runFocusedVerification(process.cwd(), passing).passed, true);
  const failing = { ...plan.commitlets[0], focusedVerification: [{ command: "node -e \"console.error('AssertionError: nope'); process.exit(1)\"", purpose: "fail", required: true }] };
  const result = runFocusedVerification(process.cwd(), failing);
  assert.equal(result.passed, false);
  assert.match(result.summary, /Focused verification failed/);
  const repair = createRepairCommitlet(failing, result.summary);
  assert.match(repair.id, /-repair$/);
  assert.deepEqual(repair.allowedFiles, failing.allowedFiles);
});

test("M2: a repair may touch a coupled file the verification failure NAMES (breaks the deadlock)", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "add a Foo type" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "add a Foo type", autopilotDecision: decision });
  const failing = { ...plan.commitlets[0], allowedFiles: ["src/types.ts"], maxFilesTouched: 1 };
  // A typecheck failure that names a DIFFERENT, coupled file (consumer.ts must change too to compile).
  const repair = createRepairCommitlet(failing, "src/consumer.ts(12,5): error TS2304: Cannot find name 'Foo'.");
  assert.ok(repair.allowedFiles.includes("src/types.ts"), "keeps the original file");
  assert.ok(repair.allowedFiles.includes("src/consumer.ts"), "adds the coupled file the failure named");
  assert.ok(repair.maxFilesTouched >= 2, "raises the file cap to fit the coupled file");
  // Never pull a test file or node_modules path in from the failure text.
  const repair2 = createRepairCommitlet(failing, "test_types.py failed; node_modules/dep.ts error");
  assert.deepEqual(repair2.allowedFiles, failing.allowedFiles, "tests and node_modules are never added");
});

test("constraint graph and impact propagation expose small facts", () => {
  const root = join(tmpdir(), `cheater-graph-${Date.now().toString(36)}`);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "commands.ts"), "export function register(pi:any){ pi.registerCommand('x', {}); }\n", "utf8");
  writeFileSync(join(root, "src", "config.ts"), "export interface CheaterConfig { reliabilityModeEnabled?: boolean; }\nexport const DEFAULT_CONFIG = {};\n", "utf8");
  writeFileSync(join(root, "test", "commands.test.ts"), "import { register } from '../src/commands';\n", "utf8");
  const graph = buildRepoConstraintGraph(root, ["src/commands.ts", "src/config.ts", "test/commands.test.ts"]);
  assert.ok(queryConstraintFacts(graph, "src/commands.ts").some((fact) => /registers commands/.test(fact)));
  assert.ok(graph.exports.some((item) => item === "src/commands.ts:register"));
  assert.ok(graph.signatures.some((item) => /src\/commands\.ts:register/.test(item)));
  assert.ok(graph.tests.includes("test/commands.test.ts"));
  assert.ok(graph.testMappings.some((item) => item.file === "src/commands.ts" && item.testFile === "test/commands.test.ts"));
  assert.ok(queryConstraintFacts(graph, "src/commands.ts").some((fact) => /likely tests/.test(fact)));
  assert.ok(queryConstraintFacts(graph, "src/commands.ts").some((fact) => /command registry behavior/.test(fact)));
  assert.ok(queryConstraintFacts(graph, "src/config.ts").some((fact) => /config\/startup defaults/.test(fact)));
  const labels = classifyImpact(["src/commands.ts"], "+pi.registerCommand('x', {})\n");
  assert.ok(derivedVerificationForImpact(labels).some((item) => /registry/.test(item)));
});

test("final review blocks unresolved commitlets and accepts clean chains", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "change one typo in README" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "change one typo in README", autopilotDecision: decision });
  assert.equal(runCommitletFinalReview(plan).accepted, false);
  const passed = { ...plan, commitlets: plan.commitlets.map((commitlet) => ({ ...commitlet, status: "passed" as const })) };
  assert.equal(runCommitletFinalReview(passed).accepted, true);
  const failedVerification = {
    ...plan,
    commitlets: plan.commitlets.map((commitlet) => ({
      ...commitlet,
      status: "passed" as const,
      result: {
        filesChanged: [],
        diffLines: 0,
        testsRun: ["fake"],
        verificationPassed: false,
        healthPassed: true,
        rollbackAvailable: true,
        summary: "verification failed",
        issues: ["verification failed"]
      }
    }))
  };
  assert.equal(runCommitletFinalReview(failedVerification).accepted, false);
  const lowHealth = runCommitletFinalReview(passed, "+if (a && b) {}\n".repeat(13));
  assert.equal(lowHealth.accepted, false);
  assert.match(lowHealth.blockingIssues.join("; "), /cleanup commitlet required/);
});

test("final review creates a low-risk cleanup commitlet for health-only blockers", () => {
  // cheater_commitlet_finalize was removed - final review + cleanup commitlet creation now
  // happens automatically inside cheater_commitlet_next once no commitlets are pending. That
  // path always reviews with the plan's own accumulated diff evidence (no external diffText
  // override), so this test exercises the same pure functions the tool now calls internally.
  const decision = routeAutopilot({ cwd: process.cwd(), message: "change one typo in README" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "change one typo in README", autopilotDecision: decision });
  const passed = {
    ...plan,
    status: "running" as const,
    commitlets: plan.commitlets.map((commitlet) => ({
      ...commitlet,
      status: "passed" as const,
      result: {
        filesChanged: ["README.md"],
        diffLines: 13,
        testsRun: ["npm test"],
        verificationPassed: true,
        healthPassed: true,
        rollbackAvailable: true,
        summary: "passed with cleanup-worthy complexity",
        issues: []
      }
    }))
  };
  const review = runCommitletFinalReview(passed, "+if (a && b) {}\n".repeat(13));
  assert.equal(review.accepted, false);
  assert.match(review.blockingIssues.join("; "), /cleanup commitlet required/);
  const cleanup = createCleanupCommitlet(passed, review.blockingIssues.join("; "));
  assert.equal(cleanup.id, "c2-cleanup-health");
  assert.equal(cleanup.status, "pending");
  assert.deepEqual(cleanup.allowedFiles, ["README.md"]);
});

test("commitlet telemetry uses plan creation time and records local metrics", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "change one typo in README" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "change one typo in README", autopilotDecision: decision });
  const createdAt = "2024-01-01T00:00:00.000Z";
  const finishedAt = Date.parse("2024-01-01T00:00:05.000Z");
  const event = telemetryFromPlan(
    { ...plan, createdAt, status: "complete", commitlets: plan.commitlets.map((commitlet) => ({ ...commitlet, status: "passed" as const })) },
    { finishedAt, toolCalls: 7, loopEvents: 2, tokenInput: 100, tokenOutput: 25, userIntervention: 0 }
  );
  assert.equal(event.startedAt, createdAt);
  assert.equal(event.finishedAt, "2024-01-01T00:00:05.000Z");
  assert.equal(event.wallMs, 5000);
  assert.equal(event.toolCalls, 7);
  assert.equal(event.loopEvents, 2);
  assert.equal(event.tokenInput, 100);
  assert.equal(event.tokenOutput, 25);
  assert.equal(event.userIntervention, 0);
});

test("reliability benchmark includes variant E kernel metrics", () => {
  const results = runReliabilityBenchmark({ cwd: process.cwd(), variant: "E", limit: 2 });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => typeof result.healthScore === "number"));
});

test("countDiffLines counts content lines containing --- and excludes only the diff headers", () => {
  // Regression: an unanchored `---` dropped real content lines (front-matter/YAML/`"---"` literals),
  // under-counting the diff (which feeds the size cap, health scoring, and the smaller-is-better tiebreak).
  const diff = [
    "--- a/notes.md", "+++ b/notes.md",
    "+---",                       // markdown front-matter fence — a real added line
    "+title: hi",
    "+const sep = \"---\";",     // a real added line containing ---
    "+ok",
    "-old --- line",              // a real removed line containing ---
  ].join("\n");
  assert.equal(countDiffLines(diff), 5, "5 real +/- content lines; the 2 headers excluded");
});

test("taskInvolvesDependency: real dependency intent yes; product 'package'/'module' nouns no", () => {
  const t = (title: string): boolean => taskInvolvesDependency({ title, purpose: "", spec: undefined } as never);
  // real dependency tasks
  assert.equal(t("npm install axios"), true);
  assert.equal(t("add a dependency on lodash"), true);
  assert.equal(t("add the axios package and use it in api.ts"), true, "naming a package (head noun) is a dep task");
  assert.equal(t("add a package"), true);
  // product features that merely contain the words — must NOT demote the manifest-edit block
  assert.equal(t("add package tracking to the shipping dashboard"), false, "package modifies 'tracking' → product feature");
  assert.equal(t("integrate the payments module"), false);
  assert.equal(t("add a user module to the admin area"), false);
});

test("forgeCommitletSpec: multi-file acceptance criteria name targets jointly, not contradictory 'only' lines", () => {
  const multi = forgeCommitletSpec({ expectedFilesTouched: ["a.ts", "b.ts", "c.ts"], focusedVerification: [], purpose: "p", scope: "edit" } as never, "feature_addition", "build");
  assert.equal(multi.acceptanceCriteria.length, 1, "one joint line, not one contradictory 'only' line per file");
  assert.match(multi.acceptanceCriteria[0], /a\.ts, b\.ts, c\.ts/);
  const single = forgeCommitletSpec({ expectedFilesTouched: ["only.ts"], focusedVerification: [], purpose: "p", scope: "edit" } as never, "feature_addition", "build");
  assert.match(single.acceptanceCriteria[0], /only\.ts is the only expected edit target/);
});

test("classifyImpact: TS method/arrow signatures counted; slash paths are not command registrations", () => {
  assert.ok(classifyImpact(["src/foo.ts"], "-  run(a) {\n+  run(a, b) {\n").includes("method_signature_change"), "keyword-less TS method sig change");
  assert.ok(!classifyImpact(["src/x.ts"], "+  if (cond) {\n").includes("method_signature_change"), "an if-statement is not a signature change");
  assert.ok(!classifyImpact(["src/math.py"], "+def add(a,b):\n+    return a/b\n").includes("command_registration_change"), "integer division a/b is not a command registration");
  assert.ok(classifyImpact(["src/x.ts"], '+ pi.registerCommand("hi", {})').includes("command_registration_change"), "a real registerCommand call still counts");
});
