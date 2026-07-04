import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type CommandKind =
  | "one_shot"
  | "dev_server"
  | "test"
  | "verify"
  | "scoring"
  | "shell";

export type ProcessStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stopped"
  | "unknown";

export type VerificationStatus =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "skipped"
  | "timed_out";

export type VerificationStageName =
  | "prepare_env"
  | "build"
  | "start_services"
  | "workspace_identity"
  | "smoke"
  | "typecheck"
  | "focused_tests"
  | "full_tests"
  | "scoring"
  | "collect_artifacts"
  | "stop_services"
  | "summarize";

export type FailureClass =
  | "app_bug"
  | "test_bug"
  | "server_runtime"
  | "dependency"
  | "snapshot_baseline"
  | "stale_workspace"
  | "command_invocation"
  | "unknown";

export interface OwnedCommand {
  cmdId: string;
  cmd: string;
  kind: CommandKind;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  status: ProcessStatus;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  workspaceSig: string;
  parentProcessId: string | null;
}

export interface OwnedProcess {
  processId: string;
  label: string;
  cmd: string;
  kind: CommandKind;
  startedAt: number;
  pid: number | null;
  status: ProcessStatus;
  workspaceSig: string;
  healthEndpoint: string | null;
  port: number | null;
}

export interface LedgerEntry {
  kind: string;
  at: number;
  summary: string;
  extra: Record<string, unknown>;
}

export interface VerificationStageResult {
  stage: VerificationStageName;
  status: VerificationStatus;
  summary: string;
  failureClass: FailureClass;
  artifacts: string[];
  signals: Record<string, unknown>;
  // Advisory stages (a non-required stage that failed, e.g. a flaky dev-server smoke check) are
  // reported for visibility but MUST NOT record a blocking unresolved failure - otherwise a clean
  // build is blocked forever by an environment-flaky probe the model cannot fix.
  advisory?: boolean;
}

export interface RecoveryCapsule {
  id: string;
  failureClass: FailureClass;
  action: string;
  description: string;
  reason: string;
  terminal: boolean;
}

export interface CompletionLedgerState {
  userGoal: string;
  startedAt: number;
  finishedAt: number;
  changedFiles: string[];
  commandsRun: string[];
  verification: VerificationStageResult[];
  artifacts: string[];
  unresolvedFailures: Array<{ summary: string; failureClass: FailureClass; stage?: VerificationStageName; commandSig?: string }>;
  entries: LedgerEntry[];
  confidence: "low" | "medium" | "high";
  done: boolean;
  doneReason: string;
}

const CLASSIFY_PATTERNS: Array<{ kind: CommandKind; re: RegExp }> = [
  { kind: "test", re: /\bpytest\b|\bunittest\b|\bmocha\b|\bjest\b|\bcargo\s+test\b|\bgo\s+test\b|\bmvn\s+test\b|\bvitest\b|\bplaywright\s+test\b|\bcypress\b|\brspec\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(make|cmake)\s+test\b/i },
  { kind: "scoring", re: /\bscore\b|\bgrading?\b|\bevaluate\b|\bbenchmark\b|\bjudge\b|\bgrade\b/i },
  { kind: "verify", re: /\bcurl\b|\bwget\b|\bhealth[-_]?check\b|\bsmoke\b|\bpayload\b/i },
  { kind: "dev_server", re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b|\bnext\s+dev\b|\bnext\s+start\b|\bflask\s+run\b|\buvicorn\b|\bgunicorn\b|\bdjango-admin\s+runserver\b|\bmanage\.py\s+runserver\b|\bhttp\.server\b|\bserve\b|\bnode\s+.*\bserver\.js\b|\bdeno\s+run\b.*-A\b|\bstreamlit\s+run\b|\bgradio\b|\bfastapi\b|\bexpress\b.*listen|\bvite\b|\bwebpack-dev-server\b|\bng\s+serve\b/i },
  { kind: "one_shot", re: /^\s*(ls|cat|echo|pwd|true|false|head|tail|wc|cp|mv|mkdir|rmdir|chmod|chown|find|grep|rg|ag|sort|uniq|cut|tr|tee|diff|tar|zip|unzip|git\s+(status|log|diff|show|rev-parse|ls-files|branch))\b/i }
];

export function classifyCommand(cmd: string): CommandKind {
  if (!cmd || !cmd.trim()) return "shell";
  for (const { kind, re } of CLASSIFY_PATTERNS) {
    if (re.test(cmd)) return kind;
  }
  return "shell";
}

export function isLongRunning(kind: CommandKind): boolean {
  return kind === "dev_server";
}

const FAILURE_PATTERNS: Array<{ cls: FailureClass; re: RegExp }> = [
  { cls: "snapshot_baseline", re: /\b(snapshot|baseline|visual[_\- ]diff|tomatchsnapshot|expected.*to (be|equal).*but received)\b/i },
  { cls: "dependency", re: /\b(module not found|no module named|cannot find module|no such file or directory|enoent.*node_modules|pep 668|externally[- ]managed|lockfile out of date|importerror|cannot find a package)\b/i },
  { cls: "server_runtime", re: /\b(eaddrinuse|address already in use|port \d+ is (already )?in use|listening on port|server (crashed|killed|stopped)|unhandled rejection|uncaughtexception|segfault)\b/i },
  { cls: "stale_workspace", re: /\b(stale|workspace (mismatch|mismatch)|serving.*different (workspace|dir|directory)|not the current (workspace|repo))\b/i },
  { cls: "test_bug", re: /\b(conftest|fixture|setup failed|teardown failed|error: cannot find|error during collection|test file not found|importerror.*test|unrecognized arguments)\b/i },
  { cls: "app_bug", re: /\b(assertionerror|assert .*==|expected .* to (be|equal)|typeerror|valueerror|keyerror|attributeerror|noneType.*has no attribute|indexerror)\b/i },
  { cls: "command_invocation", re: /\b(command not found|usage:|usage error|unknown option|invalid argument|bad flag|unrecognized arguments|no such option|errno\s*=\s*enoent)\b/i }
];

export function classifyFailure(opts: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }): FailureClass {
  if (opts.timedOut) return "server_runtime";
  if (opts.exitCode === 0) return "unknown";
  const blob = `${opts.stdout ?? ""}\n${opts.stderr ?? ""}`;
  if (!blob.trim()) return "unknown";
  for (const { cls, re } of FAILURE_PATTERNS) {
    if (re.test(blob)) return cls;
  }
  return "unknown";
}

const SKIP_DIRS = new Set(["__pycache__", ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".idea", ".vscode", "dist", "build", "target", ".next", ".cache", "_archive"]);

export function workspaceSignature(repoRoot: string): string {
  const root = resolve(repoRoot);
  if (!existsSync(root)) return `missing:${root}`;
  let fileCount = 0;
  let highestMtime = 0;
  let totalSize = 0;
  try {
    const walk = (dir: string): void => {
      if (fileCount > 2000) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        if (fileCount > 2000) break;
        const p = join(dir, name);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(p);
        } else {
          fileCount += 1;
          totalSize += Number(st.size);
          const mtime = Number(st.mtimeMs);
          if (mtime > highestMtime) highestMtime = mtime;
        }
      }
    };
    walk(root);
  } catch {
    // best-effort
  }
  return `${root}|n=${fileCount}|mtime=${Math.trunc(highestMtime)}|size=${totalSize}`;
}

export function workspaceIdentityCheck(served: string | null, expected: string): { ok: boolean; mismatch: { observed: string; expected: string; evidence: string } | null } {
  if (served === null) return { ok: true, mismatch: null };
  if (served === expected) return { ok: true, mismatch: null };
  return {
    ok: false,
    mismatch: {
      observed: served,
      expected,
      evidence: `The running server reported it is serving workspace ${served} but the current workspace is ${expected}. The agent may be talking to a stale dev server or a different checkout.`
    }
  };
}

export class ProcessRegistry {
  private commands = new Map<string, OwnedCommand>();
  private processes = new Map<string, OwnedProcess>();
  private order: string[] = [];

  recordCommand(cmd: OwnedCommand): void {
    this.commands.set(cmd.cmdId, cmd);
    this.order.push(cmd.cmdId);
  }

  getCommand(cmdId: string): OwnedCommand | undefined {
    return this.commands.get(cmdId);
  }

  allCommands(): OwnedCommand[] {
    return this.order.filter((id) => this.commands.has(id)).map((id) => this.commands.get(id)!);
  }

  commandsByKind(kind: CommandKind): OwnedCommand[] {
    return this.allCommands().filter((cmd) => cmd.kind === kind);
  }

  registerProcess(proc: OwnedProcess): void {
    this.processes.set(proc.processId, proc);
  }

  deregisterProcess(processId: string): void {
    this.processes.delete(processId);
  }

  getProcess(processId: string): OwnedProcess | undefined {
    return this.processes.get(processId);
  }

  allProcesses(): OwnedProcess[] {
    return [...this.processes.values()];
  }

  runningProcesses(): OwnedProcess[] {
    return this.allProcesses().filter((proc) => proc.status === "running");
  }

  isOwnedProcess(processId: string): boolean {
    return this.processes.has(processId);
  }

  stopAllRunning(): string[] {
    const stopped: string[] = [];
    for (const proc of this.allProcesses()) {
      if (proc.status !== "running") continue;
      proc.status = "stopped";
      stopped.push(proc.label || proc.processId);
    }
    return stopped;
  }

  safeCleanupTargets(): Array<{ kind: string; id: string; label: string; status: ProcessStatus }> {
    const out: Array<{ kind: string; id: string; label: string; status: ProcessStatus }> = [];
    for (const proc of this.allProcesses()) {
      out.push({ kind: "process", id: proc.processId, label: proc.label, status: proc.status });
    }
    for (const cmd of this.commands.values()) {
      if (cmd.status === "running") out.push({ kind: "command", id: cmd.cmdId, label: cmd.cmd.slice(0, 80), status: cmd.status });
    }
    return out;
  }

  summary(): { commands: number; processes: number; runningProcesses: number } {
    return {
      commands: this.commands.size,
      processes: this.processes.size,
      runningProcesses: this.runningProcesses().length
    };
  }
}

export class CompletionLedger {
  private state: CompletionLedgerState;

  constructor(userGoal: string) {
    this.state = {
      userGoal,
      startedAt: Date.now(),
      finishedAt: 0,
      changedFiles: [],
      commandsRun: [],
      verification: [],
      artifacts: [],
      unresolvedFailures: [],
      entries: [],
      confidence: "low",
      done: false,
      doneReason: ""
    };
  }

  get(): CompletionLedgerState {
    return { ...this.state, changedFiles: [...this.state.changedFiles], commandsRun: [...this.state.commandsRun], verification: this.state.verification.map((v) => ({ ...v })), artifacts: [...this.state.artifacts], unresolvedFailures: this.state.unresolvedFailures.map((f) => ({ ...f })), entries: [...this.state.entries] };
  }

  addEntry(kind: string, summary = "", extra: Record<string, unknown> = {}): LedgerEntry {
    const entry: LedgerEntry = { kind, at: Date.now(), summary, extra };
    this.state.entries.push(entry);
    return entry;
  }

  recordCommand(cmd: string): void {
    if (cmd && !this.state.commandsRun.includes(cmd)) this.state.commandsRun.push(cmd);
    this.addEntry("command", cmd.slice(0, 200));
  }

  recordFileChange(path: string): void {
    if (path && !this.state.changedFiles.includes(path)) this.state.changedFiles.push(path);
    this.addEntry("edit", path);
  }

  recordArtifact(path: string): void {
    if (path && !this.state.artifacts.includes(path)) this.state.artifacts.push(path);
    this.addEntry("artifact", path);
  }

  recordFailure(summary: string, failureClass: FailureClass = "unknown"): void {
    this.state.unresolvedFailures.push({ summary, failureClass });
    this.addEntry("failure", summary, { failureClass });
  }

  /**
   * Records the outcome of a command tool. On failure it latches an unresolved failure keyed
   * by the command's structural fingerprint; on success it auto-supersedes any earlier
   * failure of an equivalent command. This is the live-path recovery that keeps a single
   * fumbled exploratory command from wedging the finish gate forever.
   */
  recordCommandResult(command: string, ok: boolean, failureClass: FailureClass = "unknown"): void {
    const sig = commandFingerprint(command);
    if (ok) {
      const before = this.state.unresolvedFailures.length;
      this.state.unresolvedFailures = this.state.unresolvedFailures.filter((f) => f.commandSig !== sig);
      if (this.state.unresolvedFailures.length < before) this.addEntry("recovery", command.slice(0, 120), { commandSig: sig });
      return;
    }
    // Never wedge the finish gate on a self-corrected shell fumble (a failed `ls`/`mv`/`Move-Item`, a
    // mistyped path, a PowerShell cmdlet in bash). Record it for visibility but do NOT latch it.
    if (isExploratoryCommand(command)) {
      this.addEntry("failure", `${command.slice(0, 160)} (advisory - exploratory command, not a build blocker)`, { failureClass, commandSig: sig });
      return;
    }
    this.state.unresolvedFailures.push({ summary: `${command} -> failed`, failureClass, commandSig: sig });
    this.addEntry("failure", command.slice(0, 200), { failureClass, commandSig: sig });
  }

  recordRecovery(name: string, failureClass: FailureClass): void {
    this.addEntry("recovery", name, { failureClass });
    this.state.unresolvedFailures = this.state.unresolvedFailures.filter((f) => f.failureClass !== failureClass);
  }

  /** Drop stage-less exploratory failures once a real test stage has passed. */
  clearExploratoryFailures(): void {
    this.state.unresolvedFailures = this.state.unresolvedFailures.filter((f) => f.stage);
  }

  recordVerification(results: VerificationStageResult[]): void {
    this.state.verification = results.map((r) => ({ ...r }));
    for (const r of results) {
      this.addEntry("verification_stage", `${r.stage}: ${r.status}`, { stage: r.stage, status: r.status, failureClass: r.failureClass });
    }
  }

  recordVerificationStage(result: VerificationStageResult): void {
    const idx = this.state.verification.findIndex((v) => v.stage === result.stage);
    if (idx >= 0) this.state.verification[idx] = { ...result };
    else this.state.verification.push({ ...result });
    this.addEntry("verification_stage", `${result.stage}: ${result.status}`, { stage: result.stage, status: result.status, failureClass: result.failureClass });
    // A re-run of the same stage supersedes any earlier unresolved failure it recorded,
    // otherwise a passing re-run can never clear the latch and finish stays blocked forever.
    this.state.unresolvedFailures = this.state.unresolvedFailures.filter((f) => f.stage !== result.stage);
    if ((result.status === "failed" || result.status === "timed_out") && !result.advisory) {
      this.state.unresolvedFailures.push({ summary: `${result.stage}: ${result.summary}`, failureClass: result.failureClass, stage: result.stage });
    } else if (result.status === "ok" && TEST_STAGES.has(result.stage)) {
      // A real test/smoke/scoring stage passing means the end state is good; drop stray
      // exploratory command failures that would otherwise wedge the finish gate.
      this.clearExploratoryFailures();
    }
  }

  finalize(done: boolean, reason: string, confidence: "low" | "medium" | "high" = "medium"): void {
    this.state.finishedAt = Date.now();
    this.state.done = done;
    this.state.doneReason = reason;
    this.state.confidence = confidence;
    this.addEntry(done ? "done" : "not_done", reason, { confidence });
  }

  hasUnresolvedFailures(): boolean {
    return this.state.unresolvedFailures.length > 0;
  }

  isVerified(): boolean {
    return isTerminalVerified(this.state.verification);
  }

  toHuman(maxEntries = 20): string {
    const s = this.state;
    const lines: string[] = [];
    lines.push(`GOAL: ${s.userGoal}`);
    lines.push(`CHANGED FILES (${s.changedFiles.length}):`);
    for (const f of s.changedFiles.slice(0, 20)) lines.push(`  - ${f}`);
    if (!s.changedFiles.length) lines.push("  (none)");
    lines.push(`COMMANDS RUN (${s.commandsRun.length}):`);
    for (const c of s.commandsRun.slice(0, 10)) lines.push(`  - ${c.slice(0, 120)}`);
    lines.push("VERIFICATION:");
    if (s.verification.length) {
      for (const stage of s.verification) {
        const mark = stage.status === "ok" ? "[OK]" : stage.status === "failed" ? "[FAIL]" : stage.status === "timed_out" ? "[TIMEOUT]" : stage.status === "skipped" ? "[SKIP]" : stage.status === "running" ? "[~]" : "[...]";
        lines.push(`  ${mark} ${stage.stage}: ${stage.summary}`);
      }
    } else {
      lines.push("  (no verification was run)");
    }
    if (s.unresolvedFailures.length) {
      lines.push(`UNRESOLVED FAILURES (${s.unresolvedFailures.length}):`);
      for (const f of s.unresolvedFailures.slice(0, 5)) lines.push(`  - [${f.failureClass}] ${f.summary}`);
    }
    lines.push(`STATUS: ${s.done ? "DONE" : "NOT DONE"} (${s.doneReason})  confidence=${s.confidence}`);
    if (s.entries.length > maxEntries) lines.push(`(+${s.entries.length - maxEntries} earlier entries hidden)`);
    return lines.join("\n");
  }
}

// Stages whose PASS means the end state is good, so stray manual-command failures the model already
// fixed (a `tsc --noEmit` it corrected then re-verified via `npm run build`, a mistyped path) are
// cleared. "build" is included: a green `npm run build` compiles the whole app, so it subsumes an
// earlier fixed typecheck/compile failure the model happened to re-verify with a different command.
const TEST_STAGES = new Set<VerificationStageName>(["build", "smoke", "focused_tests", "full_tests", "scoring"]);

/** Flag-insensitive, number-insensitive command signature; equivalent commands share a key. */
// A failed exploratory/navigation/file command (a mistyped path, a PowerShell cmdlet run in the POSIX
// bash tool, a `cd` to a Windows backslash path) is a self-corrected fumble, NOT a project failure, so
// it must never latch a finish-blocking "unresolved failure". Build/test/typecheck runners are
// deliberately NOT listed, so a genuine check failure still blocks. Matches the leading command word
// after an optional `cd <path> &&` prefix.
const EXPLORATORY_WORDS = /^\s*(?:cd|pushd|popd|ls|dir|pwd|echo|printf|cat|type|head|tail|less|more|find|grep|rg|ag|sed|awk|which|where|whereis|mkdir|rmdir|rm|del|mv|move|cp|copy|touch|stat|file|wc|sort|uniq|tree|clear|export|set|env|nl|basename|dirname|realpath|readlink|move-item|get-childitem|gci|copy-item|remove-item|new-item|set-location|get-content|get-location|select-string|test-path|write-host|write-output)\b/i;
export function isExploratoryCommand(cmd: string): boolean {
  // Classify the ACTUAL operation, not a leading `cd <path> &&` wrapper (which may prefix a REAL check
  // like `cd x && npm run build`): strip the wrapper first, then test the remainder. A command that is
  // ONLY a `cd`/navigation is itself exploratory; a check runner (npm/tsc/pytest/...) is not listed.
  const stripped = cmd.replace(/^\s*(?:cd|pushd|popd)\s+[^&;]+(?:&&|;)\s*/i, "").trim();
  if (!stripped) return true;
  return EXPLORATORY_WORDS.test(stripped);
}

export function commandFingerprint(cmd: string): string {
  // Strip a leading directory-change prefix (`cd <path> &&`/`;`, `pushd <path> &&`) so the fingerprint
  // reflects the actual OPERATION, not the shell wrapper. Without this, a command the model retried
  // from a corrected path (a Windows `cd C:\..` that failed in bash vs the fixed `cd /c/..`)
  // fingerprints differently from its own successful retry, so the success never clears the earlier
  // failure latch and the finish gate stays BLOCKED on a self-corrected shell typo.
  const stripped = cmd.replace(/^\s*(?:cd|pushd)\s+[^&;]+(?:&&|;)\s*/i, "").trim();
  return (stripped || cmd)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith("-"))
    .map((token) => token.replace(/\d+/g, "#"))
    .join(" ")
    .trim();
}

export function isTerminalVerified(results: VerificationStageResult[]): boolean {
  if (!results.length) return false;
  for (const r of results) {
    if (r.status === "ok") continue;
    if (r.status === "skipped") continue;
    // An ADVISORY failure (a non-required, environment-flaky dev-server smoke/identity check that
    // timed out) must NOT prevent terminal-verified status - the build is the gate. Without this, a
    // green build still can't finish because the advisory smoke timeout blocks the finish gate (the
    // model then wastes turns "debugging" a port mismatch it cannot fix, and finishes only by waiver).
    if (r.advisory) continue;
    return false;
  }
  return results.some((r) => r.status === "ok");
}

export interface FinishGateVerdict {
  allowed: boolean;
  reason: string;
}

export function ledgerAllowsFinish(ledger: CompletionLedger): FinishGateVerdict {
  const s = ledger.get();
  if (!s.commandsRun.length && !s.changedFiles.length) {
    return { allowed: false, reason: "no work was done; refusing fake completion" };
  }
  if (s.unresolvedFailures.length) {
    return { allowed: false, reason: `unresolved failures: ${s.unresolvedFailures.map((f) => f.failureClass).join(", ")}` };
  }
  // The harness itself determined no runnable verification command exists in this project (no
  // test/typecheck/build). That is "impossible to verify", not "skipped by laziness": allow an
  // honest unverified finish rather than block forever - but ONLY when nothing failed and no
  // real check is available to have passed. Any real stage (ok or failed) reverts to the normal
  // rules below, so this can never mask a genuine failure.
  const noRunnableCheck =
    s.verification.some((v) => (v.signals as Record<string, unknown> | undefined)?.noCommandAvailable)
    && !s.verification.some((v) => v.status === "failed")
    && !s.verification.some((v) => v.status === "ok");
  if (noRunnableCheck) {
    return { allowed: true, reason: "no runnable verification command exists in this project; finishing unverified" };
  }
  if (!s.verification.length) {
    return { allowed: false, reason: "no verification was run; refusing fake completion" };
  }
  if (!isTerminalVerified(s.verification)) {
    const failed = s.verification.filter((v) => v.status === "failed");
    if (failed.length) return { allowed: false, reason: `verification not terminal: ${failed.length} stage(s) failed` };
    return { allowed: false, reason: "verification did not reach a terminal state" };
  }
  return { allowed: true, reason: "verified" };
}

export function newId(prefix = "cmd"): string {
  return `${prefix}-${randomUUID().slice(0, 10)}`;
}

export function makeRecoveryCapsule(failureClass: FailureClass, reason: string, terminal = false): RecoveryCapsule {
  const table: Record<FailureClass, { action: string; description: string }> = {
    app_bug: { action: "replan_with_focus_on_failure", description: "Re-plan with the failing assertion/exception quoted as the new focus." },
    test_bug: { action: "replan_with_focus_on_test", description: "Inspect the test setup before re-running; tests must not be silently rewritten." },
    server_runtime: { action: "stop_owned_servers_and_retry", description: "Stop owned dev servers, free the port, restart from a clean state." },
    dependency: { action: "install_or_pin_dependencies", description: "Install / re-pin the missing dependency in the current env, then retry." },
    snapshot_baseline: { action: "review_snapshot_diff_with_user", description: "Treat baseline change as deliberate; do not auto-update snapshots without user confirmation." },
    stale_workspace: { action: "restart_server_against_current_workspace", description: "Stop owned dev server, restart it pointed at the current workspace, re-verify." },
    command_invocation: { action: "fix_invocation_and_retry", description: "Fix the command line and retry exactly once." },
    unknown: { action: "collect_diagnostics_and_ask", description: "Collect tail and ledger, then surface to the user; do not loop." }
  };
  const entry = table[failureClass];
  return {
    id: newId("recovery"),
    failureClass,
    action: entry.action,
    description: entry.description,
    reason,
    terminal
  };
}

export interface NonProgressEvent {
  reason: string;
  streak: number;
  terminal: boolean;
  recovery: RecoveryCapsule;
}

export class NonProgressDetector {
  private streak = 0;
  private readonly stallWindow: number;
  private readonly maxStreak: number;
  private readonly seenFiles = new Set<string>();
  private readonly seenActions = new Set<string>();
  private lastFailureClass: FailureClass | null = null;

  constructor(stallWindow = 3, maxStreak = 5) {
    this.stallWindow = stallWindow;
    this.maxStreak = maxStreak;
  }

  observe(step: { action: string; argsSig: string; filesRead: string[]; filesChanged: string[]; failureClass?: FailureClass; ok?: boolean }): NonProgressEvent | undefined {
    let progressed = false;
    for (const f of step.filesRead) {
      if (!this.seenFiles.has(f)) {
        this.seenFiles.add(f);
        progressed = true;
      }
    }
    if (step.filesChanged.length > 0) progressed = true;
    const sig = `${step.action}|${step.argsSig}`;
    if (!this.seenActions.has(sig)) {
      this.seenActions.add(sig);
      progressed = true;
    }
    if (step.failureClass && step.failureClass !== this.lastFailureClass) {
      this.lastFailureClass = step.failureClass;
      progressed = true;
    }
    if (progressed) {
      this.streak = 0;
      return undefined;
    }
    this.streak += 1;
    if (this.streak < this.stallWindow) return undefined;
    const reason = `no progress for ${this.streak} consecutive steps`;
    const terminal = this.streak >= this.maxStreak;
    const failureClass = step.failureClass ?? "unknown";
    return {
      reason,
      streak: this.streak,
      terminal,
      recovery: makeRecoveryCapsule(failureClass, reason, terminal)
    };
  }

  get currentStreak(): number {
    return this.streak;
  }

  reset(): void {
    this.streak = 0;
  }
}

export interface WebappVerificationStageSpec {
  stage: VerificationStageName;
  required: boolean;
  timeoutSeconds: number;
  successSignal: "exit_zero" | "workspace_match" | "stage_specific";
  description: string;
}

export function defaultWebappPlan(): WebappVerificationStageSpec[] {
  return [
    { stage: "prepare_env", required: true, timeoutSeconds: 60, successSignal: "stage_specific", description: "install / sync project deps so the workspace is buildable" },
    // The BUILD is the primary, reliable success signal for a webapp ("it builds with npm run build").
    // It is the required gate; the dev-server stages below are advisory best-effort (a headless dev
    // server is environment-flaky - e.g. Vite ignores PORT and binds localhost/::1, so a curl smoke
    // check to 127.0.0.1:PORT spuriously times out - and must NEVER block a clean build).
    { stage: "build", required: true, timeoutSeconds: 240, successSignal: "exit_zero", description: "build the app (e.g. npm run build) - the primary success signal" },
    { stage: "start_services", required: false, timeoutSeconds: 20, successSignal: "stage_specific", description: "best-effort: start the dev server owned by the harness (advisory)" },
    { stage: "workspace_identity", required: false, timeoutSeconds: 10, successSignal: "workspace_match", description: "best-effort: confirm the running server serves THIS workspace (advisory)" },
    { stage: "smoke", required: false, timeoutSeconds: 8, successSignal: "exit_zero", description: "best-effort: app responds over HTTP (advisory; a headless dev server often will not)" },
    { stage: "focused_tests", required: false, timeoutSeconds: 60, successSignal: "exit_zero", description: "run the tests most likely to cover the changed code" },
    { stage: "full_tests", required: false, timeoutSeconds: 180, successSignal: "exit_zero", description: "run the full project test suite" },
    { stage: "scoring", required: false, timeoutSeconds: 60, successSignal: "exit_zero", description: "run the project's scoring / grading command if one exists" },
    { stage: "collect_artifacts", required: true, timeoutSeconds: 10, successSignal: "stage_specific", description: "collect logs, screenshots, test output paths" },
    { stage: "stop_services", required: true, timeoutSeconds: 10, successSignal: "stage_specific", description: "stop services the harness owns" },
    { stage: "summarize", required: true, timeoutSeconds: 5, successSignal: "stage_specific", description: "summarise evidence into a completion ledger" }
  ];
}

export function defaultCliPlan(): WebappVerificationStageSpec[] {
  return [
    { stage: "prepare_env", required: true, timeoutSeconds: 60, successSignal: "stage_specific", description: "install / sync deps" },
    { stage: "focused_tests", required: true, timeoutSeconds: 60, successSignal: "exit_zero", description: "run focused tests covering the changed code" },
    { stage: "full_tests", required: true, timeoutSeconds: 180, successSignal: "exit_zero", description: "run the full test suite" },
    { stage: "scoring", required: false, timeoutSeconds: 60, successSignal: "exit_zero", description: "run scoring / grading if a command is known" },
    { stage: "collect_artifacts", required: true, timeoutSeconds: 5, successSignal: "stage_specific", description: "collect test output paths" },
    { stage: "summarize", required: true, timeoutSeconds: 5, successSignal: "stage_specific", description: "summarise evidence" }
  ];
}
