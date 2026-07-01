import { detectComplexitySignals } from "../autopilot/classifier.js";
import type { BlueprintPreview, RepoOrientation } from "./types.js";

export function createBlueprintPreview(params: {
  id?: string;
  userGoal: string;
  taskType: string;
  repoOrientation?: RepoOrientation;
}): BlueprintPreview {
  const signals = detectComplexitySignals(params.userGoal);
  const areas = likelyRelevantAreas(params.userGoal, params.repoOrientation);
  const risks = likelyRisks(params.userGoal, signals);
  const shouldUseBlueprint = signals.length >= 2 || /refactor|migration|orchestrator|command|tool|config|feature|architecture/i.test(params.userGoal);
  return {
    id: params.id ?? `preview-${Date.now().toString(36)}`,
    userGoal: params.userGoal,
    taskType: params.taskType,
    taskSummary: summarizeGoal(params.userGoal),
    hiddenComplexitySignals: signals,
    likelyRelevantAreas: areas,
    likelyRisks: risks,
    shouldUseBlueprint,
    reason: shouldUseBlueprint
      ? "The request likely crosses module boundaries and benefits from packetized execution."
      : "The request appears small enough for a fast path unless verification expands scope."
  };
}

function summarizeGoal(goal: string): string {
  const trimmed = goal.replace(/\s+/g, " ").trim();
  return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 137)}...`;
}

function likelyRelevantAreas(goal: string, orientation?: RepoOrientation): string[] {
  const areas: string[] = [];
  const lower = goal.toLowerCase();
  if (/\bcommand|slash|cli\b/.test(lower)) areas.push("command registration");
  if (/\btool|schema\b/.test(lower)) areas.push("tool registration");
  if (/\bconfig|setting|defaults?\b/.test(lower)) areas.push("configuration");
  if (/\bdocs?|readme\b/.test(lower)) areas.push("documentation");
  if (/\btest|ci|verify\b/.test(lower)) areas.push("tests");
  for (const entry of orientation?.entrypoints ?? []) areas.push(entry);
  return [...new Set(areas)].slice(0, 8);
}

function likelyRisks(goal: string, signals: string[]): string[] {
  const risks: string[] = [];
  if (signals.includes("command registration")) risks.push("command registry/help drift");
  if (signals.includes("tool registration")) risks.push("tool schema drift");
  if (signals.includes("configuration change")) risks.push("startup/default config regression");
  if (/\bdependency|lockfile|delete|remove file\b/i.test(goal)) risks.push("requires approval before risky filesystem or dependency changes");
  if (!risks.length) risks.push("verification may be too broad unless focused early");
  return risks;
}
