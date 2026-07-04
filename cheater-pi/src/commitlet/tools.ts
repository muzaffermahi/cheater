import { Type } from "typebox";
import { routeAutopilot } from "../autopilot/router.js";
import { createAutonomousBlueprint } from "../blueprint/autonomous.js";
import { defaultBlueprintState } from "../blueprint/state.js";
import { createCommitletPlan } from "./planner.js";
import { defaultCommitletState } from "./state.js";
import { buildCommitletExecutionPrompt, prepareCommitlet } from "./executor.js";
import { runResampledWorker } from "./resampling.js";
import { formatPlanChecklist } from "./ui.js";
import { cleanupOldRollbackSnapshots, listRollbackSnapshotFiles, revertRollbackPoint } from "./rollback.js";
import { liveSessionState } from "../reliability/sessionState.js";
import { resolveSidecarClient } from "../sidecar/client.js";
import { runVerification } from "../reliability/verificationRunner.js";
import { detectProjectCommands } from "../reliability/projectCommands.js";
import { activeTaskRun, beginTaskRun } from "../runstate/runState.js";
import { runClosedLoopCommitlets } from "./closedLoop.js";
import {
  finalizePlan,
  finishVerdict,
  gradeCommitlet,
  resolveModelName,
  resolveRealWorkerMode,
  updateControllerFile,
  wantsRealWorker,
  workerProgress,
  workerHeartbeat
} from "./kernel.js";
import type { CheaterConfig } from "../types.js";

// Back-compat: wantsRealWorker moved into the shared kernel; existing importers keep working.
export { wantsRealWorker };

type ExtensionAPI = any;
type ExtensionContext = any;

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text", text }], details };
}

export function registerCommitletTools(pi: ExtensionAPI, deps: { config: CheaterConfig }): void {
  pi.registerTool({
    name: "cheater_run",
    label: "Cheater Run (closed loop)",
    description: "Do the whole code task in ONE call: the harness plans, makes each edit in a bounded step, grades and repairs it, verifies, and reports. Call this once for any code change (you do not call cheater_commitlet_next after it), then follow the instructions in its result. Pass a SHORT one-line goal - the harness does all planning.",
    parameters: Type.Object({
      userGoal: Type.String({ description: "The goal in ONE short IMPERATIVE sentence that KEEPS its action verb (Create/Add/Fix/Build...) - ideally the user's own words. The verb is what lets the harness tell a build from a question, so never drop it (write \"Create a Vite+React todo app\", never the bare \"Vite+React todo app\"). Do NOT restate requirements, list files, or expand into a spec - the harness plans every detail itself, and on a local model each token you type here costs real seconds for nothing." }),
      spawnFreshWorker: Type.Optional(Type.Boolean({ description: "Force real isolated worker sessions on/off; default follows config and the verified backend probe." })),
      maxCommitlets: Type.Optional(Type.Number({ description: "Hard cap on commitlets (incl. repairs) the loop may run. Default: plan length + repair budget, min 12." })),
      maxRepairRounds: Type.Optional(Type.Number({ description: "Hard cap on repair commitlets across the run. Default: repairAttemptsPerCommitlet or 3." })),
      approveLargeDeletion: Type.Optional(Type.Boolean({ description: "Approve an intended large deletion that the diff guard would otherwise block." }))
    }),
    async execute(_id: string, params: { userGoal: string; spawnFreshWorker?: boolean; maxCommitlets?: number; maxRepairRounds?: number; approveLargeDeletion?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const result = await runClosedLoopCommitlets({
        cwd: ctx.cwd,
        userGoal: params.userGoal,
        config: deps.config,
        ctx,
        spawnFreshWorker: params.spawnFreshWorker,
        maxCommitlets: params.maxCommitlets,
        maxRepairRounds: params.maxRepairRounds,
        approveLargeDeletion: params.approveLargeDeletion
      });
      return textResult(result.summary, {
        ok: result.ok,
        status: result.status,
        freshWorkerMode: result.freshWorkerMode,
        steps: result.steps,
        plan: result.plan,
        receipt: result.receipt,
        error: result.error,
        details: result.details
      });
    }
  });

  pi.registerTool({
    name: "cheater_reliability_start",
    label: "Cheater Reliability Start",
    description: "Plan the task and return the first commitlet's execution prompt with a rollback point. Do exactly what that prompt says, then call cheater_commitlet_next to grade the edit and get the next step. Pass a SHORT one-line goal - the harness does all planning.",
    parameters: Type.Object({
      userGoal: Type.String({ description: "The goal in ONE short IMPERATIVE sentence that KEEPS its action verb (Create/Add/Fix/Build...) - ideally the user's own words; the verb is what lets the harness tell a build from a question. Do NOT restate requirements or list files - the harness plans every detail, and on a local model each token you type here costs real seconds for nothing." }),
      useActiveBlueprint: Type.Optional(Type.Boolean()),
      spawnFreshWorker: Type.Optional(Type.Boolean({ description: "When true, spawn a real isolated worker session instead of returning a prompt to the current session." }))
    }),
    async execute(_id: string, params: { userGoal: string; useActiveBlueprint?: boolean; spawnFreshWorker?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const decision = routeAutopilot({ cwd: ctx.cwd, message: params.userGoal, requireApproval: deps.config.requireApprovalForHighRisk === true });
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

      ctx?.ui?.setWorkingMessage?.("Cheater: planning commitlets (routing, candidates, packet decomposition)...");
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
      liveSessionState.reset(params.userGoal);
      liveSessionState.ensure(deps.config, params.userGoal);
      if (deps.config.runStateEnabled !== false) {
        // Birth of the durable run: .cheater/runs/<planId>/ gets the literal acceptance
        // contract, controller.md, and an initial workspace digest. The phase budget derives
        // from the plan's own per-commitlet tool budgets unless configured explicitly.
        // A session-reincarnated run stays active instead: its contract, ledgers, and
        // protections are the continuing truth; a fresh run dir would orphan them.
        // Generous: the main model drives the whole build in-session and needs far more actions
        // than a bounded worker's per-commitlet estimate (see closedLoop.ts for the rationale).
        const actionBudget = deps.config.runStateActionBudget
          ?? Math.max(300, plan.commitlets.reduce((sum, commitlet) => sum + commitlet.maxToolCalls, 0) * 3 + 60);
        const existing = activeTaskRun();
        const run = existing?.resumed && existing.status === "running"
          ? existing
          : beginTaskRun(ctx.cwd, params.userGoal, { taskId: plan.id, actionBudget });
        updateControllerFile(run, plan, "running", `execute first commitlet: ${plan.commitlets[0]?.title ?? "(none)"}`);
      }
      ctx?.ui?.notify?.(`Cheater plan ready: ${plan.commitlets.length} commitlet(s) - ${plan.commitlets.map((c) => c.title).slice(0, 5).join("; ")}${plan.commitlets.length > 5 ? "; ..." : ""}`, "info");

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
      liveSessionState.setPacketId(prepared.id);
      liveSessionState.beginCommitlet();
      activeTaskRun()?.setActiveCommitlet(prepared.id);
      // Sticky lane: a scaffold plan stays in-session for the whole build (see cheater_commitlet_next).
      const wantRealWorker = updated.buildMode === "scaffold" ? false : await resolveRealWorkerMode(params, deps.config, ctx);
      let prompt = buildCommitletExecutionPrompt(updated, prepared, [], wantRealWorker ? "real" : "simulated", 1, resolveModelName(deps.config, ctx));
      let fallbackNotice = "";

      if (wantRealWorker) {
        const resample = await runResampledWorker(updated, prepared, deps.config, undefined, ctx?.model, workerProgress(ctx, updated, prepared), workerHeartbeat(ctx, updated, prepared));
        const workerResult = resample.workerResult;
        // Receipt truthfulness: the resample outcome (attempts, winner, verified or not,
        // real fresh workers) is recorded from ground truth, never model prose.
        liveSessionState.getLedger()?.addEntry("resample", resample.note, {
          commitletId: prepared.id,
          attemptsRun: resample.attemptsRun,
          samplesRequested: resample.samplesRequested,
          appliedAttempt: resample.appliedAttempt,
          passed: resample.passed,
          freshWorkerMode: workerResult.error === "worker_backend_unavailable" ? "unavailable" : "real"
        });
        if (workerResult.error === "worker_backend_unavailable") {
          // Backend cannot spawn sessions: degrade to the simulated in-session prompt below
          // instead of failing the commitlet over infrastructure.
          fallbackNotice = "note: fresh worker backend unavailable; this session executes the packet itself (simulated mode)";
          prompt = buildCommitletExecutionPrompt(updated, prepared, [], "simulated", 1, resolveModelName(deps.config, ctx));
        } else if (!workerResult.ok && !resample.passed) {
          // Fail fast only when the best attempt's worker errored AND nothing verified; a
          // worker that lost its sentinel but produced a verified edit still counts as work.
          defaultCommitletState.updateCommitlet(prepared.id, "failed", workerResult.summary);
          return textResult([
            "Cheater Reliability Start (real fresh worker failed)",
            `autopilot: ${decisionSummary}`,
            `first: ${prepared.title}`,
            resample.note,
            workerResult.summary
          ].join("\n"), { decision, plan: defaultCommitletState.get().currentPlan, commitlet: prepared, workerResult, resample, freshWorkerMode: "real" });
        } else {
          const gradedCommitlet = defaultCommitletState.get().currentPlan?.commitlets.find((commitlet) => commitlet.id === prepared.id) ?? prepared;
          const grade = await gradeCommitlet(ctx.cwd, gradedCommitlet, deps.config, { sidecar: resolveSidecarClient(deps.config, ctx) });
          return textResult([
            "Cheater Reliability Start (real fresh worker)",
            `autopilot: ${decisionSummary}`,
            `plan: ${updated.summary}${updated.blueprintPlanId ? ` blueprint=${updated.blueprintPlanId}` : ""}`,
            `commitlets: ${updated.commitlets.length}`,
            `first: ${prepared.title}`,
            `allowedFiles: ${prepared.allowedFiles.join(", ") || "(inspect only)"}`,
            `rollback: ${prepared.rollbackPoint?.id ?? "(none)"}`,
            `freshWorkerMode: real`,
            resample.note,
            workerResult.sessionId ? `session: ${workerResult.sessionId}` : "",
            workerResult.sessionFile ? `sessionFile: ${workerResult.sessionFile}` : "",
            "",
            workerResult.summary,
            "",
            grade.message
          ].filter(Boolean).join("\n"), { decision, plan: defaultCommitletState.get().currentPlan, commitlet: prepared, prompt, workerResult, resample, grade: grade.details, freshWorkerMode: "real" });
        }
      }

      return textResult([
        "Cheater Reliability Start",
        `autopilot: ${decisionSummary}`,
        `plan: ${updated.summary}${updated.blueprintPlanId ? ` blueprint=${updated.blueprintPlanId}` : ""}`,
        `commitlets: ${updated.commitlets.length}`,
        `first: ${prepared.title}`,
        `allowedFiles: ${prepared.allowedFiles.join(", ") || "(inspect only)"}`,
        `rollback: ${prepared.rollbackPoint?.id ?? "(none)"}`,
        `freshWorkerMode: simulated (prompt returned to current session; set spawnFreshWorker=true for a real isolated worker)`,
        fallbackNotice,
        "",
        "fresh-call prompt:",
        prompt.prompt
      ].filter(Boolean).join("\n"), { decision, plan: updated, commitlet: prepared, prompt, freshWorkerMode: "simulated", fallbackNotice: fallbackNotice || undefined });
    }
  });

  pi.registerTool({
    name: "cheater_commitlet_next",
    label: "Cheater Commitlet Next",
    description: "Grades the running commitlet in code (diff guard, patch health, test audit, focused verification - not model say-so), then prepares the next commitlet with rollback and returns a fresh-call execution prompt. When no commitlets remain, runs the automatic final review.",
    parameters: Type.Object({
      spawnFreshWorker: Type.Optional(Type.Boolean({ description: "When true, spawn a real isolated worker session for the next commitlet and grade it immediately." })),
      approveLargeDeletion: Type.Optional(Type.Boolean({ description: "Approve an intended large deletion that the diff guard would otherwise block." }))
    }),
    async execute(_id: string, params: { spawnFreshWorker?: boolean; approveLargeDeletion?: boolean } = {}, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      let plan = defaultCommitletState.get().currentPlan;
      if (!plan) return textResult("No active Cheater commitlet plan.");

      const running = plan.commitlets.find((commitlet) => commitlet.status === "running");
      let gradeReport = "";
      if (running) {
        const grade = await gradeCommitlet(ctx.cwd, running, deps.config, { allowLargeDeletion: params.approveLargeDeletion, sidecar: resolveSidecarClient(deps.config, ctx) });
        plan = defaultCommitletState.get().currentPlan!;
        if (!grade.advance) return textResult(grade.message, grade.details);
        // The grade verdict (including any injected cheat sheet on a failure that spawned a
        // repair) must reach the orchestrating session; the advance path used to drop it.
        gradeReport = grade.message;
      }

      const index = plan.commitlets.findIndex((commitlet) => commitlet.status === "pending");
      if (index < 0) {
        const { text, details } = finalizePlan(ctx.cwd, plan, deps.config);
        return textResult(text, details);
      }

      const next = plan.commitlets[index];
      const prepared = prepareCommitlet(ctx.cwd, next);
      const commitlets = plan.commitlets.map((commitlet) => commitlet.id === next.id ? prepared : commitlet);
      const updated = { ...plan, status: "running" as const, currentIndex: index, commitlets };
      defaultCommitletState.setPlan(updated);
      liveSessionState.beginCommitlet();
      activeTaskRun()?.setActiveCommitlet(prepared.id);
      const previousState = plan.commitlets.filter((commitlet) => commitlet.result?.summary).map((commitlet) => `${commitlet.id}: ${commitlet.result?.summary}`);
      // Sticky lane: a scaffold plan runs the WHOLE build in-session on the warm cache. commitlet_next
      // must NOT re-probe the backend and flip to cold per-file fresh workers mid-chain (the exact
      // slowdown the scaffold design avoids), so honor the plan's lane instead of resolving afresh.
      const wantRealWorker = updated.buildMode === "scaffold" ? false : await resolveRealWorkerMode(params, deps.config, ctx);
      let prompt = buildCommitletExecutionPrompt(updated, prepared, previousState, wantRealWorker ? "real" : "simulated", 1, resolveModelName(deps.config, ctx));
      let fallbackNotice = "";

      if (wantRealWorker) {
        const resample = await runResampledWorker(updated, prepared, deps.config, undefined, ctx?.model, workerProgress(ctx, updated, prepared), workerHeartbeat(ctx, updated, prepared));
        const workerResult = resample.workerResult;
        // Receipt truthfulness: the resample outcome (attempts, winner, verified or not,
        // real fresh workers) is recorded from ground truth, never model prose.
        liveSessionState.getLedger()?.addEntry("resample", resample.note, {
          commitletId: prepared.id,
          attemptsRun: resample.attemptsRun,
          samplesRequested: resample.samplesRequested,
          appliedAttempt: resample.appliedAttempt,
          passed: resample.passed,
          freshWorkerMode: workerResult.error === "worker_backend_unavailable" ? "unavailable" : "real"
        });
        if (workerResult.error === "worker_backend_unavailable") {
          fallbackNotice = "note: fresh worker backend unavailable; this session executes the packet itself (simulated mode)";
          prompt = buildCommitletExecutionPrompt(updated, prepared, previousState, "simulated", 1, resolveModelName(deps.config, ctx));
        } else if (!workerResult.ok && !resample.passed) {
          defaultCommitletState.updateCommitlet(prepared.id, "failed", workerResult.summary);
          return textResult([`Fresh worker failed for commitlet ${prepared.id}.`, resample.note, workerResult.summary].join("\n"), { commitlet: prepared, workerResult, resample, freshWorkerMode: "real" });
        } else {
          const gradedCommitlet = defaultCommitletState.get().currentPlan?.commitlets.find((commitlet) => commitlet.id === prepared.id) ?? prepared;
          const grade = await gradeCommitlet(ctx.cwd, gradedCommitlet, deps.config, { sidecar: resolveSidecarClient(deps.config, ctx) });
          if (!grade.advance) {
            // The worker's output did not verify (e.g. it claimed success but changed nothing, now
            // caught by gradeCommitlet's real-work gate). NEVER print a "workerStatus: ok" header over
            // a failed grade - that contradictory receipt is exactly what confuses a small model.
            return textResult([
              `Cheater Commitlet Next (real fresh worker): ${prepared.title} — did NOT verify`,
              resample.note,
              grade.message
            ].join("\n"), { commitlet: prepared, workerResult, resample, grade: grade.details, freshWorkerMode: "real" });
          }
          return textResult([
            `Cheater Commitlet Next (real fresh worker): ${prepared.title}`,
            "workerStatus: ok",
            resample.note,
            workerResult.summary,
            "",
            grade.message
          ].join("\n"), { commitlet: prepared, workerResult, resample, grade: grade.details, freshWorkerMode: "real" });
        }
      }

      return textResult([
        ...(gradeReport ? [gradeReport, ""] : []),
        formatPlanChecklist(updated),
        `Running commitlet ${index + 1}/${updated.commitlets.length}: ${prepared.title}`,
        `Allowed files: ${prepared.allowedFiles.join(", ") || "(inspect only)"}`,
        `Rollback: ${prepared.rollbackPoint?.id}`,
        "freshWorkerMode: simulated",
        ...(fallbackNotice ? [fallbackNotice] : []),
        "",
        prompt.prompt
      ].join("\n"), { commitlet: prepared, prompt, freshWorkerMode: "simulated", fallbackNotice: fallbackNotice || undefined });
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

  // cheater_health_report, cheater_constraint_graph, and cheater_bench_report were removed:
  // none appeared in any tool mask (dead model surface), and each duplicated a direct-render
  // user command (/commitlet-health, /constraint-graph, /bench-report) that shows the same
  // data without spending a model turn.

  pi.registerTool({
    name: "cheater_finish_gate",
    label: "Cheater Finish Gate",
    description: "Call this before telling the user a task is done: it returns allowed=true only when verification evidence exists and no failures are unresolved. If verification genuinely cannot run, pass waiver=<reason> to record an honest skip.",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "Proposed finish summary" })),
      waiver: Type.Optional(Type.String({ description: "Explicit reason to finish without full verification; recorded in the ledger as a tracked skip." }))
    }),
    async execute(_id: string, params: { summary?: string; waiver?: string } = {}, _sig: unknown, _upd: unknown, _ctx: ExtensionContext) {
      const ledger = liveSessionState.getLedger();
      if (!ledger) {
        return textResult("Cheater Finish Gate: no active completion ledger. Run cheater_reliability_start first.", { allowed: false, reason: "no_ledger" });
      }
      if (params.waiver) {
        ledger.addEntry("verification_waiver", params.waiver.slice(0, 200), { waiver: params.waiver });
        ledger.finalize(true, `verification waived: ${params.waiver}`.slice(0, 200), "low");
        return textResult([
          "Cheater Finish Gate: ALLOWED (verification WAIVED)",
          `waiver recorded: ${params.waiver}`,
          "This skip is tracked in the completion ledger; tell the user verification was skipped and why."
        ].join("\n"), { allowed: true, reason: "waived", waiver: params.waiver });
      }
      // Shared kernel verdict: completion-ledger gate + run-state staleness gate + the
      // automatic exact-artifact reread. The closed-loop executor uses the SAME function -
      // one finish truth, never two.
      const verdict = finishVerdict(deps.config, { summary: params.summary })!;
      return textResult(verdict.lines.join("\n"), { allowed: verdict.allowed, reason: verdict.reason, freshness: verdict.freshness, ledger: verdict.ledgerState });
    }
  });

  pi.registerTool({
    name: "cheater_verification_run",
    label: "Cheater Verification Run",
    description: "Detect and run the project's test/verification commands and record the results as evidence for the finish gate.",
    parameters: Type.Object({
      planKind: Type.Optional(Type.Union([Type.Literal("webapp"), Type.Literal("cli")])),
      port: Type.Optional(Type.Number({ description: "Optional fixed port; otherwise a free port is selected" }))
    }),
    async execute(_id: string, params: { planKind?: "webapp" | "cli"; port?: number } = {}, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const cmds = detectProjectCommands(ctx.cwd);
      const planKind = params.planKind ?? (cmds.devCommand ? "webapp" : "cli");
      const result = await runVerification({
        cwd: ctx.cwd,
        userGoal: liveSessionState.getLedger()?.get().userGoal ?? "verification",
        planKind,
        projectCommands: cmds,
        port: params.port
      });
      const ledger = liveSessionState.getLedger();
      if (ledger) {
        for (const stage of result.stages) {
          ledger.recordVerificationStage(stage);
        }
        for (const artifact of result.artifacts) {
          ledger.recordArtifact(artifact);
        }
        for (const cmd of result.ledger.get().commandsRun) {
          ledger.recordCommand(cmd);
        }
      }
      const run = deps.config.runStateEnabled !== false ? activeTaskRun() : null;
      if (run) {
        // Mirror the verification stages into the run's validation ledger, pinned to the
        // artifacts each stage produced, so later mutations can stale them and an
        // evaluator-mirroring pass protects the artifacts it proved.
        for (const stage of result.stages) {
          if (stage.status === "skipped") continue;
          run.recordValidation({
            name: stage.stage,
            command: typeof (stage.signals as { command?: unknown } | undefined)?.command === "string" ? (stage.signals as { command: string }).command : undefined,
            actor: "verification_run",
            validates: stage.artifacts ?? [],
            status: stage.status === "ok" ? "pass" : "fail",
            outputSummary: stage.summary
          });
        }
        run.phase.advanceTo("validate");
        run.refreshDigest();
      }
      const lines = [
        `Cheater Verification Run: ${result.passed ? "PASSED" : "FAILED"}`,
        `planKind: ${planKind}`,
        `packageManager: ${cmds.packageManager}`,
        `framework: ${cmds.framework ?? "(none)"}`,
        `devCommand: ${cmds.devCommand ?? "(none)"}`,
        `testCommand: ${cmds.testCommand ?? "(none)"}`,
        `scoreCommand: ${cmds.scoreCommand ?? "(none)"}`,
        `port: ${result.registry.runningProcesses().length ? result.registry.runningProcesses()[0]?.port ?? params.port : params.port ?? "(n/a)"}`,
        result.mismatches.length ? `STALE WORKSPACE: ${result.mismatches[0].evidence}` : "",
        "",
        "stages:",
        ...result.stages.map((stage) => `  [${stage.status}] ${stage.stage}: ${stage.summary}`),
        result.artifacts.length ? `artifacts: ${result.artifacts.join(", ")}` : "artifacts: (none)",
        "",
        result.ledger.toHuman()
      ].filter(Boolean);
      return textResult(lines.join("\n"), { result, passed: result.passed, planKind, cmds });
    }
  });

  pi.registerTool({
    name: "cheater_ledger_status",
    label: "Cheater Ledger Status",
    description: "Show the live completion ledger for the current reliability session, including changed files, commands, verification stages, and unresolved failures.",
    parameters: Type.Object({}),
    async execute() {
      const ledger = liveSessionState.getLedger();
      if (!ledger) return textResult("No active Cheater completion ledger.");
      // Local-only harness telemetry: how much the hidden machinery actually did this run.
      const run = activeTaskRun();
      const telemetryLines = run
        ? [
          "",
          "run telemetry (local only):",
          `  capsules: ${run.capsuleMetrics().count} built, max ~${run.capsuleMetrics().maxTokens} tokens`,
          ...Object.entries(run.telemetrySnapshot())
            .filter(([, count]) => count > 0)
            .map(([key, count]) => `  ${key}: ${count}`)
        ]
        : [];
      return textResult([ledger.toHuman(), ...telemetryLines].join("\n"), { ledger: ledger.get(), telemetry: run?.telemetrySnapshot() });
    }
  });
}
