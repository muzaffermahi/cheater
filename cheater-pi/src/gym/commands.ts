import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectTasks } from "./cli.js";
import { createWorkspace } from "./workspace.js";
import { buildPrompt, type RunHooks } from "./runner.js";
import { runBakeoffSuite, buildBakeoffScorecard, formatBakeoffScorecard } from "./bakeoff.js";
import { readLatestReport, listLearningSuggestions, buildReport, writeReport, writeMarkdownReport, buildLearningSuggestions, writeLearningSuggestions, listReports } from "./report.js";
import { formatTaskCard, formatTaskList, formatReportSummary, formatDeltaReport, formatLearningSuggestions } from "./ui.js";
import { loadConfig } from "../config.js";
import type { CheaterConfig } from "../types.js";
import type { GymRunResult, GymTask } from "./types.js";

type ExtensionAPI = any;
type CommandContext = any;

export interface GymCommandDeps {
  config: CheaterConfig;
  getCwd: (ctx: CommandContext) => string;
  notify?: (ctx: CommandContext, text: string, level?: "info" | "warning") => void;
  widget?: (ctx: CommandContext, key: string, lines: string[]) => void;
  sendUserMessage?: (pi: ExtensionAPI, text: string) => void;
  runAgent?: (task: GymTask, workspace: string, prompt: string) => Promise<{
    focusedTestsPassed: boolean | null;
    fullTestsPassed: boolean | null;
    reproduced: boolean;
    noOpDetected: boolean;
    memoryUsed: boolean;
    evidenceUsed: boolean;
    missionStepsCompleted: number;
    notes?: string;
    commandsRun?: string[];
  }>;
}

function notifyDefault(deps: GymCommandDeps, ctx: CommandContext, text: string, level: "info" | "warning" = "info"): void {
  if (deps.notify) deps.notify(ctx, text, level);
  else ctx.ui.notify(text, level);
  if (deps.widget) deps.widget(ctx, "cheater-gym", text.split("\n").slice(0, 60));
  else ctx.ui.setWidget?.("cheater-gym", text.split("\n").slice(0, 60), { placement: "aboveEditor" });
}

export function registerGymCommands(pi: ExtensionAPI, deps: GymCommandDeps): void {
  pi.registerCommand("gym", {
    description: "Cheater Gym help and status",
    handler: async (_args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const { tasks, warnings } = collectTasks(cwd);
      const latest = readLatestReport(cwd);
      const lines = [
        "Cheater Gym",
        `tasks: ${tasks.length}${warnings.length ? ` (${warnings.length} warning(s))` : ""}`,
        latest ? `latest report: ${latest.id}  pass=${latest.summary.passed}/${latest.summary.total}  avg=${latest.summary.averageScore}` : "latest report: (none)",
        "commands: /gym-list, /gym-run <id>, /gym-run-suite [filter], /gym-report, /gym-delta <id>, /gym-learn, /gym-clean"
      ];
      notifyDefault(deps, ctx, lines.join("\n"));
    }
  });

  pi.registerCommand("gym-list", {
    description: "List Cheater Gym tasks",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const { tasks } = collectTasks(cwd);
      const filter = parseFilter(args);
      const filtered = applyFilter(tasks, filter);
      notifyDefault(deps, ctx, formatTaskList(filtered) + `\nshowing ${filtered.length} of ${tasks.length}`);
    }
  });

  pi.registerCommand("gym-run", {
    description: "Prepare a Cheater Gym task workspace and prompt",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        notifyDefault(deps, ctx, "usage: /gym-run <task_id>", "warning");
        return;
      }
      const { tasks } = collectTasks(cwd);
      const task = tasks.find((t) => t.id === id);
      if (!task) {
        notifyDefault(deps, ctx, `task not found: ${id}`, "warning");
        return;
      }
      try {
        const workspace = createWorkspace(task, { rootDir: cwd, keep: deps.config.gymKeepWorkspaces });
        const prompt = buildPrompt(task, workspace.path, "cheater");
        notifyDefault(deps, ctx, `Cheater Gym: prepared ${task.id} at ${workspace.path}`);
        if (deps.sendUserMessage) {
          deps.sendUserMessage(pi, prompt + `\n\n(workspace: ${workspace.path})`);
        } else {
          ctx.ui.setWidget?.("cheater-gym", formatTaskCard(task).split("\n").slice(0, 30), { placement: "aboveEditor" });
        }
      } catch (e) {
        notifyDefault(deps, ctx, `failed: ${(e as Error).message}`, "warning");
      }
    }
  });

  pi.registerCommand("gym-run-suite", {
    description: "Run a suite of Cheater Gym tasks",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const { tasks } = collectTasks(cwd);
      const filter = parseFilter(args);
      const filtered = applyFilter(tasks, filter).slice(0, filter.limit ?? deps.config.gymDefaultLimit);
      if (filtered.length === 0) {
        notifyDefault(deps, ctx, "no tasks matched the suite filter", "warning");
        return;
      }
      if (!deps.runAgent) {
        notifyDefault(deps, ctx, "Gym runner hook not available; use /gym-run to prepare a workspace manually.", "warning");
        return;
      }
      const results: Array<{ task: GymTask; workspace: string; result: GymRunResult; score: ReturnType<typeof import("./scorer.js").scoreRun> }> = [];
      for (const task of filtered) {
        const ws = createWorkspace(task, { rootDir: cwd, keep: deps.config.gymKeepWorkspaces });
        const outcome = await deps.runAgent(task, ws.path, buildPrompt(task, ws.path, "cheater"));
        const { diffWorkspace } = await import("./diff.js");
        const baseline = join(ws.path, "..", `${task.id}-baseline-${Date.now().toString(36)}`);
        const { snapshotWorkspaceTo } = await import("./runner.js");
        await snapshotWorkspaceTo(ws.path, baseline);
        const diff = diffWorkspace(baseline, ws.path, task);
        const result: GymRunResult = {
          taskId: task.id,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          mode: "cheater",
          focusedTestsPassed: outcome.focusedTestsPassed,
          fullTestsPassed: outcome.fullTestsPassed,
          filesTouched: diff.filesTouched,
          diffLineCount: diff.diffLineCount,
          commandsRun: outcome.commandsRun ?? [],
          editedTests: diff.editedTests,
          editedDependencies: diff.editedDependencies,
          touchedExpectedFile: diff.touchedExpected.length > 0,
          editedForbiddenFile: diff.editedForbidden.length > 0,
          reproduced: outcome.reproduced,
          noOpDetected: outcome.noOpDetected,
          memoryUsed: outcome.memoryUsed,
          evidenceUsed: outcome.evidenceUsed,
          missionStepsCompleted: outcome.missionStepsCompleted,
          notes: outcome.notes ?? ""
        };
        const { scoreRun } = await import("./scorer.js");
        const score = scoreRun({ task, result });
        results.push({ task, workspace: ws.path, result, score });
      }
      const id = `gym-${Date.now()}`;
      const startedAt = results[0]?.result.startedAt ?? new Date().toISOString();
      const finishedAt = new Date().toISOString();
      const report = buildReport({
        id,
        startedAt,
        finishedAt,
        suite: "cheater",
        results: results.map((r) => ({ ...r.result, task: r.task, score: r.score })),
        vanillaAvailable: false
      });
      writeReport(cwd, report);
      writeMarkdownReport(cwd, report);
      const enrichedResults = results.map((r) => ({ ...r.result, task: r.task, score: r.score }));
      const suggestions = buildLearningSuggestions(enrichedResults);
      if (suggestions.length > 0) writeLearningSuggestions(cwd, suggestions);
      notifyDefault(deps, ctx, formatReportSummary(report));
    }
  });

  pi.registerCommand("bakeoff", {
    description: "Kitten Code bakeoff: run the local battery vanilla-vs-kitten and print a scorecard",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const { tasks } = collectTasks(cwd);
      const filter = parseFilter(args);
      const suite = applyFilter(tasks, filter).slice(0, filter.limit ?? deps.config.gymDefaultLimit);
      if (suite.length === 0) {
        notifyDefault(deps, ctx, "no tasks matched the bakeoff filter", "warning");
        return;
      }
      if (!deps.runAgent) {
        notifyDefault(deps, ctx, "Bakeoff needs the agent runner hook; run /bakeoff from an interactive Kitten Code session. For a true vanilla baseline (separate agent), use the harness-bakeoff/ scripts.", "warning");
        return;
      }
      // Both sides run through the session's agent runner, differing only in the PROMPT (plain-fix vs
      // the reliability flow). This is an in-session approximation - a true vanilla baseline needs a
      // separate un-harnessed agent (harness-bakeoff/) - so the scorecard says so.
      const hooksFor = (mode: "vanilla" | "cheater"): RunHooks => ({
        runAgent: async (task, ws, _prompt) => deps.runAgent!(task, ws, buildPrompt(task, ws, mode)),
        snapshotBaseline: async () => { /* runTask copies the pre-agent workspace as the baseline */ }
      });
      notifyDefault(deps, ctx, `Kitten Code bakeoff: running ${suite.length} task(s) vanilla-vs-kitten...`);
      const pairs = await runBakeoffSuite({
        rootDir: cwd,
        tasks: suite,
        vanillaHooks: hooksFor("vanilla"),
        kittenHooks: hooksFor("cheater"),
        keepWorkspaces: deps.config.gymKeepWorkspaces
      });
      const card = buildBakeoffScorecard(pairs, deps.config.model ?? null);
      notifyDefault(deps, ctx, formatBakeoffScorecard(card) + "\n\n(in-session approximation: both sides use the same harnessed session, differing only in prompt strategy; for a true vanilla baseline run harness-bakeoff/)");
    }
  });

  pi.registerCommand("gym-report", {
    description: "Show the latest Cheater Gym report",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const arg = args.trim();
      let report;
      if (arg === "list") {
        const ids = listReports(cwd).map((name) => name.replace(/\.json$/, ""));
        notifyDefault(deps, ctx, ids.length === 0 ? "no reports" : `reports: ${ids.join(", ")}`);
        return;
      }
      if (!arg || arg === "latest") report = readLatestReport(cwd);
      else {
        const { readReport } = await import("./report.js");
        report = readReport(cwd, arg);
      }
      if (!report) {
        notifyDefault(deps, ctx, "no report found", "warning");
        return;
      }
      notifyDefault(deps, ctx, formatReportSummary(report));
    }
  });

  pi.registerCommand("gym-delta", {
    description: "Show Cheater vs vanilla delta for a task",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const id = args.trim();
      if (!id) {
        notifyDefault(deps, ctx, "usage: /gym-delta <task_id>", "warning");
        return;
      }
      const { buildDeltaReport, writeDeltaReport } = await import("./report.js");
      const report = buildDeltaReport({ taskId: id, model: deps.config.model ?? null, vanilla: null, cheater: null });
      writeDeltaReport(cwd, report);
      notifyDefault(deps, ctx, formatDeltaReport(report));
    }
  });

  pi.registerCommand("gym-learn", {
    description: "Show Cheater Gym learning suggestions",
    handler: async (_args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const suggestions = listLearningSuggestions(cwd);
      notifyDefault(deps, ctx, formatLearningSuggestions(suggestions));
    }
  });

  pi.registerCommand("gym-clean", {
    description: "Remove Cheater Gym workspaces and reports",
    handler: async (_args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const targets = [".cheater/gym/runs", ".cheater/gym/reports", ".cheater/gym/traces", ".cheater/gym/learn"];
      for (const t of targets) {
        const full = join(cwd, t);
        if (existsSync(full)) {
          const { rmSync } = await import("node:fs");
          rmSync(full, { recursive: true, force: true });
        }
      }
      notifyDefault(deps, ctx, "Cheater Gym: cleared workspaces and reports");
    }
  });
}

export interface GymFilter {
  category?: string;
  language?: string;
  limit?: number;
  ids?: string[];
}

function parseFilter(args: string): GymFilter {
  const filter: GymFilter = {};
  const parts = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--category" && parts[i + 1]) { filter.category = parts[++i]; continue; }
    if (part === "--language" && parts[i + 1]) { filter.language = parts[++i]; continue; }
    if (part === "--limit" && parts[i + 1]) { filter.limit = Number(parts[++i]); continue; }
    if (part === "--ids" && parts[i + 1]) { filter.ids = parts[++i].split(","); continue; }
  }
  return filter;
}

function applyFilter(tasks: GymTask[], filter: GymFilter): GymTask[] {
  let out = tasks.slice();
  if (filter.category) out = out.filter((t) => t.category === filter.category);
  if (filter.language) out = out.filter((t) => t.language === filter.language);
  if (filter.ids && filter.ids.length > 0) out = out.filter((t) => filter.ids!.includes(t.id));
  if (typeof filter.limit === "number" && filter.limit > 0) out = out.slice(0, filter.limit);
  return out;
}

export function defaultGymDeps(): GymCommandDeps {
  return {
    config: loadConfig(),
    getCwd: (ctx) => ctx.cwd
  };
}
