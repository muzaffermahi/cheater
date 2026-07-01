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

  const passed = stages.every((stage) => stage.status === "ok" || stage.status === "skipped");
  const okCount = stages.filter((stage) => stage.status === "ok").length;
  const failCount = stages.filter((stage) => stage.status === "failed" || stage.status === "timed_out").length;
  stopAllOwnedProcesses(ctx);
  ledger.finalize(passed, passed ? `verification passed: ${okCount} ok` : `verification failed: ${failCount} failed`, passed ? "high" : "low");
  return {
    stages,
    ledger,
    registry,
    passed,
    summary: `verification ${passed ? "passed" : "failed"}: ${okCount} ok, ${failCount} fail`,
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
  try {
    switch (spec.stage) {
      case "prepare_env":
        return runPrepareEnv(spec, ctx);
      case "start_services":
        return runStartServices(spec, ctx);
      case "workspace_identity":
        return runWorkspaceIdentity(spec, ctx);
      case "smoke":
        return runSmoke(spec, ctx);
      case "focused_tests":
        return runTestStage(spec, ctx, ctx.cmds.focusedTestCommand ?? ctx.cmds.testCommand, "focused tests");
      case "full_tests":
        return runTestStage(spec, ctx, ctx.cmds.testCommand, "full tests");
      case "scoring":
        return runTestStage(spec, ctx, ctx.cmds.scoreCommand, "scoring");
      case "collect_artifacts":
        return runCollectArtifacts(spec, ctx);
      case "stop_services":
        return runStopServices(spec, ctx);
      case "summarize":
        return runSummarize(spec, ctx);
      default:
        return { ...base, status: "skipped", summary: `unknown stage ${spec.stage}` };
    }
  } catch (err) {
    return { ...base, status: "failed", summary: `handler crashed: ${(err as Error).message}`, failureClass: "unknown" };
  }
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
  recordOwnedCommand(ctx, cmd, "verify", outcome);
  ctx.ledger.recordCommand(cmd);
  return { stage: spec.stage, status, summary: status === "ok" ? `smoke ok: ${healthUrl} -> ${httpCode}` : `smoke failed: ${healthUrl}`, failureClass, artifacts: [], signals: { httpCode, url: healthUrl } };
}

function runTestStage(spec: WebappVerificationStageSpec, ctx: StageRunContext, cmd: string | null, label: string): VerificationStageResult {
  if (!cmd) {
    return { stage: spec.stage, status: "skipped", summary: `no ${label} command detected`, failureClass: "unknown", artifacts: [], signals: {} };
  }
  const outcome = ctx.runCommand(cmd, { cwd: ctx.cwd, timeoutSeconds: spec.timeoutSeconds });
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

function recordOwnedCommand(ctx: StageRunContext, cmd: string, kind: CommandKind, outcome: { returncode: number; stdout: string; stderr: string; timedOut: boolean }): void {
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
  if (status === "failed" || status === "timed_out") {
    ctx.ledger.recordFailure(`${cmd} -> ${status}`, classifyFailure({ exitCode: outcome.returncode, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: outcome.timedOut }));
  }
}
