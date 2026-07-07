import type { BlueprintPlan, WorkPacket } from "../blueprint/types.js";
import { buildPacketExecutionPrompts } from "../blueprint/executor.js";
import { fileSnippet } from "../blueprint/contextSketch.js";
import { createRoleSeparation, renderBlueprintArtifact } from "../blueprint/artifact.js";
import { evaluateBlueprintQuality } from "../blueprint/qualityGate.js";
import { sdkFreshAgentPacketRunner, type FreshAgentPacketResult, type FreshAgentPacketRunner } from "../blueprint/worker.js";
import { createRollbackPoint } from "./rollback.js";
import { synthesizedCheckDir } from "./checkFirst.js";
import { scout, type ScoutOutcome } from "../blueprint/scout.js";
import { scoreHardness } from "../runtime/computeBudget.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import { buildRepoConstraintGraph, queryConstraintFacts } from "./constraintGraph.js";
import { sidecarScheduler } from "../sidecar/scheduler.js";
import { symbolSnippet } from "../reliability/symbolSlice.js";
import { analyzePromptShape, recordWorkerPromptShape } from "../runtime/promptShape.js";
import { activeTaskRun, type TaskRunState } from "../runstate/runState.js";
import { buildPromptCapsule, renderCapsulePrompt, type PromptCapsule } from "../runstate/promptCapsule.js";
import { recallHarnessLessons, selectRulePacks } from "../runstate/rulePacks.js";
import { collectFragmentsForWorker, fragmentMeta, type ContextFragment } from "../runstate/contextFragments.js";
import { checkCapsuleInvariants } from "../runstate/invariants.js";
import { buildWorkerSpawnSpec, roleForCommitlet } from "../runstate/workerSpawn.js";
import { planToolExposure, workerModeForCommitlet } from "../runstate/toolExposure.js";
import { appendRunEvent } from "../runstate/runDir.js";
import { operatingRulesFor } from "../reliability/packetPrompt.js";
import { inferModelClass } from "../reliability/modelProfile.js";
import { effectiveMode, isRepairCommitlet } from "./types.js";
import { isManifestPath } from "../blueprint/scaffold.js";
import type { CheaterConfig } from "../types.js";

export type FreshWorkerMode = "simulated" | "real";

export interface CommitletExecutionPrompt {
  commitletId: string;
  prompt: string;
  freshWorkerMode: FreshWorkerMode;
  /** The persisted prompt capsule, when a durable run is active. */
  capsule?: PromptCapsule;
}

// Verified-resampling attempt stances. Independent samples only help if they are diverse;
// a small model re-prompted identically tends to reproduce the same wrong diff. Attempt 1
// carries no stance (byte-identical to single-sample behavior); later attempts steer the
// approach WITHOUT leaking any failure context (which would poison a weak model).
const ATTEMPT_STANCES = [
  "",
  "Approach stance for this attempt: make the smallest possible correct change. If a one-line fix satisfies the acceptance criteria, prefer it over anything broader.",
  "Approach stance for this attempt: fix the root cause. Re-read the target symbol from scratch, re-derive the expected behavior from the spec and acceptance criteria, and correct the underlying logic rather than patching the symptom.",
  "Approach stance for this attempt: re-derive the expected behavior from the spec, then rewrite the smallest enclosing function cleanly so it obviously satisfies every acceptance criterion."
];

export function attemptStance(attempt: number): string {
  if (attempt <= 1) return "";
  return ATTEMPT_STANCES[Math.min(attempt - 1, ATTEMPT_STANCES.length - 1)];
}

// Per-attempt reasoning-depth jitter, the one sampling knob Pi's SDK exposes (there is no
// temperature option). Attempt 1: the session default (byte-identical to single-sample
// behavior). Attempt 2: deliberate. Attempt 3+: fast/instinctive. Pi clamps to model caps.
// One entry per ATTEMPT_STANCE (4). Attempt 4's stance is the MOST demanding ("re-derive and rewrite
// the enclosing function cleanly"), so it gets "medium" thinking, not the "off" it used to inherit by
// clamping to the 3rd entry - pairing the hardest re-derivation with reasoning disabled was a handicap.
const ATTEMPT_THINKING: Array<"off" | "low" | "medium" | "high" | undefined> = [undefined, "high", "off", "medium"];

export function attemptThinkingLevel(attempt: number): "off" | "low" | "medium" | "high" | undefined {
  return ATTEMPT_THINKING[Math.min(Math.max(attempt - 1, 0), ATTEMPT_THINKING.length - 1)];
}

/**
 * Per-attempt evidence strategy. The root-cause stance (attempt 3) deliberately WITHHOLDS
 * the cheat sheet from the observed failure: if every attempt reads the same evidence, every
 * attempt converges on the same fix and resampling stops buying diversity. One attempt that
 * re-derives from the raw failure alone covers the case where the evidence itself is the
 * wrong hypothesis. The raw failure card (everything before the sheet) is always kept.
 */
export function observedFailureForAttempt(observedFailure: string | undefined, attempt: number): string | undefined {
  if (!observedFailure) return observedFailure;
  if (attempt !== 3) return observedFailure;
  const sheetStart = observedFailure.indexOf("=== CHEATER CHEAT SHEET");
  return sheetStart > 0 ? observedFailure.slice(0, sheetStart).trimEnd() : observedFailure;
}

/** The bounded repo facts for a commitlet (same derivation the worker packet uses). Exported so a
 *  sidecar prefetch can compress them ahead of time for the NEXT commitlet during an idle window. */
export function commitletRepoFacts(repoRoot: string, commitlet: Commitlet): string[] {
  const boundedFiles = commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")).slice(0, 3);
  const graph = buildRepoConstraintGraph(repoRoot, boundedFiles);
  return boundedFiles.flatMap((file) => queryConstraintFacts(graph, file).slice(0, 4)).slice(0, 8);
}

export function buildCommitletExecutionPrompt(plan: CommitletPlan, commitlet: Commitlet, previousState: string[] = [], freshWorkerMode: FreshWorkerMode = "simulated", attempt = 1, modelName?: string): CommitletExecutionPrompt {
  const spec = commitlet.spec;
  // Scaffold lane: return ONE coherent in-session phase prompt with no bounded-worker "stop and hand
  // off / one edit then stop" language and no separate-worker notice - so a small model never
  // receives two contradictory instruction sets at once (the core cause of the FounderOS thrash).
  if (effectiveMode(plan, commitlet) === "scaffold") {
    return buildScaffoldPhasePrompt(plan, commitlet);
  }
  const boundedFiles = commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")).slice(0, 3);
  const graph = buildRepoConstraintGraph(plan.repoRoot, boundedFiles);
  const constraintFacts = boundedFiles.flatMap((file) => queryConstraintFacts(graph, file).slice(0, 4)).slice(0, 8);
  // Sidecar working AHEAD: if it prepared this commitlet's context in an earlier window, use the
  // prepared bundle - compressed facts, a couple of orientation notes, and a prioritized order of
  // this commitlet's OWN files. Otherwise the deterministic facts. Additive - no prefetch means
  // byte-identical behavior, so nothing changes when the sidecar is off.
  const prepared = sidecarScheduler.peek<{ facts: string[]; files?: string[]; orientation?: string[] }>(`capsule:${commitlet.id}`, commitlet.id);
  const repoFacts = [
    ...(prepared?.facts?.length ? prepared.facts : constraintFacts),
    ...((prepared?.orientation ?? []).map((note) => `orientation: ${note}`))
  ].slice(0, 10);
  // Advisory file prioritization: slice snippets from the sidecar-preferred files first. This only
  // ever REORDERS the commitlet's own allowedFiles - the clerk never widens access.
  const prioritizedFiles = prepared?.files?.length
    ? [...prepared.files.filter((file) => boundedFiles.includes(file)), ...boundedFiles.filter((file) => !prepared.files!.includes(file))]
    : boundedFiles;
  // Slice the actual target symbol (function/class whose name overlaps the task terms) rather
  // than the first 40 lines of imports. Repair commitlets seed terms from the observed failure.
  const sliceTerms = [
    commitlet.title,
    ...(spec?.behaviorMustHold ?? []),
    ...(spec?.acceptanceCriteria ?? []),
    spec?.observedFailure ?? ""
  ].filter(Boolean);
  const sliceCandidates = prioritizedFiles.slice(0, 2);
  const perFileSnippets = sliceCandidates.map((file) => symbolSnippet(plan.repoRoot, file, sliceTerms) || compactSnippet(file, fileSnippet(plan.repoRoot, file, 800)));
  const snippets = perFileSnippets.filter(Boolean);
  const workerNotice = freshWorkerMode === "real"
    ? "freshWorkerMode: real (this commitlet runs in a separate isolated worker session)"
    : "freshWorkerMode: simulated (this prompt is returned to the current agent session; no separate context boundary is created)";
  const verificationCommand = commitlet.focusedVerification.find((step) => step.command)?.command;
  const finalInstruction = "Before editing, rollback must exist. After editing, stop for diff guard, focused verification, health score, and test audit.";
  // CRITICAL for multi-file builds in simulated/in-session mode: the packet's per-worker rules
  // ("stop and hand off", "do not continue to another file", "make one bounded edit then stop")
  // are written for an ISOLATED worker that an outer loop resumes. But in simulated mode the MAIN
  // model IS the whole build - there is no separate worker/planner to hand off to. Without this
  // override a small model reads "stop and hand off", ends its turn after ONE file, and the build
  // never completes (the classic "harness never finishes the project"). This last line reframes
  // every "stop" as "call cheater_commitlet_next and keep going", and it is placed LAST so a weak
  // model weights it most.
  const continuationInstruction = freshWorkerMode === "simulated"
    ? [
        "=== IN-SESSION MODE - YOU DRIVE THE WHOLE BUILD ===",
        "You are executing this yourself; there is NO separate worker or planner to hand off to.",
        "Any rule above that says 'stop and hand off', 'do not continue to another file', or 'make one",
        "edit then stop' means ONE thing here: finish THIS file, then IMMEDIATELY call",
        "cheater_commitlet_next to grade it and receive the NEXT file's instructions.",
        "Keep going file by file - do NOT end your turn, summarize, or wait for the user - until",
        "cheater_finish_gate reports ALLOWED. The task is NOT done until every planned commitlet is built."
      ].join("\n")
    : "";

  // Canonical path: when a durable run is active, the prompt capsule IS the worker context.
  // Every input (goal, contract, observed failure, stance, snippets, repo facts, run-state
  // truth, rules) enters the capsule as a typed, capped field, and the prompt is rendered
  // FROM the capsule - one context format, persisted and size-instrumented, with no nested
  // second packet prompt duplicating the same file's code.
  const run = activeTaskRun();
  if (run) {
    const { capsule } = buildRunCapsule(run, plan, commitlet, {
      snippets: sliceCandidates.map((file, index) => ({ path: file, snippet: perFileSnippets[index] })),
      repoFacts,
      previousState,
      attempt,
      modelName,
      inSession: freshWorkerMode === "simulated"
    });
    const rendered = renderCapsulePrompt(capsule);
    const editGuidance = "Edit with surgical patches: read the exact region first, then prefer cheater_line_edit (or the built-in edit tool) for existing files; use the write tool ONLY to create new files - never heredocs or echo/cat redirection.";
    // Tier-2 synthesized-check hint: when the repo has no test command, the worker's own runnable
    // check IS the oracle. Point it at the run's checks dir so the harness can discover and red-green
    // screen it (see checkFirst.ts). Relative path so a weak model writes it without path confusion.
    const checkDirRel = `.cheater/runs/${run.taskId}/checks/${commitlet.id.replace(/[^A-Za-z0-9._-]+/g, "-")}/`;
    const verifyLine = verificationCommand
      ? `Run the focused verification YOURSELF with the bash tool before finishing and report its real output: ${verificationCommand}`
      : `No project test/build command was detected, so you have no automatic signal for 'done'. Create one: exercise your change by RUNNING it - a quick script, a REPL one-liner, or the project's own entrypoint - and confirm the spec holds on the normal case AND the obvious edge cases (empty/zero input, a single element, boundaries, invalid input, negatives, ordering/precedence). Best: drop a small standalone runnable check (a .py, .mjs, or .sh file) into ${checkDirRel} and the harness will run it as this commitlet's check. Otherwise, if a test file is within THIS commitlet's allowed files, add a small one and run it. A concrete passing check is your signal to STOP - do not keep rewriting code that already works.`;
    // Prompt shape (measurement only - does not change the prompt below). The fixed operating rules
    // sit AFTER the big dynamic capsule, so they are not a reusable leading prefix; recorded so the
    // receipt can show worker-prompt size and cache-friendliness. See runtime/promptShape.ts.
    recordWorkerPromptShape(analyzePromptShape([
      { name: "kernel-header", content: "Cheater Reliability Kernel commitlet.", stable: true },
      { name: "commitlet-ids", content: `commitletId: ${commitlet.id}\ntitle: ${commitlet.title}\n${workerNotice}\nmaxDiffLines: ${commitlet.maxDiffLines}`, stable: false },
      { name: "capsule", content: rendered, stable: false },
      { name: "operating-rules", content: [editGuidance, verifyLine, finalInstruction, continuationInstruction].filter(Boolean).join("\n"), stable: true }
    ]));
    return {
      commitletId: commitlet.id,
      freshWorkerMode,
      capsule,
      prompt: [
        "Cheater Reliability Kernel commitlet.",
        `commitletId: ${commitlet.id}`,
        `title: ${commitlet.title}`,
        workerNotice,
        `maxDiffLines: ${commitlet.maxDiffLines}`,
        "",
        rendered,
        "",
        editGuidance,
        verifyLine,
        finalInstruction,
        continuationInstruction
      ].filter(Boolean).join("\n")
    };
  }

  // Fallback (no durable run active, e.g. runStateEnabled=false): the legacy assembly with
  // the nested fresh-call packet. Kept isolated here; the canonical path above never uses it.
  const packetPlan = commitletPlanAsBlueprint(plan, commitlet);
  // Files this block already sliced must not be re-embedded as a raw head excerpt by the
  // nested fresh-call packet below - that used to duplicate the same file's code twice
  // (roughly a third of the packet) inside one worker prompt.
  const filesAlreadySliced = sliceCandidates.filter((_file, index) => Boolean(perFileSnippets[index]));
  const prompt = buildPacketExecutionPrompts(packetPlan, {
    freshCallPacketsEnabled: true,
    packetOneFilePerWorkerEnabled: true,
    packetMaxFilesToTouch: 1,
    model: modelName
  }, { skipSnippetsForFiles: filesAlreadySliced })[0]?.prompt ?? "";
  return {
    commitletId: commitlet.id,
    freshWorkerMode,
    prompt: [
      "Cheater Reliability Kernel commitlet.",
      `commitletId: ${commitlet.id}`,
      `title: ${commitlet.title}`,
      workerNotice,
      `allowedFiles: ${commitlet.allowedFiles.join(", ") || "(inspect only)"}`,
      `forbiddenFiles: ${commitlet.forbiddenFiles.join(", ") || "(none)"}`,
      `maxDiffLines: ${commitlet.maxDiffLines}`,
      `focusedVerification: ${commitlet.focusedVerification.map((step) => step.command ?? step.purpose).join("; ") || "manual review"}`,
      repoFacts.length ? `constraintFacts:\n- ${repoFacts.join("\n- ")}` : "constraintFacts: none",
      snippets.length ? `relevantSnippets:\n${snippets.join("\n")}` : "relevantSnippets: none",
      previousState.length ? `previousState:\n- ${previousState.slice(-3).join("\n- ")}` : "previousState: none",
      spec ? [
        "spec:",
        `mustHold: ${spec.behaviorMustHold.join("; ")}`,
        `mustNotChange: ${spec.behaviorMustNotChange.join("; ")}`,
        `acceptance: ${spec.acceptanceCriteria.join("; ")}`,
        `nonGoals: ${spec.nonGoals.join("; ")}`,
        // The observed failure is the repair worker's single most important input: the
        // compressed failure card plus any harness-retrieved cheat sheet. It used to feed
        // only the symbol slicer and never render, so repair workers saw a 220-char
        // acceptance stub instead of the actual failure and evidence. Which portion renders
        // varies per resample attempt (see observedFailureForAttempt).
        ...(observedFailureForAttempt(spec.observedFailure, attempt) ? [`observedFailure:\n${observedFailureForAttempt(spec.observedFailure, attempt)}`] : [])
      ].join("\n") : "",
      attemptStance(attempt),
      "",
      prompt,
      "",
      finalInstruction,
      continuationInstruction
    ].filter(Boolean).join("\n")
  };
}

/**
 * The scaffold lane's single, self-consistent phase prompt. One instruction set: create THIS phase's
 * files in-session, run install if the manifest is here, then advance. Deliberately contains NO
 * bounded-worker language ("stop and hand off", "one edit then stop") and NO separate-worker notice,
 * because in a from-scratch build the main model IS the whole build and there is nothing to reverse.
 */
function buildScaffoldPhasePrompt(plan: CommitletPlan, commitlet: Commitlet): CommitletExecutionPrompt {
  const allPhaseFiles = commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/"));
  // Phase A: files the harness already stamped from a stack template are NOT for the model to author.
  // Drop them from the "create these" list and list them as already-existing (with their export
  // contracts) so the model imports them. hasManifest is computed BEFORE the drop so the install step
  // survives even when package.json was stamped.
  const stamp = activeTaskRun()?.scaffoldStamp;
  const stampedPaths = new Set((stamp?.stamped ?? []).map((entry) => entry.path));
  const files = allPhaseFiles.filter((file) => !stampedPaths.has(file));
  const phaseIndex = plan.commitlets.findIndex((entry) => entry.id === commitlet.id) + 1;
  const total = plan.commitlets.length;
  const hasManifest = allPhaseFiles.some(isManifestPath);
  const constraints = (plan.globalConstraints ?? []).slice(0, 6);
  const createBlock = files.length
    ? ["Create these files now (this phase only):", ...files.map((file) => `- ${file}`)]
    : ["Every file in this phase already exists (the harness wrote them) - do not recreate them."];
  const stampNote = stamp?.stamped.length
    ? [
        "",
        "=== FILES THE HARNESS ALREADY WROTE (do NOT recreate or rewrite these) ===",
        ...stamp.stamped.map((entry) => entry.exportsSummary ? `- ${entry.path} - ${entry.exportsSummary}` : `- ${entry.path}`),
        "Import from these; author only the files listed above. Need another library? Add it to package.json and re-run `npm install`."
      ]
    : [];
  const prompt = [
    `Cheater from-scratch build - phase ${phaseIndex}/${total}: ${commitlet.title}`,
    "",
    "You are building this project yourself, in THIS session. There is no separate worker; this is one coherent build.",
    `Goal: ${plan.userGoal.slice(0, 400)}`,
    "",
    ...createBlock,
    ...stampNote,
    "",
    hasManifest ? "After the manifest exists, run `npm install` and confirm it exits 0." : "",
    "Rules:",
    "- BE FAST: do NOT write long planning narration or restate the plan between files - every sentence you generate costs real seconds on a local model. Write each file's code directly and move on.",
    "- Use the write tool to create each new file (never heredocs or echo/cat redirection).",
    "- To FIX a file that already exists (e.g. a build error), use cheater_replace (literal find/replace) or cheater_line_edit - do NOT rewrite the whole file.",
    "- The phases are a suggested ORDER, not a cage: you MAY edit ANY file to wire the app together (e.g. import your new components into App.tsx). The scope guard will not stop you.",
    "- Keep App.tsx THIN: put each feature's UI in its own component file and import it - do NOT inline every feature into one giant file (a huge file becomes impossible to build-fix).",
    ...constraints.map((constraint) => `- ${constraint}`),
    "",
    "When every file above exists, call cheater_commitlet_next to advance to the next phase. Keep going",
    "phase by phase - do not stop, summarize, or wait for the user - until cheater_finish_gate reports",
    "ALLOWED. Before finishing, run the project's build to confirm it succeeds."
  ].filter(Boolean).join("\n");
  return { commitletId: commitlet.id, freshWorkerMode: "simulated", prompt };
}

/**
 * Build and persist the prompt capsule for one commitlet worker. The capsule is the CANONICAL
 * worker context: every input (goal, contract, observed failure, attempt stance, snippets,
 * repo facts, run-state truth, rules) is a typed, capped field - never ad hoc string piles,
 * never the parent session's chat or logs. Typed fragments are still collected for the
 * audit trail (capsule metadata records exactly what entered this worker's context) and to
 * extract the world-state delta.
 */
function buildRunCapsule(
  run: TaskRunState,
  plan: CommitletPlan,
  commitlet: Commitlet,
  extras: {
    snippets: Array<{ path: string; snippet: string }>;
    repoFacts: string[];
    previousState?: string[];
    attempt?: number;
    modelName?: string;
    /** The model runs this commitlet in the current session (no isolated worker to hand off to). */
    inSession?: boolean;
  }
): { capsule: PromptCapsule; fragments: ContextFragment[] } {
  const spec = commitlet.spec;
  const attempt = extras.attempt ?? 1;
  const packSeed = `${plan.userGoal} ${commitlet.allowedFiles.join(" ")}`;
  const rules = [
    ...selectRulePacks(packSeed).flatMap((pack) => pack.rules).slice(0, 8),
    ...recallHarnessLessons(packSeed, 2)
  ];
  const fragments = collectFragmentsForWorker(run, {
    goalSeed: packSeed,
    ruleLines: rules,
    priorReports: run.recentReportLines()
  });
  const worldDiffFragment = fragments.find((fragment) => fragment.kind === "world_state_diff");
  const guardLine = run.guard.warningLine();
  // Deterministic scouting (Phase 3): enrich relevantFiles with contract-noun briefs the executor's
  // own target-file slices don't cover (symbol definitions elsewhere, references, one import hop), so
  // a worker wanders less with read/grep. Hardness-gated: deep (symbol search + imports) only for hard
  // work; shallow (contract/target files only) keeps the easy lane lean. The executor's own snippets
  // are excluded so scout never duplicates them; scout is the deterministic floor beneath any rerank.
  const scouted = scoutForCapsule(run, plan, commitlet, extras.snippets.map((entry) => entry.path));
  const capsule = buildPromptCapsule({
    taskId: run.taskId,
    workerRole: commitlet.id,
    workerGoal: `${commitlet.title}: ${commitlet.purpose}`,
    // In-session the model IS the whole build, so the "do not continue into another commitlet/file"
    // nonGoal directly contradicts the continuation instruction and makes weak models stop after one
    // file. Drop just that nonGoal in-session; capsule.inSession also flips the closing directive.
    nonGoals: extras.inSession
      ? (spec?.nonGoals ?? []).filter((item) => !/continue into another commitlet|another file after this scope/i.test(item))
      : spec?.nonGoals,
    inSession: extras.inSession,
    acceptanceContract: [
      ...(spec?.acceptanceCriteria ?? []),
      ...run.contract.checklist.slice(0, 4)
    ],
    // The repair worker's single most important input, as a typed field. Which portion
    // renders varies per resample attempt (attempt 3 withholds the cheat sheet so attempts
    // do not converge on the same evidence-suggested fix).
    observedFailure: observedFailureForAttempt(spec?.observedFailure, attempt),
    attemptStance: attemptStance(attempt) || undefined,
    operatingRules: operatingRulesFor(inferModelClass(extras.modelName ?? "")),
    worldDiff: worldDiffFragment ? worldDiffFragment.text.split(/\r?\n/).slice(1) : undefined,
    relevantFiles: [
      ...extras.snippets
        .filter((entry) => entry.snippet)
        .map((entry) => ({ path: entry.path, reason: "commitlet target", snippet: entry.snippet })),
      ...scouted.briefs
    ],
    allowedFiles: commitlet.allowedFiles,
    forbiddenFiles: commitlet.forbiddenFiles,
    repoFacts: extras.repoFacts,
    constraints: [
      ...plan.globalConstraints,
      // Ambiguity: two definition sites for a symbol -> ask the worker to STATE which it used
      // (multiple-choice selection, not exploration), so it does not guess and drift.
      ...(scouted.ambiguous.length ? [`Two candidate definitions exist for ${scouted.ambiguous.join(", ")} - state which file's definition you built against.`] : []),
      ...(spec?.behaviorMustHold ?? []).map((item) => `must hold: ${item}`),
      ...(spec?.behaviorMustNotChange ?? []).map((item) => `must not change: ${item}`)
    ],
    riskWarnings: guardLine ? [guardLine] : [],
    validationPlan: commitlet.focusedVerification.map((step) => step.command ?? step.purpose),
    workspaceDigest: run.refreshDigest(),
    mutationSummary: run.mutations.renderSummaryLines(),
    priorWorkerReports: [...run.recentReportLines(), ...(extras.previousState ?? []).slice(-3)],
    phaseLines: run.phase.capsuleLines(),
    rulePack: rules,
    fragments: fragmentMeta(fragments)
  });
  run.noteCapsule(capsule);
  return { capsule, fragments };
}

/**
 * Deterministic scout for a commitlet capsule. Depth follows task hardness (deep = symbol search +
 * one import hop; shallow = contract/target files only), decoupled from the adaptive-compute flag so
 * a hard task always gets briefed even when adaptive sampling is off. Fully guarded - a scout failure
 * degrades to no extra briefs, never breaks capsule assembly.
 */
function scoutForCapsule(run: TaskRunState, plan: CommitletPlan, commitlet: Commitlet, excludePaths: string[]): ScoutOutcome {
  try {
    const concrete = (file: string): boolean => Boolean(file) && !file.startsWith("(") && !file.endsWith("/");
    const { hardness } = scoreHardness({
      taskKind: plan.autopilotDecision?.taskKind,
      risk: String(commitlet.risk ?? plan.risk ?? ""),
      filesInScope: commitlet.allowedFiles.filter(concrete).length,
      isRepair: isRepairCommitlet(commitlet)
    });
    return scout({
      cwd: plan.repoRoot,
      symbols: run.contract.symbols,
      files: [...run.contract.files, ...run.contract.outputPaths, ...commitlet.allowedFiles.filter(concrete)],
      terms: [commitlet.title, ...(commitlet.spec?.acceptanceCriteria ?? [])],
      depth: hardness >= 3 ? "deep" : "shallow",
      excludePaths,
      maxBriefs: 4,
      byteBudget: 3500
    });
  } catch {
    return { briefs: [], ambiguous: [] };
  }
}

export async function spawnFreshWorkerForCommitlet(
  plan: CommitletPlan,
  commitlet: Commitlet,
  config: CheaterConfig,
  runner: FreshAgentPacketRunner = sdkFreshAgentPacketRunner,
  attempt = 1,
  model?: unknown,
  onHeartbeat?: (elapsedMs: number) => void
): Promise<FreshAgentPacketResult> {
  const packetPlan = commitletPlanAsBlueprint(plan, commitlet);
  const packet = packetPlan.workPackets[0];
  if (!packet) {
    return { ok: false, summary: `No work packet for commitlet ${commitlet.id}`, error: "no_packet" };
  }
  const modelName = (model as { id?: string } | undefined)?.id ?? config.model;
  const execution = buildCommitletExecutionPrompt(plan, commitlet, [], "real", attempt, modelName);
  const promptBody = execution.prompt;
  // Spawn discipline: an explicit fork-none spawn spec, a role-scoped tool list (exposure
  // only ever shrinks), and the capsule invariant gate. A capsule that fails invariants does
  // not spawn - the controller is told to split or compress instead of shipping bloat.
  const run = activeTaskRun();
  const mode = workerModeForCommitlet(commitlet);
  const exposure = planToolExposure(mode);
  if (run && execution.capsule) {
    if (attempt === 1) {
      buildWorkerSpawnSpec({
        run,
        workerId: commitlet.id,
        role: roleForCommitlet(commitlet),
        taskName: commitlet.title,
        allowedFiles: commitlet.allowedFiles,
        forbiddenFiles: commitlet.forbiddenFiles,
        mode,
        maxContextTokens: execution.capsule.tokenBudgetHint,
        maxToolCalls: commitlet.maxToolCalls,
        config
      });
    }
    const invariants = checkCapsuleInvariants(execution.capsule, { run, workerTools: exposure.workerTools, config });
    if (!invariants.ok) {
      run.bumpTelemetry("invariantFailures");
      appendRunEvent(run.runDir, "capsule_invariant_failed", { workerId: commitlet.id, failures: invariants.failures.slice(0, 5) });
      return {
        ok: false,
        summary: `Capsule invariants failed for ${commitlet.id}: ${invariants.failures.join("; ")}. Split the task or compress the capsule before spawning.`,
        error: "capsule_invariant_failed"
      };
    }
  }
  try {
    return await runner.runPacket({
      cwd: plan.repoRoot,
      plan: packetPlan,
      packet,
      prompt: promptBody,
      config,
      model,
      tools: exposure.workerTools,
      thinkingLevel: attemptThinkingLevel(attempt),
      onHeartbeat
    });
  } catch (err) {
    // A worker backend that cannot even create a session (no provider configured, model
    // offline) must degrade to a structured error, not reject the whole tool call.
    return {
      ok: false,
      summary: `Fresh worker backend unavailable for ${commitlet.id}: ${(err as Error).message}`,
      error: "worker_backend_unavailable"
    };
  }
}

function compactSnippet(file: string, text: string): string {
  if (!text.trim()) return "";
  const lines = text.split(/\r?\n/).slice(0, 40).join("\n").slice(0, 800);
  return [`--- ${file} snippet ---`, lines, `--- end ${file} snippet ---`].join("\n");
}

export function prepareCommitlet(repoRoot: string, commitlet: Commitlet): Commitlet {
  return {
    ...commitlet,
    status: "running",
    // Preserve an inherited rollback point (e.g. a repair carrying the original's pre-edit
    // snapshot); only create a fresh one when the commitlet has none.
    rollbackPoint: commitlet.rollbackPoint ?? createRollbackPoint(repoRoot, commitlet)
  };
}

function commitletPlanAsBlueprint(plan: CommitletPlan, commitlet: Commitlet): BlueprintPlan {
  const packet: WorkPacket = {
    id: commitlet.id,
    title: commitlet.title,
    type: commitlet.scope === "review" ? "review" : "implement",
    status: "pending",
    dependsOn: [],
    estimatedModelCalls: 1,
    maxModelCalls: commitlet.maxModelCalls,
    filesToInspect: commitlet.allowedFiles.map((path) => ({ path, reason: "commitlet allowed file" })),
    filesToTouch: commitlet.allowedFiles.filter((path) => !path.startsWith("(")).slice(0, 1).map((path) => ({ path, reason: "commitlet edit target" })),
    allowedTools: commitlet.allowedActions,
    forbiddenActions: commitlet.forbiddenActions,
    promptContract: "Execute exactly this commitlet in a fresh worker and stop after one file.",
    acceptanceCriteria: commitlet.spec?.acceptanceCriteria ?? [commitlet.purpose],
    verification: commitlet.focusedVerification.map((step, index) => ({
      id: `${commitlet.id}-verify-${index + 1}`,
      command: step.command,
      description: step.purpose,
      required: step.required
    })),
    simulationChecks: [],
    risk: commitlet.risk
  };
  const id = `${plan.id}-as-blueprint`;
  const roleSeparation = createRoleSeparation(id, `${plan.id}-commitlet-planner`);
  const approval: BlueprintPlan["approval"] = commitlet.risk === "high" ? "needs_user" : "auto_approved";
  const adaptedBeforeQuality = {
    id,
    createdAt: plan.createdAt,
    repoRoot: plan.repoRoot,
    userGoal: plan.userGoal,
    preview: {
      id: "commitlet-preview",
      userGoal: plan.userGoal,
      taskType: plan.autopilotDecision?.taskKind ?? "unknown",
      taskSummary: plan.summary,
      hiddenComplexitySignals: [],
      likelyRelevantAreas: commitlet.allowedFiles,
      likelyRisks: [],
      shouldUseBlueprint: false,
      reason: "Commitlet execution prompt adapter."
    },
    selectedCandidateId: "commitlet",
    candidates: [],
    scores: [],
    summary: plan.summary,
    nonGoals: commitlet.spec?.nonGoals ?? [],
    assumptions: [],
    repoOrientation: { repoRoot: plan.repoRoot, languages: [], frameworks: [], testCommands: [], typecheckCommands: [], entrypoints: [], importantPaths: [] },
    docsFacts: [],
    memoryHits: [],
    roleSeparation,
    planGraph: { nodes: [], edges: [] },
    workPackets: [packet],
    finalReview: { id: "final-review", checks: [], required: true },
    constraints: plan.globalConstraints,
    risks: [],
    verification: [],
    approval,
    confidence: plan.autopilotDecision?.confidence ?? 0.6
  };
  const adapted: BlueprintPlan = { ...adaptedBeforeQuality, qualityGate: evaluateBlueprintQuality(adaptedBeforeQuality), artifactMarkdown: "" };
  return { ...adapted, artifactMarkdown: renderBlueprintArtifact(adapted) };
}
