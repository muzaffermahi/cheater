import type { GymRunResult, GymScored, GymTask } from "./types.js";

export interface ScoreOptions {
  task: GymTask;
  result: GymRunResult;
  /**
   * Override of "is the diff huge". Defaults to > 80 lines for easy tasks,
   * > 160 for hard tasks.
   */
  hugeDiffLines?: number;
}

const DEFAULT_HUGE_DIFF_EASY = 80;
const DEFAULT_HUGE_DIFF_HARD = 160;

const REPRO_REQUIRED_CATEGORIES = new Set([
  "import_error", "syntax_error", "off_by_one", "wrong_exception",
  "fixture_scope", "async_misuse", "path_handling", "json_serialization",
  "cli_parsing", "config_parsing", "duplicate_filter", "ranking_sorting",
  "cache_invalidation", "regex_edge", "datetime_parsing", "type_conversion",
  "package_export", "test_state_leak", "wrong_export", "promise_not_awaited",
  "path_normalization", "json_parsing", "tsc_failure", "other"
]);

export function scoreRun(options: ScoreOptions): GymScored {
  const { task, result } = options;
  const breakdown: Array<{ label: string; delta: number }> = [];
  let score = 0;

  if (result.focusedTestsPassed === true) {
    score += 50;
    breakdown.push({ label: "focused tests pass", delta: 50 });
  } else if (result.focusedTestsPassed === false) {
    breakdown.push({ label: "focused tests fail", delta: -25 });
    score -= 25;
  } else {
    breakdown.push({ label: "focused tests not run", delta: -10 });
    score -= 10;
  }

  if (result.fullTestsPassed === true) {
    score += 20;
    breakdown.push({ label: "full tests pass", delta: 20 });
  } else if (result.fullTestsPassed === false && task.fullTestCommand) {
    breakdown.push({ label: "full tests fail", delta: -10 });
    score -= 10;
  }

  if (result.touchedExpectedFile) {
    score += 10;
    breakdown.push({ label: "touched expected file", delta: 10 });
  } else if (task.expectedTouchedFiles.length > 0) {
    breakdown.push({ label: "did not touch expected file", delta: -5 });
    score -= 5;
  }

  const reproOrEvidence = result.reproduced || result.evidenceUsed;
  if (reproOrEvidence) {
    score += 10;
    breakdown.push({ label: "repro/evidence used", delta: 10 });
  } else if (task.successCriteria.noTestEdits) {
    breakdown.push({ label: "no repro/evidence step", delta: -5 });
    score -= 5;
  }

  const huge = options.hugeDiffLines
    ?? (task.difficulty === "hard" ? DEFAULT_HUGE_DIFF_HARD : DEFAULT_HUGE_DIFF_EASY);
  if (result.diffLineCount <= 12) {
    score += 5;
    breakdown.push({ label: "small diff", delta: 5 });
  } else if (result.diffLineCount > huge) {
    score -= 20;
    breakdown.push({ label: "huge diff", delta: -20 });
  }

  if (task.successCriteria.noTestEdits && result.editedTests) {
    score -= 30;
    breakdown.push({ label: "edited tests (forbidden)", delta: -30 });
  }
  if (task.successCriteria.noDependencyEdits && result.editedDependencies) {
    score -= 30;
    breakdown.push({ label: "edited dependencies (forbidden)", delta: -30 });
  }
  if (result.editedForbiddenFile) {
    score -= 10;
    breakdown.push({ label: "edited forbidden file", delta: -10 });
  }

  if (!result.reproduced && REPRO_REQUIRED_CATEGORIES.has(task.category)) {
    score -= 20;
    breakdown.push({ label: "failed to reproduce", delta: -20 });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    pass: score >= 60,
    focusedTestsPassed: result.focusedTestsPassed === true,
    fullTestsPassed: result.fullTestsPassed === true,
    touchedExpectedFile: result.touchedExpectedFile,
    editedForbiddenFile: result.editedForbiddenFile,
    editedTests: result.editedTests,
    editedDependencies: result.editedDependencies,
    diffLineCount: result.diffLineCount,
    filesTouchedCount: result.filesTouched.length,
    commandsRunCount: result.commandsRun.length,
    missionStepsCompleted: result.missionStepsCompleted,
    memoryUsed: result.memoryUsed,
    evidenceUsed: result.evidenceUsed,
    noOpDetected: result.noOpDetected,
    breakdown
  };
}
