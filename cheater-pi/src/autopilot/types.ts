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
  | "careful_repro"
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
  /** The user explicitly approved a previously blocked high-risk request ("proceed"). */
  userApprovedHighRisk?: boolean;
}

export interface AutopilotInput {
  message: string;
  cwd: string;
  recentErrors?: string;
  repoHints?: AutopilotRepoHints;
  /** When true, high-risk destructive intent stops for approval. Default false (autonomous). */
  requireApproval?: boolean;
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
  /** When true, high-risk destructive intent stops for approval. Default false (autonomous). */
  requireApproval?: boolean;
}
