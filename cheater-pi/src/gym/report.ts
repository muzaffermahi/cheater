import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GymConfig, GymDeltaReport, GymLearningSuggestion, GymReport, GymRunResult, GymScored, GymTask } from "./types.js";
import type { BugMemoryCard } from "../bug-memory.js";

export interface BuildReportInput {
  id: string;
  startedAt: string;
  finishedAt: string;
  suite: string;
  results: Array<GymRunResult & { score: GymScored; task: GymTask }>;
  vanillaAvailable: boolean;
}

export function buildReport(input: BuildReportInput): GymReport {
  const total = input.results.length;
  const passed = input.results.filter((r) => r.score.pass).length;
  const failed = total - passed;
  const averageScore = total === 0 ? 0 : Number((input.results.reduce((s, r) => s + r.score.score, 0) / total).toFixed(2));
  const averageDiff = total === 0 ? 0 : Number((input.results.reduce((s, r) => s + r.score.diffLineCount, 0) / total).toFixed(2));
  return {
    id: input.id,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    suite: input.suite,
    results: input.results.map(({ task: _task, ...rest }) => ({ ...rest, score: rest.score })),
    summary: { total, passed, failed, averageScore, averageDiff },
    vanillaAvailable: input.vanillaAvailable
  };
}

export function writeReport(cwd: string, report: GymReport): string {
  const dir = join(cwd, ".cheater", "gym", "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.id}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

export function writeMarkdownReport(cwd: string, report: GymReport): string {
  const dir = join(cwd, ".cheater", "gym", "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.id}.md`);
  const lines: string[] = [];
  lines.push(`# Cheater Gym report ${report.id}`);
  lines.push("");
  lines.push(`- suite: \`${report.suite}\``);
  lines.push(`- started: ${report.startedAt}`);
  lines.push(`- finished: ${report.finishedAt}`);
  lines.push(`- vanilla mode available: ${report.vanillaAvailable}`);
  lines.push(`- total: ${report.summary.total}`);
  lines.push(`- passed: ${report.summary.passed}`);
  lines.push(`- failed: ${report.summary.failed}`);
  lines.push(`- average score: ${report.summary.averageScore}`);
  lines.push(`- average diff lines: ${report.summary.averageDiff}`);
  lines.push("");
  lines.push("| task | mode | score | pass | focused | full | diff | tests edited | deps edited | files |");
  lines.push("|------|------|-------|------|---------|------|------|--------------|-------------|-------|");
  for (const r of report.results) {
    lines.push(`| ${r.taskId} | ${r.mode} | ${r.score.score} | ${r.score.pass ? "yes" : "no"} | ${triState(r.focusedTestsPassed)} | ${triState(r.fullTestsPassed)} | ${r.diffLineCount} | ${r.editedTests ? "yes" : "no"} | ${r.editedDependencies ? "yes" : "no"} | ${r.filesTouched.length} |`);
  }
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function triState(value: boolean | null): string {
  if (value === true) return "ok";
  if (value === false) return "FAIL";
  return "n/a";
}

export function listReports(cwd: string): string[] {
  const dir = join(cwd, ".cheater", "gym", "reports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}

export function formatReportSummary(report: GymReport): string {
  const lines: string[] = [];
  lines.push(`Cheater Gym report ${report.id}`);
  lines.push(`suite: ${report.suite}`);
  lines.push(`total: ${report.summary.total}    passed: ${report.summary.passed}    failed: ${report.summary.failed}`);
  lines.push(`avg score: ${report.summary.averageScore}    avg diff: ${report.summary.averageDiff}`);
  for (const r of report.results) {
    lines.push(`- ${r.taskId} [${r.mode}] score=${r.score.score} pass=${r.score.pass} diff=${r.diffLineCount} tests=${r.editedTests} deps=${r.editedDependencies}`);
  }
  return lines.join("\n");
}

export function readReport(cwd: string, id: string): GymReport | undefined {
  const dir = join(cwd, ".cheater", "gym", "reports");
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as GymReport;
  } catch {
    return undefined;
  }
}

export function readLatestReport(cwd: string): GymReport | undefined {
  const ids = listReports(cwd).map((name) => name.replace(/\.json$/, "")).sort();
  if (ids.length === 0) return undefined;
  return readReport(cwd, ids[ids.length - 1]);
}

export function buildDeltaReport(input: { taskId: string; model: string | null; vanilla: (GymRunResult & { score: GymScored }) | null; cheater: (GymRunResult & { score: GymScored }) | null }): GymDeltaReport {
  const vanillaAvailable = input.vanilla !== null;
  const scoreDelta = (input.cheater?.score.score ?? 0) - (input.vanilla?.score.score ?? 0);
  const toolCallsDelta = (input.cheater?.commandsRun.length ?? 0) - (input.vanilla?.commandsRun.length ?? 0);
  const diffLinesDelta = (input.cheater?.diffLineCount ?? 0) - (input.vanilla?.diffLineCount ?? 0);
  const passImproved = (input.cheater?.score.pass ?? false) && !(input.vanilla?.score.pass ?? false);
  return {
    taskId: input.taskId,
    model: input.model,
    vanilla: input.vanilla,
    cheater: input.cheater,
    improvement: {
      scoreDelta,
      toolCallsDelta,
      diffLinesDelta,
      passImproved,
      vanillaAvailable
    }
  };
}

export function writeDeltaReport(cwd: string, report: GymDeltaReport): string {
  const dir = join(cwd, ".cheater", "gym", "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `delta-${report.taskId}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

export function buildLearningSuggestions(results: Array<GymRunResult & { score: GymScored; task: GymTask }>): GymLearningSuggestion[] {
  const suggestions: GymLearningSuggestion[] = [];
  const byCategory = new Map<string, Array<GymRunResult & { score: GymScored; task: GymTask }>>();
  for (const r of results) {
    const list = byCategory.get(r.task.category) ?? [];
    list.push(r);
    byCategory.set(r.task.category, list);
  }

  for (const r of results) {
    if (r.score.pass && r.score.score >= 80) {
      suggestions.push({
        kind: "bug_memory",
        taskId: r.taskId,
        summary: `${r.task.category}: ${r.task.title}`,
        details: [
          `symptom: ${r.task.goal}`,
          `root_cause: minimal source change in ${r.task.expectedTouchedFiles.join(", ") || "target source"}`,
          `fix_pattern: ${r.task.expectedTouchedFiles.length > 0 ? `edit ${r.task.expectedTouchedFiles[0]}` : "edit the target source"}`,
          `validation: ${r.task.focusedTestCommand}`
        ].join("\n"),
        reason: "task passed with high score; pattern is reusable"
      });
    } else if (!r.score.pass) {
      suggestions.push({
        kind: "anti_pattern",
        taskId: r.taskId,
        summary: `Failed ${r.task.category}: ${r.task.title}`,
        details: [
          `edited tests: ${r.editedTests}`,
          `edited deps: ${r.editedDependencies}`,
          `reproduced: ${r.reproduced}`,
          `diff lines: ${r.diffLineCount}`,
          `notes: ${r.notes || "(none)"}`
        ].join("\n"),
        reason: "task failed; pattern is anti-helpful"
      });
    }
  }

  for (const [category, list] of byCategory.entries()) {
    if (list.length < 2) continue;
    const failed = list.filter((r) => !r.score.pass);
    if (failed.length >= 2 && failed.length === list.length) {
      suggestions.push({
        kind: "skill_improvement",
        taskId: failed.map((r) => r.taskId).join(","),
        summary: `Repeated ${category} failures`,
        details: `${failed.length}/${list.length} ${category} tasks failed. Consider tightening the ${category} playbook.`,
        reason: "recurring failure category"
      });
    }
  }

  return suggestions;
}

export interface GymBugMemoryCard extends BugMemoryCard {
  source_gym_task_id: string;
  created_at: string;
  workflow_steps: string[];
  do_not_do: string[];
}

export function buildGymBugMemoryCards(results: Array<GymRunResult & { score: GymScored; task: GymTask }>): GymBugMemoryCard[] {
  return results
    .filter((r) => r.score.pass && r.score.score >= 80 && !r.editedTests && !r.editedDependencies)
    .map((r) => {
      const touched = r.task.expectedTouchedFiles.length ? r.task.expectedTouchedFiles : r.filesTouched;
      const primaryFile = touched[0] ?? "target source";
      const workflowSteps = [
        `Reproduce with: ${r.task.focusedTestCommand}`,
        `Inspect: ${touched.join(", ") || primaryFile}`,
        "Do not edit tests, manifests, dependencies, or lockfiles to make the score pass.",
        `Apply fix pattern: edit ${primaryFile} only unless local evidence proves another source file is required.`,
        `Verify with: ${r.task.focusedTestCommand}`,
        r.task.fullTestCommand ? `Then run broad check: ${r.task.fullTestCommand}` : ""
      ].filter(Boolean);
      const doNotDo = [
        "do not edit tests to satisfy the gym task",
        "do not change dependencies or lockfiles for a source bug",
        "do not broaden the diff beyond the expected source file without evidence"
      ];
      const symptom = r.task.goal;
      const rootCause = `Minimal source defect in ${primaryFile} for ${r.task.category}.`;
      const fixPattern = `Edit ${primaryFile}; keep the diff small; rerun ${r.task.focusedTestCommand}.`;
      const testSignal = [r.task.focusedTestCommand, r.task.fullTestCommand].filter(Boolean).join(" | ");
      return {
        id: `gym-${r.task.id}`,
        source_gym_task_id: r.task.id,
        created_at: new Date().toISOString(),
        repo: "cheater-gym",
        language: r.task.language,
        bug_type: r.task.category,
        symptom,
        root_cause: rootCause,
        fix_pattern: fixPattern,
        failed_approaches: doNotDo,
        key_files: touched.slice(0, 8),
        search_keywords: unique([
          r.task.category,
          r.task.language,
          ...tokenish(r.task.title),
          ...tokenish(r.task.goal),
          ...touched.flatMap(tokenish)
        ]).slice(0, 18),
        test_signal: testSignal,
        embedding_text: [
          r.task.category,
          r.task.title,
          symptom,
          rootCause,
          fixPattern,
          testSignal,
          workflowSteps.join(" ")
        ].filter(Boolean).join("\n"),
        quality_score: Number((r.score.score / 100).toFixed(2)),
        quality_tier: r.score.score >= 90 ? "high" : "medium",
        workflow_steps: workflowSteps,
        do_not_do: doNotDo
      };
    });
}

export function writeGymBugMemoryCards(cwd: string, cards: GymBugMemoryCard[]): string | null {
  if (cards.length === 0) return null;
  const file = join(cwd, ".cheater", "bug_memories.jsonl");
  mkdirSync(join(cwd, ".cheater"), { recursive: true });
  for (const card of cards) {
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...card })}\n`, { flag: "a", encoding: "utf8" });
  }
  return file;
}

export function writeLearningSuggestions(cwd: string, suggestions: GymLearningSuggestion[]): string {
  const dir = join(cwd, ".cheater", "gym", "learn");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `suggestions-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(suggestions, null, 2), "utf8");
  return file;
}

export function listLearningSuggestions(cwd: string): GymLearningSuggestion[] {
  const dir = join(cwd, ".cheater", "gym", "learn");
  if (!existsSync(dir)) return [];
  const out: GymLearningSuggestion[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as GymLearningSuggestion[];
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      // ignore
    }
  }
  return out;
}

function tokenish(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function formatReportMarkdown(report: GymReport): string {
  const lines: string[] = [];
  lines.push(`Cheater Gym report ${report.id}`);
  lines.push(`suite: ${report.suite}`);
  lines.push(`vanilla available: ${report.vanillaAvailable}`);
  lines.push(`total: ${report.summary.total}`);
  lines.push(`passed: ${report.summary.passed}`);
  lines.push(`average score: ${report.summary.averageScore}`);
  lines.push(`average diff: ${report.summary.averageDiff}`);
  for (const r of report.results) {
    lines.push(`- ${r.taskId} [${r.mode}] score=${r.score.score} pass=${r.score.pass} diff=${r.diffLineCount} tests=${r.editedTests} deps=${r.editedDependencies}`);
  }
  return lines.join("\n");
}

export function applyGymConfigDefaults(overrides: Partial<GymConfig> | undefined): GymConfig {
  return { ...defaultGymConfig(), ...(overrides ?? {}) };
}

export function defaultGymConfig(): GymConfig {
  return {
    enabled: true,
    defaultLimit: 5,
    defaultConcurrency: 1,
    tempDir: ".cheater/gym/runs",
    keepWorkspaces: false,
    runFullTests: "if_cheap",
    autoLearn: false,
    deltaModeEnabled: false
  };
}
