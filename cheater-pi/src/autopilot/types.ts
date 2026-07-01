export type TaskKind =
  | "explanation_only"
  | "tiny_edit"
  | "bug_fix"
  | "test_failure"
  | "feature_addition"
  | "refactor"
  | "tooling"
  | "docs"
  | "migration"
  | "benchmark"
  | "unknown";

export type ExecutionMode =
  | "answer_only"
  | "vanilla_pi"
  | "mission_control"
  | "blueprint_orchestrator";

export type ExecutionDiscipline =
  | "none"
  | "fast_path"
  | "single_commitlet"
  | "commitlet_chain"
  | "blueprint_backed_commitlet_chain"
  | "blocked_needs_user";

export type RiskLevel = "low" | "medium" | "high";

export interface AutopilotRepoHints {
  hasPackageJson?: boolean;
  hasPyproject?: boolean;
  hasTests?: boolean;
  likelyFiles?: string[];
  previousFastPathFailed?: boolean;
  repeatedFailure?: boolean;
}

export interface AutopilotInput {
  message: string;
  cwd: string;
  recentErrors?: string;
  repoHints?: AutopilotRepoHints;
}

export interface AutopilotDecision {
  taskKind: TaskKind;
  executionMode: ExecutionMode;
  executionDiscipline: ExecutionDiscipline;
  confidence: number;
  reason: string;
  needsBlueprint: boolean;
  needsRepro: boolean;
  risk: RiskLevel;
  userVisibleSummary: string;
  complexitySignals: string[];
}

export interface RoutePolicyInput {
  message: string;
  taskKind: TaskKind;
  confidence: number;
  risk: RiskLevel;
  needsRepro: boolean;
  complexitySignals: string[];
  repoHints?: AutopilotRepoHints;
}
