export interface CheaterConfig {
  piCommand?: string | string[];
  provider?: string;
  model?: string;
  themeEnabled?: boolean;
  defaultTestCommand?: string;
  packagePath?: string;
  memoryEnabled?: boolean;
  skillsEnabled?: boolean;
  debug?: boolean;
  showStartupCard?: boolean;
  missionControlEnabled?: boolean;
  reproRequiredBeforePatch?: boolean;
  allowNoOpSuccess?: boolean;
  onlineEvidenceEnabled?: boolean;
  offlineStackOverflowEnabled?: boolean;
  autoSaveLearning?: boolean;
  oracleRunBroadTests?: "never" | "ask" | "always";
  oracleRunAllChecks?: boolean;
  maxContextTokens?: number;
  contextCompactRatio?: number;
  maxEvidenceItems?: number;
  maxMissionRawLogChars?: number;
  gymEnabled?: boolean;
  gymDefaultLimit?: number;
  gymDefaultConcurrency?: number;
  gymTempDir?: string;
  gymKeepWorkspaces?: boolean;
  gymRunFullTests?: "never" | "if_cheap" | "always";
  gymAutoLearn?: boolean;
  gymDeltaModeEnabled?: boolean;
  autopilotEnabled?: boolean;
  autopilotRouteAllCodeTasks?: boolean;
  blueprintModeEnabled?: boolean;
  blueprintAutoForComplexTasks?: boolean;
  blueprintUseFastPath?: boolean;
  blueprintCandidateCount?: number;
  blueprintShowInternalPlanSummary?: boolean;
  blueprintRequireApproval?: "always" | "high_risk_only" | "never";
  blueprintMaxPackets?: number;
  blueprintMaxCallsPerPacket?: number;
  blueprintMaxDebugRounds?: number;
  blueprintReplanAfterFailedDebug?: boolean;
  blueprintMemoryEnabled?: boolean;
  blueprintOfficialDocsSearchEnabled?: boolean;
  blueprintDocsProvider?: "local" | "official_allowlist" | "searxng";
  searxngBaseUrl?: string;
  blueprintMaxDocsFacts?: number;
  blueprintFetchDocsPages?: boolean;
  blueprintFreshAgentPerPacket?: boolean;
  blueprintMaxAgentTokens?: number;
  blueprintBlockPlannerFileTools?: boolean;
  bugFreshAgentEnabled?: boolean;
  reliabilityModeEnabled?: boolean;
  freshCallPacketsEnabled?: boolean;
  packetOneFilePerWorkerEnabled?: boolean;
  packetMaxFilesToTouch?: number;
  packetContextBudgetTokens9B?: number;
  packetContextBudgetTokensMoE?: number;
  packetHardContextCeilingTokens9B?: number;
  packetHardContextCeilingTokensMoE?: number;
  postEditSyntaxGateEnabled?: boolean;
  autoVerifyOnFinish?: boolean;
  loopGovernorEnabled?: boolean;
  maxLoopBreaksPerPacket?: number;
  maxToolCallsTinyPacket?: number;
  maxToolCallsNormalPacket?: number;
  maxToolCallsHardPacket?: number;
  maxTotalToolCallsPerPacket?: number;
  sameFileReadLimit?: number;
  sameFailedCommandLimit?: number;
  sameSearchQueryLimit?: number;
  samePatchLimit?: number;
  stopSentinelsEnabled?: boolean;
  jsonStopSentinel?: string;
  patchStopSentinel?: string;
  reviewStopSentinel?: string;
  officialDocsSearchEnabled?: boolean;
  docsProvider?: "local" | "official_allowlist" | "searxng";
  maxDocsFacts?: number;
  benchmarkEnabled?: boolean;
  benchmarkDefaultTaskLimit?: number;
  commitletModeEnabled?: boolean;
  commitletAutoForCodeTasks?: boolean;
  // When true, each commitlet is dispatched to a real isolated fresh worker session
  // (context isolation) by default, instead of returning a prompt to the orchestrator.
  // Requires a working model backend; keep false for offline/dry-run use.
  commitletFreshWorkerDefault?: boolean;
  rollbackRequired?: boolean;
  maxFilesTouchedDefault?: number;
  maxDiffLinesDefault?: number;
  maxModelCallsPerCommitlet?: number;
  repairAttemptsPerCommitlet?: number;
  healthScoreThreshold?: number;
  hardRejectHealthThreshold?: number;
  allowDependencyEditsByDefault?: boolean;
  allowLockfileEditsByDefault?: boolean;
  allowTestEditsByDefault?: boolean;
  finalReviewEnabled?: boolean;
  autoCleanupLowRiskHealthIssues?: boolean;
  telemetryEnabled?: boolean;
  telemetryLocalOnly?: boolean;
  retrievalMaxPlanningFacts?: number;
  retrievalMaxFeedbackFacts?: number;
}

export interface LaunchOptions {
  doctor: boolean;
  debug: boolean;
  noTheme: boolean;
  printPiCommand: boolean;
  help: boolean;
  version: boolean;
  passthrough: string[];
}

export interface PiCommandResolution {
  command: string[];
  source: "config" | "env" | "path" | "fallback";
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
