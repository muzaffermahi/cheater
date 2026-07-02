import { topologicalPackets } from "./planGraph.js";
import { buildPacketContext } from "./contextSketch.js";
import { packetScopedWorkerBrief } from "./intelligence.js";
import type { BlueprintPlan, WorkPacket } from "./types.js";
import { blueprintConfig } from "./config.js";
import { freshCallPacketFromWorkPacket, renderFreshCallPacket } from "../reliability/packetPrompt.js";
import { modelProfile } from "../reliability/modelProfile.js";
import type { CheaterConfig } from "../types.js";

export interface PacketExecutionPrompt {
  packetId: string;
  prompt: string;
}

export function buildPacketExecutionPrompts(plan: BlueprintPlan, rawConfig: CheaterConfig = {}, opts: { skipSnippetsForFiles?: string[] } = {}): PacketExecutionPrompt[] {
  const config = blueprintConfig(rawConfig);
  const packetConfig = { ...config, model: rawConfig.model };
  const profile = modelProfile(rawConfig.model, config);
  const summaries: string[] = [];
  return topologicalPackets(plan.workPackets).map((packet) => {
    const reliabilityPacket = freshCallPacketFromWorkPacket({
      plan,
      packet,
      previousState: summaries,
      contextBudgetTokens: profile.packetContextBudget,
      config: packetConfig,
      skipSnippetsForFiles: opts.skipSnippetsForFiles
    });
    const prompt = config.freshCallPacketsEnabled ? renderFreshCallPacket(reliabilityPacket) : [
      `Cheater Autonomous Blueprint fresh-agent packet ${packet.id}: ${packet.title}`,
      `Global goal: ${plan.userGoal}`,
      packetScopedWorkerBrief(plan, packet) ?? "BLUEPRINT INTELLIGENCE PACK: unavailable",
      buildPacketContext(packet, summaries, plan.docsFacts),
      `Prompt contract: ${packet.promptContract}`,
      `Forbidden actions: ${packet.forbiddenActions.join("; ")}`,
      `Verification: ${packet.verification.map((step) => step.command ?? step.description).join("; ") || "manual review"}`,
      "Use Pi native tools only. Do not execute unrelated packets.",
      "For existing files, use a line/range edit such as cheater_line_edit after reading the target lines. Avoid complete-file writes.",
      "If this packet touches one file, do not edit sibling files in the same packet. Complete the packet and request the next one.",
      "If you notice yourself starting 'Now let me update...' for another file, stop and complete the current packet first.",
      "Start from the packet context, avoid relying on previous chat history, and end with a compact handoff summary."
    ].join("\n");
    summaries.push(packet.result?.summary ? `${packet.id}: ${packet.result.summary}` : `${packet.id}: ${packet.status}`);
    return { packetId: packet.id, prompt };
  });
}

export function markPacketResult(packet: WorkPacket, ok: boolean, summary: string): WorkPacket {
  return {
    ...packet,
    status: ok ? "done" : "failed",
    result: {
      summary,
      filesTouched: packet.filesToTouch.map((file) => file.path),
      verificationPassed: ok
    }
  };
}

export function executePacketsAsPiPrompts(plan: BlueprintPlan): BlueprintPlan {
  const ordered = topologicalPackets(plan.workPackets);
  const completed = ordered.map((packet) => markPacketResult(packet, true, "Prepared for sequential Pi execution."));
  return { ...plan, workPackets: completed };
}
