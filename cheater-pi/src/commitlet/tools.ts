import { Type } from "typebox";
import { routeAutopilot } from "../autopilot/router.js";
import { createAutonomousBlueprint } from "../blueprint/autonomous.js";
import { defaultBlueprintState } from "../blueprint/state.js";
import { createCleanupCommitlet, createCommitletPlan, createRepairCommitlet } from "./planner.js";
import { commitletConfig } from "./config.js";
import { defaultCommitletState } from "./state.js";
import { buildCommitletExecutionPrompt, prepareCommitlet } from "./executor.js";
import { runResampledWorker } from "./resampling.js";
import { saveVerifiedFix } from "../reliability/experience.js";
import { buildCheatSheet, renderCheatSheet } from "../reliability/cheatSheet.js";
import { runDiffGuard, countDiffLines } from "./guard.js";
import { scorePatchHealth } from "./health.js";
import { auditTestChanges } from "./testAudit.js";
import { runCommitletFinalReview } from "./reviewer.js";
import { formatCommitletFinalReview, formatCommitletPlan, formatGuardHealthAudit, formatPlanChecklist } from "./ui.js";
import { telemetryFromPlan, writeTelemetry } from "./telemetry.js";
import { cleanupOldRollbackSnapshots, listRollbackSnapshotFiles, revertRollbackPoint } from "./rollback.js";
import { runFocusedVerification } from "./verification.js";
import { buildCommitletDiff } from "./diffUtil.js";
import { probeWorkerBackend, resetWorkerBackendLatch, workerBackendState } from "../blueprint/worker.js";
import { liveSessionState } from "../reliability/sessionState.js";
import { classifyFailure, ledgerAllowsFinish } from "../reliability/lifecycle.js";
import { runVerification } from "../reliability/verificationRunner.js";
import { detectProjectCommands } from "../reliability/projectCommands.js";
import { activeTaskRun, beginTaskRun, type TaskRunState } from "../runstate/runState.js";
import { writeControllerFile } from "../runstate/workerPlans.js";
import { artifactReread } from "../runstate/recipes.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import type { CheaterConfig } from "../types.js";

type ExtensionAPI = any;
type ExtensionContext = any;

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text", text }], details };
}

/**
 * Real fresh workers (context isolation per file change) default on only from VERIFIED
 * evidence, never a guess: explicit param > config > "a real fresh worker already spawned
 * successfully earlier in this process" (the backend latch in blueprint/worker.ts, set only
 * by an actual createAgentSession success). A filesystem heuristic (does Pi have auth on
 * disk?) was tried and rejected: it cannot distinguish "this process can spawn a working
 * worker" from "someone once logged into Pi on this machine", so it defaulted tool-harness
 * and test contexts into slow, doomed real-worker attempts. This self-discovering default
 * costs nothing extra when unset (starts "unknown" -> false) and upgrades automatically the
 * moment any commitlet actually proves the backend works, without the user re-passing the
 * flag - and unlike the disk heuristic, it can never produce a false positive.
 */
export function wantsRealWorker(params: { spawnFreshWorker?: boolean }, config: CheaterConfig, _ctx: ExtensionContext): boolean {
  if (params.spawnFreshWorker !== undefined) {
    // An explicit request also clears the latch so the user can force a retry after fixing
    // their backend without restarting the session.
    if (params.spawnFreshWorker) resetWorkerBackendLatch();
    return params.spawnFreshWorker;
  }
  if (config.commitletFreshWorkerDefault !== undefined) return config.commitletFreshWorkerDefault;
  return workerBackendState() === "available";
}

/**
 * Resolve the fresh-worker mode for this call, running the one-time backend probe when
 * needed. The latch alone had a bootstrap deadlock: real workers auto-enable only from the
 * latch, but the latch only flipped after a real worker ran - which never happened because
 * the default was off. The probe (a throwaway session whose resolved model is the verified
 * evidence; zero model tokens) breaks the loop. It runs only when: no explicit param, no
 * config override, latch still unknown, and the CURRENT session has a live model (offline
 * and test contexts have none, so they never probe).
 */
async function resolveRealWorkerMode(params: { spawnFreshWorker?: boolean }, config: CheaterConfig, ctx: ExtensionContext): Promise<boolean> {
  if (
    params.spawnFreshWorker === undefined
    && config.commitletFreshWorkerDefault === undefined
    && workerBackendState() === "unknown"
    && ctx?.model?.id
  ) {
    await probeWorkerBackend(ctx.cwd);
  }
  return wantsRealWorker(params, config, ctx);
}

/**
 * The model name for packet operating-rule selection (9b/moe30b/moe35b/unknown), preferring
 * the live session's actual model over the static config default. Without this,
 * buildCommitletExecutionPrompt never learned the real model and modelClass was always
 * "unknown" - silently dropping the model-specific operating rules (including the only rule
 * that told a moe-class worker to run its own focused verification command).
 */
function resolveModelName(config: CheaterConfig, ctx: ExtensionContext): string | undefined {
  return ctx?.model?.id ?? config.model;
}

/**
 * Live terminal narration for fresh-worker runs. A local model streams for minutes per
 * attempt; without this the user stared at a bare spinner with zero indication of what
 * Cheater was doing (observed live: "it's been in cheater_reliability_start a VERY long
 * time"). Milestones go to the chat via notify (they are minutes apart, not per-tool), and
 * the working spinner text is updated so the current activity is always visible.
 */
function workerProgress(ctx: ExtensionContext, plan: CommitletPlan, commitlet: Commitlet): (message: string) => void {
  const position = `${plan.commitlets.findIndex((c) => c.id === commitlet.id) + 1}/${plan.commitlets.length}`;
  return (message: string) => {
    const line = `Cheater [commitlet ${position}] ${message}`;
    try {
      ctx?.ui?.setWorkingMessage?.(line);
      ctx?.ui?.notify?.(line, "info");
    } catch { /* narration must never break the run */ }
  };
}

interface GradeResult {
  advance: boolean;
  message: string;
  details: unknown;
}

/**
 * Keep controller.md in step with the plan: the durable file a respawned controller (or a
 * human) reads to learn the decomposition, statuses, phase, and next step. Best-effort.
 */
function updateControllerFile(run: TaskRunState, plan: CommitletPlan, status: string, nextStep: string): void {
  try {
    writeControllerFile(run.runDir, {
      taskId: run.taskId,
      goal: plan.userGoal,
      contractSummary: run.contractSummaryText(),
      planSummary: plan.summary,
      workerDecomposition: plan.commitlets.map((commitlet) => ({ role: commitlet.id, goal: commitlet.title, status: commitlet.status })),
      globalConstraints: plan.globalConstraints,
      phaseLine: run.phase.capsuleLines()[0] ?? "",
      status,
      nextStep
    });
  } catch {
    // controller.md must never break the run
  }
}

/**
 * Runs diff guard, patch health, test audit, and focused verification for the currently
 * running commitlet in code, instead of trusting the model to call separate guard/verify
 * tools honestly. Returns advance=true when the plan may move on to the next commitlet
 * (passed, or a bounded repair commitlet was just queued); advance=false stops the chain
 * (guard/health/audit rejection, or a repair attempt also failed).
 */
async function gradeCommitlet(cwd: string, commitlet: Commitlet, config: CheaterConfig, overrides: { allowLargeDeletion?: boolean } = {}): Promise<GradeResult> {
  const observedEdits = liveSessionState.consumeCommitletEdits();
  const candidateFiles = [...new Set([...commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")), ...observedEdits])];
  const { diffText, touchedFiles } = buildCommitletDiff(cwd, candidateFiles, commitlet.rollbackPoint?.snapshotDir);

  const guard = runDiffGuard(commitlet, { touchedFiles, diffText }, { allowLargeDeletion: overrides.allowLargeDeletion });
  const health = scorePatchHealth({ diffText, filesTouched: touchedFiles, threshold: config.healthScoreThreshold, hardRejectThreshold: config.hardRejectHealthThreshold });
  const isTestChange = touchedFiles.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file));
  const audit = isTestChange ? auditTestChanges(diffText, commitlet.spec?.acceptanceCriteria ?? []) : { passed: true, warnings: [], blockingIssues: [] };
  const guardOk = guard.passed && health.passed && audit.passed;

  if (!guardOk) {
    const issues = [...guard.blockingIssues, ...health.blockingIssues, ...audit.blockingIssues];
    const observed = {
      filesChanged: touchedFiles,
      diffLines: countDiffLines(diffText),
      testsRun: [],
      verificationPassed: false,
      healthPassed: health.passed,
      rollbackAvailable: Boolean(commitlet.rollbackPoint),
      summary: `Guard failed: ${issues.join("; ")}`,
      issues
    };
    if (commitlet.rollbackPoint) {
      const reverted = revertRollbackPoint(cwd, commitlet);
      defaultCommitletState.updateCommitlet(commitlet.id, reverted.ok ? "reverted" : "failed", `Guard failed: ${issues.join("; ")}; ${reverted.reason}`, observed);
    } else {
      defaultCommitletState.updateCommitlet(commitlet.id, "failed", `Guard failed: ${issues.join("; ")}`, observed);
    }
    activeTaskRun()?.integrateWorkerReport({
      workerRole: commitlet.id,
      summary: `Guard/health/test audit blocked this commitlet: ${issues.slice(0, 3).join("; ")}`,
      filesChanged: touchedFiles,
      commandsRun: [],
      validationResults: ["guard/health/test audit: fail"],
      problems: issues.slice(0, 4),
      recommendedNextAction: "narrow the change to the allowed files and retry",
      contractSatisfied: "no"
    });
    return {
      advance: false,
      message: [`Commitlet ${commitlet.id} blocked by guard/health/test audit.`, formatGuardHealthAudit({ guard, health, audit })].join("\n"),
      details: { guard, health, audit }
    };
  }

  const verify = runFocusedVerification(cwd, commitlet);
  const ledger = liveSessionState.getLedger();
  if (ledger) {
    for (const cmd of verify.commandsRun) ledger.recordCommand(cmd);
    ledger.recordVerificationStage({
      stage: "focused_tests",
      status: verify.passed ? "ok" : "failed",
      summary: verify.summary,
      failureClass: verify.passed ? "unknown" : classifyFailure({ exitCode: 1, stdout: "", stderr: verify.failures.join("\n") }),
      artifacts: [],
      signals: { commitletId: commitlet.id }
    });
  }

  // Durable run state: record what this verification proved (pinned to the files it covered,
  // so later mutations can stale it), file the commitlet's worker report, and keep
  // controller.md current. A fresh evaluator-mirroring pass also protects its artifacts.
  const run = activeTaskRun();
  if (run) {
    run.recordValidation({
      name: `focused_verification:${commitlet.id}`,
      command: commitlet.focusedVerification.find((step) => step.command)?.command,
      actor: commitlet.id,
      validates: touchedFiles,
      status: verify.passed ? "pass" : "fail",
      outputSummary: verify.summary
    });
    run.integrateWorkerReport({
      workerRole: commitlet.id,
      summary: verify.summary,
      filesChanged: touchedFiles,
      commandsRun: verify.commandsRun,
      validationResults: [`focused verification: ${verify.passed ? "pass" : "fail"}`],
      problems: verify.passed ? [] : verify.failures.slice(0, 3),
      recommendedNextAction: verify.passed ? "advance to the next commitlet" : "run the bounded repair commitlet",
      contractSatisfied: verify.passed ? "yes" : "no"
    });
    if (verify.passed) run.phase.advanceTo("implement");
    const currentPlan = defaultCommitletState.get().currentPlan;
    if (currentPlan) updateControllerFile(run, currentPlan, currentPlan.status, verify.passed ? "next commitlet or final review" : "bounded repair");
  }

  if (verify.passed) {
    // Verified fail->pass transition: a repair commitlet just passed the verification its
    // original failed. The harness knows the observed failure AND the diff that fixed it -
    // ground truth, no model claim - so it writes the experience card itself. Future
    // matching failures get this fix recalled in-band inside their failure cards.
    if (config.experienceStoreEnabled !== false && /-repair$/.test(commitlet.id) && commitlet.spec?.observedFailure) {
      saveVerifiedFix(cwd, {
        failureText: commitlet.spec.observedFailure,
        diffText,
        files: touchedFiles,
        goal: defaultCommitletState.get().currentPlan?.userGoal
      });
    }
    defaultCommitletState.updateCommitlet(commitlet.id, "passed", verify.summary, {
      filesChanged: touchedFiles,
      diffLines: countDiffLines(diffText),
      testsRun: verify.commandsRun,
      verificationPassed: true,
      healthPassed: health.passed,
      rollbackAvailable: Boolean(commitlet.rollbackPoint),
      summary: verify.summary,
      issues: []
    });
    return {
      advance: true,
      message: [`Commitlet ${commitlet.id} passed guard, health, and focused verification.`, verify.summary].join("\n"),
      details: { guard, health, audit, verify }
    };
  }

  // The Cheat Layer: the harness (not the model) classifies this failure, retrieves compact
  // evidence from every source it owns, and injects the sheet exactly where the failure is
  // being handed to a model - into the repair commitlet's observedFailure (which flows into
  // every repair worker/resample packet) and into the grade message the orchestrating
  // session reads. No search tool call is required or possible here.
  const sheet = await buildCheatSheet(cwd, [verify.summary, ...verify.failures].join("\n"), config);
  const renderedSheet = sheet ? renderCheatSheet(sheet, commitlet.focusedVerification.find((step) => step.command)?.command) : "";
  const failureWithEvidence = renderedSheet ? `${verify.summary}\n${renderedSheet}` : verify.summary;
  if (sheet && ledger) {
    // Receipt truthfulness: record WHICH evidence sources were injected, so the completion
    // receipt can say "cheat evidence used (experience, api_oracle)" from ground truth.
    ledger.addEntry("cheat_evidence", `trigger ${sheet.trigger}`, { sources: sheet.cards.map((card) => card.source), commitletId: commitlet.id });
  }

  const alreadyRepair = /-repair$/.test(commitlet.id);
  if (!alreadyRepair) {
    const repair = createRepairCommitlet(commitlet, failureWithEvidence);
    const plan = defaultCommitletState.get().currentPlan;
    if (plan) {
      defaultCommitletState.setPlan({
        ...plan,
        commitlets: plan.commitlets.flatMap((item) => item.id === commitlet.id ? [{
          ...item,
          status: "failed" as const,
          result: {
            filesChanged: touchedFiles.length ? touchedFiles : item.expectedFilesTouched,
            diffLines: countDiffLines(diffText),
            testsRun: verify.commandsRun,
            verificationPassed: false,
            healthPassed: health.passed,
            rollbackAvailable: Boolean(item.rollbackPoint),
            summary: verify.summary,
            issues: verify.failures
          }
        }, repair] : [item])
      });
    }
    return {
      advance: true,
      message: [failureWithEvidence, `Created bounded repair commitlet: ${repair.id}`].join("\n"),
      details: { guard, health, audit, verify, repair, cheatSheet: sheet ?? undefined }
    };
  }

  if (commitlet.rollbackPoint) {
    const reverted = revertRollbackPoint(cwd, commitlet);
    defaultCommitletState.updateCommitlet(commitlet.id, reverted.ok ? "reverted" : "failed", `${verify.summary}; ${reverted.reason}`);
    return { advance: false, message: [failureWithEvidence, `Repair failed; ${reverted.reason}`].join("\n"), details: { guard, health, audit, verify, reverted, cheatSheet: sheet ?? undefined } };
  }
  defaultCommitletState.updateCommitlet(commitlet.id, "failed", verify.summary);
  return { advance: false, message: [failureWithEvidence, "Repair failed and no rollback was available."].join("\n"), details: { guard, health, audit, verify, cheatSheet: sheet ?? undefined } };
}

function shouldCreateCleanupCommitlet(plan: { commitlets: Array<{ id: string }> }, review: { accepted: boolean; blockingIssues: string[]; warnings: string[] }): boolean {
  if (review.accepted) return false;
  if (plan.commitlets.some((commitlet) => /cleanup-health$/.test(commitlet.id))) return false;
  return review.blockingIssues.length > 0 && review.blockingIssues.every((issue) => /below preferred threshold|cleanup commitlet required/i.test(issue));
}

function finalizePlan(cwd: string, plan: CommitletPlan, config: CheaterConfig): { text: string; details: unknown } {
  // Reconstruct the real accumulated diff (each commitlet's pre-edit snapshot vs current)
  // so the final review scores actual changes instead of an empty string.
  const accumulatedDiff = plan.commitlets
    .filter((commitlet) => commitlet.rollbackPoint?.snapshotDir)
    .map((commitlet) => buildCommitletDiff(
      cwd,
      commitlet.result?.filesChanged?.length ? commitlet.result.filesChanged : commitlet.allowedFiles,
      commitlet.rollbackPoint?.snapshotDir
    ).diffText)
    .filter(Boolean)
    .join("\n");
  const review = runCommitletFinalReview(plan, accumulatedDiff);
  const cfg = commitletConfig(config);
  const cleanup = cfg.autoCleanupLowRiskHealthIssues && shouldCreateCleanupCommitlet(plan, review)
    ? createCleanupCommitlet(plan, review.blockingIssues.join("; ") || review.warnings.join("; "))
    : undefined;
  const updated = cleanup
    ? { ...plan, finalReview: review, status: "running" as const, commitlets: [...plan.commitlets, cleanup], currentIndex: plan.commitlets.length }
    : { ...plan, finalReview: review, status: review.accepted ? "complete" as const : "failed" as const };
  defaultCommitletState.setPlan(updated);
  const run = activeTaskRun();
  if (run) {
    // Implementation is over: the run moves (monotonically) into VALIDATE - broad edits from
    // here on draw phase warnings, and RESERVE will follow as the budget drains.
    run.phase.advanceTo("validate");
    run.setNextAction(review.accepted ? "run cheater_finish_gate" : "resolve final-review blockers");
    updateControllerFile(run, updated, updated.status, review.accepted ? "finish gate" : "final review blockers");
    if (updated.status !== "running") run.setStatus(updated.status === "complete" ? "complete" : "failed");
    run.refreshDigest();
  }
  const telemetryFile = config.telemetryEnabled === false ? undefined : writeTelemetry(cwd, telemetryFromPlan(updated));
  return {
    text: [
      "No pending commitlets. Ran automatic final review.",
      formatCommitletFinalReview(review),
      cleanup ? `Created cleanup commitlet: ${cleanup.id} (${cleanup.title})` : ""
    ].filter(Boolean).join("\n"),
    details: { review, telemetryFile, cleanup, plan: updated }
  };
}

export function registerCommitletTools(pi: ExtensionAPI, deps: { config: CheaterConfig }): void {
  pi.registerTool({
    name: "cheater_reliability_start",
    label: "Cheater Reliability Start",
    description: "Route autopilot, create a commitlet plan, prepare the first commitlet with rollback, and return a fresh-call prompt. By default the fresh-worker handoff is simulated (prompt returned to the current session). Set spawnFreshWorker=true to spawn a real isolated LLM session via sdkFreshAgentPacketRunner.",
    parameters: Type.Object({
      userGoal: Type.String(),
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
        const actionBudget = deps.config.runStateActionBudget
          ?? plan.commitlets.reduce((sum, commitlet) => sum + commitlet.maxToolCalls, 0) + 20;
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
      const wantRealWorker = await resolveRealWorkerMode(params, deps.config, ctx);
      let prompt = buildCommitletExecutionPrompt(updated, prepared, [], wantRealWorker ? "real" : "simulated", 1, resolveModelName(deps.config, ctx));
      let fallbackNotice = "";

      if (wantRealWorker) {
        const resample = await runResampledWorker(updated, prepared, deps.config, undefined, ctx?.model, workerProgress(ctx, updated, prepared));
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
          const grade = await gradeCommitlet(ctx.cwd, gradedCommitlet, deps.config);
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
        const grade = await gradeCommitlet(ctx.cwd, running, deps.config, { allowLargeDeletion: params.approveLargeDeletion });
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
      const wantRealWorker = await resolveRealWorkerMode(params, deps.config, ctx);
      let prompt = buildCommitletExecutionPrompt(updated, prepared, previousState, wantRealWorker ? "real" : "simulated", 1, resolveModelName(deps.config, ctx));
      let fallbackNotice = "";

      if (wantRealWorker) {
        const resample = await runResampledWorker(updated, prepared, deps.config, undefined, ctx?.model, workerProgress(ctx, updated, prepared));
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
          const grade = await gradeCommitlet(ctx.cwd, gradedCommitlet, deps.config);
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
    description: "Check the completion ledger and block finishing a task without verification evidence. Returns allowed=false when verification is missing or failures are unresolved. Pass waiver=<reason> to explicitly and traceably skip verification (recorded in the ledger) instead of quietly claiming it was skipped.",
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
      const verdict = ledgerAllowsFinish(ledger);
      // Staleness gate: the completion ledger records that verification ran, but not whether
      // the files it proved were edited again afterwards. The run-state validation ledger
      // does - a finish whose only evidence is stale (or proxy-only when the contract names
      // exact artifacts) is downgraded to BLOCKED with the exact re-run instructions.
      const run = deps.config.runStateEnabled !== false ? activeTaskRun() : null;
      let recipeNote = "";
      if (run && run.contract.outputPaths.length && run.validations.summary().freshExactPasses === 0) {
        // CodeMode-lite: before judging, deterministically reread the exact artifacts the
        // contract names (parse JSON, check CSV headers) - the cheapest evaluator-mirroring
        // evidence available, produced by the harness itself, no model turn spent.
        const reread = artifactReread(run);
        recipeNote = `artifact reread (harness recipe):\n${reread.digest}`;
      }
      const freshness = run?.finishCheck();
      const allowed = verdict.allowed && (!freshness || freshness.ok);
      const state = ledger.get();
      const lines = [
        `Cheater Finish Gate: ${allowed ? "ALLOWED" : "BLOCKED"}`,
        `reason: ${verdict.allowed && !allowed ? "validation evidence is stale or proxy-only" : verdict.reason}`,
        `changedFiles: ${state.changedFiles.length} (${state.changedFiles.slice(0, 5).join(", ") || "none"})`,
        `commandsRun: ${state.commandsRun.length}`,
        `verificationStages: ${state.verification.length} (${state.verification.filter((v) => v.status === "ok").length} ok)`,
        `unresolvedFailures: ${state.unresolvedFailures.length}`,
        params.summary ? `proposedSummary: ${params.summary}` : ""
      ].filter(Boolean);
      if (recipeNote) lines.push("", recipeNote);
      if (freshness && !freshness.ok) {
        lines.push("", "Run-state freshness check:", ...freshness.warnings.map((warning) => `- ${warning}`));
      }
      if (run) {
        const checklist = run.contract.checklist;
        if (checklist.length && !allowed) lines.push("", "Contract checklist (validate these exactly):", ...checklist.slice(0, 5).map((item) => `- ${item}`));
      }
      if (!allowed) {
        lines.push("", "Finish blocked. Run cheater_verification_run to collect evidence, or resolve the listed failures before finishing.");
      }
      return textResult(lines.join("\n"), { allowed, reason: verdict.reason, freshness, ledger: state });
    }
  });

  pi.registerTool({
    name: "cheater_verification_run",
    label: "Cheater Verification Run",
    description: "Detect project dev/test/score commands, start owned services on a clean port, probe workspace identity, run smoke/focused/full/scoring checks, collect artifacts, stop owned services, and feed the completion ledger.",
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
