import { blueprintConfig } from "../blueprint/config.js";
import type { CheaterConfig } from "../types.js";
import { modelProfile } from "./modelProfile.js";

export function reliabilityStatus(config: CheaterConfig, modelName?: string): string {
  const cfg = blueprintConfig(config);
  const profile = modelProfile(modelName, cfg);
  return [
    "Cheater Reliability Mode",
    `enabled: ${cfg.reliabilityModeEnabled}`,
    `autopilot: ${cfg.autopilotEnabled} routeAllCodeTasks=${cfg.autopilotRouteAllCodeTasks}`,
    `freshCallPackets: ${cfg.freshCallPacketsEnabled}`,
    `loopGovernor: ${cfg.loopGovernorEnabled} maxBreaks=${cfg.maxLoopBreaksPerPacket}`,
    `contextBudget: ${profile.packetContextBudget} hardCeiling=${profile.hardContextCeiling} class=${profile.class}`,
    `stopSentinels: json=${cfg.jsonStopSentinel} patch=${cfg.patchStopSentinel} review=${cfg.reviewStopSentinel}`,
    `docs: enabled=${cfg.blueprintOfficialDocsSearchEnabled} provider=${cfg.blueprintDocsProvider}`,
    `benchmark: enabled=${cfg.benchmarkEnabled} defaultLimit=${cfg.benchmarkDefaultTaskLimit}`
  ].join("\n");
}
