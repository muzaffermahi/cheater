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
  // Explicit ceiling for the MAIN interactive session's context (planner/orchestrator).
  // Unset (default) means "breathe up to ~90% of the model's real context window" - do not
  // confuse this with the tiny per-worker packet budget (maxContextTokens/blueprintMaxAgentTokens).
  maxSessionContextTokens?: number;
  contextCompactRatio?: number;
  // When true, a high-risk request (destructive intent) stops and asks the user before
  // editing. Default false: Cheater is autonomous - one prompt runs to completion, and
  // destructive intent is surfaced as a caution the model proceeds through, not a hard stop.
  requireApprovalForHighRisk?: boolean;
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
  // Post-edit import gate: after each successful edit, verify the file's imports resolve
  // (repo files exist, named symbols are exported, npm packages are installed) and report
  // problems in-band on the edit's own result. Catches hallucinated imports immediately.
  postEditImportGateEnabled?: boolean;
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
  // Verified resampling: number of independent fresh-worker attempts per commitlet in
  // real-worker mode. The harness scores each candidate in code (guard/health/focused
  // verification), accepts the first verified pass, and keeps the best failing candidate
  // otherwise. 1 (default) = today's single attempt; 2-3 recommended for small local models
  // where samples are cheap and pass@1 is weak.
  commitletCandidateSamples?: number;
  // Wall-clock limit per fresh-worker attempt (ms). A wedged worker on a slow local backend
  // is aborted at this deadline instead of hanging the main session forever. Default 10min.
  commitletWorkerTimeoutMs?: number;
  // Experience store: harness-written bug memory. Cards are saved only on verified
  // fail->pass transitions and recalled in-band inside failure cards. Local-only JSONL.
  experienceStoreEnabled?: boolean;
  // Cheat Layer: on failures, the harness classifies the failure, retrieves compact evidence
  // (verified experience -> bug corpus -> local docs -> official docs when enabled), and
  // injects at most 3 hypothesis cards into repair packets and failure notices. The model
  // never calls a search tool; the verifier remains the source of truth.
  cheatSheetEnabled?: boolean;
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
