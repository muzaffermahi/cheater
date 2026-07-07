// The reusable reliability kernel: grading, final review, worker-mode resolution, finish
// verdict, and the completion receipt - extracted from commitlet/tools.ts so the tool
// handlers AND the closed-loop executor share ONE implementation. Two copies of grading
// logic would be two reliability kernels that drift; this module exists so that can never
// happen. Everything here is deterministic: success comes from diff guard, patch health,
// test audit, focused verification, final review, and ledger/freshness gates - never from
// model prose.

import { createCleanupCommitlet, createRepairCommitlet } from "./planner.js";
import { commitletConfig } from "./config.js";
import { setMascot } from "../ui/mascotUi.js";
import { mascotStateForPhase } from "../ui/mascot.js";
import { defaultCommitletState } from "./state.js";
import { distillFailureSidecar, renderDistillation, reviewDiffSidecar, type DiffReview } from "../sidecar/jobs.js";
import { sidecarScheduler } from "../sidecar/scheduler.js";
import { sidecarConfig } from "../sidecar/client.js";
import { recordSchedulerStats } from "../sidecar/calibration.js";
import type { SidecarClient } from "../sidecar/types.js";
import { runTypeCheckGate } from "../reliability/typeCheckGate.js";
import { runDiffGuard, countDiffLines } from "./guard.js";
import { scorePatchHealth } from "./health.js";
import { auditTestChanges } from "./testAudit.js";
import { runCommitletFinalReview } from "./reviewer.js";
import { formatCommitletFinalReview, formatGuardHealthAudit } from "./ui.js";
import { telemetryFromPlan, writeTelemetry } from "./telemetry.js";
import { revertRollbackPoint } from "./rollback.js";
import { runFocusedVerification } from "./verification.js";
import { evaluateCheckFirst, buildEvidenceTable, renderEvidenceTable, resetTransientState, type CheckFirstResult, type EvidenceRow } from "./checkFirst.js";
import { loadProjectCommands } from "../reliability/projectCommands.js";
import { scoreHardness } from "../runtime/computeBudget.js";
import { buildCommitletDiff } from "./diffUtil.js";
import { probeWorkerBackend, resetWorkerBackendLatch, workerBackendState } from "../blueprint/worker.js";
import { liveSessionState } from "../reliability/sessionState.js";
import { classifyFailure, ledgerAllowsFinish, type CompletionLedger } from "../reliability/lifecycle.js";
import { activeTaskRun, type TaskRunState } from "../runstate/runState.js";
import { mainCallGovernor } from "../runtime/mainCallGovernor.js";
import { sidecarUsage } from "../runtime/sidecarUsage.js";
import { getWorkerPromptShape, promptShapeLine } from "../runtime/promptShape.js";
import { providerCapabilityLines } from "../providers/lmStudioStateful.js";
import { normalizeToolError } from "../runtime/toolErrorNormalize.js";
import { writeControllerFile } from "../runstate/workerPlans.js";
import { artifactReread } from "../runstate/recipes.js";
import { effectiveMode, planAllowedFileUnion, isRepairCommitlet } from "./types.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import type { CheaterConfig } from "../types.js";
import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

type ExtensionContext = any;

export interface GradeResult {
  advance: boolean;
  message: string;
  details: unknown;
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
 * and test contexts have none, so they never probe). The latch caches the answer, so a
 * closed-loop run pays the probe cost at most once.
 */
export async function resolveRealWorkerMode(params: { spawnFreshWorker?: boolean }, config: CheaterConfig, ctx: ExtensionContext): Promise<boolean> {
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
 * The model name for packet operating-rule selection (small/medium/large/unknown), preferring
 * the live session's actual model over the static config default.
 */
export function resolveModelName(config: CheaterConfig, ctx: ExtensionContext): string | undefined {
  return ctx?.model?.id ?? config.model;
}

/**
 * Live terminal narration for fresh-worker runs. A local model streams for minutes per
 * attempt; milestones go to the chat via notify (they are minutes apart, not per-tool), and
 * the working spinner text is updated so the current activity is always visible.
 */
export function workerProgress(ctx: ExtensionContext, plan: CommitletPlan, commitlet: Commitlet): (message: string) => void {
  const position = `${plan.commitlets.findIndex((c) => c.id === commitlet.id) + 1}/${plan.commitlets.length}`;
  return (message: string) => {
    const line = `Cheater [commitlet ${position}] ${message}`;
    try {
      // The mascot's expression follows the work (sampling/verifying/working); it also sets the
      // working message. No-op in JSON/headless. notify stays for the milestone chat line.
      setMascot(ctx, mascotStateForPhase(message), line);
      ctx?.ui?.notify?.(line, "info");
    } catch { /* narration must never break the run */ }
  };
}

/**
 * Spinner-ONLY liveness ticker for a streaming worker: updates setWorkingMessage every beat so
 * a multi-minute local run never looks hung, WITHOUT calling notify (which appends chat lines
 * and jumps the viewport - the mistake the sixth pass fixed). Milestone narration stays on
 * workerProgress; this is just "still alive, N s elapsed".
 */
export function workerHeartbeat(ctx: ExtensionContext, plan: CommitletPlan, commitlet: Commitlet): (elapsedMs: number) => void {
  const position = `${plan.commitlets.findIndex((c) => c.id === commitlet.id) + 1}/${plan.commitlets.length}`;
  return (elapsedMs: number) => {
    const secs = Math.round(elapsedMs / 1000);
    // A fresh worker prefills its whole prompt from COLD (no shared KV cache). On a big model with
    // little VRAM that prefill can take minutes ("stuck at 0%"). After a slow first beat, surface
    // the real levers so the user isn't left staring at a spinner wondering if it hung.
    const tip = secs >= 75
      ? ` - slow PREFILL (this fresh worker re-processes its prompt cold). Faster: use a model that fits in VRAM, OR set "commitletFreshWorkerDefault": false to run in-session (reuses the warm cache instead of re-prefilling per file), OR raise LM Studio's GPU offload.`
      : "";
    try {
      setMascot(ctx, "working", `Cheater [commitlet ${position}] worker still streaming on the local model (${secs}s)...${tip}`);
    } catch { /* heartbeat must never break the run */ }
  };
}

/**
 * Keep controller.md in step with the plan: the durable file a respawned controller (or a
 * human) reads to learn the decomposition, statuses, phase, and next step. Best-effort.
 */
export function updateControllerFile(run: TaskRunState, plan: CommitletPlan, status: string, nextStep: string): void {
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
// Dirs that never hold project source; skipped by the scaffold basename walk.
const SCAFFOLD_WALK_SKIP = new Set([".git", "node_modules", ".cheater", ".pisession", "dist", "build", ".next", "out", "coverage", ".vite"]);
/**
 * The lower-cased basenames of every file in the project (bounded walk). A scaffold phase's expected
 * files are satisfied by NAME regardless of directory: the model routinely builds a cleaner structure
 * than the upfront plan guessed (src/components/TodoItem.tsx for a planned src/TodoItem.tsx) AND
 * front-loads all writes into an early phase, so requiring the EXACT planned path made later phases
 * spuriously "incomplete" - the model then looped or created redundant re-export files. The real gate
 * is the build, so name-presence is enough to advance a phase.
 */
// How many times each scaffold phase has been graded "incomplete". Capped so a filename mismatch the
// model won't resolve (it built src/main.tsx for a planned src/index.tsx - both valid entries) can never
// loop more than twice before the phase advances. Keyed by commitlet id; cleared when the phase advances.
const scaffoldIncompleteAttempts = new Map<string, number>();

function projectBasenames(cwd: string): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SCAFFOLD_WALK_SKIP.has(entry.name)) walk(join(dir, entry.name), depth + 1);
        } else {
          names.add(entry.name.toLowerCase());
        }
      }
    } catch {
      /* unreadable dir - skip */
    }
  };
  walk(cwd, 0);
  return names;
}

/**
 * Check-first stage (Phase 1): resolve a real check for a passing commitlet and, on the
 * hard/multi-commitlet lane, red-then-green screen it. Records strong/weak evidence into the
 * validation ledger (feeds the finish-gate evidence table + freshness) and the completion ledger
 * (feeds the receipt + weakly-verified surfacing). Purely additive: never blocks advance, fully
 * guarded so a throw degrades to no-op.
 */
function runCheckFirstStage(cwd: string, commitlet: Commitlet, config: CheaterConfig, touchedFiles: string[], verify: ReturnType<typeof runFocusedVerification>): CheckFirstResult | undefined {
  try {
    if (config.runStateEnabled === false) return undefined;
    const run = activeTaskRun();
    const plan = defaultCommitletState.get().currentPlan;
    const implementCount = plan ? plan.commitlets.filter((c) => !isRepairCommitlet(c)).length : 1;
    const { hardness } = scoreHardness({
      taskKind: plan?.autopilotDecision?.taskKind,
      risk: String(commitlet.risk ?? plan?.risk ?? ""),
      filesInScope: touchedFiles.length || commitlet.allowedFiles.length,
      isRepair: isRepairCommitlet(commitlet)
    });
    // Tier 2/3 synthesis + the mutation screen are hardness-gated: multi-commitlet or hard tasks only.
    const synthesisAllowed = implementCount > 1 || hardness >= 2;
    const result = evaluateCheckFirst(cwd, commitlet, {
      contract: run?.contract ?? null,
      projectCommands: loadProjectCommands(cwd),
      runDir: run?.runDir,
      synthesisAllowed,
      precomputedGreen: verify
    });
    if (result.ran && run) {
      // Weak checks are recorded "unknown" (ran but not red-proven) so they never count as a strong
      // evaluator-mirroring pass; only a red-then-green PROVEN (or a covering tier-1 green) is "pass".
      run.recordValidation({
        name: `check_first:tier${result.tier}:${result.verdict}`,
        command: result.provenCommand ?? result.commands[0],
        actor: commitlet.id,
        validates: touchedFiles,
        status: result.verdict === "green_failed" ? "fail" : result.weaklyVerified ? "unknown" : "pass",
        outputSummary: `${result.weaklyVerified ? "weak" : "strong"} (${result.kind}): ${result.note}`.slice(0, 280)
      });
    }
    liveSessionState.getLedger()?.addEntry("check_first", result.note, {
      tier: result.tier,
      kind: result.kind,
      verdict: result.verdict,
      weaklyVerified: result.weaklyVerified,
      commitletId: commitlet.id
    });
    return result;
  } catch {
    return undefined;
  }
}

export async function gradeCommitlet(cwd: string, commitlet: Commitlet, config: CheaterConfig, overrides: { allowLargeDeletion?: boolean; sidecar?: SidecarClient } = {}): Promise<GradeResult> {
  const observedEdits = liveSessionState.consumeCommitletEdits();
  const plan = defaultCommitletState.get().currentPlan;
  const lane = effectiveMode(plan, commitlet);
  // Scaffold lane enforces the plan-wide allow-set (any planned file may be built now), consistent
  // with the pre-write guard; surgical/repair stay on the commitlet's own files.
  const allowedScope = lane === "scaffold" && plan ? planAllowedFileUnion(plan) : undefined;
  const candidateFiles = [...new Set([...commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")), ...observedEdits])];
  const { diffText, touchedFiles } = buildCommitletDiff(cwd, candidateFiles, commitlet.rollbackPoint?.snapshotDir);

  // Real-work gate: a commitlet that changed nothing on disk is NEVER "verified" (mirrors
  // scoreCandidate's touchedFiles>0 check, closing the hole where a worker/model that only CLAIMED
  // success graded as passed). In the scaffold lane an incomplete phase is not a failure - the model
  // just hasn't written every file yet - so we tell it what's missing and keep the phase running
  // (no revert), instead of hard-failing.
  const expectedPhaseFiles = commitlet.expectedFilesTouched.filter((file) => file && !file.startsWith("(") && !file.endsWith("/"));
  // A phase file is satisfied by its EXACT planned path OR by any file of the same basename ANYWHERE in
  // the project - the model's own directory structure is valid (the build is the real gate), and this
  // lets front-loaded writes satisfy later phases immediately instead of looping on "not complete yet".
  // Crucially we NO LONGER block a phase just because nothing was written THIS turn (touchedFiles===0):
  // if the expected files already exist, advance; the only reason to hold a phase is a genuinely absent
  // file the build would need.
  let missingFiles: string[] = [];
  if (lane === "scaffold" && expectedPhaseFiles.length) {
    const present = projectBasenames(cwd);
    missingFiles = expectedPhaseFiles.filter((file) => !existsSync(join(cwd, file)) && !present.has(basename(file).toLowerCase()));
  }
  if (lane === "scaffold" && missingFiles.length) {
    // Ask for the missing files at most twice. After that the model has clearly built an EQUIVALENT
    // structure under different names (e.g. src/main.tsx for a planned src/index.tsx - both valid Vite
    // entries) and will not create the exact name; blocking further just loops. The final `npm run
    // build` is the real gate, so we advance and let the build catch any genuinely-absent module.
    const attempts = (scaffoldIncompleteAttempts.get(commitlet.id) ?? 0) + 1;
    scaffoldIncompleteAttempts.set(commitlet.id, attempts);
    if (attempts <= 2) {
      return {
        advance: false,
        message: [
          `Phase ${commitlet.id} is not complete yet.`,
          `Still to create (any directory/structure is fine - matched by file NAME, not path): ${missingFiles.map((file) => basename(file)).join(", ")}.`,
          "Create the remaining file(s) with the write tool - OR, if a file you already wrote fills the same role under a different name, just call cheater_commitlet_next again and the phase will advance (the build is the real gate)."
        ].join("\n"),
        details: { missingFiles, touched: touchedFiles }
      };
    }
  }
  scaffoldIncompleteAttempts.delete(commitlet.id);

  // Scaffold lane grades LENIENTLY: a from-scratch build's real gate is the final `npm run build`
  // (the finish gate), not a bounded-diff guard. Once this phase's files exist we advance, and we
  // NEVER revert (reverting a from-scratch phase wipes the files the model just built - the reported
  // "empty src/" bug where a health score of 0 deleted 6 real files). Health/scope/size are advisory
  // only; a huge new App.tsx legitimately scores low and must not block or be destroyed.
  if (lane === "scaffold") {
    const verify = runFocusedVerification(cwd, commitlet);
    const scaffoldHealth = scorePatchHealth({ diffText, filesTouched: touchedFiles, threshold: config.healthScoreThreshold, hardRejectThreshold: config.hardRejectHealthThreshold });
    const ledger = liveSessionState.getLedger();
    // Same real-worker/finish-gate fix as the surgical path below: record the touched files into
    // the MAIN ledger so a scaffold built by fresh workers is not seen as "no work was done".
    if (ledger) {
      for (const file of touchedFiles) ledger.recordFileChange(file);
      for (const cmd of verify.commandsRun) ledger.recordCommand(cmd);
    }
    activeTaskRun()?.integrateWorkerReport({
      workerRole: commitlet.id,
      summary: `scaffold phase created ${touchedFiles.length} file(s)`,
      filesChanged: touchedFiles,
      commandsRun: verify.commandsRun,
      validationResults: [`scaffold phase: ${touchedFiles.length} file(s) created`],
      problems: [],
      recommendedNextAction: "advance to the next phase; the final build is the real gate",
      contractSatisfied: "yes"
    });
    defaultCommitletState.updateCommitlet(commitlet.id, "passed", `scaffold phase created ${touchedFiles.length} file(s)`, {
      filesChanged: touchedFiles,
      diffLines: countDiffLines(diffText),
      testsRun: verify.commandsRun,
      verificationPassed: verify.passed,
      healthPassed: true,
      rollbackAvailable: Boolean(commitlet.rollbackPoint),
      summary: `scaffold phase created ${touchedFiles.length} file(s)`,
      issues: []
    });
    return {
      advance: true,
      message: [
        `Scaffold phase ${commitlet.id}: created ${touchedFiles.length} file(s).`,
        scaffoldHealth.passed ? "" : `(patch health ${scaffoldHealth.score} - advisory only for a from-scratch phase; files preserved)`,
        "Continue to the next phase. Before finishing, run `npm run build` - that is the real gate."
      ].filter(Boolean).join("\n"),
      details: { health: scaffoldHealth, verify, touchedFiles, scaffold: true }
    };
  }

  const guard = runDiffGuard(commitlet, { touchedFiles, diffText }, { allowLargeDeletion: overrides.allowLargeDeletion, allowedScope });
  const health = scorePatchHealth({ diffText, filesTouched: touchedFiles, threshold: config.healthScoreThreshold, hardRejectThreshold: config.hardRejectHealthThreshold });
  const isTestChange = touchedFiles.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file));
  const audit = isTestChange ? auditTestChanges(diffText, commitlet.spec?.acceptanceCriteria ?? []) : { passed: true, warnings: [], blockingIssues: [] };
  // surgical/repair: an empty diff is a real failure (nothing to verify) - fold it into the guard so
  // it can never slip through to a vacuous "passed verification".
  const emptyEditIssues = touchedFiles.length === 0 ? ["No file changes were recorded for this commitlet; there is nothing to verify. Make the edit before grading."] : [];
  const guardOk = guard.passed && health.passed && audit.passed && emptyEditIssues.length === 0;

  if (!guardOk) {
    const issues = [...guard.blockingIssues, ...health.blockingIssues, ...audit.blockingIssues, ...emptyEditIssues];
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
      message: [`Commitlet ${commitlet.id} blocked by guard/health/test audit.`, ...emptyEditIssues, formatGuardHealthAudit({ guard, health, audit })].join("\n"),
      details: { guard, health, audit }
    };
  }

  let verify = runFocusedVerification(cwd, commitlet);
  const ledger = liveSessionState.getLedger();
  if (ledger) {
    // Record the files this commitlet touched into the MAIN completion ledger. This is the load-
    // bearing line for real-worker execution: a fresh isolated worker edits files in its OWN pi
    // session, so those writes never reach this session's observeToolResult and the finish gate
    // would see changedFiles:0 -> the false "no work was done" block that made weak models loop
    // forever. touchedFiles is diffed from disk vs the rollback snapshot, so it captures the
    // worker's edits (and the in-session model's) uniformly. Recorded even on a failing verify:
    // the files WERE changed; the finish gate should then block on the real failure, not on "no
    // work". Combined with the same-goal re-entry preservation in reset(), this survives the
    // model looping back through the planning tools.
    for (const file of touchedFiles) ledger.recordFileChange(file);
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

  // Bounded typecheck gate (R1): deterministic type truth attributed to the files this change
  // touched. A changed-file type error folds into `verify` so it flows through the SAME bounded
  // repair path below (escapable, and it gets sidecar-distilled) instead of a separate dead-end.
  // Pre-existing errors / timeout / no typechecker record a stage but never block. Off by default.
  const typecheck = runTypeCheckGate({ cwd, changedFiles: touchedFiles, config });
  if (typecheck.ran) {
    if (ledger) {
      if (typecheck.command) ledger.recordCommand(typecheck.command);
      ledger.recordVerificationStage({
        stage: "typecheck",
        status: typecheck.blocking ? "failed" : "ok",
        summary: typecheck.summary,
        failureClass: typecheck.blocking ? "app_bug" : "unknown",
        artifacts: [],
        signals: { commitletId: commitlet.id, changedFileErrors: typecheck.changedFileErrors.length, otherErrors: typecheck.otherErrorCount }
      });
    }
    if (typecheck.blocking) {
      verify = verify.passed
        ? { ...verify, passed: false, summary: `Typecheck failed: ${typecheck.summary}`, failures: typecheck.changedFileErrors }
        : { ...verify, failures: [...verify.failures, ...typecheck.changedFileErrors] };
    }
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
    // Check-first (Phase 1): resolve a REAL check for this commitlet and, on the hard/multi-commitlet
    // lane, red-then-green screen it (the check must fail without the change, pass with it). This is
    // additive - it records strong/weak evidence for the finish gate's evidence table but does not by
    // itself block advance (the existing guard/health/verify already gate that). Fully guarded inside
    // evaluateCheckFirst, so a throw degrades to a static-floor result and never breaks grading.
    const checkFirst = runCheckFirstStage(cwd, commitlet, config, touchedFiles, verify);
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
    // Second pair of eyes (advisory, background): the sidecar reviews this PASSING diff for the
    // semantic bugs the gates can't see. Fire-and-forget - consumed at final review, never blocks.
    if (sidecarScheduler.enabled()) {
      const goal = defaultCommitletState.get().currentPlan?.userGoal ?? "";
      sidecarScheduler.dispatch("review_diff", `review:${commitlet.id}`, commitlet.id, (client) => reviewDiffSidecar(client, diffText, goal));
    }
    return {
      advance: true,
      message: [
        `Commitlet ${commitlet.id} passed guard, health, and focused verification.`,
        verify.summary,
        checkFirst?.ran ? `check-first: ${checkFirst.note}` : ""
      ].filter(Boolean).join("\n"),
      details: { guard, health, audit, verify, checkFirst }
    };
  }

  const rawFailure = [verify.summary, ...verify.failures].join("\n");
  let failureWithEvidence = verify.summary;

  // Tool-error normalization (governor-gated, additive): reshape the raw failure into a bounded,
  // structured kind for the ledger/receipt so we can SEE that clerical error-shaping stayed OFF the
  // big model. Does not touch the model-facing failure card (already bounded + distilled). This is
  // clerical work code owns - the big model never gets raw stderr sludge.
  if (mainCallGovernor.isEnabled()) {
    const normalized = normalizeToolError({ output: rawFailure, isError: true });
    ledger?.addEntry("tool_error", `[${normalized.kind}] ${normalized.summary}`, { kind: normalized.kind, commitletId: commitlet.id });
    mainCallGovernor.recordAvoided("tool_error_normalize", "deterministic", `normalized ${normalized.kind}`);
  }

  // Sidecar (optional, off by default): distill the raw failure into a compact
  // cause/hint/don't-repeat note so the repair worker starts INFORMED instead of re-deriving
  // the same wrong path (roadmap R4). The deterministic fallback lives inside the job; we only
  // splice the note in when the sidecar actually produced a sharper result, so behavior is
  // identical when the sidecar is off. The ledger entry is recorded either way, so the receipt
  // shows the sidecar was consulted and whether it was used or fell back - honest observability.
  if (overrides.sidecar?.available()) {
    // Route through the scheduler: if a prefetch already distilled this failure it's used for free,
    // otherwise it runs live now. Either way the client-backed job (with its deterministic
    // fallback) is the work; the scheduler just adds caching + hit/fallback telemetry.
    const sidecarClient = overrides.sidecar;
    const distilled = await sidecarScheduler.getOrRun(
      "distill_failure",
      `distill:${commitlet.id}`,
      rawFailure.slice(0, 160),
      () => distillFailureSidecar(sidecarClient, rawFailure, { goal: defaultCommitletState.get().currentPlan?.userGoal })
    );
    ledger?.addEntry("sidecar", `${distilled.label}: ${distilled.note}`, { label: distilled.label, source: distilled.source, confidence: distilled.confidence, commitletId: commitlet.id });
    // Accounting: failure distillation is a clerical job the sidecar/deterministic code owns - a big
    // model call avoided (the big model is reserved for actually WRITING the repair).
    sidecarUsage.record("failure_distill", distilled.source);
    mainCallGovernor.recordAvoided("failure_distill", distilled.source === "sidecar" ? "sidecar" : "deterministic", distilled.note);
    if (distilled.source === "sidecar") {
      // Append, never prepend: the bare failure must stay first so createRepairCommitlet builds
      // purpose/acceptance from the real failure and strips this distilled block as evidence. The
      // distill IS the single failure-path sidecar consult; parse_failure (a structured file/test/
      // assertion card) is available as a job but is not a second consult here - the distill already
      // replaces raw-log noise with a repair-ready note.
      failureWithEvidence = `${failureWithEvidence}\n${renderDistillation(distilled.value)}`;
    }
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
      details: { guard, health, audit, verify, repair }
    };
  }

  if (commitlet.rollbackPoint) {
    const reverted = revertRollbackPoint(cwd, commitlet);
    defaultCommitletState.updateCommitlet(commitlet.id, reverted.ok ? "reverted" : "failed", `${verify.summary}; ${reverted.reason}`);
    return { advance: false, message: [failureWithEvidence, `Repair failed; ${reverted.reason}`].join("\n"), details: { guard, health, audit, verify, reverted } };
  }
  defaultCommitletState.updateCommitlet(commitlet.id, "failed", verify.summary);
  return { advance: false, message: [failureWithEvidence, "Repair failed and no rollback was available."].join("\n"), details: { guard, health, audit, verify } };
}

export function shouldCreateCleanupCommitlet(plan: { commitlets: Array<{ id: string }> }, review: { accepted: boolean; blockingIssues: string[]; warnings: string[] }): boolean {
  if (review.accepted) return false;
  if (plan.commitlets.some((commitlet) => /cleanup-health$/.test(commitlet.id))) return false;
  return review.blockingIssues.length > 0 && review.blockingIssues.every((issue) => /below preferred threshold|cleanup commitlet required/i.test(issue));
}

export function finalizePlan(cwd: string, plan: CommitletPlan, config: CheaterConfig): { text: string; details: { review: ReturnType<typeof runCommitletFinalReview>; telemetryFile?: string; cleanup?: Commitlet; plan: CommitletPlan; reviewConcerns?: string[] } } {
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
  const review = runCommitletFinalReview(plan, accumulatedDiff, config);
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
  // Calibration (M1): fold this run's sidecar prefetch hit/fallback stats into the durable store,
  // keyed by the sidecar model, so low-value prefetch types self-disable over time.
  const scfg = sidecarConfig(config);
  if (scfg.enabled) recordSchedulerStats(cwd, scfg.modelId ?? "main", sidecarScheduler.stats().byType);
  const telemetryFile = config.telemetryEnabled === false ? undefined : writeTelemetry(cwd, telemetryFromPlan(updated));
  // Consume the sidecar's background diff reviews (the advisory "second pair of eyes"). Ready-only,
  // no blocking: findings that landed in time are surfaced; misses are simply omitted. Never gates.
  const reviewConcerns: string[] = [];
  for (const commitlet of updated.commitlets) {
    if (commitlet.status !== "passed") continue;
    const review = sidecarScheduler.peek<DiffReview>(`review:${commitlet.id}`, commitlet.id);
    if (review?.concerns.length) reviewConcerns.push(...review.concerns.map((concern) => `- [${commitlet.id}] ${concern}`));
  }
  if (reviewConcerns.length) {
    liveSessionState.getLedger()?.addEntry("sidecar", `review_diff: ${reviewConcerns.length} advisory concern(s)`, { label: "review_diff", source: "sidecar" });
  }
  return {
    text: [
      "No pending commitlets. Ran automatic final review.",
      formatCommitletFinalReview(review),
      reviewConcerns.length ? ["", "Sidecar review (advisory - not blocking; worth a look):", ...reviewConcerns].join("\n") : "",
      cleanup ? `Created cleanup commitlet: ${cleanup.id} (${cleanup.title})` : ""
    ].filter(Boolean).join("\n"),
    details: { review, telemetryFile, cleanup, plan: updated, reviewConcerns }
  };
}

/**
 * Clean-state rule (Phase 1): before the finish gate runs its checks, move self-test debris aside -
 * run-created data files (the expenses.json the app wrote while the model test-ran it, *.db, *.log)
 * that are NOT contract deliverables. Non-destructive: files move into .cheater/transient-aside/, so
 * a misclassification never loses a real artifact. Best-effort and fully guarded.
 */
export function resetSelfTestDebris(cwd: string, config: CheaterConfig): { removed: string[] } {
  try {
    if (config.runStateEnabled === false) return { removed: [] };
    const run = activeTaskRun();
    if (!run) return { removed: [] };
    const created = run.mutations.summary().createdFiles;
    const deliverables = [...run.contract.outputPaths, ...run.contract.files];
    const result = resetTransientState(cwd, created, deliverables, { mode: "aside" });
    if (result.removed.length) {
      liveSessionState.getLedger()?.addEntry("clean_state", `moved ${result.removed.length} self-test data file(s) aside before finish: ${result.removed.slice(0, 5).join(", ")}`, { removed: result.removed });
    }
    return { removed: result.removed };
  } catch {
    return { removed: [] };
  }
}

export interface FinishVerdictResult {
  allowed: boolean;
  reason: string;
  /** Full human-readable report lines. */
  lines: string[];
  freshness?: { ok: boolean; warnings: string[] };
  ledgerState: ReturnType<CompletionLedger["get"]>;
  /** Phase 1: each contract checklist item mapped to the validation evidence that proves it. */
  evidence?: EvidenceRow[];
  /** Phase 1: weakly-verified commitlets (tier stated) - WARNED, never a hard block. */
  warnings?: string[];
}

/**
 * The non-waiver finish verdict shared by cheater_finish_gate and the closed-loop executor:
 * completion-ledger gate (work done, no unresolved failures, terminal verification) PLUS the
 * run-state staleness gate (a pass that predates the last mutation of its files is not
 * evidence; proxy-only passes do not satisfy a contract that names exact artifacts). When
 * the contract names output artifacts with no fresh exact pass, the harness rereads them
 * itself first (JSON must parse, CSV headers must match) - the cheapest evaluator-mirroring
 * evidence, zero model turns.
 */
export function finishVerdict(config: CheaterConfig, opts: { summary?: string } = {}): FinishVerdictResult | null {
  const ledger = liveSessionState.getLedger();
  if (!ledger) return null;
  const verdict = ledgerAllowsFinish(ledger);
  const run = config.runStateEnabled !== false ? activeTaskRun() : null;
  let recipeNote = "";
  if (run && run.contract.outputPaths.length && run.validations.summary().freshExactPasses === 0) {
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
    opts.summary ? `proposedSummary: ${opts.summary}` : ""
  ].filter(Boolean);
  if (recipeNote) lines.push("", recipeNote);
  if (freshness && !freshness.ok) {
    lines.push("", "Run-state freshness check:", ...freshness.warnings.map((warning) => `- ${warning}`));
  }
  // Phase 1 evidence table: the product's face - each contract checklist item mapped to the
  // validation that proves it (verified / weak / unverified). Descriptive, not a new blocker.
  let evidence: EvidenceRow[] | undefined;
  if (run && run.contract.checklist.length) {
    evidence = buildEvidenceTable(run.contract.checklist, run.validations.all());
    lines.push("", ...renderEvidenceTable(evidence));
  }
  // Weakly-verified surfacing: commitlets whose check could not be red-proven (static floor, no
  // rollback snapshot, or a garbage check). WARNED, never a hard block - the finish decision above
  // still stands, but the receipt must say honestly which pieces are only weakly verified.
  const warnings: string[] = [];
  for (const entry of state.entries) {
    if (entry.kind !== "check_first") continue;
    const x = entry.extra as { tier?: number; kind?: string; commitletId?: string; weaklyVerified?: boolean };
    if (x?.weaklyVerified) warnings.push(`${x.commitletId ?? "commitlet"} (tier ${x.tier}, ${x.kind}): ${entry.summary}`.slice(0, 200));
  }
  if (warnings.length) {
    lines.push("", `WARNED: ${warnings.length} weakly-verified commitlet(s) (finish ${allowed ? "allowed" : "still blocked"}, but the check was not red-then-green proven):`, ...warnings.slice(0, 5).map((w) => `- ${w}`));
  }
  if (!allowed) {
    lines.push("", "Finish blocked. Run cheater_verification_run to collect evidence, or resolve the listed failures before finishing.");
  }
  return { allowed, reason: verdict.reason, lines, freshness, ledgerState: state, evidence, warnings: warnings.length ? warnings : undefined };
}

/** Compact, code-generated completion receipt: what the harness actually observed. */
export function buildCompletionReceipt(ledger: CompletionLedger): string {
  const s = ledger.get();
  const okStages = s.verification.filter((v) => v.status === "ok").map((v) => v.stage);
  const lines = [
    "Cheater: done - verified",
    `changed: ${s.changedFiles.slice(0, 6).join(", ") || "(none)"}`,
    `ran: ${s.commandsRun.slice(-3).join(" | ") || "(none)"}`,
    `verified: ${okStages.join(", ") || "(none)"}`
  ];
  // Resampling and evidence facts come from ledger entries the harness itself recorded -
  // the receipt reports what actually happened, including degraded fresh-worker modes.
  const resamples = s.entries.filter((entry) => entry.kind === "resample");
  if (resamples.length) {
    const last = resamples.at(-1)!;
    const x = last.extra as { attemptsRun?: number; samplesRequested?: number; appliedAttempt?: number; passed?: boolean; freshWorkerMode?: string };
    lines.push(`resampling: attempt ${x.appliedAttempt}/${x.attemptsRun} applied (${x.passed ? "verified pass" : "best failing candidate"}); workers: ${x.freshWorkerMode ?? "real"}`);
  }
  const evidence = s.entries.filter((entry) => entry.kind === "cheat_evidence");
  if (evidence.length) {
    const sources = [...new Set(evidence.flatMap((entry) => ((entry.extra as { sources?: string[] })?.sources ?? [])))];
    lines.push(`evidence: cheat sheet used (${sources.join(", ")})`);
  }
  // Sidecar usage from ground-truth ledger entries: how many small-model chores ran, how many
  // actually used the sidecar vs. fell back deterministically. Keeps dead features from hiding.
  const sidecarEntries = s.entries.filter((entry) => entry.kind === "sidecar");
  if (sidecarEntries.length) {
    const used = sidecarEntries.filter((entry) => (entry.extra as { source?: string })?.source === "sidecar").length;
    const labels = [...new Set(sidecarEntries.map((entry) => (entry.extra as { label?: string })?.label ?? "sidecar"))];
    lines.push(`sidecar: ${sidecarEntries.length} call(s), ${used} used, ${sidecarEntries.length - used} fell back (${labels.join(", ")})`);
  }
  const schedulerStats = sidecarScheduler.stats();
  if (schedulerStats.dispatched > 0) lines.push(sidecarScheduler.summaryLine());
  // Main-call budget + sidecar liveness + provider capability (Part F). Gated on the governor so the
  // receipt is byte-identical when the control plane is off. All facts are code-generated (the big
  // model is never asked to write the receipt) - if it isn't visible here, it isn't real.
  if (mainCallGovernor.isEnabled()) {
    lines.push(...mainCallGovernor.receiptLines());
    lines.push(...sidecarUsage.receiptLines());
    const shapeLine = promptShapeLine(getWorkerPromptShape());
    if (shapeLine) lines.push(shapeLine);
    lines.push(...providerCapabilityLines());
  }
  return lines.join("\n");
}
