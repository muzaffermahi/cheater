import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { registerCommitletTools } from "../src/commitlet/tools.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { defaultBlueprintState } from "../src/blueprint/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { CompletionLedger, ledgerAllowsFinish, NonProgressDetector, classifyCommand, classifyFailure, workspaceIdentityCheck, ProcessRegistry, isTerminalVerified, commandFingerprint, isExploratoryCommand } from "../src/reliability/lifecycle.js";
import { detectProjectCommands, focusTestCommand, loadProjectCommands } from "../src/reliability/projectCommands.js";
import { runVerification } from "../src/reliability/verificationRunner.js";
import { buildCommitletExecutionPrompt } from "../src/commitlet/executor.js";
import { createCommitletPlan } from "../src/commitlet/planner.js";
import { routeAutopilot } from "../src/autopilot/router.js";

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    }
  };
  return { pi, tools, commands };
}

function ctxWithCwd(cwd: string) {
  return { cwd, model: { id: "test-model", provider: "test" } };
}

test("reliability start creates ledger state in the live session", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  defaultBlueprintState.clear();
  liveSessionState.reset();
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const cwd = mkdtempSync(join(tmpdir(), "cheater-live-ledger-"));
  writeFileSync(join(cwd, "README.md"), "docs\n", "utf8");
  await tools.get("cheater_reliability_start").execute(
    "start-ledger",
    { userGoal: "change one typo in README" },
    undefined,
    undefined,
    ctxWithCwd(cwd)
  );
  const ledger = liveSessionState.getLedger();
  assert.ok(ledger, "reliability start must create a completion ledger");
  const state = ledger.get();
  assert.equal(state.userGoal, "change one typo in README");
  assert.equal(state.done, false);
});

test("repeated no-progress action is detected by the live session state", () => {
  liveSessionState.reset("no-progress test");
  const config = { ...DEFAULT_CONFIG, loopGovernorEnabled: true };
  for (let i = 0; i < 5; i++) {
    const toolCallId = `call-${i}`;
    liveSessionState.observeToolCall({ toolCallId, toolName: "read", path: "src/same.ts" }, config);
    liveSessionState.observeToolResult({ toolCallId, toolName: "read", ok: true, path: "src/same.ts" }, config);
  }
  const detector = liveSessionState.getDetector();
  assert.ok(detector, "non-progress detector must be active");
  assert.ok(detector.currentStreak >= 3, `expected streak >= 3, got ${detector.currentStreak}`);
});

test("a call+result pair records exactly one tool record (no double-counting regression)", () => {
  // The live tool_call/tool_result hooks used to both invoke the same combined observer,
  // recording two entries per logical tool call. That silently halved the effective
  // maxTotalToolCallsPerPacket budget (default 14), false-terminal-blocking real sessions
  // after ~7 tool calls. 14 distinct-file calls must stay under the cap now.
  liveSessionState.reset("double-count regression test");
  const config = { ...DEFAULT_CONFIG, loopGovernorEnabled: true };
  const events: string[] = [];
  for (let i = 0; i < 14; i++) {
    const toolCallId = `distinct-${i}`;
    const callEvents = liveSessionState.observeToolCall({ toolCallId, toolName: "read", path: `src/file-${i}.ts` }, config);
    for (const evt of callEvents) events.push(evt.kind);
    liveSessionState.observeToolResult({ toolCallId, toolName: "read", ok: true, path: `src/file-${i}.ts` }, config);
  }
  assert.deepEqual(events, [], "14 distinct-file calls must fit the per-packet tool-call budget without a loop break");
  assert.equal(liveSessionState.getToolRecords().length, 14, "each call+result pair must add exactly one record");
});

test("finish is blocked without verification evidence", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  liveSessionState.reset("finish-gate test");
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const cwd = mkdtempSync(join(tmpdir(), "cheater-finish-gate-"));
  writeFileSync(join(cwd, "README.md"), "docs\n", "utf8");
  await tools.get("cheater_reliability_start").execute(
    "start",
    { userGoal: "change one typo in README" },
    undefined,
    undefined,
    ctxWithCwd(cwd)
  );
  const ledger = liveSessionState.getLedger();
  assert.ok(ledger);
  const verdict = ledgerAllowsFinish(ledger);
  assert.equal(verdict.allowed, false, "finish must be blocked when no verification was run");
  assert.match(verdict.reason, /no verification|no work|unresolved/);
  const gateResult = await tools.get("cheater_finish_gate").execute(
    "gate",
    { summary: "I am done" },
    undefined,
    undefined,
    ctxWithCwd(cwd)
  );
  assert.match(gateResult.content[0].text, /BLOCKED/);
  assert.equal(gateResult.details.allowed, false);
});

test("finish is allowed after verification evidence is recorded", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  liveSessionState.reset("finish-ok test");
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const cwd = mkdtempSync(join(tmpdir(), "cheater-finish-ok-"));
  writeFileSync(join(cwd, "README.md"), "docs\n", "utf8");
  await tools.get("cheater_reliability_start").execute(
    "start",
    { userGoal: "change one typo in README" },
    undefined,
    undefined,
    ctxWithCwd(cwd)
  );
  const ledger = liveSessionState.getLedger();
  assert.ok(ledger, "ledger must exist after reliability start");
  const l = ledger!;
  l.recordFileChange("README.md");
  l.recordCommand("node -e process.exit(0)");
  l.recordVerificationStage({
    stage: "focused_tests",
    status: "ok",
    summary: "focused tests passed",
    failureClass: "unknown",
    artifacts: [],
    signals: {}
  });
  l.recordVerificationStage({
    stage: "summarize",
    status: "ok",
    summary: "summary ok",
    failureClass: "unknown",
    artifacts: [],
    signals: {}
  });
  const verdict = ledgerAllowsFinish(l);
  assert.equal(verdict.allowed, true, `finish should be allowed after verification; got: ${verdict.reason}`);
});

test("verification command detection works for JS repos", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-js-cmd-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "test-js",
    scripts: { test: "vitest run", build: "tsc", dev: "vite" },
    devDependencies: { vitest: "^1.0.0" }
  }), "utf8");
  const cmds = detectProjectCommands(cwd);
  assert.equal(cmds.framework, "vitest");
  // With a real `test` script, the correct command is `npm test` (runs the script);
  // the focused command falls back to invoking vitest directly since no test:unit exists.
  assert.match(cmds.testCommand ?? "", /npm test/);
  assert.match(cmds.focusedTestCommand ?? "", /vitest/);
  assert.match(cmds.buildCommand ?? "", /build/);
  assert.match(cmds.devCommand ?? "", /dev/);
});

test("verification command detection works for Python repos", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-py-cmd-"));
  writeFileSync(join(cwd, "pyproject.toml"), [
    "[project]",
    'name = "test-py"',
    "dependencies = [\"pytest>=8\"]",
    "",
    "[tool.pytest.ini_options]",
    "testpaths = [\"tests\"]"
  ].join("\n"), "utf8");
  const cmds = detectProjectCommands(cwd);
  assert.equal(cmds.framework, "pytest");
  assert.match(cmds.testCommand ?? "", /pytest/);
});

test("loadProjectCommands discovers a bare model-written test with no manifest (test-oracle fix)", () => {
  // Spec-only task: the model writes test_thing.py in a dir with NO pyproject/pytest.ini. Manifest
  // detection finds no test command -> verification would skip every stage and 'pass' on zero checks.
  // The read-time bare-test probe must find it so pytest actually gates completion. This also proves
  // the probe works AFTER the (manifest-mtime-keyed) command cache is already populated.
  const cwd = mkdtempSync(join(tmpdir(), "cheater-bare-test-"));
  assert.equal(loadProjectCommands(cwd).testCommand, null, "empty dir: no test command, and this caches it");
  writeFileSync(join(cwd, "test_thing.py"), "def test_ok():\n    assert 1 == 1\n", "utf8");
  const cmds2 = loadProjectCommands(cwd); // manifest sig unchanged -> cache hit, but probe still runs
  assert.match(cmds2.testCommand ?? "", /pytest/, "a bare test_*.py must make pytest the test command");
  assert.match(cmds2.focusedTestCommand ?? "", /pytest/);
});

test("verification command detection works for Cargo and Go repos", () => {
  const cargoCwd = mkdtempSync(join(tmpdir(), "cheater-cargo-"));
  writeFileSync(join(cargoCwd, "Cargo.toml"), "[package]\nname = \"test\"\nversion = \"0.1.0\"\n", "utf8");
  const cargoCmds = detectProjectCommands(cargoCwd);
  assert.equal(cargoCmds.packageManager, "cargo");
  assert.match(cargoCmds.testCommand ?? "", /cargo test/);

  const goCwd = mkdtempSync(join(tmpdir(), "cheater-go-"));
  writeFileSync(join(goCwd, "go.mod"), "module test\n\ngo 1.21\n", "utf8");
  const goCmds = detectProjectCommands(goCwd);
  assert.equal(goCmds.packageManager, "go");
  assert.match(goCmds.testCommand ?? "", /go test/);
});

test("focus test command does not default to npm test for Python repos", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-focus-py-"));
  writeFileSync(join(cwd, "pyproject.toml"), "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n", "utf8");
  const cmd = focusTestCommand(cwd, "test_foo");
  assert.match(cmd, /pytest/);
  assert.doesNotMatch(cmd, /^npm test/);
});

test("webapp playbook uses owned service metadata", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-webapp-verify-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "webapp",
    scripts: { dev: "vite", test: "vitest run" },
    devDependencies: { vite: "^5.0.0", vitest: "^1.0.0" }
  }), "utf8");
  const cmds = detectProjectCommands(cwd);
  assert.ok(cmds.devCommand, "webapp must have a dev command");
  const result = await runVerification({
    cwd,
    userGoal: "webapp smoke",
    planKind: "webapp",
    projectCommands: cmds,
    hooks: {
      runCommand: (cmd) => {
        if (cmd.includes("curl")) return { returncode: 0, stdout: "200", stderr: "", timedOut: false };
        return { returncode: 0, stdout: "", stderr: "", timedOut: false };
      },
      startService: () => ({ pid: 12345 }),
      servedWorkspaceProbe: () => null
    }
  });
  const startStage = result.stages.find((s) => s.stage === "start_services");
  assert.ok(startStage, "start_services stage must exist");
  assert.equal(startStage.status, "ok");
  assert.ok(startStage.signals.port, "start_services must record a port");
  const procCount = result.registry.allProcesses().length;
  assert.ok(procCount > 0, "webapp playbook must register an owned process");
  const stopStage = result.stages.find((s) => s.stage === "stop_services");
  assert.ok(stopStage, "stop_services stage must exist");
  assert.equal(stopStage.status, "ok");
});

test("webapp verification: with a build command, the dev-server smoke is SKIPPED and the build is the gate (terminal-verified)", async () => {
  // Regression (speed6-9): a Vite dev-server smoke curl always times out (Vite ignores PORT) - it does
  // not just fail-advisory, it wastes model turns "debugging a port mismatch". With a build command the
  // whole dev-server sub-pipeline is skipped; a green build alone reaches terminal-verified.
  const cwd = mkdtempSync(join(tmpdir(), "cheater-build-gate-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "webapp",
    scripts: { dev: "vite", build: "tsc && vite build" },
    devDependencies: { vite: "^5.0.0", typescript: "^5.0.0" }
  }), "utf8");
  const cmds = detectProjectCommands(cwd);
  assert.ok(cmds.buildCommand, "webapp must have a build command");
  const result = await runVerification({
    cwd,
    userGoal: "Create a Vite React app that builds",
    planKind: "webapp",
    projectCommands: cmds,
    hooks: {
      runCommand: (cmd) => {
        if (cmd.includes("curl")) return { returncode: 28, stdout: "", stderr: "", timedOut: true }; // (never reached now)
        return { returncode: 0, stdout: "", stderr: "", timedOut: false }; // install + build ok
      },
      startService: () => ({ pid: 4242 }),
      servedWorkspaceProbe: () => null
    }
  });
  const buildStage = result.stages.find((s) => s.stage === "build");
  const startStage = result.stages.find((s) => s.stage === "start_services");
  const smokeStage = result.stages.find((s) => s.stage === "smoke");
  assert.equal(buildStage?.status, "ok", "the build stage ran and passed");
  assert.equal(startStage?.status, "skipped", "start_services is skipped because a build command is the gate");
  assert.equal(startStage?.signals?.skippedForBuild, true, "skip is recorded as build-gated");
  assert.equal(smokeStage?.status, "skipped", "smoke is skipped (no running dev server to hit)");
  assert.equal(result.passed, true, "verification PASSES on the build alone");
  assert.equal(isTerminalVerified(result.ledger.get().verification), true, "a green build with skipped dev-server IS terminal-verified");
  assert.equal(result.ledger.get().unresolvedFailures.length, 0, "no blocking unresolved failure");
});

test("webapp verification: a real build failure STILL blocks (the gate stays honest)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-build-fail-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "webapp", scripts: { dev: "vite", build: "tsc && vite build" }, devDependencies: { vite: "^5.0.0" }
  }), "utf8");
  const cmds = detectProjectCommands(cwd);
  const result = await runVerification({
    cwd, userGoal: "Create a Vite app", planKind: "webapp", projectCommands: cmds,
    hooks: {
      runCommand: (cmd) => {
        if (cmd.includes("curl")) return { returncode: 0, stdout: "200", stderr: "", timedOut: false };
        if (cmd.includes("build")) return { returncode: 2, stdout: "", stderr: "src/App.tsx: error TS2304", timedOut: false };
        return { returncode: 0, stdout: "", stderr: "", timedOut: false };
      },
      startService: () => ({ pid: 1 }),
      servedWorkspaceProbe: () => null
    }
  });
  const buildStage = result.stages.find((s) => s.stage === "build");
  assert.equal(buildStage?.status, "failed", "a broken build fails the build stage");
  assert.equal(result.passed, false, "a real build failure blocks verification (honest gate)");
  assert.ok(result.ledger.get().unresolvedFailures.length > 0, "a real build failure IS a blocking unresolved failure");
});

test("stale served workspace is detected through a mocked probe", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-stale-ws-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "stale",
    scripts: { dev: "vite" },
    devDependencies: { vite: "^5.0.0" }
  }), "utf8");
  const realSig = realpathSync(cwd) + "|n=1|";
  const staleSig = "/other/checkout|n=99|";
  const result = await runVerification({
    cwd,
    userGoal: "detect stale workspace",
    planKind: "webapp",
    hooks: {
      runCommand: () => ({ returncode: 0, stdout: "", stderr: "", timedOut: false }),
      startService: () => ({ pid: 1 }),
      servedWorkspaceProbe: () => staleSig
    }
  });
  const identityStage = result.stages.find((s) => s.stage === "workspace_identity");
  assert.ok(identityStage, "workspace_identity stage must exist");
  assert.equal(identityStage.status, "failed");
  assert.equal(identityStage.failureClass, "stale_workspace");
  assert.ok(result.mismatches.length > 0, "a mismatch must be recorded");
  assert.match(result.mismatches[0].evidence, /stale|different/);
});

test("fresh-worker handoff is explicitly marked simulated by default", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  defaultBlueprintState.clear();
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const cwd = mkdtempSync(join(tmpdir(), "cheater-fw-simulated-"));
  writeFileSync(join(cwd, "README.md"), "docs\n", "utf8");
  const result = await tools.get("cheater_reliability_start").execute(
    "start-fw",
    { userGoal: "change one typo in README" },
    undefined,
    undefined,
    ctxWithCwd(cwd)
  );
  assert.equal(result.details.freshWorkerMode, "simulated");
  assert.match(result.content[0].text, /freshWorkerMode: simulated/);
});

test("fresh-worker prompt includes simulated marker in commitlet execution prompt", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "change one typo in README" });
  const plan = createCommitletPlan({ repoRoot: process.cwd(), userGoal: "change one typo in README", autopilotDecision: decision });
  const prompt = buildCommitletExecutionPrompt(plan, plan.commitlets[0], [], "simulated");
  assert.equal(prompt.freshWorkerMode, "simulated");
  assert.match(prompt.prompt, /freshWorkerMode: simulated/);
  const realPrompt = buildCommitletExecutionPrompt(plan, plan.commitlets[0], [], "real");
  assert.equal(realPrompt.freshWorkerMode, "real");
  assert.match(realPrompt.prompt, /freshWorkerMode: real/);
});

test("completion ledger records verification stages and blocks fake completion", () => {
  const ledger = new CompletionLedger("test task");
  assert.equal(ledgerAllowsFinish(ledger).allowed, false, "empty ledger must block finish");
  ledger.recordFileChange("src/a.ts");
  ledger.recordCommand("npm test");
  assert.equal(ledgerAllowsFinish(ledger).allowed, false, "no verification must block finish");
  ledger.recordVerificationStage({
    stage: "focused_tests",
    status: "failed",
    summary: "test failed",
    failureClass: "app_bug",
    artifacts: [],
    signals: {}
  });
  assert.equal(ledgerAllowsFinish(ledger).allowed, false, "failed verification must block finish");
  assert.ok(ledger.hasUnresolvedFailures(), "failed verification must record an unresolved failure");
  ledger.recordVerificationStage({
    stage: "focused_tests",
    status: "ok",
    summary: "test passed",
    failureClass: "unknown",
    artifacts: [],
    signals: {}
  });
  ledger.recordVerificationStage({
    stage: "summarize",
    status: "ok",
    summary: "done",
    failureClass: "unknown",
    artifacts: [],
    signals: {}
  });
  ledger.recordRecovery("replan", "app_bug");
  assert.equal(ledgerAllowsFinish(ledger).allowed, true, "verified ledger with no unresolved failures must allow finish");
});

test("a project with no runnable verification command finishes honestly-unverified, not forever-blocked", () => {
  const ledger = new CompletionLedger("edit a plain script folder");
  ledger.recordFileChange("run.sh");
  // The harness determined there is no test/typecheck/build to run and recorded that fact.
  ledger.recordVerificationStage({
    stage: "smoke",
    status: "skipped",
    summary: "no runnable verification command found (no test/typecheck/build detected in this project)",
    failureClass: "unknown",
    artifacts: [],
    signals: { auto: true, noCommandAvailable: true }
  });
  const verdict = ledgerAllowsFinish(ledger);
  assert.equal(verdict.allowed, true, "impossible-to-verify must not block the finish gate forever");
  assert.match(verdict.reason, /no runnable verification command|unverified/);
});

test("a real later failure still blocks finish even after a no-command marker", () => {
  const ledger = new CompletionLedger("edit then a check fails");
  ledger.recordFileChange("app.py");
  ledger.recordVerificationStage({
    stage: "smoke", status: "skipped", summary: "no command", failureClass: "unknown", artifacts: [], signals: { noCommandAvailable: true }
  });
  // A command the model DID run later fails: the no-command escape must not mask it.
  ledger.recordVerificationStage({
    stage: "focused_tests", status: "failed", summary: "AssertionError", failureClass: "app_bug", artifacts: [], signals: {}
  });
  assert.equal(ledgerAllowsFinish(ledger).allowed, false, "a real failed stage overrides the no-command escape");
});

test("a self-corrected cd-prefixed command clears the earlier failure latch (a shell path typo does not wedge finish)", () => {
  // Regression: the model ran `cd C:\..\proj && npm install` (Windows backslashes in bash) -> the whole
  // command failed; it then ran the corrected `cd /c/../proj && npm install` which succeeded. The
  // success must clear the failure latch (same operation), not leave the finish gate blocked forever.
  const ledger = new CompletionLedger("build the app");
  ledger.recordCommandResult("cd C:\\Users\\me\\proj && npm install", false, "unknown");
  assert.ok(ledger.get().unresolvedFailures.length > 0, "the failed install latches a finish blocker");
  ledger.recordCommandResult("cd /c/Users/me/proj && npm install", true, "unknown");
  assert.equal(ledger.get().unresolvedFailures.length, 0, "the corrected-path success clears the latch (same operation)");
});

test("commandFingerprint strips a leading cd/pushd wrapper so it fingerprints the operation, not the path", () => {
  assert.equal(commandFingerprint("cd C:\\a\\b && npm install"), commandFingerprint("npm install"));
  assert.equal(commandFingerprint("cd /c/a/b && npm install"), commandFingerprint("cd C:\\a\\b && npm install"));
  assert.notEqual(commandFingerprint("cd x && npm install"), commandFingerprint("cd x && npm run build"), "different operations still differ");
});

test("a failed exploratory shell command (ls/Move-Item) does NOT latch a finish-blocker, but a real check failure does", () => {
  // Regression: the model fumbled `ls C:\..` (backslashes stripped) and `Move-Item ..` (PowerShell in
  // bash); both failed but are self-corrected fumbles, not project failures. They must not block finish.
  const ledger = new CompletionLedger("build the app");
  ledger.recordCommandResult("ls C:UsersLENOVODesktopproj", false, "unknown");
  ledger.recordCommandResult("Move-Item public/index.html index.html", false, "unknown");
  assert.equal(ledger.get().unresolvedFailures.length, 0, "exploratory shell fumbles never latch a finish blocker");
  ledger.recordCommandResult("npm run build", false, "app_bug");
  assert.ok(ledger.get().unresolvedFailures.length > 0, "a genuine build/check failure still blocks");
});

test("a passing BUILD verification stage clears a stray manual-command failure (fixed tsc, re-verified via npm run build)", () => {
  // Regression (speed8): the model ran `npx tsc --noEmit` -> a real syntax error it then FIXED, but it
  // re-verified with `npm run build` (a different command fingerprint), so the tsc failure stayed
  // latched and blocked finish. A green build compiles the whole app, so it must clear that stray.
  const ledger = new CompletionLedger("build the app");
  ledger.recordCommandResult("npx tsc --noEmit", false, "app_bug");
  assert.ok(ledger.get().unresolvedFailures.length > 0, "the tsc failure latches");
  ledger.recordVerificationStage({ stage: "build", status: "ok", summary: "build ok", failureClass: "unknown", artifacts: [], signals: {} });
  assert.equal(ledger.get().unresolvedFailures.length, 0, "a green build clears the stray already-fixed tsc failure");
});

test("isExploratoryCommand flags navigation/file commands but not build/test runners", () => {
  assert.equal(isExploratoryCommand("ls -la /c/x"), true);
  assert.equal(isExploratoryCommand("cd /c/x && mv a b"), true);
  assert.equal(isExploratoryCommand("Move-Item a b"), true);
  assert.equal(isExploratoryCommand("Get-ChildItem"), true);
  assert.equal(isExploratoryCommand("npm run build"), false);
  assert.equal(isExploratoryCommand("cd /c/x && npm run build"), false);
  assert.equal(isExploratoryCommand("tsc --noEmit"), false);
});

test("non-progress detector fires after stall window and produces a recovery capsule", () => {
  const detector = new NonProgressDetector(3, 5);
  const event0 = detector.observe({ action: "read", argsSig: "src/a.ts", filesRead: ["src/a.ts"], filesChanged: [] });
  assert.equal(event0, undefined, "first read of a new file is progress");
  for (let i = 0; i < 2; i++) {
    const event = detector.observe({ action: "read", argsSig: "src/a.ts", filesRead: [], filesChanged: [] });
    assert.equal(event, undefined, "should not fire before stall window");
  }
  const event = detector.observe({ action: "read", argsSig: "src/a.ts", filesRead: [], filesChanged: [] });
  assert.ok(event, "should fire at stall window");
  assert.match(event.reason, /no progress/);
  assert.ok(event.recovery, "recovery capsule must exist");
  detector.observe({ action: "read", argsSig: "src/a.ts", filesRead: [], filesChanged: [] });
  detector.observe({ action: "read", argsSig: "src/a.ts", filesRead: [], filesChanged: [] });
  assert.ok(event);
});

test("command classifier detects test, dev_server, verify, and scoring commands", () => {
  assert.equal(classifyCommand("pytest -q"), "test");
  assert.equal(classifyCommand("npm test"), "test");
  assert.equal(classifyCommand("npm run dev"), "dev_server");
  assert.equal(classifyCommand("vite"), "dev_server");
  assert.equal(classifyCommand("curl http://localhost:3000"), "verify");
  assert.equal(classifyCommand("npm run score"), "scoring");
  assert.equal(classifyCommand("ls -la"), "one_shot");
  assert.equal(classifyCommand("echo hello"), "one_shot");
  assert.equal(classifyCommand("python weird_thing.py"), "shell");
});

test("failure classifier maps common error patterns", () => {
  assert.equal(classifyFailure({ exitCode: 1, stdout: "", stderr: "EADDRINUSE port 3000 in use" }), "server_runtime");
  assert.equal(classifyFailure({ exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named foo" }), "dependency");
  assert.equal(classifyFailure({ exitCode: 1, stdout: "", stderr: "AssertionError: expected 5 got 3" }), "app_bug");
  assert.equal(classifyFailure({ exitCode: 1, stdout: "", stderr: "stale workspace mismatch" }), "stale_workspace");
  assert.equal(classifyFailure({ exitCode: 0, stdout: "", stderr: "" }), "unknown");
  assert.equal(classifyFailure({ exitCode: null, stdout: "", stderr: "", timedOut: true }), "server_runtime");
});

test("workspace identity check detects mismatch", () => {
  const sig = "/repo|n=10|mtime=100|size=5000";
  assert.equal(workspaceIdentityCheck(null, sig).ok, true);
  assert.equal(workspaceIdentityCheck(sig, sig).ok, true);
  const mismatch = workspaceIdentityCheck("/other|n=5", sig);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.mismatch);
  assert.match(mismatch.mismatch.evidence, /stale|different/);
});

test("process registry tracks owned processes and stops them", () => {
  const registry = new ProcessRegistry();
  registry.registerProcess({
    processId: "p1",
    label: "dev server",
    cmd: "npm run dev",
    kind: "dev_server",
    startedAt: Date.now(),
    pid: 123,
    status: "running",
    workspaceSig: "sig",
    healthEndpoint: "http://127.0.0.1:3000",
    port: 3000
  });
  assert.equal(registry.runningProcesses().length, 1);
  assert.equal(registry.isOwnedProcess("p1"), true);
  const stopped = registry.stopAllRunning();
  assert.equal(stopped.length, 1);
  assert.equal(registry.runningProcesses().length, 0);
});

test("isTerminalVerified requires at least one ok stage", () => {
  assert.equal(isTerminalVerified([]), false);
  assert.equal(isTerminalVerified([{ stage: "smoke", status: "skipped", summary: "", failureClass: "unknown", artifacts: [], signals: {} }]), false);
  assert.equal(isTerminalVerified([{ stage: "smoke", status: "ok", summary: "", failureClass: "unknown", artifacts: [], signals: {} }]), true);
  assert.equal(isTerminalVerified([{ stage: "smoke", status: "ok", summary: "", failureClass: "unknown", artifacts: [], signals: {} }, { stage: "focused_tests", status: "failed", summary: "", failureClass: "unknown", artifacts: [], signals: {} }]), false);
});

test("isTerminalVerified: a green build with an ADVISORY smoke timeout IS terminal-verified (the flaky dev-server never blocks finish)", () => {
  // Regression (speed9): build ok + advisory smoke timed_out -> the finish gate must reach terminal-
  // verified. An advisory failure must be ignored; a NON-advisory failed stage still blocks.
  const stages = [
    { stage: "build" as const, status: "ok" as const, summary: "build ok", failureClass: "unknown" as const, artifacts: [], signals: {} },
    { stage: "smoke" as const, status: "timed_out" as const, summary: "smoke failed", failureClass: "unknown" as const, artifacts: [], signals: {}, advisory: true }
  ];
  assert.equal(isTerminalVerified(stages), true, "advisory smoke timeout does not block terminal-verified");
  // But a NON-advisory failed stage still blocks (no silent masking of a real failure).
  const withRealFail = [...stages, { stage: "full_tests" as const, status: "failed" as const, summary: "tests failed", failureClass: "app_bug" as const, artifacts: [], signals: {} }];
  assert.equal(isTerminalVerified(withRealFail), false, "a real (non-advisory) stage failure still blocks");
});

test("verification run tool feeds the completion ledger", async () => {
  const { pi, tools } = makePi();
  defaultCommitletState.clear();
  liveSessionState.reset("verify-run test");
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  const cwd = mkdtempSync(join(tmpdir(), "cheater-verify-run-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "verify-run",
    scripts: { test: "node -e \"process.exit(0)\"" },
    devDependencies: {}
  }), "utf8");
  liveSessionState.ensure(DEFAULT_CONFIG, "verify-run test");
  const result = await tools.get("cheater_verification_run").execute(
    "vrun",
    { planKind: "cli" },
    undefined,
    undefined,
    ctxWithCwd(cwd)
  );
  assert.match(result.content[0].text, /Verification Run/);
  assert.ok(result.details.passed !== undefined);
  const ledger = liveSessionState.getLedger();
  assert.ok(ledger, "ledger must be active after verification run");
  assert.ok(ledger.get().verification.length > 0, "ledger must have verification stages");
});

test("ledger status tool shows the live ledger", async () => {
  const { pi, tools } = makePi();
  liveSessionState.reset("ledger-status test");
  registerCommitletTools(pi, { config: DEFAULT_CONFIG });
  liveSessionState.ensure(DEFAULT_CONFIG, "ledger-status test");
  liveSessionState.getLedger()?.recordFileChange("src/a.ts");
  const result = await tools.get("cheater_ledger_status").execute("ls", {}, undefined, undefined, ctxWithCwd(process.cwd()));
  assert.match(result.content[0].text, /GOAL: ledger-status test/);
  assert.match(result.content[0].text, /src\/a\.ts/);
});
