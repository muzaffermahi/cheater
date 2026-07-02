// TaskRunState: one object that owns a run's durable state and keeps it coherent.
//
// The wiring layer (extension hooks, commitlet tools) talks to this aggregate instead of to
// five separate modules, so the invariants live in one place: every file mutation marks
// dependent validations stale; every passing evaluator-mirroring validation protects its
// artifacts; every capsule build is measured and logged; the digest is re-derived from the
// ledgers, never hand-edited. All disk writes are best-effort - runstate must never break
// the run it is recording.

import { extractAcceptanceContract, saveContract, summarizeContract, type AcceptanceContract } from "./contract.js";
import { MutationLedger, mutationsFromCommand, type MutationAction } from "./mutationLedger.js";
import { ValidationLedger, classifyValidationResultType, mirrorsEvaluator, type ValidationEntry, type ValidationStatus } from "./validationLedger.js";
import { PhaseController, type PhaseActionKind, type PhaseAssessment, type RunPhase } from "./phaseController.js";
import { PostSuccessGuard, type GuardVerdict } from "./postSuccessGuard.js";
import { buildWorkspaceDigest, writeWorkspaceDigest } from "./workspaceDigest.js";
import { appendRunEvent, ensureRunDir, mintTaskId, writeRunFile } from "./runDir.js";
import { assessRisk, type RiskInput } from "./riskMiddleware.js";
import { capsuleSizeReport, type CapsuleSizeReport, type PromptCapsule } from "./promptCapsule.js";
import { writeWorkerPlan, writeWorkerReport, type WorkerReport } from "./workerPlans.js";
import { buildWorldState, diffWorldState, loadWorldState, renderWorldStateDiff, saveWorldState, type RunStatus, type WorldState } from "./worldState.js";

export interface TaskRunOptions {
  taskId?: string;
  actionBudget?: number;
  wallClockMs?: number;
  /** Reincarnation: restore phase/status/reports from the persisted world state. */
  resume?: boolean;
}

/** Local-only harness-quality counters. No network, no cloud - engineering feedback only. */
export interface RunTelemetry {
  blockedToolCalls: number;
  guardBlocks: number;
  reserveBlocks: number;
  riskWarnings: number;
  staleValidationEvents: number;
  invariantFailures: number;
  loopEvents: number;
  capsulesBuilt: number;
}

export interface FinishCheck {
  ok: boolean;
  warnings: string[];
}

export class TaskRunState {
  readonly repoRoot: string;
  readonly taskId: string;
  readonly runDir: string;
  readonly goal: string;
  readonly contract: AcceptanceContract;
  readonly phase: PhaseController;
  readonly mutations: MutationLedger;
  readonly validations: ValidationLedger;
  readonly guard: PostSuccessGuard;
  status: RunStatus = "running";
  /** True when this run was reactivated from disk (session reincarnation). */
  readonly resumed: boolean;
  activeCommitletId?: string;
  /** Bounded history of observed commands, for world state. */
  commandsRun: string[] = [];
  private readonly filesRead = new Set<string>();
  private telemetry: RunTelemetry = {
    blockedToolCalls: 0,
    guardBlocks: 0,
    reserveBlocks: 0,
    riskWarnings: 0,
    staleValidationEvents: 0,
    invariantFailures: 0,
    loopEvents: 0,
    capsulesBuilt: 0
  };
  private maxCapsuleTokens = 0;
  private blockers: string[] = [];
  private environmentNotes: string[] = [];
  private priorReportLines: string[] = [];
  private nextAction = "extract plan and spawn the first worker";
  /** World state as of the last capsule build - the diff baseline for the next worker. */
  private lastCapsuleWorld: WorldState | null = null;

  constructor(repoRoot: string, goal: string, opts: TaskRunOptions = {}) {
    this.repoRoot = repoRoot;
    this.goal = goal ?? "";
    this.taskId = opts.taskId ?? mintTaskId();
    this.runDir = ensureRunDir(repoRoot, this.taskId);
    this.resumed = opts.resume === true;
    this.contract = extractAcceptanceContract(this.goal);
    const previousWorld = opts.resume ? loadWorldState(this.runDir) : null;
    this.phase = previousWorld
      ? PhaseController.fromSnapshot(previousWorld.phase, { actionBudget: opts.actionBudget ?? previousWorld.phase.actionBudget, wallClockMs: opts.wallClockMs })
      : new PhaseController({ actionBudget: opts.actionBudget, wallClockMs: opts.wallClockMs });
    this.mutations = MutationLedger.load(this.runDir);
    this.validations = ValidationLedger.load(this.runDir);
    this.guard = PostSuccessGuard.load(this.runDir);
    if (previousWorld) {
      this.priorReportLines = previousWorld.workerReports.slice(-6);
      this.commandsRun = previousWorld.commandsRun.slice(-20);
      this.activeCommitletId = previousWorld.activeCommitletId;
    }
    try {
      saveContract(this.runDir, this.contract);
    } catch {
      // best-effort
    }
    appendRunEvent(this.runDir, opts.resume ? "run_resumed" : "run_started", { taskId: this.taskId, goal: this.goal.slice(0, 200) });
    this.refreshDigest();
  }

  currentPhase(): RunPhase {
    return this.phase.currentPhase();
  }

  budgetRemainingPercent(): number {
    return Math.max(0, Math.round((1 - this.phase.fractionUsed()) * 100));
  }

  /** One budget-consuming action happened (tool call / command). */
  noteAction(kind: PhaseActionKind, detail?: string): PhaseAssessment {
    this.phase.noteAction();
    return this.phase.assessAction(kind, detail);
  }

  /** A file was created/modified/deleted. Stales dependent validations, feeds the ledger. */
  recordFileMutation(path: string, action: MutationAction, actor: string, source: string, reason?: string): void {
    if (!path) return;
    this.mutations.record({ actor, action, paths: [path], source: source.slice(0, 120), reason });
    const newlyStale = this.validations.markStaleForPaths([path]);
    if (newlyStale.length) {
      this.telemetry.staleValidationEvents += newlyStale.length;
      appendRunEvent(this.runDir, "validations_stale", { path, count: newlyStale.length, names: newlyStale.map((e) => e.name).slice(0, 4) });
    }
    this.persistLedgers();
  }

  /** A file's content was read (or supplied in a capsule) - the read-before-write evidence. */
  noteFileRead(path: string): void {
    if (path) this.filesRead.add(path.replace(/\\/g, "/").replace(/^\.\//, ""));
  }

  wasRead(path: string): boolean {
    const norm = (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (this.filesRead.has(norm)) return true;
    for (const seen of this.filesRead) {
      if (seen.endsWith(`/${norm}`) || norm.endsWith(`/${seen}`)) return true;
    }
    return false;
  }

  /** Files whose content a capsule carried count as read for its worker. */
  registerCapsuleFiles(paths: string[]): void {
    for (const path of paths) this.noteFileRead(path);
  }

  bumpTelemetry(key: keyof RunTelemetry, by = 1): void {
    this.telemetry[key] += by;
  }

  telemetrySnapshot(): Record<string, number> {
    return { ...this.telemetry };
  }

  capsuleMetrics(): { count: number; maxTokens: number } {
    return { count: this.telemetry.capsulesBuilt, maxTokens: this.maxCapsuleTokens };
  }

  /** A durable risk event (loop verdicts, hook warnings worth keeping). */
  recordRiskEvent(kind: string, message: string): void {
    this.telemetry.riskWarnings += 1;
    if (kind.startsWith("loop")) this.telemetry.loopEvents += 1;
    appendRunEvent(this.runDir, "risk_event", { riskKind: kind, message: message.slice(0, 200) });
  }

  setStatus(status: RunStatus): void {
    this.status = status;
    this.syncWorldState();
  }

  setActiveCommitlet(id: string | undefined): void {
    this.activeCommitletId = id;
  }

  /** A shell command ran; derive any plain state changes from it. */
  recordCommand(command: string, actor: string): void {
    if (command) {
      this.commandsRun.push(command.slice(0, 160));
      this.commandsRun = this.commandsRun.slice(-20);
    }
    const derived = mutationsFromCommand(command, actor);
    for (const entry of derived) {
      this.mutations.record(entry);
      if (entry.action === "file_deleted" || entry.action === "file_modified") {
        this.validations.markStaleForPaths(entry.paths);
      }
      if (entry.action === "dependency_installed") {
        this.environmentNotes.push(`installed: ${entry.paths.join(", ")}`.slice(0, 100));
        this.environmentNotes = this.environmentNotes.slice(-5);
      }
    }
    if (derived.length) this.persistLedgers();
  }

  /**
   * Record a validation outcome. On a fresh evaluator-mirroring pass, protect the artifacts
   * it proved; on a failure over protected paths, release them for a targeted repair.
   */
  recordValidation(params: {
    name: string;
    command?: string;
    actor: string;
    validates: string[];
    status: ValidationStatus;
    outputSummary?: string;
  }): ValidationEntry {
    const probe = `${params.command ?? ""} ${params.name}`;
    const mirrors = mirrorsEvaluator(probe, this.contract);
    const resultType = classifyValidationResultType(probe, this.contract);
    const entry = this.validations.record({ ...params, outputSummary: params.outputSummary?.slice(0, 300), mirrorsEvaluator: mirrors, resultType });
    if (params.status === "pass") {
      if (params.validates.length) this.mutations.markValidated(params.validates);
      else this.mutations.markAllValidated();
      const toProtect = [...new Set([...params.validates, ...this.contract.outputPaths])].filter(Boolean);
      if (mirrors && toProtect.length) {
        const added = this.guard.protect(toProtect, `validated by ${params.name}`);
        if (added.length) appendRunEvent(this.runDir, "artifacts_protected", { paths: added.map((a) => a.path) });
      }
    } else if (params.status === "fail" && params.validates.length) {
      this.guard.releaseForRepair(params.validates);
    }
    appendRunEvent(this.runDir, "validation_recorded", { name: params.name, status: params.status, mirrorsEvaluator: mirrors, resultType });
    this.persistLedgers();
    return entry;
  }

  addBlocker(blocker: string): void {
    this.blockers.push(blocker.slice(0, 140));
    this.blockers = this.blockers.slice(-5);
  }

  clearBlockers(): void {
    this.blockers = [];
  }

  setNextAction(next: string): void {
    this.nextAction = next.slice(0, 200);
  }

  /** Persist a capsule + its worker plan, log its size, and return the size report. */
  noteCapsule(capsule: PromptCapsule): CapsuleSizeReport {
    const report = capsuleSizeReport(capsule);
    this.maxCapsuleTokens = Math.max(this.maxCapsuleTokens, report.estimatedTokens);
    this.telemetry.capsulesBuilt += 1;
    this.registerCapsuleFiles(capsule.relevantFiles.filter((file) => file.snippet).map((file) => file.path));
    try {
      writeWorkerPlan(this.runDir, capsule);
      writeRunFile(this.runDir, `capsules/${capsule.workerRole}-capsule.json`, JSON.stringify(capsule, null, 2) + "\n");
    } catch {
      // best-effort
    }
    appendRunEvent(this.runDir, "capsule_built", {
      capsuleId: report.capsuleId,
      workerRole: report.workerRole,
      estimatedTokens: report.estimatedTokens,
      fileCount: report.fileCount,
      priorReportCount: report.priorReportCount,
      digestIncluded: report.digestIncluded,
      fullLogsIncluded: report.fullLogsIncluded,
      warning: report.warning
    });
    return report;
  }

  /** Fold a finished worker's report into durable state and refresh the digest. */
  integrateWorkerReport(report: WorkerReport): { compactLine: string } {
    const { compactLine } = writeWorkerReport(this.runDir, report);
    this.priorReportLines.push(compactLine);
    this.priorReportLines = this.priorReportLines.slice(-6);
    for (const problem of report.problems.slice(0, 2)) this.addBlocker(problem);
    if (report.recommendedNextAction) this.setNextAction(report.recommendedNextAction);
    appendRunEvent(this.runDir, "worker_report", {
      workerRole: report.workerRole,
      contractSatisfied: report.contractSatisfied,
      filesChanged: report.filesChanged.slice(0, 6)
    });
    this.refreshDigest();
    return { compactLine };
  }

  recentReportLines(max = 3): string[] {
    return this.priorReportLines.slice(-max);
  }

  /** Re-derive and persist the digest from current ledgers/contract/phase/guard. */
  refreshDigest(): string {
    const digest = buildWorkspaceDigest({
      taskId: this.taskId,
      goal: this.goal,
      phase: this.currentPhase(),
      budgetRemainingPercent: this.budgetRemainingPercent(),
      contract: this.contract,
      mutations: this.mutations,
      validations: this.validations,
      environmentNotes: this.environmentNotes,
      blockers: this.blockers,
      protectedArtifacts: this.guard.list().map((artifact) => artifact.path),
      nextAction: this.nextAction,
      maxCapsuleTokens: this.maxCapsuleTokens || undefined
    });
    writeWorkspaceDigest(this.runDir, digest);
    this.syncWorldState();
    return digest;
  }

  /** Rebuild and persist world-state.json from current run truth. */
  syncWorldState(): WorldState {
    const state = buildWorldState(this);
    saveWorldState(this.runDir, state);
    return state;
  }

  /**
   * World-state diff since the LAST capsule build, rendered compactly. First capsule gets []
   * (the digest fragment already carries the compact full state); later capsules get only
   * what changed - Codex-style "what changed", not "reread the past".
   */
  consumeWorldStateDiffLines(): string[] {
    const current = buildWorldState(this);
    const previous = this.lastCapsuleWorld;
    this.lastCapsuleWorld = current;
    if (!previous) return [];
    return renderWorldStateDiff(diffWorldState(previous, current));
  }

  /** Guard verdict for a planned shell command. */
  assessCommand(command: string): GuardVerdict {
    return this.guard.assessCommand(command);
  }

  /** Risk hints for a planned action, with run state filled in. */
  riskHints(partial: Omit<RiskInput, "phase" | "budgetRemainingPercent" | "contract" | "validationSummary" | "mutationSummary" | "guard">): string[] {
    const hints = this.computeRiskHints(partial);
    if (hints.length) this.telemetry.riskWarnings += hints.length;
    return hints;
  }

  private computeRiskHints(partial: Omit<RiskInput, "phase" | "budgetRemainingPercent" | "contract" | "validationSummary" | "mutationSummary" | "guard">): string[] {
    return assessRisk({
      ...partial,
      phase: this.currentPhase(),
      budgetRemainingPercent: this.budgetRemainingPercent(),
      contract: this.contract,
      validationSummary: this.validations.summary(),
      mutationSummary: this.mutations.summary(),
      guard: this.guard
    });
  }

  /**
   * Freshness check for the finish gate: stale-only evidence or proxy-only evidence when the
   * contract names exact targets produces warnings the gate can surface.
   */
  finishCheck(): FinishCheck {
    const warnings: string[] = [];
    const summary = this.validations.summary();
    // An EMPTY run ledger has no opinion - the completion ledger already gates the base
    // "verification must exist" requirement. This check only bites on evidence it recorded.
    if (summary.passes === 0 && summary.failures === 0) return { ok: true, warnings };
    if (summary.passes === 0) {
      warnings.push("Only failing validations are recorded in this run - nothing has passed yet.");
    } else if (summary.freshPasses === 0) {
      warnings.push(`All ${summary.stalePasses} passing validation(s) are stale - files changed after they ran. Re-run before finishing.`);
    }
    const hasExactTargets = this.contract.outputPaths.length || this.contract.endpoints.length || this.contract.commands.length;
    if (hasExactTargets && summary.freshPasses > 0 && summary.freshExactPasses === 0) {
      const target = this.contract.outputPaths[0] ?? this.contract.endpoints[0] ?? `\`${this.contract.commands[0]}\``;
      warnings.push(`Fresh passes are proxy-only; nothing validated the exact contract target ${target}.`);
    }
    return { ok: warnings.length === 0, warnings };
  }

  contractSummaryText(): string {
    return summarizeContract(this.contract);
  }

  private persistLedgers(): void {
    this.mutations.save(this.runDir);
    this.validations.save(this.runDir);
    this.guard.save(this.runDir);
  }
}

let active: TaskRunState | null = null;

/** Start (or replace) the active run. One run at a time, matching the one-plan-at-a-time flow. */
export function beginTaskRun(repoRoot: string, goal: string, opts: TaskRunOptions = {}): TaskRunState {
  // A superseded run must not linger as "running" - it would haunt session reincarnation.
  if (active && active.taskId !== opts.taskId) endTaskRun("superseded by a new run");
  active = new TaskRunState(repoRoot, goal, opts);
  return active;
}

/** Reincarnation: re-activate an unfinished run from its durable files. */
export function resumeTaskRun(repoRoot: string, taskId: string, goal: string, opts: Omit<TaskRunOptions, "taskId" | "resume"> = {}): TaskRunState {
  active = new TaskRunState(repoRoot, goal, { ...opts, taskId, resume: true });
  return active;
}

export function activeTaskRun(): TaskRunState | null {
  return active;
}

export function endTaskRun(reason = "finished"): void {
  if (active) {
    appendRunEvent(active.runDir, "run_ended", { reason });
    active.status = reason === "complete" ? "complete" : reason === "failed" ? "failed" : "ended";
    active.refreshDigest();
  }
  active = null;
}

/** Test hook: clear module state without touching disk. */
export function resetTaskRunForTests(): void {
  active = null;
}
