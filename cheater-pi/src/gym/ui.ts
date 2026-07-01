import type { GymReport, GymDeltaReport, GymLearningSuggestion, GymTask } from "./types.js";

export function formatTaskList(tasks: GymTask[]): string {
  if (tasks.length === 0) return "No gym tasks available.";
  const lines = [`Cheater Gym - ${tasks.length} task(s)`];
  for (const task of tasks) {
    lines.push(`- ${task.id}  [${task.language}/${task.category}/${task.difficulty}]  ${task.title}`);
  }
  return lines.join("\n");
}

export function formatTaskCard(task: GymTask): string {
  return [
    `Cheater Gym task: ${task.id}`,
    `title: ${task.title}`,
    `language: ${task.language}    category: ${task.category}    difficulty: ${task.difficulty}`,
    `goal: ${task.goal}`,
    `focused: ${task.focusedTestCommand}`,
    task.fullTestCommand ? `full: ${task.fullTestCommand}` : "",
    `expected: ${task.expectedTouchedFiles.join(", ") || "(none)"}`,
    `forbidden: ${task.forbiddenTouchedFiles.join(", ") || "(none)"}`,
    `mode: ${task.runMode}`,
    `tags: ${task.tags.join(", ")}`
  ].filter(Boolean).join("\n");
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

export function formatDeltaReport(report: GymDeltaReport): string {
  const lines: string[] = [];
  lines.push(`Cheater Gym delta: ${report.taskId}`);
  lines.push(`model: ${report.model ?? "(unknown)"}`);
  lines.push(`vanilla available: ${report.improvement.vanillaAvailable}`);
  if (report.vanilla) {
    lines.push(`vanilla:  score=${report.vanilla.score.score} pass=${report.vanilla.score.pass} diff=${report.vanilla.diffLineCount} tools=${report.vanilla.commandsRun.length}`);
  } else {
    lines.push("vanilla:  (no run recorded)");
  }
  if (report.cheater) {
    lines.push(`cheater:  score=${report.cheater.score.score} pass=${report.cheater.score.pass} diff=${report.cheater.diffLineCount} tools=${report.cheater.commandsRun.length}`);
  } else {
    lines.push("cheater:  (no run recorded)");
  }
  lines.push(`improvement: scoreDelta=${report.improvement.scoreDelta} passImproved=${report.improvement.passImproved}`);
  return lines.join("\n");
}

export function formatLearningSuggestions(suggestions: GymLearningSuggestion[]): string {
  if (suggestions.length === 0) return "No learning suggestions.";
  const lines = [`Cheater Gym learning - ${suggestions.length} suggestion(s)`];
  for (const s of suggestions) {
    lines.push(`- [${s.kind}] ${s.summary}  (${s.taskId})`);
    lines.push(`    reason: ${s.reason}`);
  }
  return lines.join("\n");
}
