import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyAutopilotTask } from "./classifier.js";
import { decideExecutionMode } from "./policy.js";
import type { AutopilotDecision, AutopilotInput, AutopilotRepoHints } from "./types.js";

export function routeAutopilot(input: AutopilotInput): AutopilotDecision {
  const repoHints = { ...inferRepoHints(input.cwd), ...input.repoHints };
  const classification = classifyAutopilotTask({ ...input, repoHints });
  const partial = decideExecutionMode({
    message: input.message,
    taskKind: classification.taskKind,
    confidence: classification.confidence,
    risk: classification.risk,
    needsRepro: classification.needsRepro,
    complexitySignals: classification.complexitySignals,
    repoHints
  });
  return {
    ...partial,
    userVisibleSummary: summarizeDecision(partial.executionMode, partial.reason)
  };
}

export function inferRepoHints(cwd: string): AutopilotRepoHints {
  return {
    hasPackageJson: existsSync(join(cwd, "package.json")),
    hasPyproject: existsSync(join(cwd, "pyproject.toml")),
    hasTests: existsSync(join(cwd, "tests")) || existsSync(join(cwd, "test"))
  };
}

function summarizeDecision(mode: AutopilotDecision["executionMode"], reason: string): string {
  if (mode === "answer_only") return "This looks informational, so I will answer without editing.";
  if (mode === "vanilla_pi") return "This looks small, so I will wrap Pi's fast path in one commitlet and verify narrowly.";
  if (mode === "mission_control") return "I will use Mission Control, then run the edit as a verified commitlet.";
  if (/because: /.test(reason)) {
    const signals = reason.replace(/^.*because:\s*/, "").replace(/\.$/, "");
    return `Planning internally because this touches ${signals}.`;
  }
  return "Planning internally because this looks like a multi-step code task.";
}

export function buildAutopilotInstruction(decision: AutopilotDecision, goal: string): string {
  const lines = [
    "Cheater Autopilot decision",
    `mode: ${decision.executionMode}`,
    `executionDiscipline: ${decision.executionDiscipline}`,
    `taskKind: ${decision.taskKind}`,
    `risk: ${decision.risk}`,
    `confidence: ${decision.confidence.toFixed(2)}`,
    `reason: ${decision.reason}`,
    `goal: ${goal}`
  ];
  if (decision.executionMode === "answer_only") {
    lines.push("Proceed by answering directly. Do not edit files or run blueprint tools.");
  } else if (decision.executionDiscipline === "blocked_needs_user") {
    lines.push("Stop before editing and ask the user for explicit approval because this is high risk.");
  } else if (decision.executionDiscipline === "single_commitlet" || decision.executionDiscipline === "fast_path") {
    lines.push("For this code-changing task, first call cheater_reliability_start. Do not manually chain cheater_commitlet_plan, cheater_commitlet_next, or cheater_blueprint_create. Do not ask the user to type /blueprint or /commitlet; users do not need /blueprint or /commitlet. Each file-change commitlet must run in a different worker session.");
  } else if (decision.executionMode === "mission_control") {
    lines.push("Use Cheater Mission Control only when repro/evidence is needed. If editing is required after repro/evidence, continue by first calling cheater_reliability_start. Do not manually chain cheater_commitlet_plan, cheater_commitlet_next, or cheater_blueprint_create. Do not ask the user to type /blueprint or /commitlet; users do not need /blueprint or /commitlet. Each file-change commitlet must run in a different worker session.");
  } else {
    lines.push("Planner session only: for this code-changing task, first call cheater_reliability_start. Do not manually chain cheater_commitlet_plan, cheater_commitlet_next, or cheater_blueprint_create. Do not call read, grep, ls, bash, edit, or write yourself. Each file-change commitlet must run in a different worker session; do not ask the user to type /blueprint or /commitlet. Users do not need /blueprint or /commitlet.");
  }
  return lines.join("\n");
}
