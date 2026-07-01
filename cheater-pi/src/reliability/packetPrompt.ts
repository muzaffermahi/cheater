import type { BlueprintConfig } from "../blueprint/config.js";
import { buildPacketContext, fileSnippet } from "../blueprint/contextSketch.js";
import { packetScopedWorkerBrief } from "../blueprint/intelligence.js";
import type { BlueprintPlan, WorkPacket } from "../blueprint/types.js";
import { modelProfile } from "./modelProfile.js";
import { sentinelFor } from "./sentinels.js";
import type { FreshCallPacket, ReliabilityPacketOutputFormat } from "./types.js";

export function freshCallPacketFromWorkPacket(params: {
  plan: BlueprintPlan;
  packet: WorkPacket;
  previousState?: string[];
  contextBudgetTokens: number;
  config: BlueprintConfig;
}): FreshCallPacket {
  const outputFormat = outputFormatFor(params.packet);
  const profile = modelProfile((params.config as BlueprintConfig & { model?: string }).model, params.config);
  const contextBudgetTokens = Math.min(params.contextBudgetTokens, profile.packetContextBudget);
  return {
    globalGoal: oneParagraph(params.plan.userGoal, 360),
    packetId: params.packet.id,
    packetType: params.packet.type,
    filesToTouch: params.packet.filesToTouch.slice(0, params.config.packetMaxFilesToTouch).map((file) => file.path),
    filesToAvoid: forbiddenFiles(params.plan, params.packet),
    contextSketch: trimToBudget([
      packetScopedWorkerBrief(params.plan, params.packet),
      buildPacketContext(params.packet, params.previousState ?? [], params.plan.docsFacts ?? [])
    ].filter(Boolean).join("\n\n"), contextBudgetTokens),
    relevantSnippets: relevantSnippets(params.plan, params.packet, profile.class),
    previousState: (params.previousState ?? []).slice(-3),
    acceptanceCriteria: params.packet.acceptanceCriteria,
    allowedActions: ["inspect", "edit", "run_test", "stop_blocked"],
    stopWhen: params.packet.type === "review" ? "final review is complete" : "this packet's acceptance criteria are met or one blocker is clear",
    outputFormat,
    endSentinel: sentinelFor(outputFormat, params.config),
    modelClass: profile.class,
    contextBudgetTokens,
    maxOutputTokens: profile.maxOutputTokens,
    modelOperatingRules: operatingRulesFor(profile.class)
  };
}

export function renderFreshCallPacket(packet: FreshCallPacket): string {
  return [
    "Cheater Autonomous Blueprint fresh-agent packet.",
    "Cheater Reliability Mode fresh-call packet.",
    `globalGoal: ${packet.globalGoal}`,
    `packetId: ${packet.packetId}`,
    `packetType: ${packet.packetType}`,
    `filesToTouch: ${packet.filesToTouch.join(", ") || "(inspect first)"}`,
    `filesToAvoid: ${packet.filesToAvoid.join(", ") || "(none)"}`,
    "",
    "contextSketch:",
    packet.contextSketch,
    "",
    packet.previousState.length ? `previousState:\n- ${packet.previousState.join("\n- ")}` : "previousState: none",
    "",
    packet.relevantSnippets.length ? `relevantSnippets:\n${packet.relevantSnippets.join("\n")}` : "relevantSnippets: none",
    "",
    `acceptanceCriteria:\n- ${packet.acceptanceCriteria.join("\n- ")}`,
    `allowedActions: ${packet.allowedActions.join(", ")}`,
    `stopWhen: ${packet.stopWhen}`,
    `outputFormat: ${packet.outputFormat}`,
    `endSentinel: ${packet.endSentinel}`,
    `modelClass: ${packet.modelClass ?? "unknown"}`,
    `contextBudgetTokens: ${packet.contextBudgetTokens ?? "(default)"}`,
    `maxOutputTokens: ${packet.maxOutputTokens ?? "(default)"}`,
    packet.modelOperatingRules?.length ? `modelOperatingRules:\n- ${packet.modelOperatingRules.join("\n- ")}` : "modelOperatingRules: default",
    "",
    "Use Pi native tools only. Do not execute unrelated packets. Do not include unrelated prior chat.",
    "One file-change worker means one file-change worker: after editing the listed file, stop and hand off. Do not continue to another file.",
    "End with a compact handoff summary and the sentinel."
  ].join("\n");
}

function outputFormatFor(packet: WorkPacket): ReliabilityPacketOutputFormat {
  if (packet.type === "review") return "review";
  if (packet.type === "implement" || packet.type === "repair") return "patch";
  return "json";
}

function forbiddenFiles(plan: BlueprintPlan, packet: WorkPacket): string[] {
  const allowed = new Set(packet.filesToTouch.map((file) => file.path));
  return plan.workPackets.flatMap((p) => p.filesToTouch.map((file) => file.path)).filter((file) => !allowed.has(file)).slice(0, 6);
}

function oneParagraph(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function trimToBudget(text: string, budgetTokens: number): string {
  const maxChars = Math.max(1000, budgetTokens * 4);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function relevantSnippets(plan: BlueprintPlan, packet: WorkPacket, modelClass: ReturnType<typeof modelProfile>["class"]): string[] {
  const maxFiles = modelClass === "9b" ? 1 : 2;
  const maxChars = modelClass === "9b" ? 900 : 1400;
  const files = [
    ...packet.filesToTouch.map((file) => file.path),
    ...packet.filesToInspect.map((file) => file.path)
  ].filter(isSnippetSafeFile);
  return [...new Set(files)].slice(0, maxFiles).map((file) => {
    const snippet = fileSnippet(plan.repoRoot, file, maxChars).trim();
    if (!snippet) return "";
    return [`--- ${file} excerpt ---`, snippet, `--- end ${file} excerpt ---`].join("\n");
  }).filter(Boolean);
}

function isSnippetSafeFile(file: string): boolean {
  if (!file || file.startsWith("(") || file.endsWith("/")) return false;
  if (/(^|[\\/])(\.git|node_modules|dist|build|coverage|\.cheater)([\\/]|$)/i.test(file)) return false;
  return /\.(ts|tsx|js|jsx|py|md|json|toml|yml|yaml|html|css|scss|vue|svelte|go|rs)$/i.test(file);
}

function operatingRulesFor(modelClass: ReturnType<typeof modelProfile>["class"]): string[] {
  if (modelClass === "9b") {
    return [
      "Read at most one target file region before editing.",
      "Make one bounded edit, then stop for verification.",
      "Prefer exact file paths, commands, and acceptance checks over explanatory prose.",
      "If a second file is needed, stop with BLOCKED_NEXT_FILE."
    ];
  }
  if (modelClass === "moe30b" || modelClass === "moe35b") {
    return [
      "Use the packet facts first, then inspect only the smallest missing local region.",
      "Keep one touched file per worker even if reasoning spans multiple files.",
      "Run the focused verification command before broad tests.",
      "Stop after the compact handoff; do not continue into the next packet."
    ];
  }
  return [
    "Keep context narrow and execute only this packet.",
    "Stop when acceptance criteria are met or a blocker is found."
  ];
}
