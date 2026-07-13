import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isFromScratchBuild, proposeScaffoldFiles, repoHasManifest, installCommandForManifest } from "../src/blueprint/scaffold.js";
import { buildScaffoldCommitlets, createCommitletPlan, classifyScaffoldFile, groupScaffoldFilesIntoPhases } from "../src/commitlet/planner.js";
import { runCommitletFinalReview } from "../src/commitlet/reviewer.js";
import { buildCommitletExecutionPrompt } from "../src/commitlet/executor.js";
import { isCreationDiff } from "../src/commitlet/guard.js";
import { scorePatchHealth } from "../src/commitlet/health.js";
import { gradeCommitlet, resetScaffoldAttempts } from "../src/commitlet/kernel.js";
import { ledgerAllowsFinish } from "../src/reliability/lifecycle.js";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { createCheaterReplaceTool } from "../src/tools.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { routeAutopilot } from "../src/autopilot/router.js";
import { runClosedLoopCommitlets } from "../src/commitlet/closedLoop.js";
import { defaultBlueprintState } from "../src/blueprint/state.js";
import { detectStackProfile, stampProfile, deriveAppName, VITE_REACT_TS, VITE_REACT_JS } from "../src/blueprint/stackTemplates.js";
import { beginTaskRun, endTaskRun } from "../src/runstate/runState.js";

// --- B1: stack-agnostic from-scratch detection ---------------------------------------------------

test("isFromScratchBuild fires on a missing-manifest new-app goal, not on edits or existing projects", () => {
  const empty = mkdtempSync(join(tmpdir(), "cheater-scratch-"));
  assert.equal(repoHasManifest(empty), false);
  assert.equal(isFromScratchBuild(empty, "Create a complete web app called FounderOS from scratch"), true);
  assert.equal(isFromScratchBuild(empty, "fix the off-by-one in the parser"), false, "not a create-app goal");
  // Verb-less goal (a terse small model drops "create"): a stack + app noun in an empty repo is still
  // a build, not a question - otherwise it misroutes answer_only and cheater_run no-ops.
  assert.equal(isFromScratchBuild(empty, "Vite + React + TypeScript todo app with TodoInput, TodoList, FilterBar components and a useTodos hook"), true, "verb-less stack+app goal is a build");
  assert.equal(isFromScratchBuild(empty, "what is the best way to structure a react app?"), false, "a plain question without a stack build phrasing is not a build");
  writeFileSync(join(empty, "package.json"), "{}\n", "utf8");
  assert.equal(isFromScratchBuild(empty, "create a new web app"), false, "a manifest means the project already exists");
  assert.equal(isFromScratchBuild(empty, "Vite + React todo app with components"), false, "a manifest overrides even the verb-less stack path");
});

// --- B2: the MODEL proposes the file plan; Cheater validates shape only ---------------------------

test("proposeScaffoldFiles takes the model's file list, manifest-first, and validates the shape", async () => {
  const good = async () => JSON.stringify({ files: [
    { path: "src/App.tsx", purpose: "root component" },
    { path: "package.json", purpose: "manifest + scripts" },
    { path: "vite.config.ts", purpose: "build config" }
  ] });
  const files = await proposeScaffoldFiles("build a react app", good);
  assert.equal(files.length, 3);
  assert.equal(files[0].path, "package.json", "the manifest is ordered first");

  // No manifest in the proposal -> invalid scaffold -> [] (caller falls back to the normal plan).
  assert.deepEqual(await proposeScaffoldFiles("x", async () => JSON.stringify({ files: [{ path: "src/App.tsx" }] })), []);
  // Off-shape / non-JSON / thrown -> [] (never crashes).
  assert.deepEqual(await proposeScaffoldFiles("x", async () => "sorry, I can't"), []);
  assert.deepEqual(await proposeScaffoldFiles("x", async () => { throw new Error("boom"); }), []);

  // Path traversal / absolute / directory paths are dropped; real relative files survive.
  const risky = await proposeScaffoldFiles("x", async () => JSON.stringify({ files: [
    { path: "../etc/passwd" }, { path: "/abs/evil" }, { path: "src/" }, { path: "package.json" }, { path: "src/ok.ts" }
  ] }));
  assert.ok(risky.every((f) => !f.path.includes("..") && !f.path.startsWith("/") && !f.path.endsWith("/")), "unsafe paths dropped");
  assert.ok(risky.some((f) => f.path === "package.json") && risky.some((f) => f.path === "src/ok.ts"));
});

// --- B3: create-commitlets from the file list are GROUPED INTO PHASES (not one-per-file) ----------

test("buildScaffoldCommitlets groups the file list into ordered phase commitlets, not one per file", () => {
  const decision = routeAutopilot({ cwd: ".", message: "build a new app from scratch" });
  const commitlets = buildScaffoldCommitlets(
    [
      { path: "package.json", purpose: "manifest" },
      { path: "tsconfig.json", purpose: "ts config" },
      { path: "vite.config.ts", purpose: "build config" },
      { path: "index.html", purpose: "entry html" },
      { path: "src/main.tsx", purpose: "entry" },
      { path: "src/App.tsx", purpose: "root component" },
      { path: "src/types.ts", purpose: "types" },
      { path: "src/components/Board.tsx", purpose: "board" },
      { path: "src/components/Card.tsx", purpose: "card" },
      { path: "src/App.test.tsx", purpose: "smoke test" }
    ],
    "build a new app from scratch",
    decision
  );
  // 10 files -> a handful of PHASE commitlets, never 10 one-file commitlets (the whole point).
  assert.ok(commitlets.length >= 3 && commitlets.length <= 5, `expected ~3-5 phase commitlets, got ${commitlets.length}`);
  const config = commitlets[0];
  assert.equal(config.scope, "scaffold");
  assert.ok(
    config.allowedFiles.includes("package.json") && config.allowedFiles.includes("tsconfig.json") && config.allowedFiles.includes("index.html"),
    "the config phase groups the manifest + build/config files"
  );
  assert.equal(config.maxFilesTouched, config.allowedFiles.length, "a phase may touch all of its own files");
  assert.equal(config.healthBudget.allowDependencyEdits, true, "the config phase (with the manifest) may edit dependencies");
  assert.ok(config.maxDiffLines >= 2000, "a phase of new files may be large");
  assert.ok(config.spec, "specs are forged");
  const featurePhase = commitlets.find((commitlet) => commitlet.allowedFiles.some((file) => file.includes("components/")));
  assert.ok(featurePhase, "feature components are grouped into a phase");
  assert.equal(featurePhase!.healthBudget.allowDependencyEdits, false, "a non-manifest phase may not edit dependencies");
  const validationPhase = commitlets.find((commitlet) => commitlet.allowedFiles.some((file) => /\.test\./.test(file)));
  assert.ok(validationPhase && validationPhase.healthBudget.allowTestEdits, "the validation phase may edit tests");
});

test("a scaffold plan carries buildMode:scaffold and renders ONE coherent phase prompt (no contradictory worker language)", () => {
  const decision = routeAutopilot({ cwd: ".", message: "build a new app from scratch" });
  const plan = createCommitletPlan({
    repoRoot: ".",
    userGoal: "build a new app from scratch",
    autopilotDecision: decision,
    commitlets: buildScaffoldCommitlets(
      [{ path: "package.json", purpose: "manifest" }, { path: "src/App.tsx", purpose: "root" }],
      "build a new app from scratch",
      decision
    ),
    buildMode: "scaffold"
  });
  assert.equal(plan.buildMode, "scaffold", "the plan carries the scaffold lane");
  const prompt = buildCommitletExecutionPrompt(plan, plan.commitlets[0]).prompt;
  assert.match(prompt, /phase 1\//, "names the phase and its position");
  assert.match(prompt, /npm install/, "the config phase (with the manifest) installs deps");
  assert.match(prompt, /cheater_commitlet_next/, "tells the model how to advance");
  // The core prompt-coherence fix: the scaffold prompt must NOT carry bounded-worker contradictions.
  assert.doesNotMatch(prompt, /stop and hand off|do not continue to another file|one[\s\S]{0,14}edit then stop/i, "no contradictory bounded-worker language");
  assert.doesNotMatch(prompt, /separate isolated worker session/i, "no separate-worker notice for an in-session build");
  // Wiring fix: phases are a suggested order, not a cage - the model may edit any file to wire the app.
  assert.doesNotMatch(prompt, /Stay within this phase's files/i, "the old cage language is gone");
  assert.match(prompt, /edit ANY file|wire the app together/i, "the model is told it may wire across files");
  assert.match(prompt, /thin/i, "the model is told to keep App.tsx thin, not a monolith");
});

test("final review is scaffold-lenient on patch health: a from-scratch plan scoring health 0 is ACCEPTED; surgical still blocks", () => {
  // A churny diff with removals (not a pure creation) + heavy duplication scores well below the
  // hard-reject threshold - exactly the accumulated shape that blocked the live FounderOS build.
  const badDiff = [
    ...Array.from({ length: 130 }, () => "+  if (doSame()) { return doSame(); } else { return null; }"),
    ...Array.from({ length: 40 }, () => "-  legacy();")
  ].join("\n");
  const basePlan: any = {
    id: "p", createdAt: "", repoRoot: ".", userGoal: "build", summary: "",
    commitlets: [{ id: "c1-scaffold-config", status: "passed", forbiddenFiles: [], result: { filesChanged: ["src/App.tsx"], verificationPassed: true, healthPassed: true } }],
    currentIndex: 0, status: "running", globalConstraints: [], finalVerification: [], finalReview: {}, risk: "low"
  };
  const scaffold = runCommitletFinalReview({ ...basePlan, buildMode: "scaffold" }, badDiff);
  assert.equal(scaffold.accepted, true, "scaffold: patch health is advisory, never the final blocker (npm run build is the real gate)");
  assert.ok(scaffold.warnings.some((w: string) => /health/i.test(w)), "low health surfaces as a warning, not a block");
  const surgical = runCommitletFinalReview({ ...basePlan, buildMode: "surgical" }, badDiff);
  assert.equal(surgical.accepted, false, "surgical/repair: low health still hard-blocks the final review");
});

test("classifyScaffoldFile puts the app entry/shell (App/main) in the 'entry' phase, ordered AFTER components", () => {
  assert.equal(classifyScaffoldFile("src/App.tsx"), "entry");
  assert.equal(classifyScaffoldFile("src/main.tsx"), "entry");
  assert.equal(classifyScaffoldFile("src/components/Dashboard.tsx"), "features");
  assert.equal(classifyScaffoldFile("src/types/index.ts"), "foundation", "a barrel index.ts is foundation, not entry");
  const phases = groupScaffoldFilesIntoPhases([
    { path: "src/App.tsx", purpose: "" },
    { path: "src/main.tsx", purpose: "" },
    { path: "src/components/Dashboard.tsx", purpose: "" },
    { path: "src/types/index.ts", purpose: "" }
  ]);
  const featuresIdx = phases.findIndex((p) => p.key === "features");
  const entryIdx = phases.findIndex((p) => p.key === "entry");
  assert.ok(featuresIdx >= 0 && entryIdx > featuresIdx, "App/main are built AFTER the components they import (no inline monolith)");
});

test("a surgical plan is unchanged: buildMode defaults to surgical", () => {
  const decision = routeAutopilot({ cwd: ".", message: "fix the parser off-by-one" });
  const plan = createCommitletPlan({ repoRoot: ".", userGoal: "fix the parser off-by-one", autopilotDecision: decision });
  assert.equal(plan.buildMode, "surgical", "non-scaffold plans default to the surgical lane");
});

// --- C3: a big NEW file passes guard/health (creation diff) --------------------------------------

test("a big NEW-file (pure-addition) diff is treated as creation and passes health", () => {
  const newFile = Array.from({ length: 400 }, (_, i) => `+  const line${i} = ${i};`).join("\n");
  assert.equal(isCreationDiff(newFile), true);
  const created = scorePatchHealth({ diffText: newFile, filesTouched: ["src/App.tsx"] });
  assert.equal(created.passed, true, "creating a 400-line component is not a health failure");

  const edit = "+  added line\n-  removed line\n+  another added";
  assert.equal(isCreationDiff(edit), false, "a diff with deletions is an edit, not a creation");
});

// --- C1: a crash in the run loop clears blueprint state (unbrick) --------------------------------

test("a crash in the run loop clears blueprint state so the tool mask releases (unbrick)", async () => {
  defaultBlueprintState.setPlan({ workPackets: [{ status: "pending" }] } as never);
  const result = await runClosedLoopCommitlets(
    { cwd: ".", userGoal: "x", config: {}, ctx: {} },
    { route: () => { throw new Error("boom"); } } as never
  );
  assert.equal(result.status, "failed", "a crash returns a clean failure, not an unhandled throw");
  assert.equal(defaultBlueprintState.get().currentPlan, null, "blueprint state cleared -> file/shell tools restored");
});

// --- scaffold grading never wipes the model's work; cheater_replace is the cheap targeted fix ----

test("scaffold grade advances and NEVER reverts (a low-health from-scratch file survives)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-scaffold-grade-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const decision = routeAutopilot({ cwd, message: "build a new app from scratch" });
  const commitlets = buildScaffoldCommitlets([{ path: "src/App.tsx", purpose: "app" }], "build a new app", decision);
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "build a new app", autopilotDecision: decision, commitlets, buildMode: "scaffold" });
  const commitlet = { ...plan.commitlets[0], status: "running" as const };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  // A big, duplicative file scores health well below the hard-reject threshold - in the OLD behavior
  // this reverted and DELETED the file (the "empty src/" bug). Scaffold must keep it.
  const lowHealth = Array.from({ length: 300 }, () => "const x = doSame(); if (x) { return x; } else { return null; }").join("\n");
  writeFileSync(join(cwd, "src", "App.tsx"), lowHealth, "utf8");
  const health = scorePatchHealth({ diffText: lowHealth.split("\n").map((l) => `+${l}`).join("\n"), filesTouched: ["src/App.tsx"] });
  defaultCommitletState.setPlan({ ...plan, status: "running", commitlets: [commitlet] } as any);
  liveSessionState.reset("build a new app");

  const grade = await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);
  assert.equal(grade.advance, true, "a scaffold phase advances even when patch health is low");
  assert.ok(existsSync(join(cwd, "src", "App.tsx")), "the from-scratch file is NEVER reverted/wiped");
  assert.equal(readFileSync(join(cwd, "src", "App.tsx"), "utf8"), lowHealth, "the file content is intact on disk");
  defaultCommitletState.clear();
});

test("scaffold phase advances when its expected file exists under a DIFFERENT directory (basename match, not exact path)", async () => {
  // Regression: the model builds a cleaner structure (src/components/TodoItem.tsx) than the upfront plan
  // guessed (flat src/TodoItem.tsx). The phase must advance on the basename, not loop on the exact path.
  const cwd = mkdtempSync(join(tmpdir(), "cheater-scaffold-basename-"));
  mkdirSync(join(cwd, "src", "components"), { recursive: true });
  const decision = routeAutopilot({ cwd, message: "build a new app from scratch" });
  const commitlets = buildScaffoldCommitlets([{ path: "src/TodoItem.tsx", purpose: "item" }], "build a new app", decision);
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "build a new app", autopilotDecision: decision, commitlets, buildMode: "scaffold" });
  const commitlet = { ...plan.commitlets[0], status: "running" as const };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  defaultCommitletState.setPlan({ ...plan, status: "running", commitlets: [commitlet] } as any);
  liveSessionState.reset("build a new app");
  // Model wrote the file under components/ (same basename, different path).
  writeFileSync(join(cwd, "src", "components", "TodoItem.tsx"), "export const TodoItem = () => null;\n", "utf8");
  const grade = await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);
  assert.equal(grade.advance, true, "phase advances: the expected basename exists somewhere in the project");
  defaultCommitletState.clear();
});

test("gradeCommitlet records a REAL WORKER's file edit into the main ledger (the finish-gate loop fix)", async () => {
  // Regression for the local-bake-off finding: a fresh isolated worker edits files in its OWN pi
  // session, so those writes never reach THIS session's observeToolResult. gradeCommitlet used to
  // record the verification stage but NOT the touched files, so the finish gate saw changedFiles:0
  // and blocked with "no work was done" - forever, as the model looped back through the planning
  // tools. Here we simulate the worker by editing the file on disk WITHOUT any observeToolResult
  // call; after grading, the MAIN completion ledger must reflect the change.
  const cwd = mkdtempSync(join(tmpdir(), "cheater-worker-ledger-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "stats.py"), "def median(xs):\n    return 0  # buggy\n", "utf8");
  const decision = routeAutopilot({ cwd, message: "fix the median function in src/stats.py" });
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "fix the median function in src/stats.py", autopilotDecision: decision });
  const commitlet = { ...plan.commitlets[0], status: "running" as const, allowedFiles: ["src/stats.py"], expectedFilesTouched: ["src/stats.py"] };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet); // snapshots the buggy version
  defaultCommitletState.setPlan({ ...plan, status: "running", commitlets: [commitlet] } as any);
  liveSessionState.reset("fix the median function in src/stats.py");
  assert.equal(liveSessionState.getLedger()!.get().changedFiles.length, 0, "ledger starts with no work");

  // The "worker" edits the file in its own session - no observeToolResult here, by design.
  writeFileSync(join(cwd, "src", "stats.py"), "def median(xs):\n    s = sorted(xs)\n    n = len(s)\n    return s[n // 2]\n", "utf8");
  await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);

  const changed = liveSessionState.getLedger()!.get().changedFiles;
  assert.ok(changed.some((f) => /stats\.py/.test(f)), `worker edit must be in the main ledger, got: ${JSON.stringify(changed)}`);
  // And that recorded work now makes a same-goal re-entry PRESERVE the ledger (the two fixes combine).
  assert.equal(liveSessionState.isReentryGoal("fix the median function in src/stats.py"), true, "recorded work makes a restart preserve, not wipe");
  defaultCommitletState.clear();
});

test("a command-less commitlet records a SKIPPED stage (not a vacuous ok) → finishes honestly-unverified, never 'verified'", async () => {
  // Regression (triple-confirmed): runFocusedVerification returns a vacuous passed:true when a commitlet
  // has no command-backed step. The kernel recorded that as focused_tests:ok, so isTerminalVerified /
  // ledgerAllowsFinish reported "verified" with ZERO commands run — a false green — and the honest
  // noRunnableCheck path was defeated. It must record skipped + noCommandAvailable instead.
  const cwd = mkdtempSync(join(tmpdir(), "cheater-nocmd-verify-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "stats.py"), "def median(xs):\n    return 0\n", "utf8");
  const decision = routeAutopilot({ cwd, message: "fix median in src/stats.py" });
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "fix median in src/stats.py", autopilotDecision: decision });
  const commitlet = {
    ...plan.commitlets[0], status: "running" as const, allowedFiles: ["src/stats.py"], expectedFilesTouched: ["src/stats.py"],
    focusedVerification: [{ purpose: "manual review — no test command in this project", required: false }],
  };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  defaultCommitletState.setPlan({ ...plan, status: "running", commitlets: [commitlet] } as any);
  liveSessionState.reset("fix median in src/stats.py");
  writeFileSync(join(cwd, "src", "stats.py"), "def median(xs):\n    s = sorted(xs)\n    return s[len(s)//2]\n", "utf8");

  await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);

  const ledger = liveSessionState.getLedger()!;
  const focused = ledger.get().verification.find((v) => v.stage === "focused_tests");
  assert.equal(focused?.status, "skipped", "a command-less verification is skipped, not a vacuous ok");
  assert.equal((focused?.signals as Record<string, unknown> | undefined)?.noCommandAvailable, true);
  const verdict = ledgerAllowsFinish(ledger);
  assert.equal(verdict.allowed, true, "no runnable check → honest unverified finish, not forever-blocked");
  assert.notEqual(verdict.reason, "verified", "must NOT claim verified when zero commands ran");
  assert.match(verdict.reason, /unverified|no runnable/);
  defaultCommitletState.clear();
});

test("scaffold phase STILL blocks when an expected file is genuinely absent by name (no false advance)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-scaffold-missing-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const decision = routeAutopilot({ cwd, message: "build a new app from scratch" });
  const commitlets = buildScaffoldCommitlets([{ path: "src/OnlyExpected.tsx", purpose: "x" }], "build a new app", decision);
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "build a new app", autopilotDecision: decision, commitlets, buildMode: "scaffold" });
  const commitlet = { ...plan.commitlets[0], status: "running" as const };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  defaultCommitletState.setPlan({ ...plan, status: "running", commitlets: [commitlet] } as any);
  liveSessionState.reset("build a new app");
  // Nothing with that basename exists -> the phase must NOT advance (the build would be missing a file).
  const grade = await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);
  assert.equal(grade.advance, false, "a genuinely absent expected file keeps the phase incomplete");
  assert.match(grade.message, /not complete yet/);
  defaultCommitletState.clear();
});

test("resetScaffoldAttempts restarts the grace period so an interrupted build's counts don't leak into the next run", async () => {
  // Regression: the scaffold-incomplete counter is a module-global keyed by a non-plan-scoped commitlet
  // id. An interrupted build that reached the 2-attempt cap left the count behind, so a later same-process
  // build reusing the id advanced immediately, skipping the intended "here's what's missing" grace re-asks.
  const cwd = mkdtempSync(join(tmpdir(), "cheater-scaffold-reset-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const decision = routeAutopilot({ cwd, message: "build a new app from scratch" });
  const commitlets = buildScaffoldCommitlets([{ path: "src/index.tsx", purpose: "entry" }], "build a new app", decision);
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "build a new app", autopilotDecision: decision, commitlets, buildMode: "scaffold" });
  const commitlet = { ...plan.commitlets[0], status: "running" as const };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  defaultCommitletState.setPlan({ ...plan, status: "running", commitlets: [commitlet] } as any);
  liveSessionState.reset("build a new app");
  resetScaffoldAttempts(); // isolate from any prior test's leftover counts (the very leak under test)
  writeFileSync(join(cwd, "src", "main.tsx"), "export const x = 1;\n", "utf8"); // never creates the exact name
  assert.equal((await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG)).advance, false); // attempt 1
  assert.equal((await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG)).advance, false); // attempt 2 (cap)
  // A new run resets the counter; the same id must restart the grace period, not advance early.
  resetScaffoldAttempts();
  assert.equal((await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG)).advance, false, "grace restarts after reset (would be true without the fix)");
  defaultCommitletState.clear();
  resetScaffoldAttempts(); // don't pollute later tests sharing this scaffold id
});

test("a scaffold phase advances after 2 incomplete grades even if the exact expected NAME is never created (rename escape; build is the gate)", async () => {
  // Regression: the plan expected src/index.tsx but the model built src/main.tsx (a valid Vite entry
  // under a different name) and will never create index.tsx. Without a cap this loops forever; the cap
  // advances after 2 asks and lets the final `npm run build` be the real gate.
  const cwd = mkdtempSync(join(tmpdir(), "cheater-scaffold-cap-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const decision = routeAutopilot({ cwd, message: "build a new app from scratch" });
  const commitlets = buildScaffoldCommitlets([{ path: "src/index.tsx", purpose: "entry" }], "build a new app", decision);
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "build a new app", autopilotDecision: decision, commitlets, buildMode: "scaffold" });
  const commitlet = { ...plan.commitlets[0], status: "running" as const };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  defaultCommitletState.setPlan({ ...plan, status: "running", commitlets: [commitlet] } as any);
  liveSessionState.reset("build a new app");
  writeFileSync(join(cwd, "src", "main.tsx"), "export const x = 1;\n", "utf8"); // different name, same role
  const g1 = await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);
  assert.equal(g1.advance, false, "1st grade still asks for the missing name");
  const g2 = await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);
  assert.equal(g2.advance, false, "2nd grade still asks");
  const g3 = await gradeCommitlet(cwd, commitlet, DEFAULT_CONFIG);
  assert.equal(g3.advance, true, "3rd grade advances anyway - the model built an equivalent file; the build is the real gate");
  defaultCommitletState.clear();
});

test("cheater_replace does literal replace-all without rewriting the file, and refuses a 0-match no-op", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-replace-"));
  writeFileSync(join(cwd, "a.txt"), "x \u{26A1} y \u{26A1} z", "utf8");
  const tool = createCheaterReplaceTool();
  const r: any = await tool.execute("t", { path: "a.txt", find: "\u{26A1}", replace: "OK" }, undefined, undefined, { cwd });
  assert.equal(r.details.ok, true);
  assert.equal(r.details.replacements, 2, "every occurrence is replaced in one cheap call");
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "x OK y OK z");
  const miss: any = await tool.execute("t2", { path: "a.txt", find: "not-present", replace: "q" }, undefined, undefined, { cwd });
  assert.equal(miss.details.ok, false, "a 0-match reports failure instead of a silent no-op");
  assert.equal(miss.details.replacements, 0);
});

// --- Phase A: stack-template boilerplate acceleration ---------------------------------------------

test("detectStackProfile picks the stack from the model's OWN file plan (TS vs JS), else null", () => {
  const tsFiles = ["package.json", "vite.config.ts", "src/App.tsx", "src/main.tsx"];
  const jsFiles = ["package.json", "vite.config.js", "src/App.jsx", "src/main.jsx"];
  // .tsx in the plan -> TS profile; .jsx (no .tsx) -> JS profile. No goal regex involved.
  assert.equal(detectStackProfile(tsFiles)?.id, "vite-react-ts");
  assert.equal(detectStackProfile(jsFiles)?.id, "vite-react-js", "the common 'react + vite' JS plan now matches (the A/B gap)");
  // TS wins when both extensions appear (a .tsx present means TypeScript)
  assert.equal(detectStackProfile(["package.json", "vite.config.ts", "src/App.tsx", "src/legacy.jsx"])?.id, "vite-react-ts");
  // no Vite manifest signature -> null (model-authored path unchanged)
  assert.equal(detectStackProfile(["package.json", "src/index.js"]), null, "no vite.config -> no match");
  // an unrelated stack is not recognized
  assert.equal(detectStackProfile(["requirements.txt", "app.py"]), null, "a Python plan matches no React profile");
  // allowedStacks (config) gates the menu
  assert.equal(detectStackProfile(jsFiles, ["vite-react-ts"]), null, "JS plan excluded when only TS is allowed");
  assert.equal(detectStackProfile(jsFiles, ["vite-react-js"])?.id, "vite-react-js");
});

test("stampProfile (JS) stamps vite.config.js + main.jsx, no tsconfig, vite-only build", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-stamp-js-"));
  const planned = ["package.json", "vite.config.js", "src/App.jsx", "src/main.jsx", "index.html", "src/hooks/useLocalStorage.js"];
  const stamped = stampProfile(cwd, VITE_REACT_JS, { appName: "todo", usesTailwind: false, entryComponent: "./App" }, planned);
  const paths = stamped.map((s) => s.path);
  assert.ok(paths.includes("vite.config.js") && paths.includes("src/main.jsx"), "JS config + jsx entry stamped");
  assert.ok(!paths.some((p) => p.includes("tsconfig")), "no tsconfig in a JS project");
  assert.ok(!paths.includes("src/App.jsx"), "App is the model's real logic - never stamped");
  assert.match(readFileSync(join(cwd, "src", "main.jsx"), "utf8"), /from "\.\/App"/, "entry mounts ./App");
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  assert.equal(pkg.scripts.build, "vite build", "JS build is vite-only (no tsc)");
  assert.ok(!pkg.devDependencies.typescript, "no typescript dep in a JS project");
  assert.ok(pkg.devDependencies.vitest, "test deps still pre-included");
});

test("stampProfile stamps invariant files to disk, honors the model's plan, and skips gated ones", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-stamp-"));
  const planned = ["package.json", "vite.config.ts", "tsconfig.json", "tsconfig.node.json", "index.html",
    "src/main.tsx", "src/App.tsx", "src/hooks/useLocalStorage.ts", "postcss.config.js", "tailwind.config.js",
    "src/vite-env.d.ts", "src/index.css"];
  const stamped = stampProfile(cwd, VITE_REACT_TS, { appName: "demo", usesTailwind: true, entryComponent: "./App" }, planned);
  const paths = stamped.map((s) => s.path);
  assert.ok(paths.includes("package.json") && paths.includes("vite.config.ts"), "structural build config is stamped");
  assert.ok(paths.includes("src/main.tsx") && paths.includes("index.html"), "the entry pair is stamped");
  assert.ok(paths.includes("tailwind.config.js") && paths.includes("postcss.config.js"), "tailwind config stamped when usesTailwind");
  assert.ok(paths.includes("src/hooks/useLocalStorage.ts"), "the hook is stamped because the model planned it");
  assert.ok(!paths.includes("src/App.tsx"), "App.tsx is real app logic - NEVER stamped");
  // files really landed on disk with correct, aligned content
  assert.ok(existsSync(join(cwd, "package.json")));
  assert.match(readFileSync(join(cwd, "src", "main.tsx"), "utf8"), /from "\.\/App"/, "the entry mounts ./App (the App the model still writes)");
  assert.match(readFileSync(join(cwd, "src", "index.css"), "utf8"), /@tailwind base/, "tailwind directives in index.css");
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  assert.ok(pkg.devDependencies.vitest && pkg.devDependencies.jsdom, "test deps pre-included so the model needs no mid-build install");
  assert.ok(pkg.devDependencies.tailwindcss, "tailwind dep present when usesTailwind");
});

test("stampProfile without Tailwind skips the styling files and Tailwind deps", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-stamp-notw-"));
  const planned = ["package.json", "vite.config.ts", "src/App.tsx", "src/main.tsx", "index.html", "src/index.css"];
  const stamped = stampProfile(cwd, VITE_REACT_TS, { appName: "demo", usesTailwind: false, entryComponent: "./App" }, planned);
  const paths = stamped.map((s) => s.path);
  assert.ok(!paths.includes("tailwind.config.js") && !paths.includes("postcss.config.js"), "no tailwind/postcss without Tailwind");
  assert.match(readFileSync(join(cwd, "src", "index.css"), "utf8"), /box-sizing/, "a minimal reset index.css, not Tailwind directives");
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  assert.ok(!pkg.devDependencies.tailwindcss, "no tailwind dep without Tailwind");
});

test("stampProfile leaves the entry to the model when it chose its own entry name (src/index.tsx)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-stamp-entry-"));
  const planned = ["package.json", "vite.config.ts", "src/App.tsx", "src/index.tsx"]; // index.tsx entry, no main.tsx
  const stamped = stampProfile(cwd, VITE_REACT_TS, { appName: "demo", usesTailwind: true, entryComponent: "./App" }, planned);
  const paths = stamped.map((s) => s.path);
  assert.ok(!paths.includes("src/main.tsx") && !paths.includes("index.html") && !paths.includes("src/index.css"),
    "no entry pair when the model picked its own entry - avoids an index.html pointing at a nonexistent main.tsx");
  assert.ok(!paths.includes("src/hooks/useLocalStorage.ts"), "an optional file the model did not plan is not stamped");
  assert.ok(paths.includes("package.json"), "structural config is still stamped");
  assert.ok(!existsSync(join(cwd, "src", "main.tsx")), "main.tsx not written");
});

test("deriveAppName makes an npm-safe name from the goal", () => {
  assert.equal(deriveAppName("Create a startup command center called FounderOS with a dashboard"), "founder-os");
  assert.equal(deriveAppName("build a todo app"), "app");
});

test("scaffold phase prompt lists stamped files as existing, drops them from 'create', keeps install; OFF path unchanged", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-stamp-prompt-"));
  const decision = routeAutopilot({ cwd, message: "build a new app from scratch" });
  const commitlets = buildScaffoldCommitlets(
    [{ path: "package.json", purpose: "manifest" }, { path: "vite.config.ts", purpose: "config" }, { path: "src/App.tsx", purpose: "root" }],
    "build a new app from scratch", decision);
  const plan = createCommitletPlan({ repoRoot: cwd, userGoal: "build a new app from scratch", autopilotDecision: decision, commitlets, buildMode: "scaffold" });
  const configPhase = plan.commitlets.find((c) => c.id.includes("config"))!;

  // OFF path: no active run/stamp -> no "already wrote" block, and the files are still listed to create.
  endTaskRun();
  const off = buildCommitletExecutionPrompt(plan, configPhase).prompt;
  assert.doesNotMatch(off, /FILES THE HARNESS ALREADY WROTE/, "no stamp note without a stamp (OFF path is unchanged)");
  assert.match(off, /- package\.json/, "lists the manifest to create when nothing is stamped");

  // ON path: a run carrying a stamp ledger -> stamped files move to the 'already exists' note.
  const run = beginTaskRun(cwd, "build a new app from scratch", { taskId: plan.id });
  run.setScaffoldStamp({ stamped: [
    { path: "package.json", exportsSummary: "manifest - run npm install once" },
    { path: "vite.config.ts", exportsSummary: "" }
  ] });
  const on = buildCommitletExecutionPrompt(plan, configPhase).prompt;
  assert.match(on, /FILES THE HARNESS ALREADY WROTE/, "stamped files are announced as existing");
  assert.match(on, /- package\.json - manifest - run npm install once/, "the export contract is shown to the model");
  assert.match(on, /Every file in this phase already exists/, "both config files stamped -> nothing to create this phase");
  assert.match(on, /npm install/, "the install step survives even though package.json was stamped");
  endTaskRun();
  defaultCommitletState.clear();
});

test("isFromScratchBuild: empty-repo build yes; a fix goal or a monorepo subdir manifest is not from-scratch", () => {
  const empty = mkdtempSync(join(tmpdir(), "sf-empty-"));
  assert.equal(isFromScratchBuild(empty, "build a flask+react weather app"), true);
  assert.equal(isFromScratchBuild(empty, "React + TypeScript todo app with components"), true, "terse verb-less build still detected");
  assert.equal(isFromScratchBuild(empty, "fix the flask service routing in my app"), false, "a fix goal is not a from-scratch build");
  const mono = mkdtempSync(join(tmpdir(), "sf-mono-"));
  mkdirSync(join(mono, "frontend"), { recursive: true });
  writeFileSync(join(mono, "frontend", "package.json"), "{}", "utf8");
  assert.equal(isFromScratchBuild(mono, "create a new admin dashboard app"), false, "a subdir manifest means the project already exists");
});

test("installCommandForManifest picks the stack's install step, not always npm", () => {
  assert.equal(installCommandForManifest("requirements.txt"), "pip install -r requirements.txt");
  assert.equal(installCommandForManifest("Cargo.toml"), "cargo build");
  assert.equal(installCommandForManifest("go.mod"), "go mod download");
  assert.equal(installCommandForManifest("package.json"), "npm install");
});

test("classifyScaffoldFile: a React index entry in ANY directory is 'entry'; a barrel index.ts is not", () => {
  assert.equal(classifyScaffoldFile("index.tsx"), "entry");
  assert.equal(classifyScaffoldFile("app/index.tsx"), "entry", "entry-last ordering must apply regardless of directory");
  assert.equal(classifyScaffoldFile("src/components/index.ts"), "features", "a barrel index.ts is not the app entry");
});
