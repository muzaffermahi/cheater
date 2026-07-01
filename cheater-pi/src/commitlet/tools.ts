import { Type } from "typebox";
import { routeAutopilot } from "../autopilot/router.js";
import { createAutonomousBlueprint } from "../blueprint/autonomous.js";
import { defaultBlueprintState } from "../blueprint/state.js";
import { createCleanupCommitlet, createCommitletPlan, createRepairCommitlet } from "./planner.js";
import { commitletConfig } from "./config.js";
import { defaultCommitletState } from "./state.js";
import { buildCommitletExecutionPrompt, prepareCommitlet } from "./executor.js";
import { runDiffGuard } from "./guard.js";
import { scorePatchHealth } from "./health.js";
import { auditTestChanges } from "./testAudit.js";
import { runCommitletFinalReview } from "./reviewer.js";
import { formatCommitletFinalReview, formatCommitletPlan, formatGuardHealthAudit } from "./ui.js";
import { telemetryFromPlan, writeTelemetry } from "./telemetry.js";
import { cleanupOldRollbackSnapshots, listRollbackSnapshotFiles, revertRollbackPoint } from "./rollback.js";
import { runFocusedVerification } from "./verification.js";
import { buildRepoConstraintGraph, queryConstraintFacts } from "./constraintGraph.js";
import { latestReliabilityBenchmark, compareReliabilityBenchmark } from "../reliability/bench.js";
import type { CheaterConfig } from "../types.js";

type ExtensionAPI = any;
type ExtensionContext = any;

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text", text }], details };
}

export function registerCommitletTools(pi: ExtensionAPI, deps: { config: CheaterConfig }): void {
  pi.registerTool({
    name: "cheater_commitlet_plan",
    label: "Cheater Commitlet Plan",
    description: "Create a Reliability Kernel commitlet plan. Does not edit files.",
    parameters: Type.Object({
      userGoal: Type.String(),
      useActiveBlueprint: Type.Optional(Type.Boolean())
    }),
    async execute(_id: string, params: { userGoal: string; useActiveBlueprint?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const decision = routeAutopilot({ cwd: ctx.cwd, message: params.userGoal });
      const activeBlueprint = params.useActiveBlueprint === false
        ? undefined
        : defaultBlueprintState.get().currentPlan ?? undefined;
      const blueprintPlan = activeBlueprint ?? (decision.executionMode === "blueprint_orchestrator" || decision.needsBlueprint
        ? await createAutonomousBlueprint({
          cwd: ctx.cwd,
          userGoal: params.userGoal,
          taskType: decision.taskKind,
          modelName: ctx.model?.id ?? deps.config.model,
          config: deps.config
        })
        : undefined);
      if (blueprintPlan && blueprintPlan !== activeBlueprint) defaultBlueprintState.setPlan(blueprintPlan);

      const plan = createCommitletPlan({
        repoRoot: ctx.cwd,
        userGoal: params.userGoal,
        autopilotDecision: decision,
        blueprintPlan
      });
      defaultCommitletState.setPlan(plan);
      return textResult(formatCommitletPlan(plan), plan);
    }
  });

  pi.registerTool({
    name: "cheater_reliability_start",
    label: "Cheater Reliability Start",
    description: "Route autopilot, create a commitlet plan, prepare the first commitlet with rollback, and return a fresh-call prompt.",
    parameters: Type.Object({
      userGoal: Type.String(),
      useActiveBlueprint: Type.Optional(Type.Boolean())
    }),
    async execute(_id: string, params: { userGoal: string; useActiveBlueprint?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const decision = routeAutopilot({ cwd: ctx.cwd, message: params.userGoal });
      const decisionSummary = [
        `mode=${decision.executionMode}`,
        `discipline=${decision.executionDiscipline}`,
        `task=${decision.taskKind}`,
        `risk=${decision.risk}`,
        `confidence=${decision.confidence.toFixed(2)}`,
        decision.userVisibleSummary
      ].join("; ");

      if (decision.executionMode === "answer_only" || decision.executionDiscipline === "none") {
        return textResult([
          "Cheater Reliability Start: no edits.",
          `autopilot: ${decisionSummary}`,
          `reason: ${decision.reason}`
        ].join("\n"), { decision, noEdit: true });
      }

      const activeBlueprint = params.useActiveBlueprint === false
        ? undefined
        : defaultBlueprintState.get().currentPlan ?? undefined;
      const blueprintPlan = activeBlueprint ?? (decision.executionMode === "blueprint_orchestrator" || decision.needsBlueprint
        ? await createAutonomousBlueprint({
          cwd: ctx.cwd,
          userGoal: params.userGoal,
          taskType: decision.taskKind,
          modelName: ctx.model?.id ?? deps.config.model,
          config: deps.config
        })
        : undefined);
      if (blueprintPlan && blueprintPlan !== activeBlueprint) defaultBlueprintState.setPlan(blueprintPlan);

      const plan = createCommitletPlan({
        repoRoot: ctx.cwd,
        userGoal: params.userGoal,
        autopilotDecision: decision,
        blueprintPlan
      });
      defaultCommitletState.setPlan(plan);

      const index = plan.commitlets.findIndex((commitlet) => commitlet.status === "pending");
      const next = index >= 0 ? plan.commitlets[index] : undefined;
      if (!next) {
        return textResult([
          "Cheater Reliability Start: no pending commitlets.",
          `autopilot: ${decisionSummary}`,
          `plan: ${plan.summary}`
        ].join("\n"), { decision, plan });
      }

      const prepared = prepareCommitlet(ctx.cwd, next);
      const commitlets = plan.commitlets.map((commitlet) => commitlet.id === next.id ? prepared : commitlet);
      const updated = { ...plan, status: "running" as const, currentIndex: index, commitlets };
      defaultCommitletState.setPlan(updated);
      const prompt = buildCommitletExecutionPrompt(updated, prepared);

      return textResult([
        "Cheater Reliability Start",
        `autopilot: ${decisionSummary}`,
        `plan: ${updated.summary}${updated.blueprintPlanId ? ` blueprint=${updated.blueprintPlanId}` : ""}`,
        `commitlets: ${updated.commitlets.length}`,
        `first: ${prepared.title}`,
        `allowedFiles: ${prepared.allowedFiles.join(", ") || "(inspect only)"}`,
        `rollback: ${prepared.rollbackPoint?.id ?? "(none)"}`,
        "",
        "fresh-call prompt:",
        prompt.prompt
      ].join("\n"), { decision, plan: updated, commitlet: prepared, prompt });
    }
  });

  pi.registerTool({
    name: "cheater_commitlet_next",
    label: "Cheater Commitlet Next",
    description: "Prepare the next commitlet with rollback and return a fresh-call execution prompt.",
    parameters: Type.Object({
      completedCommitletId: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: { completedCommitletId?: string; summary?: string } = {}, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      let plan = defaultCommitletState.get().currentPlan;
      if (!plan) return textResult("No active Cheater commitlet plan.");
      if (params.completedCommitletId) {
        defaultCommitletState.updateCommitlet(params.completedCommitletId, "passed", params.summary ?? "Commitlet completed.");
        plan = defaultCommitletState.get().currentPlan;
        if (!plan) return textResult("No active Cheater commitlet plan.");
      }
      const index = plan.commitlets.findIndex((commitlet) => commitlet.status === "pending");
      const next = index >= 0 ? plan.commitlets[index] : undefined;
      if (!next) {
        const review = runCommitletFinalReview(plan);
        const updated = { ...plan, finalReview: review, status: review.accepted ? "complete" as const : "failed" as const };
        defaultCommitletState.setPlan(updated);
        const telemetryFile = deps.config.telemetryEnabled === false ? undefined : writeTelemetry(ctx.cwd, telemetryFromPlan(updated));
        return textResult([
          "No pending commitlets. Ran automatic final review.",
          formatCommitletFinalReview(review)
        ].join("\n"), { review, telemetryFile, plan: updated });
      }
      const prepared = prepareCommitlet(ctx.cwd, next);
      const commitlets = plan.commitlets.map((commitlet) => commitlet.id === next.id ? prepared : commitlet);
      const updated = { ...plan, status: "running" as const, currentIndex: index, commitlets };
      defaultCommitletState.setPlan(updated);
      const prompt = buildCommitletExecutionPrompt(updated, prepared, plan.commitlets.filter((commitlet) => commitlet.result?.summary).map((commitlet) => `${commitlet.id}: ${commitlet.result?.summary}`));
      return textResult([
        `Running commitlet ${index + 1}/${plan.commitlets.length}: ${prepared.title}`,
        `Allowed files: ${prepared.allowedFiles.join(", ") || "(inspect only)"}`,
        `Rollback: ${prepared.rollbackPoint?.id}`,
        "",
        prompt.prompt
      ].join("\n"), { commitlet: prepared, prompt });
    }
  });

  pi.registerTool({
    name: "cheater_commitlet_guard",
    label: "Cheater Commitlet Guard",
    description: "Run diff guard, patch health score, and test audit for a commitlet.",
    parameters: Type.Object({
      commitletId: Type.String(),
      touchedFiles: Type.Array(Type.String()),
      diffText: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: { commitletId: string; touchedFiles: string[]; diffText?: string }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const plan = defaultCommitletState.get().currentPlan;
      const commitlet = plan?.commitlets.find((item) => item.id === params.commitletId);
      if (!plan || !commitlet) return textResult(`Unknown commitlet: ${params.commitletId}`);
      const guard = runDiffGuard(commitlet, { touchedFiles: params.touchedFiles, diffText: params.diffText });
      const health = scorePatchHealth({
        diffText: params.diffText,
        filesTouched: params.touchedFiles,
        threshold: deps.config.healthScoreThreshold,
        hardRejectThreshold: deps.config.hardRejectHealthThreshold
      });
      const audit = params.touchedFiles.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file))
        ? auditTestChanges(params.diffText ?? "", commitlet.spec?.acceptanceCriteria ?? [])
        : { passed: true, warnings: [], blockingIssues: [] };
      const ok = guard.passed && health.passed && audit.passed;
      defaultCommitletState.updateCommitlet(commitlet.id, ok ? "passed" : "failed", ok ? "Guard, health, and test audit passed." : [...guard.blockingIssues, ...health.blockingIssues, ...audit.blockingIssues].join("; "));
      if (!ok && commitlet.rollbackPoint) {
        const reverted = revertRollbackPoint(ctx.cwd, commitlet);
        if (reverted.ok) defaultCommitletState.updateCommitlet(commitlet.id, "reverted", `Guard failed; ${reverted.reason}`);
      }
      return textResult(formatGuardHealthAudit({ guard, health, audit }), { guard, health, audit, ok });
    }
  });

  pi.registerTool({
    name: "cheater_commitlet_verify",
    label: "Cheater Commitlet Verify",
    description: "Run focused verification for a commitlet and create one bounded repair commitlet on failure.",
    parameters: Type.Object({
      commitletId: Type.String(),
      timeoutSeconds: Type.Optional(Type.Number())
    }),
    async execute(_id: string, params: { commitletId: string; timeoutSeconds?: number }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const plan = defaultCommitletState.get().currentPlan;
      const commitlet = plan?.commitlets.find((item) => item.id === params.commitletId);
      if (!plan || !commitlet) return textResult(`Unknown commitlet: ${params.commitletId}`);
      const result = runFocusedVerification(ctx.cwd, commitlet, (params.timeoutSeconds ?? 120) * 1000);
      if (result.passed) {
        defaultCommitletState.updateCommitlet(commitlet.id, "passed", result.summary);
        return textResult(result.summary, result);
      }
      const alreadyRepair = /-repair$/.test(commitlet.id);
      if (!alreadyRepair) {
        const repair = createRepairCommitlet(commitlet, result.summary);
        defaultCommitletState.setPlan({
          ...plan,
          commitlets: plan.commitlets.flatMap((item) => item.id === commitlet.id ? [{ ...item, status: "failed" as const, result: {
            filesChanged: item.expectedFilesTouched,
            diffLines: 0,
            testsRun: result.commandsRun,
            verificationPassed: false,
            healthPassed: false,
            rollbackAvailable: Boolean(item.rollbackPoint),
            summary: result.summary,
            issues: result.failures
          } }, repair] : [item])
        });
        return textResult(`${result.summary}\nCreated bounded repair commitlet: ${repair.id}`, { result, repair });
      }
      if (commitlet.rollbackPoint) {
        const reverted = revertRollbackPoint(ctx.cwd, commitlet);
        defaultCommitletState.updateCommitlet(commitlet.id, reverted.ok ? "reverted" : "failed", `${result.summary}; ${reverted.reason}`);
        return textResult(`${result.summary}\nRepair failed; ${reverted.reason}`, { result, reverted });
      }
      defaultCommitletState.updateCommitlet(commitlet.id, "failed", result.summary);
      return textResult(`${result.summary}\nRepair failed and no rollback was available.`, result);
    }
  });

  pi.registerTool({
    name: "cheater_commitlet_finalize",
    label: "Cheater Commitlet Finalize",
    description: "Run Reliability Kernel final review and local telemetry.",
    parameters: Type.Object({
      diffText: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: { diffText?: string } = {}, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const plan = defaultCommitletState.get().currentPlan;
      if (!plan) return textResult("No active Cheater commitlet plan.");
      const review = runCommitletFinalReview(plan, params.diffText);
      const cfg = commitletConfig(deps.config);
      const cleanup = cfg.autoCleanupLowRiskHealthIssues && shouldCreateCleanupCommitlet(plan, review)
        ? createCleanupCommitlet(plan, review.blockingIssues.join("; ") || review.warnings.join("; "))
        : undefined;
      const updated = cleanup
        ? { ...plan, finalReview: review, status: "running" as const, commitlets: [...plan.commitlets, cleanup], currentIndex: plan.commitlets.length }
        : { ...plan, finalReview: review, status: review.accepted ? "complete" as const : "failed" as const };
      defaultCommitletState.setPlan(updated);
      const telemetryFile = deps.config.telemetryEnabled === false ? undefined : writeTelemetry(ctx.cwd, telemetryFromPlan(updated));
      return textResult([
        formatCommitletFinalReview(review),
        cleanup ? `Created cleanup commitlet: ${cleanup.id} (${cleanup.title})` : ""
      ].filter(Boolean).join("\n"), { review, telemetryFile, cleanup });
    }
  });

  pi.registerTool({
    name: "cheater_commitlet_revert",
    label: "Cheater Commitlet Revert",
    description: "Revert one commitlet using its allowed-file rollback snapshot.",
    parameters: Type.Object({
      commitletId: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: { commitletId?: string } = {}, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const plan = defaultCommitletState.get().currentPlan;
      if (!plan) return textResult("No active Cheater commitlet plan.");
      const commitlet = params.commitletId
        ? plan.commitlets.find((item) => item.id === params.commitletId)
        : plan.commitlets.find((item) => item.status === "running" || item.status === "failed") ?? plan.commitlets[plan.currentIndex];
      if (!commitlet) return textResult("No commitlet selected for revert.");
      const result = revertRollbackPoint(ctx.cwd, commitlet);
      if (result.ok) defaultCommitletState.updateCommitlet(commitlet.id, "reverted", result.reason);
      return textResult([
        result.ok ? `Reverted commitlet ${commitlet.id}.` : `Could not revert commitlet ${commitlet.id}.`,
        result.reason,
        `snapshotFiles: ${listRollbackSnapshotFiles(commitlet.rollbackPoint).join(", ") || "(none)"}`
      ].join("\n"), result);
    }
  });

  pi.registerTool({
    name: "cheater_rollback_status",
    label: "Cheater Rollback Status",
    description: "Inspect commitlet rollback snapshots and optionally clean old snapshots.",
    parameters: Type.Object({
      cleanup: Type.Optional(Type.Boolean()),
      keepLatest: Type.Optional(Type.Number())
    }),
    async execute(_id: string, params: { cleanup?: boolean; keepLatest?: number } = {}, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const plan = defaultCommitletState.get().currentPlan;
      const rows = plan?.commitlets.map((commitlet) => ({
        id: commitlet.id,
        status: commitlet.status,
        rollback: commitlet.rollbackPoint?.id ?? "",
        files: listRollbackSnapshotFiles(commitlet.rollbackPoint)
      })) ?? [];
      const cleanup = params.cleanup ? cleanupOldRollbackSnapshots(ctx.cwd, params.keepLatest ?? 20) : undefined;
      return textResult([
        "Rollback status",
        rows.length ? rows.map((row) => `${row.id}: ${row.rollback || "(none)"} files=${row.files.join(", ") || "(none)"}`).join("\n") : "No active rollback points.",
        cleanup ? `cleanup: removed=${cleanup.removed.length} kept=${cleanup.kept.length}` : ""
      ].filter(Boolean).join("\n"), { rows, cleanup });
    }
  });

  pi.registerTool({
    name: "cheater_health_report",
    label: "Cheater Health Report",
    description: "Show latest commitlet final review and patch health summary.",
    parameters: Type.Object({}),
    async execute() {
      const plan = defaultCommitletState.get().currentPlan;
      if (!plan) return textResult("No active Cheater commitlet plan.");
      return textResult(formatCommitletFinalReview(plan.finalReview), plan.finalReview);
    }
  });

  pi.registerTool({
    name: "cheater_constraint_graph",
    label: "Cheater Constraint Graph",
    description: "Build a compact repo constraint graph for selected files.",
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String())),
      queryFile: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: { files?: string[]; queryFile?: string }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const plan = defaultCommitletState.get().currentPlan;
      const files = params.files?.length
        ? params.files
        : [...new Set(plan?.commitlets.flatMap((commitlet) => commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/"))) ?? [])];
      const graph = buildRepoConstraintGraph(ctx.cwd, files);
      const facts = params.queryFile ? queryConstraintFacts(graph, params.queryFile) : [];
      return textResult([
        "Constraint graph",
        `files: ${graph.files.length}`,
        `symbols: ${graph.symbols.length}`,
        `exports: ${graph.exports.length}`,
        `signatures: ${graph.signatures.length}`,
        `imports: ${graph.imports.length}`,
        `tests: ${graph.tests.length}`,
        `testMappings: ${graph.testMappings.length}`,
        `relatedFiles: ${graph.relatedFiles.length}`,
        `verificationHints: ${graph.verificationCommands.length}`,
        `commands: ${graph.commandRegistrations.join(", ") || "(none)"}`,
        `tools: ${graph.toolRegistrations.join(", ") || "(none)"}`,
        `configKeys: ${graph.configKeys.slice(0, 10).join(", ") || "(none)"}`,
        facts.length ? `facts:\n- ${facts.join("\n- ")}` : ""
      ].filter(Boolean).join("\n"), { graph, facts });
    }
  });

  pi.registerTool({
    name: "cheater_bench_report",
    label: "Cheater Bench Report",
    description: "Show the latest local Reliability Kernel benchmark report.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const results = latestReliabilityBenchmark(ctx.cwd);
      return textResult(results.length ? compareReliabilityBenchmark(results) : "No reliability benchmark report found.", { results });
    }
  });
}

function shouldCreateCleanupCommitlet(plan: { commitlets: Array<{ id: string }> }, review: { accepted: boolean; blockingIssues: string[]; warnings: string[] }): boolean {
  if (review.accepted) return false;
  if (plan.commitlets.some((commitlet) => /cleanup-health$/.test(commitlet.id))) return false;
  return review.blockingIssues.length > 0 && review.blockingIssues.every((issue) => /below preferred threshold|cleanup commitlet required/i.test(issue));
}
