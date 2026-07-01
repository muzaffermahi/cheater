import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGymTasks } from "./taskLoader.js";
import { ZOO_TASKS } from "./zoo.js";
import { createWorkspace } from "./workspace.js";
import { buildPrompt } from "./runner.js";
import { readLatestReport, listReports, readReport, formatReportSummary, listLearningSuggestions } from "./report.js";
import { formatTaskCard, formatTaskList } from "./ui.js";
import type { GymTask } from "./types.js";

export interface GymCliOptions {
  cwd: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function out(options: GymCliOptions, text: string): void {
  if (options.stdout) options.stdout(text);
  else console.log(text);
}

function err(options: GymCliOptions, text: string): void {
  if (options.stderr) options.stderr(text);
  else console.error(text);
}

export function collectTasks(cwd: string): { tasks: GymTask[]; warnings: string[] } {
  const tasks: GymTask[] = [...ZOO_TASKS];
  const warnings: string[] = [];
  const { tasks: fromDisk, errors } = loadGymTasks({ rootDir: cwd, includeGenerated: true });
  for (const e of errors) warnings.push(`task error: ${e.taskId} - ${e.reason}`);
  for (const task of fromDisk) {
    if (tasks.some((t) => t.id === task.id)) continue;
    tasks.push(task);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, warnings };
}

export function runGymCli(argv: string[], options: GymCliOptions): number {
  const sub = argv[0] ?? "help";
  switch (sub) {
    case "list":
      return gymList(options);
    case "show":
      return gymShow(argv.slice(1), options);
    case "run":
      return gymRun(argv.slice(1), options);
    case "report":
      return gymReport(argv.slice(1), options);
    case "clean":
      return gymClean(options);
    case "learn":
      return gymLearn(options);
    case "help":
    case "--help":
    case "-h":
      return gymHelp(options);
    default:
      err(options, `cheater gym: unknown subcommand '${sub}'`);
      gymHelp(options);
      return 2;
  }
}

function gymHelp(options: GymCliOptions): number {
  out(options, [
    "Cheater Gym",
    "",
    "Subcommands:",
    "  cheater gym list                 list available tasks",
    "  cheater gym show <id>            show one task",
    "  cheater gym run <id>             create a workspace and print the prompt",
    "  cheater gym report [latest|<id>] show a report (default: latest)",
    "  cheater gym clean                remove workspaces and reports",
    "  cheater gym learn                show pending learning suggestions",
    "  cheater gym help                 this help",
    "",
    "Real Cheater runs happen inside `cheater` via /gym-run <id>."
  ].join("\n"));
  return 0;
}

function gymList(options: GymCliOptions): number {
  const { tasks, warnings } = collectTasks(options.cwd);
  if (warnings.length > 0) {
    for (const w of warnings) err(options, w);
  }
  out(options, formatTaskList(tasks));
  out(options, `total: ${tasks.length}`);
  return 0;
}

function gymShow(args: string[], options: GymCliOptions): number {
  const id = args[0];
  if (!id) {
    err(options, "usage: cheater gym show <task_id>");
    return 2;
  }
  const { tasks } = collectTasks(options.cwd);
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    err(options, `task not found: ${id}`);
    return 1;
  }
  out(options, formatTaskCard(task));
  return 0;
}

function gymRun(args: string[], options: GymCliOptions): number {
  const id = args[0];
  if (!id) {
    err(options, "usage: cheater gym run <task_id>");
    return 2;
  }
  const { tasks } = collectTasks(options.cwd);
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    err(options, `task not found: ${id}`);
    return 1;
  }
  try {
    const workspace = createWorkspace(task, { rootDir: options.cwd, keep: true });
    const prompt = buildPrompt(task, workspace.path, "cheater");
    const promptFile = join(workspace.path, ".cheater-gym-prompt.txt");
    writeFileSync(promptFile, prompt, "utf8");
    out(options, [
      `Cheater Gym task ready: ${task.id}`,
      `workspace: ${workspace.path}`,
      `prompt file: ${promptFile}`,
      "",
      "--- prompt ---",
      prompt,
      "--- end prompt ---",
      "",
      "Open Cheater in this workspace to run the task via /gym-run,",
      "or run the focused test directly to verify the bug."
    ].join("\n"));
    return 0;
  } catch (e) {
    err(options, `failed to create workspace: ${(e as Error).message}`);
    return 1;
  }
}

function gymReport(args: string[], options: GymCliOptions): number {
  const arg = args[0];
  if (arg === "list") {
    const ids = listReports(options.cwd).map((name) => name.replace(/\.json$/, ""));
    out(options, ids.length === 0 ? "no reports" : `reports: ${ids.join(", ")}`);
    return 0;
  }
  let report;
  if (!arg || arg === "latest") {
    report = readLatestReport(options.cwd);
  } else {
    report = readReport(options.cwd, arg);
  }
  if (!report) {
    err(options, "no report found");
    return 1;
  }
  out(options, formatReportSummary(report));
  return 0;
}

function gymClean(options: GymCliOptions): number {
  const targets = [
    join(options.cwd, ".cheater", "gym", "runs"),
    join(options.cwd, ".cheater", "gym", "reports"),
    join(options.cwd, ".cheater", "gym", "traces"),
    join(options.cwd, ".cheater", "gym", "learn")
  ];
  for (const target of targets) {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      out(options, `removed ${target}`);
    }
  }
  return 0;
}

function gymLearn(options: GymCliOptions): number {
  const suggestions = listLearningSuggestions(options.cwd);
  if (suggestions.length === 0) {
    out(options, "No learning suggestions recorded yet. Run a suite first, then check again.");
    return 0;
  }
  for (const s of suggestions) {
    out(options, `[${s.kind}] ${s.taskId} - ${s.summary}`);
  }
  return 0;
}

export function readGymDir(cwd: string, sub: string): string {
  const dir = join(cwd, ".cheater", "gym", sub);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
