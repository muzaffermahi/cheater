import type { BlueprintPlan, WorkPacket } from "../blueprint/types.js";
import { buildPacketExecutionPrompts } from "../blueprint/executor.js";
import { fileSnippet } from "../blueprint/contextSketch.js";
import { createRoleSeparation, renderBlueprintArtifact } from "../blueprint/artifact.js";
import { evaluateBlueprintQuality } from "../blueprint/qualityGate.js";
import { sdkFreshAgentPacketRunner, type FreshAgentPacketResult, type FreshAgentPacketRunner } from "../blueprint/worker.js";
import { createRollbackPoint } from "./rollback.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import { buildRepoConstraintGraph, queryConstraintFacts } from "./constraintGraph.js";
import { symbolSnippet } from "../reliability/symbolSlice.js";
import type { CheaterConfig } from "../types.js";

export type FreshWorkerMode = "simulated" | "real";

export interface CommitletExecutionPrompt {
  commitletId: string;
  prompt: string;
  freshWorkerMode: FreshWorkerMode;
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
const ATTEMPT_THINKING: Array<"off" | "low" | "medium" | "high" | undefined> = [undefined, "high", "off"];

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

export function buildCommitletExecutionPrompt(plan: CommitletPlan, commitlet: Commitlet, previousState: string[] = [], freshWorkerMode: FreshWorkerMode = "simulated", attempt = 1, modelName?: string): CommitletExecutionPrompt {
  const packetPlan = commitletPlanAsBlueprint(plan, commitlet);
  const spec = commitlet.spec;
  const boundedFiles = commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")).slice(0, 3);
  const graph = buildRepoConstraintGraph(plan.repoRoot, boundedFiles);
  const constraintFacts = boundedFiles.flatMap((file) => queryConstraintFacts(graph, file).slice(0, 4)).slice(0, 8);
  // Slice the actual target symbol (function/class whose name overlaps the task terms) rather
  // than the first 40 lines of imports. Repair commitlets seed terms from the observed failure.
  const sliceTerms = [
    commitlet.title,
    ...(spec?.behaviorMustHold ?? []),
    ...(spec?.acceptanceCriteria ?? []),
    spec?.observedFailure ?? ""
  ].filter(Boolean);
  const sliceCandidates = boundedFiles.slice(0, 2);
  const perFileSnippets = sliceCandidates.map((file) => symbolSnippet(plan.repoRoot, file, sliceTerms) || compactSnippet(file, fileSnippet(plan.repoRoot, file, 800)));
  const snippets = perFileSnippets.filter(Boolean);
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
  const workerNotice = freshWorkerMode === "real"
    ? "freshWorkerMode: real (this commitlet runs in a separate isolated LLM session via sdkFreshAgentPacketRunner)"
    : "freshWorkerMode: simulated (this prompt is returned to the current agent session; no separate context boundary is created)";
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
      constraintFacts.length ? `constraintFacts:\n- ${constraintFacts.join("\n- ")}` : "constraintFacts: none",
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
      "Before editing, rollback must exist. After editing, stop for diff guard, focused verification, health score, and test audit."
    ].filter(Boolean).join("\n")
  };
}

export async function spawnFreshWorkerForCommitlet(
  plan: CommitletPlan,
  commitlet: Commitlet,
  config: CheaterConfig,
  runner: FreshAgentPacketRunner = sdkFreshAgentPacketRunner,
  attempt = 1,
  model?: unknown
): Promise<FreshAgentPacketResult> {
  const packetPlan = commitletPlanAsBlueprint(plan, commitlet);
  const packet = packetPlan.workPackets[0];
  if (!packet) {
    return { ok: false, summary: `No work packet for commitlet ${commitlet.id}`, error: "no_packet" };
  }
  const modelName = (model as { id?: string } | undefined)?.id ?? config.model;
  const promptBody = buildCommitletExecutionPrompt(plan, commitlet, [], "real", attempt, modelName).prompt;
  try {
    return await runner.runPacket({
      cwd: plan.repoRoot,
      plan: packetPlan,
      packet,
      prompt: promptBody,
      config,
      model,
      thinkingLevel: attemptThinkingLevel(attempt)
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
