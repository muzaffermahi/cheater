// World-state snapshots and diffs: workers receive "what changed", not the whole past.
//
// world-state.json is the machine-readable twin of the human digest: compact, derived, and
// diffable. A worker that already saw snapshot N gets only the N->N+1 diff in its capsule;
// a respawned controller reads the latest snapshot instead of any transcript. The status
// field is also how unfinished runs are found for session reincarnation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRunState } from "./runState.js";
import type { PhaseSnapshot } from "./phaseController.js";
import { listRuns, readRunFile, runDirFor, writeRunFile } from "./runDir.js";

export type RunStatus = "running" | "complete" | "failed" | "ended";

export interface WorldState {
  taskId: string;
  repoRoot: string;
  goal: string;
  status: RunStatus;
  phase: PhaseSnapshot;
  activeCommitletId?: string;
  contractSummary: string;
  changedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  protectedArtifacts: string[];
  validations: Array<{ name: string; status: string; stale: boolean; resultType?: string }>;
  staleValidations: string[];
  commandsRun: string[];
  workerReports: string[];
  capsules: { count: number; maxTokens: number };
  telemetry: Record<string, number>;
  updatedAt: string;
}

export function buildWorldState(run: TaskRunState, extras: { activeCommitletId?: string; status?: RunStatus } = {}): WorldState {
  const mutation = run.mutations.summary();
  const validations = run.validations.all().slice(-8);
  return {
    taskId: run.taskId,
    repoRoot: run.repoRoot,
    goal: run.goal.slice(0, 300),
    status: extras.status ?? run.status,
    phase: run.phase.snapshot(),
    activeCommitletId: extras.activeCommitletId ?? run.activeCommitletId,
    contractSummary: run.contractSummaryText().slice(0, 500),
    changedFiles: mutation.modifiedFiles,
    createdFiles: mutation.createdFiles,
    deletedFiles: mutation.deletedFiles,
    protectedArtifacts: run.guard.list().map((artifact) => artifact.path),
    validations: validations.map((entry) => ({ name: entry.name, status: entry.status, stale: entry.stale, resultType: entry.resultType })),
    staleValidations: run.validations.stalePasses().map((entry) => entry.name).slice(-6),
    commandsRun: run.commandsRun.slice(-8),
    workerReports: run.recentReportLines(4),
    capsules: run.capsuleMetrics(),
    telemetry: run.telemetrySnapshot(),
    updatedAt: new Date().toISOString()
  };
}

export function saveWorldState(runDir: string, state: WorldState): void {
  try {
    writeRunFile(runDir, "world-state.json", JSON.stringify(state, null, 2) + "\n");
  } catch {
    // best-effort persistence
  }
}

export function loadWorldState(runDir: string): WorldState | null {
  const raw = readRunFile(runDir, "world-state.json");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorldState;
  } catch {
    return null;
  }
}

export interface WorldStateDiff {
  phaseChanged?: { from: string; to: string };
  statusChanged?: { from: RunStatus; to: RunStatus };
  filesChanged: string[];
  filesCreated: string[];
  filesDeleted: string[];
  newValidations: Array<{ name: string; status: string }>;
  newlyStale: string[];
  newlyProtected: string[];
  newCommands: string[];
  newReports: string[];
}

function added(prev: string[], next: string[]): string[] {
  const before = new Set(prev);
  return next.filter((item) => !before.has(item));
}

export function diffWorldState(prev: WorldState | null, next: WorldState): WorldStateDiff {
  if (!prev) {
    return {
      filesChanged: next.changedFiles,
      filesCreated: next.createdFiles,
      filesDeleted: next.deletedFiles,
      newValidations: next.validations.map((entry) => ({ name: entry.name, status: entry.status })),
      newlyStale: next.staleValidations,
      newlyProtected: next.protectedArtifacts,
      newCommands: next.commandsRun,
      newReports: next.workerReports
    };
  }
  return {
    phaseChanged: prev.phase.phase !== next.phase.phase ? { from: prev.phase.phase, to: next.phase.phase } : undefined,
    statusChanged: prev.status !== next.status ? { from: prev.status, to: next.status } : undefined,
    filesChanged: added(prev.changedFiles, next.changedFiles),
    filesCreated: added(prev.createdFiles, next.createdFiles),
    filesDeleted: added(prev.deletedFiles, next.deletedFiles),
    newValidations: next.validations
      .filter((entry) => !prev.validations.some((old) => old.name === entry.name && old.status === entry.status && old.stale === entry.stale))
      .map((entry) => ({ name: entry.name, status: entry.status })),
    newlyStale: added(prev.staleValidations, next.staleValidations),
    newlyProtected: added(prev.protectedArtifacts, next.protectedArtifacts),
    newCommands: added(prev.commandsRun, next.commandsRun),
    newReports: added(prev.workerReports, next.workerReports)
  };
}

/** Compact human lines for capsules. Empty array = nothing changed worth saying. */
export function renderWorldStateDiff(diff: WorldStateDiff): string[] {
  const lines: string[] = [];
  if (diff.phaseChanged) lines.push(`phase: ${diff.phaseChanged.from} -> ${diff.phaseChanged.to}`);
  if (diff.statusChanged) lines.push(`status: ${diff.statusChanged.from} -> ${diff.statusChanged.to}`);
  if (diff.filesCreated.length) lines.push(`created: ${diff.filesCreated.slice(0, 6).join(", ")}`);
  if (diff.filesChanged.length) lines.push(`changed: ${diff.filesChanged.slice(0, 6).join(", ")}`);
  if (diff.filesDeleted.length) lines.push(`deleted: ${diff.filesDeleted.slice(0, 4).join(", ")}`);
  if (diff.newValidations.length) lines.push(`validations: ${diff.newValidations.slice(-4).map((v) => `${v.name}=${v.status}`).join(", ")}`);
  if (diff.newlyStale.length) lines.push(`now STALE: ${diff.newlyStale.slice(0, 4).join(", ")}`);
  if (diff.newlyProtected.length) lines.push(`now protected: ${diff.newlyProtected.slice(0, 4).join(", ")}`);
  if (diff.newCommands.length) lines.push(`ran: ${diff.newCommands.slice(-3).join(" | ").slice(0, 200)}`);
  return lines.slice(0, 10);
}

export interface UnfinishedRun {
  taskId: string;
  goal: string;
  updatedAt: string;
  runDir: string;
}

/** Unfinished runs for this repo, most recent first - the reincarnation candidates. */
export function listUnfinishedRuns(repoRoot: string): UnfinishedRun[] {
  const unfinished: UnfinishedRun[] = [];
  for (const taskId of listRuns(repoRoot)) {
    const runDir = runDirFor(repoRoot, taskId);
    if (!existsSync(join(runDir, "world-state.json"))) continue;
    try {
      const state = JSON.parse(readFileSync(join(runDir, "world-state.json"), "utf8")) as WorldState;
      if (state.status === "running") {
        unfinished.push({ taskId, goal: state.goal ?? "", updatedAt: state.updatedAt ?? "", runDir });
      }
    } catch {
      // unreadable world state -> not a resume candidate
    }
  }
  return unfinished.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
