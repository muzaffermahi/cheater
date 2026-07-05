import type { CheaterConfig } from "../types.js";
import { DEFAULT_COMMITLET_CONFIG, type CommitletConfig } from "../commitlet/config.js";

export interface BlueprintConfig extends CommitletConfig {
  reliabilityModeEnabled: boolean;
  autopilotEnabled: boolean;
  autopilotRouteAllCodeTasks: boolean;
  blueprintModeEnabled: boolean;
  blueprintAutoForComplexTasks: boolean;
  blueprintUseFastPath: boolean;
  blueprintCandidateCount: number;
  blueprintShowInternalPlanSummary: boolean;
  blueprintRequireApproval: "always" | "high_risk_only" | "never";
  blueprintMaxPackets: number;
  blueprintMaxCallsPerPacket: number;
  blueprintMaxDebugRounds: number;
  blueprintReplanAfterFailedDebug: boolean;
  blueprintMemoryEnabled: boolean;
  blueprintOfficialDocsSearchEnabled: boolean;
  blueprintDocsProvider: "local" | "official_allowlist" | "searxng";
  searxngBaseUrl: string;
  blueprintMaxDocsFacts: number;
  blueprintFetchDocsPages: boolean;
  blueprintFreshAgentPerPacket: boolean;
  blueprintMaxAgentTokens: number;
  blueprintBlockPlannerFileTools: boolean;
  maxContextTokens: number;
  contextCompactRatio: number;
  bugFreshAgentEnabled: boolean;
  freshCallPacketsEnabled: boolean;
  packetOneFilePerWorkerEnabled: boolean;
  packetMaxFilesToTouch: number;
  packetContextBudgetTokens9B: number;
  packetContextBudgetTokensMoE: number;
  packetHardContextCeilingTokens9B: number;
  packetHardContextCeilingTokensMoE: number;
  loopGovernorEnabled: boolean;
  maxLoopBreaksPerPacket: number;
  maxToolCallsTinyPacket: number;
  maxToolCallsNormalPacket: number;
  maxToolCallsHardPacket: number;
  maxTotalToolCallsPerPacket: number;
  sameFileReadLimit: number;
  sameFailedCommandLimit: number;
  sameSearchQueryLimit: number;
  samePatchLimit: number;
  stopSentinelsEnabled: boolean;
  jsonStopSentinel: string;
  patchStopSentinel: string;
  reviewStopSentinel: string;
  benchmarkEnabled: boolean;
  benchmarkDefaultTaskLimit: number;
}

export const DEFAULT_BLUEPRINT_CONFIG: BlueprintConfig = {
  ...DEFAULT_COMMITLET_CONFIG,
  reliabilityModeEnabled: true,
  autopilotEnabled: true,
  autopilotRouteAllCodeTasks: true,
  blueprintModeEnabled: true,
  blueprintAutoForComplexTasks: true,
  blueprintUseFastPath: true,
  blueprintCandidateCount: 3,
  blueprintShowInternalPlanSummary: true,
  blueprintRequireApproval: "high_risk_only",
  blueprintMaxPackets: 24,
  blueprintMaxCallsPerPacket: 1,
  blueprintMaxDebugRounds: 3,
  blueprintReplanAfterFailedDebug: true,
  blueprintMemoryEnabled: true,
  // Intentional layering (NOT a contradiction): the blueprint subsystem's OWN default is on - it is
  // used directly when createAutonomousBlueprint runs standalone (e.g. tests). The integrated cheater
  // path (DEFAULT_CONFIG in config.ts) overrides this to OFF, so normal cheater runs keep docs search
  // off unless an env var / explicit config turns it on.
  blueprintOfficialDocsSearchEnabled: true,
  blueprintDocsProvider: "official_allowlist",
  searxngBaseUrl: "",
  blueprintMaxDocsFacts: 5,
  blueprintFetchDocsPages: false,
  blueprintFreshAgentPerPacket: true,
  blueprintMaxAgentTokens: 12000,
  blueprintBlockPlannerFileTools: true,
  maxContextTokens: 12000,
  contextCompactRatio: 0.85,
  bugFreshAgentEnabled: true,
  freshCallPacketsEnabled: true,
  packetOneFilePerWorkerEnabled: true,
  packetMaxFilesToTouch: 1,
  packetContextBudgetTokens9B: 10000,
  packetContextBudgetTokensMoE: 20000,
  packetHardContextCeilingTokens9B: 12000,
  packetHardContextCeilingTokensMoE: 24000,
  loopGovernorEnabled: true,
  maxLoopBreaksPerPacket: 3,
  maxToolCallsTinyPacket: 6,
  maxToolCallsNormalPacket: 14,
  maxToolCallsHardPacket: 24,
  // Budgets sized for normal iterative work by a competent local model, not to punish it.
  // Terminal blocks are reserved for genuinely degenerate repetition (see structural
  // fingerprints in loopGovernor.ts), not ordinary multi-edit sessions.
  maxTotalToolCallsPerPacket: 40,
  sameFileReadLimit: 4,
  sameFailedCommandLimit: 2,
  sameSearchQueryLimit: 3,
  samePatchLimit: 3,
  stopSentinelsEnabled: true,
  jsonStopSentinel: "@@END_JSON@@",
  patchStopSentinel: "@@END_PATCH@@",
  reviewStopSentinel: "@@END_REVIEW@@",
  benchmarkEnabled: true,
  benchmarkDefaultTaskLimit: 10
};

export function blueprintConfig(config: CheaterConfig = {}): BlueprintConfig {
  const aliases: Partial<BlueprintConfig> = {};
  if (config.officialDocsSearchEnabled !== undefined) aliases.blueprintOfficialDocsSearchEnabled = config.officialDocsSearchEnabled;
  if (config.docsProvider !== undefined) aliases.blueprintDocsProvider = config.docsProvider;
  if (config.maxDocsFacts !== undefined) aliases.blueprintMaxDocsFacts = config.maxDocsFacts;
  return { ...DEFAULT_BLUEPRINT_CONFIG, ...aliases, ...config };
}
