import type { CheaterConfig } from "../types.js";

export interface CommitletConfig {
  commitletModeEnabled: boolean;
  commitletAutoForCodeTasks: boolean;
  rollbackRequired: boolean;
  maxFilesTouchedDefault: number;
  maxDiffLinesDefault: number;
  maxModelCallsPerCommitlet: number;
  repairAttemptsPerCommitlet: number;
  healthScoreThreshold: number;
  hardRejectHealthThreshold: number;
  allowDependencyEditsByDefault: boolean;
  allowLockfileEditsByDefault: boolean;
  allowTestEditsByDefault: boolean;
  finalReviewEnabled: boolean;
  autoCleanupLowRiskHealthIssues: boolean;
  telemetryEnabled: boolean;
  telemetryLocalOnly: boolean;
  retrievalMaxPlanningFacts: number;
  retrievalMaxFeedbackFacts: number;
}

export const DEFAULT_COMMITLET_CONFIG: CommitletConfig = {
  commitletModeEnabled: true,
  commitletAutoForCodeTasks: true,
  rollbackRequired: true,
  maxFilesTouchedDefault: 3,
  maxDiffLinesDefault: 180,
  maxModelCallsPerCommitlet: 1,
  repairAttemptsPerCommitlet: 1,
  healthScoreThreshold: 75,
  hardRejectHealthThreshold: 50,
  allowDependencyEditsByDefault: false,
  allowLockfileEditsByDefault: false,
  allowTestEditsByDefault: false,
  finalReviewEnabled: true,
  autoCleanupLowRiskHealthIssues: true,
  telemetryEnabled: true,
  telemetryLocalOnly: true,
  retrievalMaxPlanningFacts: 3,
  retrievalMaxFeedbackFacts: 5
};

export function commitletConfig(config: CheaterConfig = {}): CommitletConfig {
  return { ...DEFAULT_COMMITLET_CONFIG, ...config };
}
