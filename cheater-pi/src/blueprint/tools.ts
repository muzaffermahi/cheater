import { Type } from "typebox";
import { createAutonomousBlueprint } from "./autonomous.js";
import { defaultBlueprintState } from "./state.js";
import { buildPacketExecutionPrompts } from "./executor.js";
import { runFinalBlueprintReview } from "./reviewer.js";
import { scoutOfficialDocs } from "./docsScout.js";
import { blueprintConfig } from "./config.js";
import { persistBlueprintArtifacts } from "./memory.js";
import { sdkFreshAgentPacketRunner, type FreshAgentPacketResult, type FreshAgentPacketRunner } from "./worker.js";
import { formatBlueprintPlanSummary, formatBlueprintCandidates, formatBlueprintPreview, formatFinalReview } from "./ui.js";
import { buildQualityRepairDraft, formatQualityRepairDraft } from "./qualityRepair.js";
import type { CheaterConfig } from "../types.js";
import { LoopGovernor } from "../reliability/loopGovernor.js";
import type { LoopBreakEvent, ToolCallRecord } from "../reliability/types.js";
import type { BlueprintPlan, WorkPacket } from "./types.js";

type ExtensionAPI = any;
type ExtensionContext = any;

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text", text }], details };
}

function finalReviewResult(details: Record<string, unknown> = {}) {
  const plan = defaultBlueprintState.get().currentPlan;
  if (!plan) return textResult("No active Cheater blueprint.", details);
  const review = runFinalBlueprintReview(plan);
  defaultBlueprintState.setReview(review);
  return textResult(formatFinalReview(review), { ...details, autoFinalReview: true, review });
}

function packetDoneIds(plan: BlueprintPlan): Set<string> {
  return new Set(plan.workPackets.filter((packet) => packet.status === "done" || packet.status === "skipped").map((packet) => packet.id));
}

function nextRunnablePendingPacket(plan: BlueprintPlan): WorkPacket | undefined {
  const done = packetDoneIds(plan);
  return plan.workPackets.find((packet) => packet.status === "pending" && packet.dependsOn.every((id) => done.has(id)));
}

function blockingRunState(plan: BlueprintPlan): string | undefined {
  const state = defaultBlueprintState.get();
  if (state.cancelled || plan.approval === "cancelled") return "Blueprint run is cancelled. Create a new blueprint before dispatching more packets.";
  if (plan.approval === "blocked") return "Blueprint run is blocked. Resolve the blocker or create a new blueprint before dispatching packets.";
  if (!plan.qualityGate.passed) return `Blueprint quality gate failed before dispatch. score=${plan.qualityGate.score}; blocking=${plan.qualityGate.blockingIssues.join("; ") || "none"}; warnings=${plan.qualityGate.warnings.join("; ") || "none"}; call cheater_blueprint_quality_repair for a planner-only repair draft.`;
  if (plan.approval === "needs_user") return "Blueprint requires explicit user approval before dispatching packets. Call cheater_blueprint_approve only after the user approves this plan.";
  const failed = plan.workPackets.filter((packet) => packet.status === "failed");
  if (failed.length) return `Blueprint has failed packets and will not continue silently: ${failed.map((packet) => packet.id).join(", ")}. Run cheater_blueprint_review or create a repair plan.`;
  return undefined;
}

function loopRecordsFromResult(result: FreshAgentPacketResult): ToolCallRecord[] {
  if (result.ok) return [];
  return [
    {
      kind: "failed_command",
      value: result.error?.trim() || result.summary.trim() || "packet worker failed"
    }
  ];
}

function assessPacketResultLoop(governor: LoopGovernor, result: FreshAgentPacketResult): LoopBreakEvent | undefined {
  const textLoopBreak = governor.observeText(result.summary);
  if (textLoopBreak?.terminal) return textLoopBreak;

  const records = loopRecordsFromResult(result);
  const summaries = result.ok ? [result.summary] : [result.summary, result.summary];
  const noProgressLoopBreak = governor.observeNoProgress(records, summaries);
  if (noProgressLoopBreak?.terminal) return noProgressLoopBreak;

  return noProgressLoopBreak ?? textLoopBreak;
}

export function registerBlueprintTools(pi: ExtensionAPI, deps: { config: CheaterConfig; packetRunner?: FreshAgentPacketRunner }): void {
  const packetRunner = deps.packetRunner ?? sdkFreshAgentPacketRunner;

  pi.registerTool({
    name: "cheater_blueprint_create",
    label: "Cheater Blueprint Create",
    description: "Create an internal Autonomous Blueprint plan for a complex coding task. Does not edit files.",
    promptSnippet: "cheater_blueprint_create - preview, generate/score candidates, and produce sequential work packets.",
    parameters: Type.Object({
      goal: Type.String({ description: "User goal" }),
      taskType: Type.Optional(Type.String({ description: "Autopilot task kind" }))
    }),
    async execute(_id: string, params: { goal: string; taskType?: string }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const plan = await createAutonomousBlueprint({
        cwd: ctx.cwd,
        userGoal: params.goal,
        taskType: params.taskType,
        plannerSessionId: ctx.sessionId,
        modelName: ctx.model?.id ?? deps.config.model,
        config: deps.config
      });
      defaultBlueprintState.setPlan(plan);
      const artifacts = persistBlueprintArtifacts(ctx.cwd, plan);
      return textResult(`${formatBlueprintPreview(plan)}\n\n${formatBlueprintPlanSummary(plan)}\n\nartifacts:\n${artifacts.markdownPath}\n${artifacts.jsonPath}\n\n${plan.artifactMarkdown}`, { ...plan, artifacts });
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_approve",
    label: "Cheater Blueprint Approve",
    description: "Record explicit user approval for a blueprint that is waiting before dispatch.",
    parameters: Type.Object({
      note: Type.Optional(Type.String({ description: "Short note describing the user's approval." }))
    }),
    async execute(_id: string, params: { note?: string } = {}) {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) return textResult("No active Cheater blueprint.");
      if (defaultBlueprintState.get().cancelled || plan.approval === "cancelled") return textResult("Blueprint run is cancelled. Create a new blueprint before approving.");
      if (plan.approval !== "needs_user") return textResult(`Blueprint does not need approval; current approval state is ${plan.approval}.`, { approval: plan.approval });
      defaultBlueprintState.setApproval("approved");
      return textResult(`Blueprint approved for packet dispatch.${params.note?.trim() ? ` note: ${params.note.trim()}` : ""}`, { approval: "approved" });
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_next_packet",
    label: "Cheater Blueprint Next Packet",
    description: "Advance the active blueprint run by dispatching the next packet in a fresh worker LLM session.",
    parameters: Type.Object({
      completedPacketId: Type.Optional(Type.String({ description: "Packet just completed. If omitted, the current running packet is completed." })),
      summary: Type.Optional(Type.String({ description: "Compact handoff summary for the completed packet." }))
    }),
    async execute(_id: string, params: { completedPacketId?: string; summary?: string } = {}, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      let plan = defaultBlueprintState.get().currentPlan;
      if (!plan) return textResult("No active Cheater blueprint.");
      const summary = params.summary?.trim();
      const running = plan.workPackets.find((packet) => packet.status === "running");
      const completedPacketId = params.completedPacketId ?? (summary ? running?.id : undefined);
      if (completedPacketId) {
        const completed = plan.workPackets.find((packet) => packet.id === completedPacketId);
        if (!completed) return textResult(`Unknown blueprint packet: ${completedPacketId}`);
        if (completed.status === "failed") return textResult(`Blueprint packet ${completedPacketId} is failed and cannot be marked done by next_packet. Run review or create a repair plan.`, { completedPacketId, status: completed.status });
        if (completed.status !== "running" && completed.status !== "done") {
          return textResult(`Blueprint packet ${completedPacketId} is ${completed.status}; next_packet only completes the current running packet.`, { completedPacketId, status: completed.status });
        }
        if (completed && completed.status !== "done") {
          defaultBlueprintState.updatePacket(
            completed.id,
            "done",
            summary || `${completed.title} completed; continue with the next packet.`
          );
          plan = defaultBlueprintState.get().currentPlan;
          if (!plan) return textResult("No active Cheater blueprint.");
        }
      }
      if (running && !completedPacketId) {
        return textResult(`Blueprint packet ${running.id} is already running. Provide a completion summary or call cheater_blueprint_complete_packet before dispatching another packet.`, {
          runningPacketId: running.id,
          status: "running"
        });
      }
      const blocked = blockingRunState(plan);
      if (blocked) return textResult(blocked, { approval: plan.approval, cancelled: defaultBlueprintState.get().cancelled });
      const prompts = buildPacketExecutionPrompts(plan, { ...deps.config, model: ctx.model?.id ?? deps.config.model });
      const pending = nextRunnablePendingPacket(plan);
      const next = pending ? prompts.find((prompt) => prompt.packetId === pending.id) : undefined;
      if (!next) {
        const failedOrRunning = plan.workPackets.filter((packet) => packet.status === "failed" || packet.status === "running");
        const blockedPending = plan.workPackets.filter((packet) => packet.status === "pending");
        if (!blockedPending.length && failedOrRunning.length === 0) {
          return finalReviewResult({ completedPacketId });
        }
        return textResult(pending ? `No execution prompt found for pending packet ${pending.id}.` : "No runnable pending packets. A dependency may still be incomplete.", {
          completedPacketId,
          pendingPacketId: pending?.id,
          blockedPending: blockedPending.map((packet) => ({ id: packet.id, dependsOn: packet.dependsOn, status: packet.status })),
          failedOrRunning: failedOrRunning.map((packet) => ({ id: packet.id, status: packet.status }))
        });
      }
      defaultBlueprintState.updatePacket(next.packetId, "running");
      plan = defaultBlueprintState.get().currentPlan;
      if (!plan) return textResult("No active Cheater blueprint.");
      const packet = plan.workPackets.find((item) => item.id === next.packetId);
      if (!packet) return textResult(`Unknown blueprint packet: ${next.packetId}`);
      const governor = new LoopGovernor(blueprintConfig(deps.config), packet.id);
      const promptLoopCheck = governor.observeText(next.prompt);
      if (promptLoopCheck?.terminal) {
        defaultBlueprintState.updatePacket(packet.id, "failed", promptLoopCheck.reason);
        return textResult(`Loop Governor stopped packet ${packet.id}: ${promptLoopCheck.reason}`, {
          packetId: packet.id,
          completedPacketId,
          status: "failed",
          freshAgent: true,
          loopBreak: promptLoopCheck,
          loopBreaks: governor.history,
          loopBreakTerminal: true
        });
      }
      const result = await packetRunner.runPacket({
        cwd: ctx.cwd,
        plan,
        packet,
        prompt: next.prompt,
        config: deps.config
      });
      const loopBreak = assessPacketResultLoop(governor, result);
      const terminalLoop = loopBreak?.terminal === true;
      const status = result.ok && !terminalLoop ? "done" : "failed";
      const workerSummary = terminalLoop ? `${result.summary}\nLoop Governor stopped packet ${packet.id}: ${loopBreak.reason}` : result.summary;
      defaultBlueprintState.updatePacket(packet.id, status, workerSummary);
      return textResult(
        [
          `Spawned fresh worker session for packet ${packet.id}.`,
          `status: ${status}`,
          result.sessionId ? `session: ${result.sessionId}` : undefined,
          result.sessionFile ? `sessionFile: ${result.sessionFile}` : undefined,
          loopBreak ? `loopBreak: ${loopBreak.reason}${loopBreak.terminal ? " (terminal)" : ""}` : undefined,
          "",
          workerSummary,
          "",
          "Loop Governor: enabled for worker telemetry; repeated reads, failed commands, searches, patches, or no-progress summaries should restart once with a forced single action.",
          "",
          "Planner session must not read or edit files. Call cheater_blueprint_next_packet again to dispatch the next packet."
        ].filter(Boolean).join("\n"),
        {
          packetId: packet.id,
          completedPacketId,
          status,
          freshAgent: true,
          result,
          loopBreak,
          loopBreaks: governor.history,
          loopBreakTerminal: terminalLoop
        }
      );
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_complete_packet",
    label: "Cheater Blueprint Complete Packet",
    description: "Mark the current or named blueprint packet complete with a compact handoff summary.",
    parameters: Type.Object({
      packetId: Type.Optional(Type.String({ description: "Packet to complete. Defaults to the current running packet." })),
      summary: Type.String({ description: "Compact handoff summary of what was learned or changed." }),
      ok: Type.Optional(Type.Boolean({ description: "Whether the packet completed successfully. Defaults to true." }))
    }),
    async execute(_id: string, params: { packetId?: string; summary: string; ok?: boolean }) {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) return textResult("No active Cheater blueprint.");
      if (defaultBlueprintState.get().cancelled || plan.approval === "cancelled") return textResult("Blueprint run is cancelled. Create a new blueprint before completing packets.");
      const running = plan.workPackets.find((packet) => packet.status === "running");
      const packetId = params.packetId ?? running?.id;
      if (!packetId) return textResult("No running blueprint packet to complete.");
      const summary = params.summary.trim();
      if (!summary) return textResult("A non-empty packet summary is required before changing packet status.");
      const packet = plan.workPackets.find((item) => item.id === packetId);
      if (!packet) return textResult(`Unknown blueprint packet: ${packetId}`);
      defaultBlueprintState.updatePacket(packetId, params.ok === false ? "failed" : "done", summary);
      return textResult(`Marked blueprint packet ${packetId} ${params.ok === false ? "failed" : "done"}.`, {
        packetId,
        status: params.ok === false ? "failed" : "done"
      });
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_execute_as_pi_prompts",
    label: "Cheater Blueprint Execute As Pi Prompts",
    description: "Legacy same-session packet prompt execution is permanently disabled; Blueprint packets must use fresh workers.",
    parameters: Type.Object({}),
    async execute() {
      return textResult(
        "Legacy same-session packet prompt execution is disabled. Use cheater_blueprint_next_packet so each packet runs in a fresh worker LLM session.",
        { freshAgentRequired: true, alwaysFreshWorkers: true }
      );
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_review",
    label: "Cheater Blueprint Review",
    description: "Run final Autonomous Blueprint reviewer over the active plan.",
    parameters: Type.Object({}),
    async execute() {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) return textResult("No active Cheater blueprint.");
      const review = runFinalBlueprintReview(plan);
      defaultBlueprintState.setReview(review);
      return textResult(formatFinalReview(review), review);
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_quality_repair",
    label: "Cheater Blueprint Quality Repair",
    description: "Build a planner-only repair draft from the active Blueprint quality gate blockers and remediations.",
    parameters: Type.Object({}),
    async execute() {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) return textResult("No active Cheater blueprint.");
      const draft = buildQualityRepairDraft(plan);
      return textResult(formatQualityRepairDraft(draft), draft);
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_candidates",
    label: "Cheater Blueprint Candidates",
    description: "Show internal blueprint candidate scores for debugging.",
    parameters: Type.Object({}),
    async execute() {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) return textResult("No active Cheater blueprint.");
      return textResult(formatBlueprintCandidates(plan), { candidates: plan.candidates, scores: plan.scores });
    }
  });

  pi.registerTool({
    name: "cheater_blueprint_docs",
    label: "Cheater Blueprint Docs",
    description: "Search local/official docs facts using the configured official-only docs provider.",
    parameters: Type.Object({
      query: Type.String(),
      packageOrLibrary: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: { query: string; packageOrLibrary?: string }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const facts = await scoutOfficialDocs({
        cwd: ctx.cwd,
        query: params.query,
        packageOrLibrary: params.packageOrLibrary,
        config: blueprintConfig(deps.config)
      });
      return textResult(facts.map((fact) => `${fact.sourceTitle}: ${fact.claim} (${fact.sourceUrl})`).join("\n") || "No docs facts found.", { facts });
    }
  });
}
