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
  // Files already given a symbol-aware snippet by an outer caller (e.g. the commitlet
  // block); skipping them here avoids embedding the same file's code twice in one packet.
  skipSnippetsForFiles?: string[];
}): FreshCallPacket {
  const outputFormat = outputFormatFor(params.packet);
  const profile = modelProfile((params.config as BlueprintConfig & { model?: string }).model, params.config);
  const contextBudgetTokens = Math.min(params.contextBudgetTokens, profile.packetContextBudget);
  const verificationCommand = params.packet.verification.find((step) => step.required && step.command)?.command
    ?? params.packet.verification.find((step) => step.command)?.command;
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
    relevantSnippets: relevantSnippets(params.plan, params.packet, profile.class, params.skipSnippetsForFiles),
    previousState: (params.previousState ?? []).slice(-3),
    acceptanceCriteria: params.packet.acceptanceCriteria,
    allowedActions: ["inspect", "edit", "run_test", "stop_blocked"],
    stopWhen: params.packet.type === "review" ? "final review is complete" : "this packet's acceptance criteria are met or one blocker is clear",
    outputFormat,
    endSentinel: sentinelFor(outputFormat, params.config),
    verificationCommand,
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
    ...(packet.verificationCommand ? [`verificationCommand: ${packet.verificationCommand} - run this yourself via bash after editing, before ending the packet.`] : []),
    `outputFormat: ${packet.outputFormat}`,
    `endSentinel: ${packet.endSentinel}`,
    `modelClass: ${packet.modelClass ?? "unknown"}`,
    `contextBudgetTokens: ${packet.contextBudgetTokens ?? "(default)"}`,
    // maxOutputTokens is a server-side sampling parameter the model cannot set itself, so
    // it is not rendered into the packet as advisory noise. Configure it on the backend.
    packet.modelOperatingRules?.length ? `modelOperatingRules:\n- ${packet.modelOperatingRules.join("\n- ")}` : "modelOperatingRules: default",
    "",
    // Prefer structured edit tools (cheater_line_edit, then Pi's native edit) over emitting a
    // raw diff - this used to say "Use Pi native tools only", contradicting the commitlet
    // block's own instruction to use cheater_line_edit and pushing outputFormat:"patch" into
    // the worker's ending as a literal diff instead of a tool call.
    "Use structured edit tools (cheater_line_edit, or the built-in edit tool) to make the change; outputFormat/endSentinel describe how to REPORT the result, not how to edit. Do not execute unrelated packets. Do not include unrelated prior chat.",
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

function relevantSnippets(plan: BlueprintPlan, packet: WorkPacket, modelClass: ReturnType<typeof modelProfile>["class"], skipFiles: string[] = []): string[] {
  // One file per worker is universal; the tier only widens how much of that file (and, for the
  // strongest in-range models, whether a second supporting file) rides in the packet.
  const maxFiles = modelClass === "large" ? 2 : 1;
  const maxChars = modelClass === "large" ? 1400 : modelClass === "medium" ? 1200 : 900;
  const skip = new Set(skipFiles);
  const files = [
    ...packet.filesToTouch.map((file) => file.path),
    ...packet.filesToInspect.map((file) => file.path)
  ].filter((file) => isSnippetSafeFile(file) && !skip.has(file));
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

export function operatingRulesFor(modelClass: ReturnType<typeof modelProfile>["class"]): string[] {
  if (modelClass === "small") {
    return [
      "Read at most one target file region before editing.",
      "Make one bounded edit, then stop for verification.",
      "Prefer exact file paths, commands, and acceptance checks over explanatory prose.",
      "If a second file is needed, stop with BLOCKED_NEXT_FILE."
    ];
  }
  if (modelClass === "medium") {
    return [
      "Use the packet facts first; read only the smallest target region you still need.",
      "Make one bounded edit to the allowed file, then stop for verification.",
      "Run the focused verification command yourself before broad tests.",
      "If a second file is needed, stop with BLOCKED_NEXT_FILE instead of editing it."
    ];
  }
  if (modelClass === "large") {
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
