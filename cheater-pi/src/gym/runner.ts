import { mkdirSync, existsSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import type { CheaterConfig } from "../types.js";
import type { GymRunResult, GymTask } from "./types.js";
import { createWorkspace, type WorkspaceResult } from "./workspace.js";
import { diffWorkspace } from "./diff.js";

export interface RunHooks {
  /**
   * Run the agent against a workspace. The real implementation sends a prompt
   * to the active Cheater session and waits for completion; the test
   * implementation returns a deterministic result.
   */
  runAgent(task: GymTask, workspace: string, prompt: string): Promise<RunHookOutcome>;
  /** Snapshot the workspace before the agent runs. */
  snapshotBaseline(workspace: string): Promise<void>;
  /** Return commands the agent actually ran. Optional, defaults to []. */
  collectCommands?(workspace: string): Promise<string[]>;
  /** Return a string describing what happened. */
  summarize?(workspace: string): Promise<string>;
}

export interface RunHookOutcome {
  focusedTestsPassed: boolean | null;
  fullTestsPassed: boolean | null;
  reproduced: boolean;
  noOpDetected: boolean;
  memoryUsed: boolean;
  evidenceUsed: boolean;
  missionStepsCompleted: number;
  notes?: string;
  commandsRun?: string[];
}

export interface RunOptions {
  rootDir: string;
  task: GymTask;
  mode: "cheater" | "vanilla";
  hooks: RunHooks;
  keepWorkspaces?: boolean;
  runFullTests?: "never" | "if_cheap" | "always";
  /** Inline mode overrides for tests: pre-defined outcome. */
  outcomeOverride?: RunHookOutcome;
  startedAt?: string;
}

export interface RunReport {
  result: GymRunResult;
  workspace: WorkspaceResult;
  diff: ReturnType<typeof diffWorkspace>;
}

export function buildPrompt(task: GymTask, workspace: string, mode: "cheater" | "vanilla"): string {
  if (mode === "vanilla") {
    return [
      `Cheater Gym task ${task.id} (vanilla mode)`,
      `Title: ${task.title}`,
      `Goal: ${task.goal}`,
      `Workspace: ${workspace}`,
      `Focused test command: ${task.focusedTestCommand}`,
      task.fullTestCommand ? `Full test command: ${task.fullTestCommand}` : "",
      `Expected files to edit: ${task.expectedTouchedFiles.join(", ") || "(none)"}`,
      `Forbidden files: ${task.forbiddenTouchedFiles.join(", ") || "(none)"}`,
      "Read the workspace, fix the smallest source bug, and stop. Do not edit tests."
    ].filter(Boolean).join("\n");
  }
  return [
    `Cheater Reliability task ${task.id} - ${task.title}`,
    `Category: ${task.category}    Language: ${task.language}    Difficulty: ${task.difficulty}`,
    `Goal: ${task.goal}`,
    `Workspace: ${workspace}`,
    `Focused test command: ${task.focusedTestCommand}`,
    task.fullTestCommand ? `Full test command: ${task.fullTestCommand}` : "",
    `Expected files: ${task.expectedTouchedFiles.join(", ") || "(none)"}`,
    `Forbidden files: ${task.forbiddenTouchedFiles.join(", ") || "(none)"}`,
    "Run the one flow: cheater_reliability_start -> edit the allowed files -> cheater_commitlet_next -> cheater_verification_run -> cheater_finish_gate.",
    "Do not edit tests. Do not edit dependencies or lockfiles. Make the smallest change."
  ].filter(Boolean).join("\n");
}

export async function runTask(options: RunOptions): Promise<RunReport> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const workspace = createWorkspace(options.task, {
    rootDir: options.rootDir,
    keep: options.keepWorkspaces
  });
  const baselineDir = join(workspace.path, "..", `${options.task.id}-baseline-${Date.now().toString(36)}`);
  mkdirSync(baselineDir, { recursive: true });
  await options.hooks.snapshotBaseline(workspace.path);
  await snapshotWorkspaceTo(workspace.path, baselineDir);

  const prompt = buildPrompt(options.task, workspace.path, options.mode);
  const outcome = options.outcomeOverride ?? await options.hooks.runAgent(options.task, workspace.path, prompt);
  const commandsRun = options.outcomeOverride?.commandsRun
    ?? (options.hooks.collectCommands ? await options.hooks.collectCommands(workspace.path) : []);
  const notes = options.outcomeOverride?.notes
    ?? (options.hooks.summarize ? await options.hooks.summarize(workspace.path) : "");
  const diff = diffWorkspace(baselineDir, workspace.path, options.task);
  const finishedAt = new Date().toISOString();

  const result: GymRunResult = {
    taskId: options.task.id,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    mode: options.mode,
    focusedTestsPassed: outcome.focusedTestsPassed,
    fullTestsPassed: outcome.fullTestsPassed,
    filesTouched: diff.filesTouched,
    diffLineCount: diff.diffLineCount,
    commandsRun,
    editedTests: diff.editedTests,
    editedDependencies: diff.editedDependencies,
    touchedExpectedFile: diff.touchedExpected.length > 0,
    editedForbiddenFile: diff.editedForbidden.length > 0,
    reproduced: outcome.reproduced,
    noOpDetected: outcome.noOpDetected,
    memoryUsed: outcome.memoryUsed,
    evidenceUsed: outcome.evidenceUsed,
    missionStepsCompleted: outcome.missionStepsCompleted,
    notes
  };

  return { result, workspace, diff };
}

export async function snapshotWorkspaceTo(workspace: string, target: string): Promise<void> {
  if (!existsSync(workspace)) return;
  cpSync(workspace, target, { recursive: true, filter: (src: string) => !src.includes(`${workspace}/.cheater-gym-baseline`) });
}

export interface GymRunConfigSlice {
  keepWorkspaces?: boolean;
  runFullTests?: "never" | "if_cheap" | "always";
  defaultConcurrency?: number;
  tempDir?: string;
}

export function applyConfigToRunOptions(config: CheaterConfig, mode: "cheater" | "vanilla"): GymRunConfigSlice {
  return {
    keepWorkspaces: config.gymKeepWorkspaces,
    runFullTests: config.gymRunFullTests,
    defaultConcurrency: config.gymDefaultConcurrency,
    tempDir: config.gymTempDir
  };
}

export function recordRunTrace(cwd: string, task: GymTask, mode: "cheater" | "vanilla", result: GymRunResult): string {
  const dir = join(cwd, ".cheater", "gym", "traces");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${task.id}-${mode}-${result.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ task: { id: task.id, title: task.title, category: task.category }, result }, null, 2), "utf8");
  return file;
}
