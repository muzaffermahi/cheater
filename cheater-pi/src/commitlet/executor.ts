import type { BlueprintPlan, WorkPacket } from "../blueprint/types.js";
import { buildPacketExecutionPrompts } from "../blueprint/executor.js";
import { fileSnippet } from "../blueprint/contextSketch.js";
import { createRoleSeparation, renderBlueprintArtifact } from "../blueprint/artifact.js";
import { evaluateBlueprintQuality } from "../blueprint/qualityGate.js";
import { createRollbackPoint } from "./rollback.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import { buildRepoConstraintGraph, queryConstraintFacts } from "./constraintGraph.js";

export interface CommitletExecutionPrompt {
  commitletId: string;
  prompt: string;
}

export function buildCommitletExecutionPrompt(plan: CommitletPlan, commitlet: Commitlet, previousState: string[] = []): CommitletExecutionPrompt {
  const packetPlan = commitletPlanAsBlueprint(plan, commitlet);
  const prompt = buildPacketExecutionPrompts(packetPlan, {
    freshCallPacketsEnabled: true,
    packetOneFilePerWorkerEnabled: true,
    packetMaxFilesToTouch: 1
  })[0]?.prompt ?? "";
  const spec = commitlet.spec;
  const boundedFiles = commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")).slice(0, 3);
  const graph = buildRepoConstraintGraph(plan.repoRoot, boundedFiles);
  const constraintFacts = boundedFiles.flatMap((file) => queryConstraintFacts(graph, file).slice(0, 4)).slice(0, 8);
  const snippets = boundedFiles.slice(0, 2).map((file) => compactSnippet(file, fileSnippet(plan.repoRoot, file, 800))).filter(Boolean);
  return {
    commitletId: commitlet.id,
    prompt: [
      "Cheater Reliability Kernel commitlet.",
      `commitletId: ${commitlet.id}`,
      `title: ${commitlet.title}`,
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
        `nonGoals: ${spec.nonGoals.join("; ")}`
      ].join("\n") : "",
      "",
      prompt,
      "",
      "Before editing, rollback must exist. After editing, stop for diff guard, focused verification, health score, and test audit."
    ].filter(Boolean).join("\n")
  };
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
    rollbackPoint: createRollbackPoint(repoRoot, commitlet)
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
