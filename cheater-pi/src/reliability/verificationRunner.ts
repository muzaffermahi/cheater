import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  classifyCommand,
  classifyFailure,
  CompletionLedger,
  defaultCliPlan,
  defaultWebappPlan,
  isLongRunning,
  newId,
  ProcessRegistry,
  workspaceIdentityCheck,
  workspaceSignature,
  type CommandKind,
  type FailureClass,
  type OwnedCommand,
  type OwnedProcess,
  type ProcessStatus,
  type VerificationStageName,
  type VerificationStageResult,
  type VerificationStatus,
  type WebappVerificationStageSpec
} from "./lifecycle.js";
import { detectProjectCommands, type ProjectCommands } from "./projectCommands.js";
import { compressFailureOutput } from "./failureCompressor.js";

export interface VerificationRunnerHooks {
  runCommand?: (cmd: string, opts: { cwd: string; timeoutSeconds: number }) => { returncode: number; stdout: string; stderr: string; timedOut: boolean };
  startService?: (cmd: string, opts: { cwd: string; port: number; env?: Record<string, string> }) => { pid: number | null; onStop?: () => void };
  servedWorkspaceProbe?: () => string | null;
}

export interface VerificationRunResult {
  stages: VerificationStageResult[];
  ledger: CompletionLedger;
  registry: ProcessRegistry;
  passed: boolean;
  summary: string;
  artifacts: string[];
  mismatches: Array<{ observed: string; expected: string; evidence: string }>;
}

export interface VerificationRunInput {
  cwd: string;
  userGoal: string;
  planKind: "webapp" | "cli";
  projectCommands?: ProjectCommands;
  hooks?: VerificationRunnerHooks;
  port?: number;
  artifactsDir?: string;
}

const FREE_PORT_MIN = 4321;
const FREE_PORT_MAX = 9100;

export async function findFreePort(start = FREE_PORT_MIN): Promise<number> {
  for (let port = start; port <= FREE_PORT_MAX; port++) {
    if (await portInUse(port)) continue;
    return port;
  }
  return start;
}

// net.Server.listen() reports "port in use" asynchronously via the "error" event, so a
// synchronous try/catch around it never observes the failure and always reports free.
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

function killOwnedProcess(pid: number | null, child?: ChildProcess): void {
  if (pid) {
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } catch {
        // best effort
      }
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // best effort
        }
      }
    }
  }
  try {
    child?.kill();
  } catch {
    // best effort
  }
}

function stopAllOwnedProcesses(ctx: StageRunContext): string[] {
  for (const proc of ctx.registry.runningProcesses()) {
    const stopCallback = ctx.stopCallbacks.get(proc.processId);
    if (stopCallback) {
      try {
        stopCallback();
      } catch {
        // best effort
      }
    } else {
      killOwnedProcess(proc.pid, ctx.childProcesses.get(proc.processId));
    }
  }
  return ctx.registry.stopAllRunning();
}

function defaultRunCommand(cmd: string, opts: { cwd: string; timeoutSeconds: number }): { returncode: number; stdout: string; stderr: string; timedOut: boolean } {
  const result = spawnSync(cmd, {
    cwd: opts.cwd,
    shell: true,
    encoding: "utf8",
    timeout: opts.timeoutSeconds * 1000,
    windowsHide: true
  });
  return {
    returncode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.signal === "SIGTERM" || result.signal === "SIGKILL"
  };
}

export async function runVerification(input: VerificationRunInput): Promise<VerificationRunResult> {
  const cwd = resolve(input.cwd);
  const cmds = input.projectCommands ?? detectProjectCommands(cwd);
  const plan = input.planKind === "webapp" ? defaultWebappPlan() : defaultCliPlan();
  const registry = new ProcessRegistry();
  const ledger = new CompletionLedger(input.userGoal);
  const hooks = input.hooks ?? {};
  const runCommand = hooks.runCommand ?? defaultRunCommand;
  const sig = workspaceSignature(cwd);
  const artifacts: string[] = [];
  const mismatches: Array<{ observed: string; expected: string; evidence: string }> = [];
  const port = input.port ?? (input.planKind === "webapp" ? await findFreePort() : 0);
  const artifactsDir = input.artifactsDir ?? join(cwd, ".cheater", "artifacts");
  const stageOutputs = new Map<VerificationStageName, VerificationStageResult>();
  const ctx: StageRunContext = {
    cwd,
    userGoal: input.userGoal,
    cmds,
    hooks,
    runCommand,
    registry,
    ledger,
    sig,
    port,
    artifactsDir,
    artifacts,
    stageOutputs,
    mismatches,
    childProcesses: new Map(),
    stopCallbacks: new Map()
  };

  const stages: VerificationStageResult[] = [];

  for (const spec of plan) {
    const result = runStage(spec, ctx);
    stages.push(result);
    stageOutputs.set(spec.stage, result);
    ledger.recordVerificationStage(result);
    if ((result.status === "failed" || result.status === "timed_out") && spec.required) {
      for (const follow of plan.slice(plan.indexOf(spec) + 1)) {
        const skip: VerificationStageResult = {
          stage: follow.stage,
          status: "skipped",
          summary: `skipped because required stage ${spec.stage} ${result.status}`,
          failureClass: "unknown",
          artifacts: [],
          signals: {}
        };
        stages.push(skip);
        stageOutputs.set(follow.stage, skip);
        ledger.recordVerificationStage(skip);
      }
      break;
    }
  }

  // Verification passes when no BLOCKING stage failed. An advisory stage (a non-required dev-server
  // smoke/identity check) that fails is reported but never fails the run - a clean build is the gate.
  const passed = stages.every((stage) => stage.status === "ok" || stage.status === "skipped" || stage.advisory === true);
  const okCount = stages.filter((stage) => stage.status === "ok").length;
  const blockingFailCount = stages.filter((stage) => (stage.status === "failed" || stage.status === "timed_out") && !stage.advisory).length;
  const advisoryFailCount = stages.filter((stage) => (stage.status === "failed" || stage.status === "timed_out") && stage.advisory).length;
  const advisoryNote = advisoryFailCount ? `, ${advisoryFailCount} advisory (non-blocking)` : "";
  stopAllOwnedProcesses(ctx);
  ledger.finalize(passed, passed ? `verification passed: ${okCount} ok${advisoryNote}` : `verification failed: ${blockingFailCount} blocking failure(s)`, passed ? "high" : "low");
  return {
    stages,
    ledger,
    registry,
    passed,
    summary: `verification ${passed ? "passed" : "failed"}: ${okCount} ok, ${blockingFailCount} fail${advisoryNote}`,
    artifacts,
    mismatches
  };
}

interface StageRunContext {
  cwd: string;
  userGoal: string;
  cmds: ProjectCommands;
  hooks: VerificationRunnerHooks;
  runCommand: NonNullable<VerificationRunnerHooks["runCommand"]>;
  registry: ProcessRegistry;
  ledger: CompletionLedger;
  sig: string;
  port: number;
  artifactsDir: string;
  artifacts: string[];
  stageOutputs: Map<VerificationStageName, VerificationStageResult>;
  mismatches: Array<{ observed: string; expected: string; evidence: string }>;
  childProcesses: Map<string, ChildProcess>;
  stopCallbacks: Map<string, () => void>;
}

function runStage(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  const base: VerificationStageResult = { stage: spec.stage, status: "running", summary: "", failureClass: "unknown", artifacts: [], signals: {} };
  let result: VerificationStageResult;
  try {
    switch (spec.stage) {
      case "prepare_env":
        result = runPrepareEnv(spec, ctx); break;
      case "build":
        result = runBuildStage(spec, ctx); break;
      case "start_services":
        result = runStartServices(spec, ctx); break;
      case "workspace_identity":
        result = runWorkspaceIdentity(spec, ctx); break;
      case "smoke":
        result = runSmoke(spec, ctx); break;
      case "focused_tests":
        result = runTestStage(spec, ctx, ctx.cmds.focusedTestCommand ?? ctx.cmds.testCommand, "focused tests"); break;
      case "full_tests":
        result = runTestStage(spec, ctx, ctx.cmds.testCommand, "full tests"); break;
      case "scoring":
        result = runTestStage(spec, ctx, ctx.cmds.scoreCommand, "scoring"); break;
      case "collect_artifacts":
        result = runCollectArtifacts(spec, ctx); break;
      case "stop_services":
        result = runStopServices(spec, ctx); break;
      case "summarize":
        result = runSummarize(spec, ctx); break;
      default:
        result = { ...base, status: "skipped", summary: `unknown stage ${spec.stage}` };
    }
  } catch (err) {
    result = { ...base, status: "failed", summary: `handler crashed: ${(err as Error).message}`, failureClass: "unknown" };
  }
  // A non-required (advisory) stage that fails is reported for visibility but is NOT a blocking
  // failure: it never fails the overall verification or records an unresolved failure in the ledger.
  if (!spec.required && (result.status === "failed" || result.status === "timed_out")) {
    result.advisory = true;
  }
  return result;
}

function runBuildStage(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  const cmd = ctx.cmds.buildCommand;
  if (!cmd) {
    return { stage: spec.stage, status: "skipped", summary: "no build command detected", failureClass: "unknown", artifacts: [], signals: { noCommandAvailable: true } };
  }
  const outcome = ctx.runCommand(cmd, { cwd: ctx.cwd, timeoutSeconds: spec.timeoutSeconds });
  const status: VerificationStatus = outcome.timedOut ? "timed_out" : outcome.returncode === 0 ? "ok" : "failed";
  const failureClass = outcome.returncode === 0 ? "unknown" : classifyFailure({ exitCode: outcome.returncode, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: outcome.timedOut });
  recordOwnedCommand(ctx, cmd, "verify", outcome);
  ctx.ledger.recordCommand(cmd);
  const failCard = status === "ok" ? "" : compressFailureOutput(cmd, outcome.stdout, outcome.stderr, outcome.returncode || 1);
  return { stage: spec.stage, status, summary: status === "ok" ? `build ok (${cmd})` : `build failed exit=${outcome.returncode}; ${failureClass}\n${failCard}`, failureClass, artifacts: [], signals: { exitCode: outcome.returncode } };
}

function runPrepareEnv(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  const pm = ctx.cmds.packageManager;
  let installCmd: string | null = null;
  if (pm === "npm" && existsSync(join(ctx.cwd, "package-lock.json"))) installCmd = "npm ci";
  else if (pm === "pnpm") installCmd = "pnpm install --frozen-lockfile";
  else if (pm === "yarn") installCmd = "yarn install --frozen-lockfile";
  else if (pm === "bun") installCmd = "bun install --frozen-lockfile";
  else if (pm === "uv") installCmd = "uv sync";
  else if (pm === "pip" && existsSync(join(ctx.cwd, "requirements.txt"))) installCmd = "pip install -r requirements.txt";
  else if (pm === "cargo") installCmd = null;
  else if (pm === "go") installCmd = null;

  if (!installCmd) {
    return { stage: spec.stage, status: "ok", summary: "no install step needed", failureClass: "unknown", artifacts: [], signals: { pm } };
  }
  const outcome = ctx.runCommand(installCmd, { cwd: ctx.cwd, timeoutSeconds: spec.timeoutSeconds });
  const status: VerificationStatus = outcome.timedOut ? "timed_out" : outcome.returncode === 0 ? "ok" : "failed";
  const failureClass = outcome.returncode === 0 ? "unknown" : classifyFailure({ exitCode: outcome.returncode, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: outcome.timedOut });
  recordOwnedCommand(ctx, installCmd, "one_shot", outcome);
  ctx.ledger.recordCommand(installCmd);
  return { stage: spec.stage, status, summary: status === "ok" ? `install ok (${pm})` : `install failed exit=${outcome.returncode}`, failureClass, artifacts: [], signals: { exitCode: outcome.returncode, pm } };
}

function runStartServices(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  // A green build is the authoritative gate for a buildable webapp, and a headless dev-server smoke is
  // environment-flaky (Vite ignores PORT so the curl to 127.0.0.1:PORT always times out) AND actively
  // wastes model turns as it "debugs" a port mismatch it cannot fix. So skip the whole dev-server
  // sub-pipeline (start_services -> smoke naturally skips with no running process) when a build command
  // exists; run it only as a fallback signal when there is nothing to build.
  if (ctx.cmds.buildCommand) {
    return { stage: spec.stage, status: "skipped", summary: "skipped: a green build is the gate for this webapp; dev-server smoke not needed", failureClass: "unknown", artifacts: [], signals: { skippedForBuild: true } };
  }
  const devCmd = ctx.cmds.devCommand;
  if (!devCmd) {
    return { stage: spec.stage, status: "ok", summary: "no dev server command; nothing to start", failureClass: "unknown", artifacts: [], signals: { port: ctx.port } };
  }
  const kind = classifyCommand(devCmd);
  if (!isLongRunning(kind)) {
    return { stage: spec.stage, status: "ok", summary: `dev command is not long-running (${kind}); skipping service start`, failureClass: "unknown", artifacts: [], signals: { devCmd, kind } };
  }
  const env: Record<string, string> = { ...process.env, PORT: String(ctx.port), CI: "1" };
  if (ctx.hooks.startService) {
    const started = ctx.hooks.startService(devCmd, { cwd: ctx.cwd, port: ctx.port, env });
    const proc: OwnedProcess = {
      processId: newId("proc"),
      label: devCmd,
      cmd: devCmd,
      kind: "dev_server",
      startedAt: Date.now(),
      pid: started.pid,
      status: "running",
      workspaceSig: ctx.sig,
      healthEndpoint: `http://127.0.0.1:${ctx.port}`,
      port: ctx.port
    };
    ctx.registry.registerProcess(proc);
    if (started.onStop) ctx.stopCallbacks.set(proc.processId, started.onStop);
    return { stage: spec.stage, status: "ok", summary: `started dev server on port ${ctx.port} (pid ${started.pid ?? "n/a"})`, failureClass: "unknown", artifacts: [], signals: { port: ctx.port, processId: proc.processId } };
  }
  const child = spawn(devCmd, { cwd: ctx.cwd, shell: true, env, detached: false, windowsHide: true, stdio: "pipe" });
  const proc: OwnedProcess = {
    processId: newId("proc"),
    label: devCmd,
    cmd: devCmd,
    kind: "dev_server",
    startedAt: Date.now(),
    pid: child.pid ?? null,
    status: "running",
    workspaceSig: ctx.sig,
    healthEndpoint: `http://127.0.0.1:${ctx.port}`,
    port: ctx.port
  };
  ctx.registry.registerProcess(proc);
  ctx.childProcesses.set(proc.processId, child);
  return { stage: spec.stage, status: "ok", summary: `started dev server on port ${ctx.port} (pid ${child.pid ?? "n/a"})`, failureClass: "unknown", artifacts: [], signals: { port: ctx.port, processId: proc.processId } };
}

function runWorkspaceIdentity(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  const probe = ctx.hooks.servedWorkspaceProbe;
  if (!probe) {
    return { stage: spec.stage, status: "skipped", summary: "no served-workspace probe was available", failureClass: "unknown", artifacts: [], signals: { expected: ctx.sig } };
  }
  const served = probe();
  const check = workspaceIdentityCheck(served, ctx.sig);
  if (check.mismatch) {
    ctx.mismatches.push(check.mismatch);
    return { stage: spec.stage, status: "failed", summary: check.mismatch.evidence, failureClass: "stale_workspace", artifacts: [], signals: { observed: check.mismatch.observed, expected: check.mismatch.expected } };
  }
  return { stage: spec.stage, status: "ok", summary: "served workspace matches current workspace", failureClass: "unknown", artifacts: [], signals: { served, expected: ctx.sig } };
}

function runSmoke(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  const running = ctx.registry.runningProcesses();
  if (!running.length) {
    return { stage: spec.stage, status: "skipped", summary: "no running service to smoke-check", failureClass: "unknown", artifacts: [], signals: {} };
  }
  const proc = running[0];
  const healthUrl = proc.healthEndpoint ?? `http://127.0.0.1:${proc.port ?? 0}`;
  // Poll for readiness instead of curling once the instant after spawn: --retry-connrefused
  // waits out server startup so a slow-booting dev server is not a spurious "smoke failed"
  // the model cannot fix. Bounded by --max-time to the stage timeout.
  const cmd = `curl -sS --retry 15 --retry-connrefused --retry-delay 1 --max-time ${spec.timeoutSeconds} -o /dev/null -w "%{http_code}" ${healthUrl}`;
  const outcome = ctx.runCommand(cmd, { cwd: ctx.cwd, timeoutSeconds: spec.timeoutSeconds + 2 });
  const status: VerificationStatus = outcome.timedOut ? "timed_out" : outcome.returncode === 0 ? "ok" : "failed";
  const failureClass = outcome.returncode === 0 ? "unknown" : classifyFailure({ exitCode: outcome.returncode, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: outcome.timedOut });
  const httpCode = (outcome.stdout ?? "").trim();
  recordOwnedCommand(ctx, cmd, "verify", outcome, spec.required);
  ctx.ledger.recordCommand(cmd);
  return { stage: spec.stage, status, summary: status === "ok" ? `smoke ok: ${healthUrl} -> ${httpCode}` : `smoke failed: ${healthUrl}`, failureClass, artifacts: [], signals: { httpCode, url: healthUrl } };
}

// A test command that RAN but found no tests to execute is "nothing to gate on", NOT a failure.
// pytest exits 5 with "no tests ran"; a stub `npm test` is the classic "no test specified" / a
// missing "test" script. Treating these as a hard failure on a REQUIRED stage blocks the finish gate
// forever on a from-scratch CLI/library with no suite yet - the CLI twin of the fixed Vite-smoke
// webapp dead-end. Real test FAILURES (exit 1 with assertion output) are unaffected.
function ranButFoundNoTests(outcome: { returncode: number; stdout: string; stderr: string }): boolean {
  if (outcome.returncode === 0) return false;
  if (outcome.returncode === 5) return true; // pytest: no tests collected
  const text = `${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`.toLowerCase();
  return /no tests ran|collected 0 items|no tests? (were )?(found|collected|ran)|no test specified|missing script: "?test"?/.test(text);
}

function runTestStage(spec: WebappVerificationStageSpec, ctx: StageRunContext, cmd: string | null, label: string): VerificationStageResult {
  if (!cmd) {
    // No command exists for this check — mark it so the finish gate's noRunnableCheck path can allow an
    // honest UNVERIFIED finish (not block forever), rather than a bookkeeping stage faking a green.
    return { stage: spec.stage, status: "skipped", summary: `no ${label} command detected`, failureClass: "unknown", artifacts: [], signals: { noCommandAvailable: true } };
  }
  const outcome = ctx.runCommand(cmd, { cwd: ctx.cwd, timeoutSeconds: spec.timeoutSeconds });
  if (!outcome.timedOut && ranButFoundNoTests(outcome)) {
    // Record the command (honest receipt) but do NOT count "no tests to run" as a blocking failure.
    recordOwnedCommand(ctx, cmd, "test", { ...outcome, returncode: 0 });
    ctx.ledger.recordCommand(cmd);
    return { stage: spec.stage, status: "skipped", summary: `${label} skipped: the command ran but found no tests to execute (nothing to gate on)`, failureClass: "unknown", artifacts: [], signals: { exitCode: outcome.returncode, noTests: true } };
  }
  const status: VerificationStatus = outcome.timedOut ? "timed_out" : outcome.returncode === 0 ? "ok" : "failed";
  const failureClass = outcome.returncode === 0 ? "unknown" : classifyFailure({ exitCode: outcome.returncode, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: outcome.timedOut });
  recordOwnedCommand(ctx, cmd, "test", outcome);
  ctx.ledger.recordCommand(cmd);
  const failCard = status === "ok" ? "" : compressFailureOutput(cmd, outcome.stdout, outcome.stderr, outcome.returncode || 1);
  return { stage: spec.stage, status, summary: status === "ok" ? `${label} ok` : `${label} failed exit=${outcome.returncode}; ${failureClass}\n${failCard}`, failureClass, artifacts: [], signals: { exitCode: outcome.returncode } };
}

function runCollectArtifacts(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  mkdirSync(ctx.artifactsDir, { recursive: true });
  const manifestPath = join(ctx.artifactsDir, "verification-manifest.json");
  const manifest = {
    userGoal: ctx.userGoal,
    workspaceSig: ctx.sig,
    stages: [...ctx.stageOutputs.values()].map((stage) => ({ stage: stage.stage, status: stage.status, summary: stage.summary })),
    port: ctx.port,
    collectedAt: new Date().toISOString()
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  ctx.artifacts.push(manifestPath);
  ctx.ledger.recordArtifact(manifestPath);
  return { stage: spec.stage, status: "ok", summary: `collected ${ctx.artifacts.length} artifact(s)`, failureClass: "unknown", artifacts: [manifestPath], signals: { artifactsDir: ctx.artifactsDir } };
}

function runStopServices(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  const stopped = stopAllOwnedProcesses(ctx);
  return { stage: spec.stage, status: "ok", summary: stopped.length ? `stopped ${stopped.length} owned service(s): ${stopped.join(", ")}` : "no owned services to stop", failureClass: "unknown", artifacts: [], signals: { stopped } };
}

function runSummarize(spec: WebappVerificationStageSpec, ctx: StageRunContext): VerificationStageResult {
  const okCount = [...ctx.stageOutputs.values()].filter((stage) => stage.status === "ok").length;
  const failCount = [...ctx.stageOutputs.values()].filter((stage) => stage.status === "failed" || stage.status === "timed_out").length;
  return { stage: spec.stage, status: "ok", summary: `verification summary: ${okCount} ok, ${failCount} fail`, failureClass: "unknown", artifacts: [], signals: { ok: okCount, fail: failCount } };
}

function recordOwnedCommand(ctx: StageRunContext, cmd: string, kind: CommandKind, outcome: { returncode: number; stdout: string; stderr: string; timedOut: boolean }, blocking = true): void {
  const status: ProcessStatus = outcome.timedOut ? "timed_out" : outcome.returncode === 0 ? "succeeded" : "failed";
  const owned: OwnedCommand = {
    cmdId: newId("cmd"),
    cmd,
    kind,
    cwd: ctx.cwd,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    exitCode: outcome.returncode,
    status,
    stdout: (outcome.stdout ?? "").slice(-400),
    stderr: (outcome.stderr ?? "").slice(-400),
    timedOut: outcome.timedOut,
    workspaceSig: ctx.sig,
    parentProcessId: null
  };
  ctx.registry.recordCommand(owned);
  // Advisory (non-blocking) stage commands are kept in history but never latch an unresolved failure
  // in the completion ledger - a flaky dev-server smoke curl must not block the finish gate.
  if (blocking && (status === "failed" || status === "timed_out")) {
    ctx.ledger.recordFailure(`${cmd} -> ${status}`, classifyFailure({ exitCode: outcome.returncode, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: outcome.timedOut }));
  }
}
