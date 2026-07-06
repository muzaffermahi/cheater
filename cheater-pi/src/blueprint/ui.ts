import type { BlueprintPlan, BlueprintRunState, FinalReviewResult } from "./types.js";

export function formatBlueprintPreview(plan: BlueprintPlan): string {
  return [
    "Cheater Blueprint preview",
    `goal: ${plan.preview.taskSummary}`,
    `task: ${plan.preview.taskType}    blueprint: ${plan.preview.shouldUseBlueprint}`,
    `signals: ${plan.preview.hiddenComplexitySignals.join(", ") || "(none)"}`,
    `risks: ${plan.preview.likelyRisks.join(", ") || "(none)"}`
  ].join("\n");
}

export function formatBlueprintPlanSummary(plan: BlueprintPlan): string {
  return [
    "Cheater Blueprint plan",
    `selected: ${plan.selectedCandidateId}    confidence: ${plan.confidence}`,
    `approval: ${plan.approval}`,
    plan.intelligence ? `intelligence: evidence=${plan.intelligence.evidence.length} decisions=${plan.intelligence.architectureDecisions.length} web=${plan.intelligence.webSearch.status}` : "intelligence: unavailable",
    `packets: ${plan.workPackets.map((packet) => `${packet.id}:${packet.status}`).join(", ")}`,
    `verification: ${plan.verification.map((step) => step.command ?? step.description).join(" | ") || "(manual)"}`
  ].join("\n");
}

export function formatFinalReview(result: FinalReviewResult, includeDebug = false): string {
  const lines = [
    "Cheater Blueprint final review",
    `accepted: ${result.accepted}`,
    `summary: ${result.summary}`,
    `blocking: ${result.blockingIssues.join("; ") || "none"}`,
    `warnings: ${result.nonBlockingWarnings.join("; ") || "none"}`
  ];
  if (includeDebug && result.debugNotes.length) {
    lines.push(`debug: ${result.debugNotes.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatBlueprintRunState(state: BlueprintRunState): string {
  if (!state.currentPlan) return "Cheater Blueprint\nstatus: idle";
  return state.lastReview ? formatFinalReview(state.lastReview) : state.currentPlan.artifactMarkdown || formatBlueprintPlanSummary(state.currentPlan);
}
