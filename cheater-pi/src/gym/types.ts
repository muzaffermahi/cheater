export type GymCategory =
  | "import_error"
  | "syntax_error"
  | "off_by_one"
  | "wrong_exception"
  | "fixture_scope"
  | "async_misuse"
  | "path_handling"
  | "json_serialization"
  | "cli_parsing"
  | "config_parsing"
  | "duplicate_filter"
  | "ranking_sorting"
  | "cache_invalidation"
  | "regex_edge"
  | "datetime_parsing"
  | "type_conversion"
  | "package_export"
  | "test_state_leak"
  | "wrong_export"
  | "promise_not_awaited"
  | "path_normalization"
  | "json_parsing"
  | "tsc_failure"
  | "other";

export type GymDifficulty = "easy" | "medium" | "hard";

export type GymLanguage = "python" | "javascript" | "typescript";

export type GymRunMode = "fixture" | "generated";

export interface GymSuccessCriteria {
  focusedTestsPass: boolean;
  fullTestsPass: boolean;
  noTestEdits: boolean;
  noDependencyEdits: boolean;
}

export interface GymTask {
  id: string;
  title: string;
  language: GymLanguage;
  category: GymCategory;
  difficulty: GymDifficulty;
  goal: string;
  focusedTestCommand: string;
  fullTestCommand?: string;
  expectedTouchedFiles: string[];
  forbiddenTouchedFiles: string[];
  successCriteria: GymSuccessCriteria;
  tags: string[];
  runMode: GymRunMode;
  source: string;
  /** Path to the fixture repo inside the gym/tasks directory, relative to the task. */
  fixturePath?: string;
  /** Inline source for generated-repo tasks. */
  generated?: GymGeneratedTask;
  /** Documentation in the task (optional, optional `README.md` is read first). */
  notes?: string;
}

export interface GymGeneratedTask {
  /** Files to write into the temp workspace, keyed by relative path. */
  files: Record<string, string>;
  /** Setup command run before the focused test, e.g. `pip install -e .`. */
  setupCommand?: string;
  /** Optional Python version constraint, e.g. `>=3.10`. */
  pythonVersion?: string;
  /** Optional node version constraint, e.g. `>=18`. */
  nodeVersion?: string;
}

export interface GymRunResult {
  taskId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  mode: "cheater" | "vanilla";
  focusedTestsPassed: boolean | null;
  fullTestsPassed: boolean | null;
  filesTouched: string[];
  diffLineCount: number;
  commandsRun: string[];
  editedTests: boolean;
  editedDependencies: boolean;
  touchedExpectedFile: boolean;
  editedForbiddenFile: boolean;
  reproduced: boolean;
  noOpDetected: boolean;
  memoryUsed: boolean;
  evidenceUsed: boolean;
  missionStepsCompleted: number;
  notes: string;
}

export interface GymScored {
  score: number;
  pass: boolean;
  focusedTestsPassed: boolean;
  fullTestsPassed: boolean;
  touchedExpectedFile: boolean;
  editedForbiddenFile: boolean;
  editedTests: boolean;
  editedDependencies: boolean;
  diffLineCount: number;
  filesTouchedCount: number;
  commandsRunCount: number;
  missionStepsCompleted: number;
  memoryUsed: boolean;
  evidenceUsed: boolean;
  noOpDetected: boolean;
  breakdown: Array<{ label: string; delta: number }>;
}

export interface GymReport {
  id: string;
  startedAt: string;
  finishedAt: string;
  suite: string;
  results: Array<GymRunResult & { score: GymScored }>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    averageScore: number;
    averageDiff: number;
  };
  vanillaAvailable: boolean;
}

export interface GymDeltaReport {
  taskId: string;
  model: string | null;
  vanilla: (GymRunResult & { score: GymScored }) | null;
  cheater: (GymRunResult & { score: GymScored }) | null;
  improvement: {
    scoreDelta: number;
    toolCallsDelta: number;
    diffLinesDelta: number;
    passImproved: boolean;
    vanillaAvailable: boolean;
  };
}

export interface GymLearningSuggestion {
  kind: "anti_pattern" | "skill_improvement" | "playbook_note";
  taskId: string;
  summary: string;
  details: string;
  reason: string;
}

export interface GymConfig {
  enabled: boolean;
  defaultLimit: number;
  defaultConcurrency: number;
  tempDir: string;
  keepWorkspaces: boolean;
  runFullTests: "never" | "if_cheap" | "always";
  autoLearn: boolean;
  deltaModeEnabled: boolean;
}

export const DEFAULT_GYM_CONFIG: GymConfig = {
  enabled: true,
  defaultLimit: 5,
  defaultConcurrency: 1,
  tempDir: ".cheater/gym/runs",
  keepWorkspaces: false,
  runFullTests: "if_cheap",
  autoLearn: false,
  deltaModeEnabled: false
};

export const GYM_CATEGORIES: readonly GymCategory[] = [
  "import_error", "syntax_error", "off_by_one", "wrong_exception", "fixture_scope",
  "async_misuse", "path_handling", "json_serialization", "cli_parsing", "config_parsing",
  "duplicate_filter", "ranking_sorting", "cache_invalidation", "regex_edge",
  "datetime_parsing", "type_conversion", "package_export", "test_state_leak",
  "wrong_export", "promise_not_awaited", "path_normalization", "json_parsing", "tsc_failure", "other"
];
