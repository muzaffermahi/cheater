import { createAutonomousBlueprint } from "./autonomous.js";
import { defaultBlueprintState } from "./state.js";
import { runFinalBlueprintReview } from "./reviewer.js";
import { scoutOfficialDocs } from "./docsScout.js";
import { blueprintConfig } from "./config.js";
import { persistBlueprintArtifacts, retrievePlanningMemory } from "./memory.js";
import { runBlueprintEval, summarizeEval } from "./evalHarness.js";
import { buildQualityRepairDraft, formatQualityRepairDraft } from "./qualityRepair.js";
import { repoOrientationFromMissionFacts } from "./contextSketch.js";
import { scanOrientation } from "../mission/orientation.js";
import {
  formatBlueprintCandidates,
  formatBlueprintDebug,
  formatBlueprintPlanSummary,
  formatBlueprintRunState,
  formatFinalReview
} from "./ui.js";
import type { CheaterConfig } from "../types.js";

type ExtensionAPI = any;
type CommandContext = any;

function widget(ctx: CommandContext, key: string, text: string, level: "info" | "warning" = "info"): void {
  ctx.ui.notify(text.split("\n")[0], level);
  ctx.ui.setWidget?.(key, text.split("\n").slice(0, 100), { placement: "aboveEditor" });
}

export function registerBlueprintCommands(pi: ExtensionAPI, deps: { config: CheaterConfig }): void {
  pi.registerCommand("blueprint-show", {
    description: "Show the current internal Autonomous Blueprint plan",
    handler: async (_args: string, ctx: CommandContext) => {
      widget(ctx, "cheater-blueprint", formatBlueprintRunState(defaultBlueprintState.get()));
    }
  });

  pi.registerCommand("blueprint-candidates", {
    description: "Show internal blueprint candidate scores",
    handler: async (_args: string, ctx: CommandContext) => {
      const plan = defaultBlueprintState.get().currentPlan;
      widget(ctx, "cheater-blueprint", plan ? formatBlueprintCandidates(plan) : "No active Cheater blueprint.");
    }
  });

  pi.registerCommand("blueprint-step", {
    description: "Debug: dispatch the next blueprint packet through a fresh worker",
    handler: async (_args: string, ctx: CommandContext) => {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) {
        widget(ctx, "cheater-blueprint", "No active Cheater blueprint.", "warning");
        return;
      }
      const pending = plan.workPackets.find((packet) => packet.status === "pending");
      if (!pending) {
        widget(ctx, "cheater-blueprint", "No pending blueprint packet.", "warning");
        return;
      }
      pi.sendUserMessage("Cheater /blueprint-step: call cheater_blueprint_next_packet now. Do not paste or execute packet prompts in this planner session; the tool must dispatch a fresh worker session.");
      widget(ctx, "cheater-blueprint", `Requested fresh-worker dispatch for blueprint packet ${pending.id}.`);
    }
  });

  pi.registerCommand("blueprint-review", {
    description: "Run final Autonomous Blueprint review",
    handler: async (_args: string, ctx: CommandContext) => {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) {
        widget(ctx, "cheater-blueprint", "No active Cheater blueprint.", "warning");
        return;
      }
      const review = runFinalBlueprintReview(plan);
      defaultBlueprintState.setReview(review);
      widget(ctx, "cheater-blueprint", formatFinalReview(review), review.accepted ? "info" : "warning");
    }
  });

  pi.registerCommand("blueprint-quality-repair", {
    description: "Show planner-only repair draft for quality-gate blockers",
    handler: async (_args: string, ctx: CommandContext) => {
      const plan = defaultBlueprintState.get().currentPlan;
      if (!plan) {
        widget(ctx, "cheater-blueprint", "No active Cheater blueprint.", "warning");
        return;
      }
      widget(ctx, "cheater-blueprint-quality-repair", formatQualityRepairDraft(buildQualityRepairDraft(plan)), plan.qualityGate.passed ? "info" : "warning");
    }
  });

  pi.registerCommand("blueprint-debug", {
    description: "Show blueprint graph, packet statuses, and failures",
    handler: async (_args: string, ctx: CommandContext) => {
      const plan = defaultBlueprintState.get().currentPlan;
      widget(ctx, "cheater-blueprint", plan ? formatBlueprintDebug(plan) : "No active Cheater blueprint.");
    }
  });

  pi.registerCommand("blueprint-eval", {
    description: "Debug: run the blueprint eval harness comparing worker-context variants for the current goal",
    handler: async (_args: string, ctx: CommandContext) => {
      const plan = defaultBlueprintState.get().currentPlan;
      const goal = plan?.userGoal ?? _args.trim();
      if (!goal) {
        widget(ctx, "cheater-blueprint-eval", "Usage: /blueprint-eval <goal> (or run with an active blueprint)", "warning");
        return;
      }
      const orientation = repoOrientationFromMissionFacts(scanOrientation(ctx.cwd));
      const expectedFiles = plan ? [...new Set(plan.workPackets.flatMap((p) => p.filesToTouch.map((f) => f.path)))].filter((f) => f && !f.startsWith("(") && !f.endsWith("/")) : [];
      const results = await runBlueprintEval({
        cwd: ctx.cwd,
        orientation,
        task: { goal, taskType: plan?.preview.taskType, expectedFiles, expectedTests: [], modelName: ctx.model?.id ?? deps.config.model }
      });
      widget(ctx, "cheater-blueprint-eval", summarizeEval(results));
    }
  });

  pi.registerCommand("blueprint-cancel", {
    description: "Cancel the current internal blueprint run",
    handler: async (_args: string, ctx: CommandContext) => {
      defaultBlueprintState.cancel();
      widget(ctx, "cheater-blueprint", "Cheater Blueprint cancelled.");
    }
  });

  pi.registerCommand("blueprint-approve", {
    description: "Approve the current Autonomous Blueprint plan for packet dispatch",
    handler: async (args: string, ctx: CommandContext) => {
      const state = defaultBlueprintState.get();
      const plan = state.currentPlan;
      if (!plan) {
        widget(ctx, "cheater-blueprint", "No active Cheater blueprint.", "warning");
        return;
      }
      if (state.cancelled || plan.approval === "cancelled") {
        widget(ctx, "cheater-blueprint", "Blueprint run is cancelled. Create a new blueprint before approving.", "warning");
        return;
      }
      if (plan.approval !== "needs_user") {
        widget(ctx, "cheater-blueprint", `Blueprint does not need approval; current approval state is ${plan.approval}.`);
        return;
      }
      defaultBlueprintState.setApproval("approved");
      const note = args.trim();
      widget(ctx, "cheater-blueprint", `Cheater Blueprint approved.${note ? ` note: ${note}` : ""}`);
    }
  });

  pi.registerCommand("blueprint-force", {
    description: "Force Autonomous Blueprint mode for a goal",
    handler: async (args: string, ctx: CommandContext) => {
      const goal = args.trim();
      if (!goal) {
        widget(ctx, "cheater-blueprint", "Usage: /blueprint-force <goal>", "warning");
        return;
      }
      const plan = await createAutonomousBlueprint({ cwd: ctx.cwd, userGoal: goal, plannerSessionId: ctx.sessionId, modelName: ctx.model?.id ?? deps.config.model, config: deps.config });
      defaultBlueprintState.setPlan(plan);
      persistBlueprintArtifacts(ctx.cwd, plan);
      widget(ctx, "cheater-blueprint", formatBlueprintPlanSummary(plan));
      pi.sendUserMessage("Cheater /blueprint-force: call cheater_blueprint_next_packet to dispatch the next packet in a fresh worker session. Do not execute multiple packet prompts in this planner session.");
    }
  });

  pi.registerCommand("blueprint-docs", {
    description: "Search configured official/local docs facts",
    handler: async (args: string, ctx: CommandContext) => {
      const query = args.trim();
      if (!query) {
        widget(ctx, "cheater-blueprint-docs", "Usage: /blueprint-docs <query>", "warning");
        return;
      }
      const facts = await scoutOfficialDocs({ cwd: ctx.cwd, query, config: blueprintConfig(deps.config) });
      widget(ctx, "cheater-blueprint-docs", facts.map((fact) => `${fact.sourceTitle}: ${fact.claim}`).join("\n") || "No docs facts found.");
    }
  });

  pi.registerCommand("blueprint-memory", {
    description: "Show blueprint planning memories for a query",
    handler: async (args: string, ctx: CommandContext) => {
      const query = args.trim() || defaultBlueprintState.get().currentPlan?.userGoal || "";
      if (!query) {
        widget(ctx, "cheater-blueprint-memory", "No blueprint memory query available.", "warning");
        return;
      }
      const hits = retrievePlanningMemory(ctx.cwd, query, blueprintConfig(deps.config).blueprintMemoryEnabled);
      widget(ctx, "cheater-blueprint-memory", hits.map((hit) => `${hit.id}: ${hit.summary}`).join("\n") || "No blueprint memories found.");
    }
  });
}
