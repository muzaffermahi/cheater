import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { repairMissingSentinelPrompt, sentinelFor } from "../reliability/sentinels.js";
import type { ReliabilityPacketOutputFormat } from "../reliability/types.js";
import { createCheaterLineEditTool } from "../tools.js";
import type { CheaterConfig } from "../types.js";
import { blueprintConfig } from "./config.js";
import type { BlueprintPlan, WorkPacket } from "./types.js";

export interface FreshAgentPacketResult {
  ok: boolean;
  summary: string;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
}

export interface FreshAgentPacketRunner {
  runPacket(params: {
    cwd: string;
    plan: BlueprintPlan;
    packet: WorkPacket;
    prompt: string;
    config: CheaterConfig;
  }): Promise<FreshAgentPacketResult>;
}

let workerDepth = 0;

export function isBlueprintWorkerSession(): boolean {
  return workerDepth > 0;
}

export function isIsolatedWorkerSession(): boolean {
  return workerDepth > 0;
}

export async function withIsolatedWorker<T>(fn: () => Promise<T>): Promise<T> {
  workerDepth += 1;
  try {
    return await fn();
  } finally {
    workerDepth -= 1;
  }
}

export function effectiveAgentTokenCap(config: CheaterConfig = {}, modelContextWindow?: number): number {
  const requested = Math.trunc(config.maxContextTokens ?? config.blueprintMaxAgentTokens ?? 100000);
  const blueprintRequested = Math.trunc(config.blueprintMaxAgentTokens ?? requested);
  const configured = Number.isFinite(requested) && requested > 0 ? requested : 100000;
  const blueprintCap = Number.isFinite(blueprintRequested) && blueprintRequested > 0 ? blueprintRequested : configured;
  const modelCap = modelContextWindow && modelContextWindow > 0 ? Math.trunc(modelContextWindow) : Number.POSITIVE_INFINITY;
  return Math.max(1024, Math.min(100000, Math.max(8000, configured), Math.max(8000, blueprintCap), modelCap));
}

export function contextCompactRatio(config: CheaterConfig = {}): number {
  const ratio = Number(config.contextCompactRatio ?? 0.85);
  if (!Number.isFinite(ratio)) return 0.85;
  return Math.max(0.5, Math.min(0.95, ratio));
}

export function compactThresholdTokens(config: CheaterConfig = {}, modelContextWindow?: number): number {
  return Math.floor(effectiveAgentTokenCap(config, modelContextWindow) * contextCompactRatio(config));
}

export function compactSettingsForCap(contextWindow: number | undefined, cap: number, threshold = Math.floor(cap * 0.85)) {
  const window = contextWindow && contextWindow > 0 ? contextWindow : cap + 32768;
  const reserveTokens = Math.max(8192, window - threshold);
  const keepRecentTokens = Math.min(12000, Math.max(4000, Math.floor(cap / 6)));
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens
  };
}

function workerPrompt(plan: BlueprintPlan, packet: WorkPacket, prompt: string, cap: number, sentinel: string): string {
  const files = packet.filesToTouch.map((file) => file.path).join(", ") || "(none)";
  return [
    "CHEATER FRESH WORKER SESSION",
    "",
    `Global goal: ${plan.userGoal}`,
    `Packet: ${packet.id} - ${packet.title}`,
    `Packet type: ${packet.type}`,
    `Allowed files for this packet: ${files}`,
    `Hard token cap for this worker: ${cap}`,
    `Required packet end sentinel: ${sentinel}`,
    "",
    "Rules:",
    "- You are the code-changing worker, not the planner.",
    "- Execute only this one packet, then stop. You are not allowed to roll into the next file.",
    "- Do not call cheater_blueprint_create, cheater_blueprint_next_packet, or cheater_blueprint_execute_as_pi_prompts.",
    "- If this packet touches a file, do not inspect or edit unrelated sibling templates/styles/source files.",
    "- If another file seems necessary, stop with BLOCKED_NEXT_FILE instead of editing it; the planner will summon a new fresh worker.",
    "- For existing files, read the exact target lines and use cheater_line_edit or the smallest Pi edit.",
    "- Do not rewrite an entire existing template, stylesheet, or source file unless the packet explicitly requires full replacement.",
    "- If context pressure approaches the cap, compact once. If still pressured, stop with a compact handoff summary.",
    "- End with PACKET_RESULT, SUMMARY, FILES_TOUCHED, and VERIFY lines.",
    `- Your final assistant message must end with exactly this required packet end sentinel: ${sentinel}`,
    "",
    prompt
  ].join("\n");
}

function packetSessionId(packet: WorkPacket): string {
  const safeId = packet.id.replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 48) || "packet";
  return `cheater-${safeId}-${Date.now().toString(36)}`;
}

function compactText(text: string | undefined, fallback: string): string {
  const cleaned = (text ?? "").trim().replace(/\n{3,}/g, "\n\n");
  if (!cleaned) return fallback;
  return cleaned.length <= 1600 ? cleaned : `${cleaned.slice(0, 1600)}\n...`;
}

function outputFormatFor(packet: WorkPacket): ReliabilityPacketOutputFormat {
  if (packet.type === "review") return "review";
  if (packet.type === "implement" || packet.type === "repair") return "patch";
  return "json";
}

function hasEndingSentinel(text: string | undefined, sentinel: string): boolean {
  return (text ?? "").trimEnd().endsWith(sentinel);
}

function compactSentinelBody(text: string | undefined, sentinel: string, fallback: string): string {
  const trimmed = (text ?? "").trimEnd();
  const body = trimmed.endsWith(sentinel) ? trimmed.slice(0, -sentinel.length).trimEnd() : trimmed;
  return compactText(body, fallback);
}

export const sdkFreshAgentPacketRunner: FreshAgentPacketRunner = {
  async runPacket({ cwd, plan, packet, prompt, config }) {
    if (config.packetOneFilePerWorkerEnabled !== false && packet.filesToTouch.length > (config.packetMaxFilesToTouch ?? 1)) {
      return {
        ok: false,
        summary: `Packet ${packet.id} violates one-file-per-worker discipline: ${packet.filesToTouch.map((file) => file.path).join(", ")}`,
        error: "packet_scope_too_broad"
      };
    }
    return withIsolatedWorker(async () => {
      const requiredSentinel = sentinelFor(outputFormatFor(packet), blueprintConfig(config));
      const cap = effectiveAgentTokenCap(config);
      const threshold = compactThresholdTokens(config);
      const settingsManager = SettingsManager.inMemory({
        compaction: compactSettingsForCap(undefined, cap, threshold),
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time"
      }, { projectTrusted: true });
      const sessionManager = SessionManager.create(cwd, undefined, { id: packetSessionId(packet) });
      const { session } = await createAgentSession({
        cwd,
        sessionManager,
        settingsManager,
        tools: ["read", "edit", "bash", "grep", "find", "ls", "cheater_line_edit"],
        customTools: [createCheaterLineEditTool()]
      });
      try {
        const contextWindow = session.model?.contextWindow;
        const effectiveCap = effectiveAgentTokenCap(config, contextWindow);
        const effectiveThreshold = compactThresholdTokens(config, contextWindow);
        session.settingsManager.applyOverrides({
          compaction: compactSettingsForCap(contextWindow, effectiveCap, effectiveThreshold),
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time"
        });
        session.setAutoCompactionEnabled(true);
        session.setSessionName(`Cheater worker ${packet.id}`);
        await session.prompt(workerPrompt(plan, packet, prompt, effectiveCap, requiredSentinel), { source: "extension" });
        let assistantText = session.getLastAssistantText();
        if (!hasEndingSentinel(assistantText, requiredSentinel)) {
          await session.prompt(repairMissingSentinelPrompt(assistantText ?? "", requiredSentinel), { source: "extension" });
          assistantText = session.getLastAssistantText();
        }
        if (!hasEndingSentinel(assistantText, requiredSentinel)) {
          const lastOutput = compactText(assistantText, "(no assistant output)");
          return {
            ok: false,
            summary: `Worker session for ${packet.id} did not return the required end sentinel ${requiredSentinel} after one repair attempt. Last output: ${lastOutput}`,
            error: `missing_packet_end_sentinel:${requiredSentinel}`,
            sessionId: session.sessionId,
            sessionFile: session.sessionFile
          };
        }
        return {
          ok: true,
          summary: compactSentinelBody(assistantText, requiredSentinel, `${packet.title} completed.`),
          sessionId: session.sessionId,
          sessionFile: session.sessionFile
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Worker session failed for ${packet.id}: ${(err as Error).message}`,
          error: (err as Error).message,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile
        };
      } finally {
        session.dispose();
      }
    });
  }
};
