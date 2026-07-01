import type { AutopilotDecision } from "./types.js";
import type { AutopilotStatus } from "./status.js";

export function formatAutopilotDecision(decision: AutopilotDecision): string {
  const lines = [
    "Cheater Autopilot",
    `mode: ${decision.executionMode}    task: ${decision.taskKind}    risk: ${decision.risk}`,
    `confidence: ${decision.confidence.toFixed(2)}`,
    `summary: ${decision.userVisibleSummary}`
  ];
  if (decision.complexitySignals.length) lines.push(`signals: ${decision.complexitySignals.join(", ")}`);
  return lines.join("\n");
}

export function formatAutopilotStatus(status: AutopilotStatus): string {
  if (!status.lastDecision) return "Cheater Autopilot\nstatus: idle\nlast decision: none";
  return [
    "Cheater Autopilot status",
    `updated: ${status.updatedAt ?? "(unknown)"}`,
    `goal: ${status.currentGoal}`,
    formatAutopilotDecision(status.lastDecision)
  ].join("\n");
}
