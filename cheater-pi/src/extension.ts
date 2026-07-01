import { CHEATER_SYSTEM_PROMPT } from "./prompts.js";
import { registerCheaterCommands } from "./commands.js";
import { registerCheaterTools, saveMemory } from "./tools.js";
import { startupCard } from "./ui.js";
import { loadConfig } from "./config.js";
import { registerAutopilotCommands } from "./autopilot/commands.js";
import { registerAutopilotTools } from "./autopilot/tools.js";
import { routeAutopilot, buildAutopilotInstruction } from "./autopilot/router.js";
import { defaultAutopilotState } from "./autopilot/status.js";
import { formatAutopilotDecision } from "./autopilot/ui.js";
import { registerBlueprintCommands } from "./blueprint/commands.js";
import { registerBlueprintTools } from "./blueprint/tools.js";
import { defaultBlueprintState } from "./blueprint/state.js";
import { compactThresholdTokens, effectiveAgentTokenCap, isBlueprintWorkerSession } from "./blueprint/worker.js";
import { defaultMissionStore } from "./mission/store.js";
import { registerMissionCommands } from "./mission/commands.js";
import { registerMissionTools } from "./mission/tools.js";
import { registerGymCommands } from "./gym/commands.js";
import { registerReliabilityCommands } from "./reliability/commands.js";
import { registerCommitletCommands } from "./commitlet/commands.js";
import { registerCommitletTools } from "./commitlet/tools.js";
import { defaultCommitletState } from "./commitlet/state.js";

type ExtensionAPI = any;

const PLANNER_BLOCKED_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls", "bash"]);
const EDIT_TOOLS = new Set(["edit", "write", "cheater_line_edit"]);

function cheaterCapPrompt(cap: number, threshold: number): string {
  return [
    `CHEATER HARD SESSION CAP: keep this LLM session under ${cap} context tokens.`,
    `When estimated context reaches ${threshold} tokens, compact immediately or stop with a compact handoff.`,
    "In blueprint_orchestrator mode, the current session is the planner only: it must not read, grep, list, shell, edit, or write project files.",
    "Use cheater_blueprint_create, then cheater_blueprint_next_packet. Each packet/file change must run in a fresh worker LLM session and stop after its packet.",
    "One file change means one worker. If a second file is needed, stop and dispatch another fresh worker with new context."
  ].join("\n");
}

export default function cheaterExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const agentTokenCap = effectiveAgentTokenCap(config);
  const defaultCompactThreshold = compactThresholdTokens(config);

  registerCheaterCommands(pi);
  registerCheaterTools(pi);
  if (config.autopilotEnabled !== false) {
    registerAutopilotCommands(pi);
    registerAutopilotTools(pi);
  }
  if (config.blueprintModeEnabled !== false) {
    registerBlueprintCommands(pi, { config });
    registerBlueprintTools(pi, { config });
  }
  if (config.commitletModeEnabled !== false) {
    registerCommitletCommands(pi);
    registerCommitletTools(pi, { config });
  }

  if (config.missionControlEnabled !== false) {
    const store = defaultMissionStore({ cwd: process.cwd() });
    registerMissionCommands(pi, {
      store,
      config,
      getCwd: (ctx) => ctx.cwd,
      saveProjectMemory: (cwd, text) => saveMemory(cwd, text)
    });
    registerMissionTools(pi, { store, config });
  }

  if (config.gymEnabled !== false) {
    registerGymCommands(pi, {
      config,
      getCwd: (ctx) => ctx.cwd
    });
  }
  if (config.reliabilityModeEnabled !== false) {
    registerReliabilityCommands(pi, { config });
  }

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    ctx.ui.setTitle?.(`Cheater - ${ctx.cwd}`);
    ctx.ui.setStatus?.("cheater", ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "Cheater") : "Cheater");
    ctx.ui.setWidget?.("cheater-startup", startupCard(ctx.cwd, ctx.model?.id), { placement: "aboveEditor" });
    ctx.ui.notify?.("Cheater mode active", "info");
  });

  pi.on("before_user_message", async (event: { message?: string; text?: string }, ctx: any) => {
    if (config.autopilotEnabled === false || config.autopilotRouteAllCodeTasks === false) return {};
    const message = (event.message ?? event.text ?? "").trim();
    if (!message || message.startsWith("/")) return {};
    const decision = routeAutopilot({ cwd: ctx.cwd, message });
    defaultAutopilotState.setDecision(message, decision);
    ctx.ui.setWidget?.("cheater-autopilot", formatAutopilotDecision(decision).split("\n"), { placement: "aboveEditor" });
    ctx.ui.notify?.(decision.userVisibleSummary, "info");
    return {
      message: buildAutopilotInstruction(decision, message)
    };
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: any) => {
    const usage = ctx.getContextUsage?.();
    const cap = effectiveAgentTokenCap(config, usage?.contextWindow);
    const threshold = compactThresholdTokens(config, usage?.contextWindow);
    const shouldCompact = typeof usage?.tokens === "number" && usage.tokens >= threshold;
    if (shouldCompact) {
      ctx.compact?.({
        customInstructions: [
          `Cheater session reached the ${threshold}/${cap} token compaction threshold.`,
          "Preserve the user goal, current mode, active blueprint packet statuses, files touched, verification results, and blockers.",
          "Drop repeated file reads, stale tool outputs, and duplicated planner narration."
        ].join(" ")
      });
      ctx.ui.notify?.(`Cheater requested compaction at ${usage.tokens} tokens (threshold ${threshold}, cap ${cap}).`, "warning");
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${CHEATER_SYSTEM_PROMPT}\n\n${cheaterCapPrompt(cap || agentTokenCap, threshold || defaultCompactThreshold)}`,
      message: shouldCompact ? {
        customType: "cheater-context-cap",
        content: `Cheater requested compaction because this session reached ${threshold} tokens.`,
        display: true,
        details: usage
      } : undefined
    };
  });

  pi.on("tool_call", async (event: { toolName: string }, _ctx: any) => {
    const commitletBlock = blockCommitletScopeViolation(event);
    if (commitletBlock) return commitletBlock;
    if (config.blueprintBlockPlannerFileTools === false) return {};
    if (isBlueprintWorkerSession()) return {};
    const plan = defaultBlueprintState.get().currentPlan;
    const activeBlueprint = Boolean(plan && plan.workPackets.some((packet) => packet.status === "pending" || packet.status === "running"));
    if (!activeBlueprint || !PLANNER_BLOCKED_TOOLS.has(event.toolName)) return {};
    return {
      block: true,
      reason: "Cheater blueprint planner sessions cannot use file or shell tools. Call cheater_blueprint_next_packet to spawn a fresh worker LLM session for the next packet/file change."
    };
  });
}

export function blockCommitletScopeViolation(event: any): { block: boolean; reason: string } | undefined {
  if (!EDIT_TOOLS.has(event.toolName)) return undefined;
  const plan = defaultCommitletState.get().currentPlan;
  const running = plan?.commitlets.find((commitlet) => commitlet.status === "running");
  if (!running) return undefined;
  const path = String(event.path ?? event.file ?? event.filePath ?? event.args?.path ?? event.params?.path ?? "");
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/");
  const allowed = running.allowedFiles.some((file) => !file.startsWith("(") && (normalized === file || normalized.endsWith(`/${file}`)));
  if (!allowed) {
    return {
      block: true,
      reason: `Cheater Commitlet guard blocked ${event.toolName} outside allowed files for ${running.id}. Allowed: ${running.allowedFiles.join(", ") || "(none)"}`
    };
  }
  if (running.forbiddenFiles.some((file) => normalized === file || normalized.endsWith(`/${file}`))) {
    return {
      block: true,
      reason: `Cheater Commitlet guard blocked ${event.toolName} on forbidden file for ${running.id}: ${path}`
    };
  }
  return undefined;
}
