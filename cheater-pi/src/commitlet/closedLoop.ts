// The deterministic closed-loop executor: the harness drives the commitlet chain.
//
// Before this module, the MODEL was the orchestration bus - it had to remember to call
// cheater_commitlet_next after every edit, which is exactly the long-chain reliability
// burden small local models fail at. The closed loop moves orchestration into code:
// route -> plan -> for each commitlet (prepare rollback -> spawn bounded worker -> grade in
// code -> auto-queue repair) -> final review -> finish gate -> deterministic receipt. The
// model's only job is bounded local implementation inside a worker.
//
// Honesty rule: the loop is only truly closed when real fresh workers can spawn. If the
// backend cannot, this module does NOT pretend the harness executed anything - it returns a
// structured "simulated handoff required" result carrying the first worker prompt, and the
// session continues on the classic reliability_start/commitlet_next flow.
//
// Every dependency is injectable so the loop's state machine is testable without a model,
// a filesystem diff, or a Pi backend - but the DEFAULTS are the one real kernel
// (gradeCommitlet/finalizePlan/finishVerdict from kernel.ts). There is no second grader.

import { routeAutopilot } from "../autopilot/router.js";
import { createAutonomousBlueprint } from "../blueprint/autonomous.js";
import { defaultBlueprintState } from "../blueprint/state.js";
import { createCommitletPlan, buildScaffoldCommitlets } from "./planner.js";
import { isFromScratchBuild, proposeScaffoldFiles, type ScaffoldFile } from "../blueprint/scaffold.js";
import { detectStackProfile, stampProfile, deriveAppName, type StampedFile } from "../blueprint/stackTemplates.js";
import { defaultCommitletState } from "./state.js";
import { buildCommitletExecutionPrompt, commitletRepoFacts, prepareCommitlet } from "./executor.js";
import { runResampledWorker } from "./resampling.js";
import {
  mainModelSampler,
  runInSessionResample,
  shouldResampleInSession,
  singleTargetFile,
  type InSessionResampleOutcome
} from "./inSessionResample.js";
import { computeBudget } from "../runtime/computeBudget.js";
import { isRepairCommitlet } from "./types.js";
import { liveSessionState } from "../reliability/sessionState.js";
import { resolveSidecarClient, sidecarConfig, sdkSidecarClient } from "../sidecar/client.js";
import { sidecarScheduler } from "../sidecar/scheduler.js";
import { routeGoalSidecar, prepareContextSidecar } from "../sidecar/jobs.js";
import { jobGate } from "../sidecar/calibration.js";
import type { SidecarClient } from "../sidecar/types.js";
import { mainCallGovernor, workerRoleForCommitletId } from "../runtime/mainCallGovernor.js";
import { sidecarUsage, sidecarKeepAlive } from "../runtime/sidecarUsage.js";
import { getWorkerPromptShape, resetWorkerPromptShape } from "../runtime/promptShape.js";
import { runProviderProbe } from "../providers/lmStudioStateful.js";
import { setLeanCapsule } from "../runstate/promptCapsule.js";
import { workerBackendReason } from "../blueprint/worker.js";
import { steeringControl } from "../runstate/steering.js";
import { activeTaskRun, beginTaskRun, type TaskRunState } from "../runstate/runState.js";
import {
  buildCompletionReceipt,
  finalizePlan,
  finishVerdict,
  gradeCommitlet,
  resolveModelName,
  resolveRealWorkerMode,
  updateControllerFile,
  workerProgress,
  workerHeartbeat
} from "./kernel.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import type { CheaterConfig } from "../types.js";

type ExtensionContextLike = any;

export interface ClosedLoopStep {
  commitletId: string;
  title: string;
  outcome: "passed" | "repair_created" | "worker_failed" | "blocked" | "failed" | "skipped_repair_budget";
  note: string;
}

export interface ClosedLoopRunParams {
  cwd: string;
  userGoal: string;
  config: CheaterConfig;
  ctx?: ExtensionContextLike;
  spawnFreshWorker?: boolean;
  maxCommitlets?: number;
  maxRepairRounds?: number;
  approveLargeDeletion?: boolean;
  useActiveBlueprint?: boolean;
}

export interface ClosedLoopRunResult {
  ok: boolean;
  status: "complete" | "failed" | "blocked" | "partial";
  freshWorkerMode: "real" | "simulated" | "none";
  summary: string;
  steps: ClosedLoopStep[];
  plan?: CommitletPlan;
  /** Present only in simulated mode: the first worker prompt for the session to execute. */
  handoffPrompt?: string;
  receipt?: string;
  error?: string;
  details?: unknown;
}

/** Injectable seams for tests. Defaults are the one real reliability kernel. */
export interface ClosedLoopDeps {
  route: typeof routeAutopilot;
  createBlueprint: typeof createAutonomousBlueprint;
  createPlan: typeof createCommitletPlan;
  prepare: typeof prepareCommitlet;
  runWorker: typeof runResampledWorker;
  grade: typeof gradeCommitlet;
  finalize: typeof finalizePlan;
  finish: typeof finishVerdict;
  resolveWorkerMode: typeof resolveRealWorkerMode;
  /** In-session best-of-N pre-build (local best-of-N). Injectable so the wiring is testable without
   *  a model; the default runs k direct main-model completions via mainModelSampler. */
  runInSession: (
    plan: CommitletPlan,
    commitlet: Commitlet,
    config: CheaterConfig,
    ctx: ExtensionContextLike,
    samples: number,
    onProgress?: (message: string) => void
  ) => Promise<InSessionResampleOutcome>;
}

const DEFAULT_DEPS: ClosedLoopDeps = {
  route: routeAutopilot,
  createBlueprint: createAutonomousBlueprint,
  createPlan: createCommitletPlan,
  prepare: prepareCommitlet,
  runWorker: runResampledWorker,
  grade: gradeCommitlet,
  finalize: finalizePlan,
  finish: finishVerdict,
  resolveWorkerMode: resolveRealWorkerMode,
  runInSession: (plan, commitlet, config, ctx, samples, onProgress) =>
    runInSessionResample(plan, commitlet, config, mainModelSampler(plan, commitlet, config, ctx), samples, onProgress)
};

function narrate(ctx: ExtensionContextLike, message: string): void {
  try {
    ctx?.ui?.setWorkingMessage?.(`Cheater closed loop: ${message}`);
    ctx?.ui?.notify?.(`Cheater closed loop: ${message}`, "info");
  } catch { /* narration must never break the run */ }
}

// Bounded completion for the from-scratch scaffold FILE PLAN (propose the project's file structure).
// This is an ORGANIZE/list task, NOT code generation, so it PREFERS the fast SIDECAR (small 2-4B
// clerk): on a slow local main model this one call costs MINUTES (~350 tokens at ~3 t/s), and the 2B
// does a rote file list in seconds. Falls back to the main model only when the sidecar is unavailable.
// Returns "" on any failure so the caller falls back to the normal (de-biased) plan; proposeScaffoldFiles
// SHAPE-validates the output (manifest present, real relative paths) either way.
function scaffoldFilePlanFn(cwd: string, ctx: ExtensionContextLike, config: CheaterConfig): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const sidecar = resolveSidecarClient(config, ctx);
    if (sidecar?.available?.()) {
      try {
        const res = await sidecar.complete({ prompt, maxOutputTokens: 1500, timeoutMs: 90_000, label: "scaffold_plan" });
        if (res.ok && res.text) return res.text;
      } catch { /* fall through to the main model */ }
    }
    if (!ctx?.model) return "";
    try {
      const client = sdkSidecarClient({ cwd, model: ctx.model, timeoutMs: 90_000, maxOutputTokens: 1500 });
      const res = await client.complete({ prompt, maxOutputTokens: 1500, timeoutMs: 90_000, label: "scaffold_plan" });
      return res.ok ? res.text : "";
    } catch { return ""; }
  };
}

// Phase A boilerplate acceleration: for a RECOGNIZED stack, stamp that stack's INVARIANT files to
// disk so the local model never decodes ~260s of pure boilerplate. Purely additive + gated: an
// unrecognized stack (detectStackProfile -> null) stamps nothing and the model-authored path is
// unchanged. Each stamped file is recorded as a run mutation - which marks it READ, so read-before-
// write never later blocks the model from editing it - and listed back as "already exists"
// (executor.buildScaffoldPhasePrompt) so the model imports instead of recreating. Best-effort: any
// failure degrades to "the model writes it".
function stampScaffoldPrelude(cwd: string, scaffoldFiles: ScaffoldFile[], goal: string, config: CheaterConfig, run: TaskRunState): StampedFile[] {
  try {
    const plannedPaths = scaffoldFiles.map((file) => file.path);
    // The model's OWN proposed file list picks the stack (.tsx -> TS, .jsx -> JS, ...); no goal regex.
    const profile = detectStackProfile(plannedPaths, config.scaffoldTemplateStacks);
    if (!profile) return [];
    const usesTailwind = /\btailwind/i.test(goal) || plannedPaths.some((path) => /tailwind/i.test(path));
    const stamped = stampProfile(cwd, profile, { appName: deriveAppName(goal), usesTailwind, entryComponent: "./App" }, plannedPaths);
    if (!stamped.length) return [];
    for (const file of stamped) run.recordFileMutation(file.path, "file_created", "harness", `scaffold template (${profile.id})`);
    run.setScaffoldStamp({ stamped });
    mainCallGovernor.recordAvoided("scaffold_content", "deterministic", `${stamped.length} boilerplate file(s) stamped from the ${profile.id} template`);
    return stamped;
  } catch {
    return [];
  }
}

// One-time-per-process, non-blocking sidecar health announcement. A separate CPU endpoint does not
// contend with the GPU, so this never delays the run; success is silent and it only SPEAKS UP when
// the sidecar is dark - so a misconfigured sidecar announces itself (with the fix) instead of
// sitting idle and unnoticed all session. See /sidecar doctor for the on-demand version.
let sidecarHealthAnnounced = false;
function announceSidecarHealth(sidecar: SidecarClient, ctx: ExtensionContextLike): void {
  if (sidecarHealthAnnounced) return;
  sidecarHealthAnnounced = true;
  void sidecar
    .complete({ prompt: "Reply with exactly: OK", maxOutputTokens: 8, label: "probe" })
    .then((res) => {
      if (!res.ok) narrate(ctx, `sidecar is enabled but OFFLINE (${res.error}). Run /sidecar doctor to fix - continuing without it.`);
    })
    .catch(() => { /* complete() is contractually safe, but never let a probe break a run */ });
}

/**
 * Fire prepare_context (fire-and-forget) for the next `count` PENDING commitlets so the clerk always
 * has a full queue to work through while the GPU model runs. This is the heart of "no brakes": the
 * CPU sidecar prepares each upcoming worker's context (compressed facts + prioritized files +
 * orientation) ahead of time; buildCommitletExecutionPrompt consumes it when that worker spawns, or
 * falls back deterministically if it isn't ready. Keyed `capsule:<id>` so the sync packet builder
 * peeks it. No-op when the scheduler is disabled. maxConcurrent=1 serializes these on the single
 * small model - the point is queue DEPTH (work banked ahead), not parallelism-with-itself.
 */
function dispatchContextPrep(cwd: string, plan: CommitletPlan, userGoal: string, count: number): void {
  if (!sidecarScheduler.enabled()) return;
  // Context prep is optional + non-blocking; a malformed commitlet (e.g. a missing allowedFiles) must
  // never crash cheater_run. Guard every field and swallow any error.
  try {
  const pending = (plan.commitlets ?? []).filter((commitlet) => commitlet.status === "pending").slice(0, Math.max(1, count));
  // Sibling files this build touches, so the clerk can prep for cross-file consistency even when a
  // new file has no repo facts of its own (the from-scratch / create-heavy case).
  const allFiles = (plan.commitlets ?? []).flatMap((commitlet) => commitlet.allowedFiles ?? []).filter((file) => file && !file.startsWith("(") && !file.endsWith("/"));
  for (const commitlet of pending) {
    const candidateFiles = (commitlet.allowedFiles ?? []).filter((file) => file && !file.startsWith("(") && !file.endsWith("/")).slice(0, 3);
    // The contract is ALREADY DECIDED (this commitlet's own acceptance criteria + must-hold). The
    // clerk only ORGANIZES it into a worker-ready build card - it never plans. This is what keeps the
    // sidecar busy on create-heavy commitlets (new files) instead of idle.
    const contract = [
      ...(commitlet.spec?.acceptanceCriteria ?? []),
      ...(commitlet.spec?.behaviorMustHold ?? []).map((item) => `must hold: ${item}`)
    ].filter(Boolean).slice(0, 6);
    const siblings = allFiles.filter((file) => !candidateFiles.includes(file)).slice(0, 8);
    sidecarScheduler.dispatch("prepare_context", `capsule:${commitlet.id}`, commitlet.id, (client) =>
      prepareContextSidecar(client, { goal: userGoal, rawFacts: commitletRepoFacts(cwd, commitlet), candidateFiles, contract, siblings }).then((outcome) => {
        // Accounting: context prep is a clerical job the sidecar handles instead of the big model.
        sidecarUsage.record("capsule_compress", outcome.source);
        mainCallGovernor.recordAvoided("capsule_compress", outcome.source === "sidecar" ? "sidecar" : "deterministic", outcome.note);
        return outcome.value;
      })
    );
  }
  } catch { /* context prep is best-effort; it must never crash the run */ }
}

function compactNote(text: string, cap = 240): string {
  const oneLine = (text ?? "").split(/\r?\n/).filter(Boolean).slice(0, 2).join(" | ");
  return oneLine.length <= cap ? oneLine : oneLine.slice(0, cap - 3) + "...";
}

function report(result: Omit<ClosedLoopRunResult, "summary">, goal: string, extra: string[] = []): ClosedLoopRunResult {
  const lines = [
    `Cheater Closed Loop: ${result.status.toUpperCase()}`,
    `goal: ${goal.slice(0, 200)}`,
    result.plan ? `plan: ${result.plan.summary.slice(0, 160)}` : "",
    result.plan ? `commitlets: ${result.plan.commitlets.length}` : "",
    `workers: ${result.freshWorkerMode}`,
    result.steps.length ? "steps:" : "",
    ...result.steps.map((step) => `- ${step.commitletId} ${step.outcome}: ${step.note}`),
    ...extra,
    result.error ? `error: ${result.error}` : "",
    ...(result.receipt ? ["receipt:", result.receipt] : [])
  ].filter(Boolean);
  return { ...result, summary: lines.join("\n") };
}

/**
 * Run the whole task loop deterministically. The model never orchestrates: it only
 * implements inside bounded workers spawned by this loop.
 */
export async function runClosedLoopCommitlets(
  params: ClosedLoopRunParams,
  depOverrides: Partial<ClosedLoopDeps> = {}
): Promise<ClosedLoopRunResult> {
  // Crash guard: an internal error must NEVER leave the session bricked. A crashed run used to leave
  // defaultBlueprintState holding pending packets, so the extension's planner tool-mask kept blocking
  // EVERY file/shell tool for the rest of the session ("cannot use file or shell tools" lockout). On
  // any throw we clear the blueprint state (releasing the mask) and return a clean failure result.
  try {
    return await runClosedLoopInner(params, depOverrides);
  } catch (err) {
    try { defaultBlueprintState.clear(); } catch { /* best-effort */ }
    return report(
      { ok: false, status: "failed", freshWorkerMode: "none", steps: [], error: `cheater_run internal error: ${(err as Error).message}` },
      params.userGoal,
      ["The run hit an internal error and was aborted cleanly - file/shell tools are restored. Re-run cheater_run, or use cheater_reliability_start for the step-by-step flow."]
    );
  }
}

async function runClosedLoopInner(
  params: ClosedLoopRunParams,
  depOverrides: Partial<ClosedLoopDeps> = {}
): Promise<ClosedLoopRunResult> {
  const deps: ClosedLoopDeps = { ...DEFAULT_DEPS, ...depOverrides };
  const { cwd, userGoal, config, ctx } = params;
  const steps: ClosedLoopStep[] = [];

  narrate(ctx, "routing and planning");
  let decision = deps.route({ cwd, message: userGoal, requireApproval: config.requireApprovalForHighRisk === true });

  // A from-scratch build in an EMPTY repo gets MISROUTED answer_only when a terse goal drops its
  // create verb (e.g. "Vite + React + TypeScript todo app with X components" - no "create"). An empty
  // repo + a stack/app goal is never a question, so detect it here and DO NOT bail: override the route
  // and fall through to the scaffold path, which builds the app from the model-proposed file list.
  // (Without this the tool returns "no edits needed" and the model flails for many turns trying to
  // understand why - a top source of wasted tokens on local models.)
  const fromScratch = isFromScratchBuild(cwd, userGoal);

  if (!fromScratch && (decision.executionMode === "answer_only" || decision.executionDiscipline === "none")) {
    return report({
      ok: true,
      status: "complete",
      freshWorkerMode: "none",
      steps,
      details: { decision, noEdit: true }
    }, userGoal, [
      // This routed as "no orchestration needed". The guidance MUST be action-imperative, not
      // "answer the user directly": in an agentic task context (a bench task, a "do X for me"
      // request) small/mid models take "answer the user" LITERALLY and produce a chat reply -
      // step-by-step instructions, or a claim that it is done - while performing ZERO actual work,
      // so the task fails with nothing written. (deepseek ignores it and acts; qwen3-8b/coder-flash
      // obeyed it and failed fix-git; qwen3.5-35b answered a "write the regex to a file" task in
      // chat and never wrote the file.) Tell the model to DO the work now with its tools.
      "no build/orchestration harness is needed for this one. If the task requires ANY actions " +
        "(shell commands, file edits, creating a file, a git operation), perform them NOW yourself " +
        "with your tools (bash/read/write/edit) and then verify the result. Do NOT merely describe " +
        "the steps, hand back instructions, or claim it is done - actually make the changes. Only if " +
        "this is genuinely a pure question with no work to perform should you answer it directly."
    ]);
  }
  if (fromScratch && (decision.executionMode === "answer_only" || decision.executionDiscipline === "none")) {
    narrate(ctx, "empty repo + build goal: overriding an answer-only route to scaffold from scratch");
    decision = { ...decision, executionMode: "blueprint_orchestrator", executionDiscipline: "blueprint_backed_commitlet_chain" };
  }
  if (decision.executionDiscipline === "blocked_needs_user") {
    return report({
      ok: false,
      status: "blocked",
      freshWorkerMode: "none",
      steps,
      details: { decision },
      error: "high-risk request requires explicit user approval before editing"
    }, userGoal, [`reason: ${decision.reason}`]);
  }

  // Sidecar for the run: null (unavailable) unless a model is configured, so behavior is identical
  // by default. Reset the scheduler per task so its cache/stats don't leak across goals.
  const sidecar = resolveSidecarClient(config, ctx);
  const scfg = sidecarConfig(config);
  sidecarScheduler.reset();
  // Calibration gates PREFETCH types whose speculation rarely pays off - but that only matters when
  // sidecar time competes with the GPU ("gap" mode). A separate CPU endpoint ("concurrent") runs
  // for free relative to the GPU, so there is nothing to gate: let it speculate freely.
  // Track 2: a separate CPU endpoint won't contend with the GPU, so allow a small concurrent pool
  // (queue DEPTH keeps the clerk busy). A shared/main-model sidecar stays serialized at 1.
  const sidecarConcurrency = scfg.baseUrl ? Math.max(1, config.sidecarMaxConcurrency ?? 1) : 1;
  sidecarScheduler.configure(sidecar, scfg.parallelism, scfg.parallelism === "concurrent" ? undefined : jobGate(cwd, scfg.modelId ?? "main"), sidecarConcurrency);
  steeringControl.reset();
  if (scfg.enabled) announceSidecarHealth(sidecar, ctx);

  // Control plane (Main LLM Call Governor + sidecar usage accounting + prompt shape). All per-run
  // state is reset here; when the governor is off this is pure accounting that changes nothing.
  mainCallGovernor.configure(config);
  mainCallGovernor.reset();
  sidecarUsage.reset();
  resetWorkerPromptShape();
  setLeanCapsule(config.leanWorkerPromptEnabled === true); // Track 3: smaller worker prompts = cheaper prefill
  sidecarUsage.noteResolved(scfg.enabled, sidecar.available());
  // Optional: keep a CPU sidecar warm with ONE tiny JSON health check (non-blocking, never a gate).
  if (scfg.enabled && (config.sidecarForceWarmOnRunStart || config.sidecarKeepAliveEnabled)) {
    void sidecarKeepAlive(sidecar, config).then((ok) => sidecarUsage.noteKeepAlive(ok)).catch(() => { /* keepalive must never break a run */ });
  }
  // Optional: probe the configured LM Studio endpoint for native stateful chat + TTFT stats
  // (standalone fetch, does not touch Pi's provider). Fire-and-forget so it never delays the run;
  // it seeds the receipt's provider/perf section. /v1/chat/completions stays treated as stateless.
  if (config.providerProbeEnabled) {
    void runProviderProbe(config).catch(() => { /* probe is best-effort, never fatal */ });
  }

  // Sidecar routing assist: consulted ONLY for a genuinely uncertain deterministic route, and it
  // can only refine the taskKind (which shapes decomposition) - never override the answer_only /
  // blocked verdicts already returned above. A wrong/absent sidecar changes nothing.
  if (sidecar.available() && decision.confidence < 0.6) {
    const assist = await routeGoalSidecar(sidecar, userGoal, { taskKind: decision.taskKind, confidence: decision.confidence });
    liveSessionState.getLedger()?.addEntry("sidecar", `${assist.label}: ${assist.note}`, { label: assist.label, source: assist.source });
    sidecarUsage.record("route", assist.source);
    mainCallGovernor.recordAvoided("route", assist.source === "sidecar" ? "sidecar" : "deterministic", assist.note);
    if (assist.source === "sidecar" && assist.value.taskKind !== "unknown" && (decision.taskKind === "unknown" || decision.confidence < 0.55)) {
      decision = { ...decision, taskKind: assist.value.taskKind };
    }
  } else {
    // Routing never calls the big model: a confident deterministic route is an avoided main call.
    mainCallGovernor.recordAvoided("route", "deterministic", "confident deterministic route");
  }

  // From-scratch build (stack-agnostic): the repo has no ecosystem manifest and the goal is "create a
  // new app". Cheater's edit-oriented inference would guess its OWN filenames + constraints here (that
  // is how a web-app goal built a Pi CLI). Instead the MODEL proposes the file structure - no
  // per-framework template - and we build create-commitlets (manifest first). Falls back to the normal
  // de-biased plan if the model gives nothing usable. (fromScratch was computed up front, above the
  // answer_only bail, so a verb-less build goal is never dropped as a question.)
  let scaffoldFiles: ScaffoldFile[] = [];
  if (fromScratch) {
    narrate(ctx, "from-scratch project: planning the file structure");
    scaffoldFiles = await proposeScaffoldFiles(userGoal, scaffoldFilePlanFn(cwd, ctx, config));
    if (scaffoldFiles.length) mainCallGovernor.recordMain("blueprint_planning", { calls: 1, reason: "from-scratch scaffold file plan (sidecar-preferred)" });
  }
  const scaffolding = scaffoldFiles.length > 0;

  // Blueprint: reuse an active plan or build one internally for complex tasks (skipped when a
  // model-derived scaffold is driving) - identical policy to cheater_reliability_start otherwise.
  const activeBlueprint = params.useActiveBlueprint === false ? undefined : defaultBlueprintState.get().currentPlan ?? undefined;
  const blueprintPlan = scaffolding ? undefined : (activeBlueprint ?? (decision.executionMode === "blueprint_orchestrator" || decision.needsBlueprint
    ? await deps.createBlueprint({ cwd, userGoal, taskType: decision.taskKind, modelName: ctx?.model?.id ?? config.model, config })
    : undefined));
  if (blueprintPlan && blueprintPlan !== activeBlueprint) defaultBlueprintState.setPlan(blueprintPlan);

  const plan = scaffolding
    ? deps.createPlan({ repoRoot: cwd, userGoal, autopilotDecision: decision, commitlets: buildScaffoldCommitlets(scaffoldFiles, userGoal, decision), buildMode: "scaffold" })
    : deps.createPlan({ repoRoot: cwd, userGoal, autopilotDecision: decision, blueprintPlan });
  if (scaffolding) narrate(ctx, `from-scratch scaffold: ${scaffoldFiles.length} files planned by the model (${scaffoldFiles[0]?.path} first)`);
  defaultCommitletState.setPlan(plan);
  // Concurrent (a separate CPU endpoint): start the clerk working ahead on the first few commitlets
  // immediately - it prepares their context in parallel while the GPU model handles commitlet 1.
  // The horizon (Track 2) is how many commitlets ahead it preps - deeper = the clerk always has a queue.
  const prefetchHorizon = Math.max(1, config.sidecarPrefetchHorizon ?? 3);
  if (scfg.parallelism === "concurrent") dispatchContextPrep(cwd, plan, userGoal, prefetchHorizon);
  liveSessionState.reset(userGoal);
  liveSessionState.ensure(config, userGoal);
  if (config.runStateEnabled !== false) {
    // Budget generously: the per-commitlet maxToolCalls (~10) is for a BOUNDED isolated worker,
    // but in simulated/in-session mode the MAIN model does the whole multi-file build itself and
    // needs far more actions (scaffold, install, per-file read/write/verify/fix). Sizing the budget
    // at the worker estimate drove real builds into RESERVE (installs blocked) long before the app
    // was runnable. Floor at 300 and ~3x the estimate so RESERVE is only reached near real completion.
    const actionBudget = config.runStateActionBudget
      ?? Math.max(300, plan.commitlets.reduce((sum, commitlet) => sum + commitlet.maxToolCalls, 0) * 3 + 60);
    const existing = activeTaskRun();
    const run = existing?.resumed && existing.status === "running"
      ? existing
      : beginTaskRun(cwd, userGoal, { taskId: plan.id, actionBudget });
    updateControllerFile(run, plan, "running", `closed loop: execute ${plan.commitlets.length} commitlet(s)`);
  }

  // Phase A: stamp a recognized stack's invariant boilerplate to disk up front (once), so the model
  // decodes only real app logic. Needs the durable run for read-before-write bookkeeping; a no-op
  // when the flag is off, there is no run, or the stack is not recognized.
  if (scaffolding && config.scaffoldTemplatesEnabled === true) {
    const stampRun = activeTaskRun();
    if (stampRun) {
      const stamped = stampScaffoldPrelude(cwd, scaffoldFiles, userGoal, config, stampRun);
      if (stamped.length) narrate(ctx, `scaffold templates: stamped ${stamped.length} invariant file(s) - the model builds only app logic`);
    }
  }

  // This is the TOTAL repair budget across the whole build, not per file. An explicit param wins;
  // otherwise scale with the plan (repairAttemptsPerCommitlet default 1 as a GLOBAL cap meant a
  // build got exactly one repair total, then every other file's repair was skipped).
  const maxRepairRounds = params.maxRepairRounds ?? Math.max(config.repairAttemptsPerCommitlet ?? 1, plan.commitlets.length + 1);
  const maxCommitlets = Math.max(1, params.maxCommitlets ?? Math.max(12, plan.commitlets.length + maxRepairRounds + 2));

  // From-scratch scaffolding runs IN-SESSION (spawnFreshWorker:false -> the main model builds all files
  // in one warm session): 15-25 cold fresh-worker prefills on a local model would take hours, and the
  // files must be coherent across the project. Editing an existing repo keeps the caller's choice.
  //
  // #3 fix (the dominant remaining hard-task friction): a SINGLE-commitlet task also runs in-session.
  // A COLD fresh worker handed a terminal/surgical commitlet ("build X", "configure Y", "produce a
  // file") lacks the main model's exploration context, hallucinates paths (e.g. wrote to /app/tls
  // instead of /app/ssl), records no change, and grades "blocked by guard/health/test audit" - so the
  // main model then thrashes. The main model, which JUST explored the repo, does a single focused task
  // far better than a cold worker. Multi-commitlet plans still fan out to fresh workers.
  const inSessionByDesign = scaffolding
    || (config.singleCommitletInSession !== false && plan.commitlets.length <= 1);
  const realWorkers = await deps.resolveWorkerMode({ spawnFreshWorker: inSessionByDesign ? false : params.spawnFreshWorker }, config, ctx);
  const modelName = resolveModelName(config, ctx);

  const prepareNext = (current: CommitletPlan, next: Commitlet): Commitlet => {
    const prepared = deps.prepare(cwd, next);
    const commitlets = current.commitlets.map((commitlet) => commitlet.id === next.id ? prepared : commitlet);
    const index = current.commitlets.findIndex((commitlet) => commitlet.id === next.id);
    defaultCommitletState.setPlan({ ...current, status: "running", currentIndex: index, commitlets });
    liveSessionState.setPacketId(prepared.id);
    liveSessionState.beginCommitlet();
    activeTaskRun()?.setActiveCommitlet(prepared.id);
    return prepared;
  };

  const previousState = (): string[] => {
    const current = defaultCommitletState.get().currentPlan;
    return (current?.commitlets ?? []).filter((commitlet) => commitlet.result?.summary).map((commitlet) => `${commitlet.id}: ${commitlet.result?.summary}`);
  };

  // Simulated mode: the closed loop cannot truthfully execute a prompt that only the CURRENT
  // session's model can act on. Degrade honestly to the classic handoff: prepare the first
  // commitlet, return its prompt, and let the session continue via cheater_commitlet_next.
  if (!realWorkers) {
    const firstPending = plan.commitlets.find((commitlet) => commitlet.status === "pending");
    if (!firstPending) {
      const finalized = deps.finalize(cwd, plan, config);
      return report({ ok: false, status: "partial", freshWorkerMode: "simulated", steps, plan: finalized.details.plan, details: { decision, finalize: finalized.details } }, userGoal, [finalized.text]);
    }
    const prepared = prepareNext(plan, firstPending);
    const activePlan = defaultCommitletState.get().currentPlan ?? plan;
    // In-session best-of-N pre-build (local best-of-N, roadmap P1): fresh-worker resampling is
    // unavailable on a single-GPU local box, so for a SINGLE-FILE commitlet with an adaptive sample
    // budget > 1 the harness itself runs k independent direct-completion samples from the rollback
    // snapshot and leaves the first VERIFIED pass (else the best candidate) on disk BEFORE the
    // handoff. The existing cheater_commitlet_next then grades that pre-built file - zero change to
    // grade/advance. Behind inSessionResampleEnabled (default off) so nothing changes unless enabled.
    let preBuiltNote: string | undefined;
    if (config.inSessionResampleEnabled === true) {
      const budget = computeBudget({
        taskKind: activePlan.autopilotDecision?.taskKind,
        risk: String(activePlan.risk ?? ""),
        filesInScope: prepared.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")).length,
        isRepair: isRepairCommitlet(prepared)
      }, config);
      if (shouldResampleInSession(prepared, budget.samples)) {
        const target = singleTargetFile(prepared);
        narrate(ctx, `in-session best-of-N: sampling ${budget.samples}x for ${prepared.id} (${target}) - local best-of-N, sequential on one GPU (~minutes each)`);
        const outcome = await deps.runInSession(activePlan, prepared, config, ctx, budget.samples, (message) => narrate(ctx, message));
        steps.push({
          commitletId: prepared.id,
          title: prepared.title,
          outcome: outcome.passed ? "passed" : "blocked",
          note: `in-session best-of-N pre-build: ${outcome.note}`
        });
        preBuiltNote = outcome.passed
          ? `The harness PRE-BUILT ${target} for you via in-session best-of-N: sample ${outcome.appliedAttempt}/${outcome.samplesRequested} passed guard+health+verification and is already on disk. Do NOT rewrite it - call cheater_commitlet_next now to grade it and continue.`
          : `The harness ran in-session best-of-N for ${target} (${outcome.attemptsRun} samples; none fully verified) and left the strongest candidate on disk. Fix only what remains, then call cheater_commitlet_next.`;
      }
    }
    const prompt = buildCommitletExecutionPrompt(activePlan, prepared, [], "simulated", 1, modelName);
    // A scaffold plan runs in-session BY DESIGN (the fast path - no per-file worker spawns), not
    // because a backend is missing. Say that plainly instead of the alarming "no backend available"
    // degradation notice, and frame the loop as phases so the model's ONE instruction set is coherent.
    const scaffoldLane = activePlan.buildMode === "scaffold";
    const handoffLines = scaffoldLane
      ? [
          `From-scratch build: ${activePlan.commitlets.length} phase(s), built in-session in this warm session (the fast path - no per-file worker spawns).`,
          "Build the phase below, then call cheater_commitlet_next for the next phase. Keep going until cheater_finish_gate reports ALLOWED.",
          "",
          prompt.prompt
        ]
      : inSessionByDesign
      ? [
          // #3: a single focused task runs in-session ON PURPOSE - the main model has the exploration
          // context a cold worker lacks. This is NOT a missing backend, so don't sound the alarm.
          "This task runs IN-SESSION: you already explored this repo, so YOU do it directly (a cold fresh worker lacked that context and kept failing terminal tasks - wrong paths, no changes recorded).",
          "Do the step below now with your tools (bash/read/write/edit), then call cheater_commitlet_next. Keep going until cheater_finish_gate reports ALLOWED.",
          "",
          prompt.prompt
        ]
      : [
          "simulated handoff required: no real fresh-worker backend is available, so the harness cannot execute the chain itself.",
          `why: ${workerBackendReason()}`,
          "Execute the worker prompt below in THIS session, then call cheater_commitlet_next after each edit (classic flow).",
          "",
          "worker prompt:",
          prompt.prompt
        ];
    return report({
      ok: false,
      status: "partial",
      freshWorkerMode: "simulated",
      steps,
      plan: activePlan,
      handoffPrompt: prompt.prompt,
      details: { decision, commitlet: prepared, prompt }
    }, userGoal, preBuiltNote ? [preBuiltNote, "", ...handoffLines] : handoffLines);
  }

  // The closed loop proper: harness prepares, spawns, grades, repairs, advances.
  let repairRounds = 0;
  let workersRun = 0;
  // RESILIENCE: files that could not be completed. A single file's failure must NOT abort the
  // whole multi-file build (the top "harness never finishes the project" cause) - we record it,
  // keep building the rest, and report partial with this list at the end.
  const failedCommitlets: Array<{ id: string; note: string }> = [];
  const iterationCap = maxCommitlets * 2 + 4;
  for (let iteration = 0; iteration < iterationCap; iteration++) {
    let current = defaultCommitletState.get().currentPlan;
    if (!current) {
      return report({ ok: false, status: "failed", freshWorkerMode: "real", steps, error: "commitlet plan disappeared mid-run" }, userGoal);
    }

    // Mid-run steering (/steer runs even while cheater_run streams). Honor a graceful stop with
    // preserved state; fold queued corrections into the plan's global constraints so the upcoming
    // workers must honor them - the "steering wheel" for a run heading the wrong way.
    if (steeringControl.stopRequested()) {
      return report({ ok: false, status: "partial", freshWorkerMode: "real", steps, plan: current }, userGoal, [
        "Stopped by /steer stop. Plan, rollbacks, and ledger are preserved - send a new instruction to resume."
      ]);
    }
    const corrections = steeringControl.drainCorrections();
    if (corrections.length) {
      current = { ...current, globalConstraints: [...(current.globalConstraints ?? []), ...corrections.map((correction) => `User steering: ${correction}`)] };
      defaultCommitletState.setPlan(current);
      narrate(ctx, `applied ${corrections.length} steering correction(s)`);
      liveSessionState.getLedger()?.addEntry("steering", corrections.join(" | "), { count: corrections.length });
    }

    // Defensive: grade any leftover running commitlet (e.g. a resumed partial run) before
    // touching the next one, so no edit ever advances ungraded.
    const running = current.commitlets.find((commitlet) => commitlet.status === "running");
    if (running) {
      narrate(ctx, `grading ${running.id}`);
      const grade = await deps.grade(cwd, running, config, { allowLargeDeletion: params.approveLargeDeletion, sidecar });
      const repairCreated = /repair commitlet: /.test(grade.message);
      steps.push({
        commitletId: running.id,
        title: running.title,
        outcome: grade.advance ? (repairCreated ? "repair_created" : "passed") : (/-repair$/.test(running.id) ? "failed" : "blocked"),
        note: compactNote(grade.message)
      });
      if (!grade.advance) {
        // Do NOT abort the build. gradeCommitlet already reverted/failed this commitlet; record it
        // and continue so the remaining files still get built. The final report lists what failed.
        failedCommitlets.push({ id: running.id, note: compactNote(grade.message) });
        const stillRunning = defaultCommitletState.get().currentPlan?.commitlets.find((commitlet) => commitlet.id === running.id);
        if (stillRunning?.status === "running") defaultCommitletState.updateCommitlet(running.id, "failed", compactNote(grade.message));
        narrate(ctx, `commitlet ${running.id} did not pass - recording it and continuing with the remaining files`);
        continue;
      }
      current = defaultCommitletState.get().currentPlan!;
      // Sidecar works AHEAD in the GPU-free grade window (BOTH gap and concurrent modes): prepare the
      // next commitlet's context now; buildCommitletExecutionPrompt consumes it when that worker
      // spawns, or falls back deterministically if it isn't ready.
      dispatchContextPrep(cwd, current, userGoal, 1);
    }

    const next = current.commitlets.find((commitlet) => commitlet.status === "pending");
    if (!next) {
      narrate(ctx, "final review");
      const finalized = deps.finalize(cwd, current, config);
      const updated = finalized.details.plan;
      if (finalized.details.cleanup) {
        steps.push({ commitletId: finalized.details.cleanup.id, title: finalized.details.cleanup.title, outcome: "repair_created", note: "cleanup commitlet created by final review" });
        continue; // the cleanup commitlet is now pending; keep looping into it
      }
      const accepted = finalized.details.review.accepted;
      narrate(ctx, "finish gate");
      const gate = deps.finish(config);
      const gateAllowed = gate?.allowed === true;
      const receipt = gateAllowed && liveSessionState.getLedger() ? buildCompletionReceipt(liveSessionState.getLedger()!) : undefined;
      // Any file that failed and was skipped makes the whole build PARTIAL, never "complete".
      const status = failedCommitlets.length ? "partial" : (accepted && gateAllowed ? "complete" : accepted ? "partial" : "failed");
      return report({
        ok: status === "complete",
        status,
        freshWorkerMode: "real",
        steps,
        plan: updated,
        receipt,
        details: { finalReview: finalized.details.review, finishGate: gate ?? undefined, failedCommitlets }
      }, userGoal, [
        `final review: ${accepted ? "accepted" : "failed"}`,
        ...(failedCommitlets.length ? [`${failedCommitlets.length} file(s) could not be completed and were skipped so the rest of the build could finish: ${failedCommitlets.map((f) => f.id).join(", ")}. These still need fixing before the task is truly done.`] : []),
        ...(gate ? [gate.lines.join("\n")] : ["finish gate: no completion ledger available"]),
        ...(status === "partial" && !failedCommitlets.length ? ["Final review accepted but the finish gate is not satisfied yet - resolve the listed evidence gaps before telling the user this is done."] : []),
        ...(status === "failed" ? [finalized.text] : [])
      ]);
    }

    if (/-repair$/.test(next.id)) {
      repairRounds += 1;
      if (repairRounds > maxRepairRounds) {
        // Repair budget spent: skip THIS repair and keep building the rest (don't abort the build).
        defaultCommitletState.updateCommitlet(next.id, "skipped", `repair budget exhausted (${maxRepairRounds} round(s))`);
        steps.push({ commitletId: next.id, title: next.title, outcome: "skipped_repair_budget", note: `repair budget exhausted after ${maxRepairRounds} round(s)` });
        failedCommitlets.push({ id: next.id, note: `repair budget exhausted (${maxRepairRounds} round(s))` });
        continue;
      }
    }
    if (workersRun >= maxCommitlets) {
      return report({ ok: false, status: "partial", freshWorkerMode: "real", steps, plan: current, error: `commitlet budget exhausted (${maxCommitlets})` }, userGoal, [
        "The chain is longer than the configured budget; continue with cheater_commitlet_next or re-run cheater_run with a higher maxCommitlets."
      ]);
    }

    const prepared = prepareNext(current, next);
    const position = `${current.commitlets.findIndex((commitlet) => commitlet.id === next.id) + 1}/${current.commitlets.length}`;
    narrate(ctx, `commitlet ${position}: ${prepared.title}`);
    workersRun += 1;
    const updatedPlan = defaultCommitletState.get().currentPlan!;
    // Concurrent: the GPU model is about to spend a while writing THIS file - the perfect (and
    // longest) window for the CPU clerk to prepare the NEXT commitlets' context in parallel, the one
    // "gap" mode never used. Fire-and-forget; consumed when those workers spawn.
    if (scfg.parallelism === "concurrent") dispatchContextPrep(cwd, updatedPlan, userGoal, prefetchHorizon);
    const resample = await deps.runWorker(updatedPlan, prepared, config, undefined, ctx?.model, workerProgress(ctx, updatedPlan, prepared), workerHeartbeat(ctx, updatedPlan, prepared));
    const workerResult = resample.workerResult;
    liveSessionState.getLedger()?.addEntry("resample", resample.note, {
      commitletId: prepared.id,
      attemptsRun: resample.attemptsRun,
      samplesRequested: resample.samplesRequested,
      appliedAttempt: resample.appliedAttempt,
      passed: resample.passed,
      freshWorkerMode: workerResult.error === "worker_backend_unavailable" ? "unavailable" : "real"
    });
    // Governor: a fresh worker IS a big-model call (code_worker / repair_worker) - the one role that
    // legitimately needs the big model. Count the physical attempts (a resample can be several) with
    // the estimated prompt size, so the receipt shows the main-call budget. Backend-unavailable = no
    // call actually happened, so it is not counted.
    if (workerResult.error !== "worker_backend_unavailable") {
      mainCallGovernor.recordMain(workerRoleForCommitletId(prepared.id), {
        calls: Math.max(1, resample.attemptsRun ?? 1),
        estTokens: getWorkerPromptShape()?.totalEstimatedTokens,
        reason: `fresh worker for ${prepared.id}`
      });
    }

    if (workerResult.error === "worker_backend_unavailable") {
      // The backend died mid-run. Never fake progress: hand the prepared commitlet's prompt
      // back to the session and let the classic flow continue.
      const prompt = buildCommitletExecutionPrompt(updatedPlan, prepared, previousState(), "simulated", 1, modelName);
      return report({
        ok: false,
        status: "partial",
        freshWorkerMode: "simulated",
        steps,
        plan: updatedPlan,
        handoffPrompt: prompt.prompt,
        details: { workerResult, resample },
        error: "fresh worker backend became unavailable"
      }, userGoal, [
        "simulated handoff required: the worker backend became unavailable mid-run.",
        "Execute the worker prompt below in THIS session, then call cheater_commitlet_next after each edit.",
        "",
        "worker prompt:",
        prompt.prompt
      ]);
    }

    if (!workerResult.ok && !resample.passed) {
      // A worker error on ONE file (that produced no verified edit) does not abort the whole build:
      // record the file as failed and keep building the rest. (Backend-unavailable is handled above
      // and DOES degrade the whole run, because nothing further can spawn.)
      defaultCommitletState.updateCommitlet(prepared.id, "failed", workerResult.summary);
      steps.push({ commitletId: prepared.id, title: prepared.title, outcome: "worker_failed", note: compactNote(`${resample.note} | ${workerResult.summary}`) });
      failedCommitlets.push({ id: prepared.id, note: compactNote(workerResult.summary) });
      narrate(ctx, `worker for ${prepared.id} failed - continuing with the remaining files`);
      continue;
    }
    // Grading happens at the top of the next iteration (the commitlet is now "running").
  }

  return report({
    ok: false,
    status: "partial",
    freshWorkerMode: "real",
    steps,
    plan: defaultCommitletState.get().currentPlan ?? undefined,
    error: "iteration cap reached without reaching final review"
  }, userGoal);
}
