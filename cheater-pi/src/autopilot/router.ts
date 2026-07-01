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

// Model-facing instruction: only imperative directives, no routing telemetry
// (mode/discipline/risk/confidence live in the TUI widget and /autopilot-status). A small
// model attends to the top of the message, so the goal keeps positional primacy and this
// block is short.
export function buildAutopilotInstruction(decision: AutopilotDecision, _goal: string): string {
  if (decision.executionMode === "answer_only") {
    return "Cheater: this is a question, not a code change. Answer directly. Do not edit files or start a commitlet plan.";
  }
  if (decision.executionDiscipline === "blocked_needs_user") {
    return "Cheater: this looks high-risk (dependency/lockfile/destructive change). Stop before editing and ask the user for explicit approval.";
  }
  const lines: string[] = [];
  if (decision.executionMode === "blueprint_orchestrator") {
    lines.push(
      "Cheater plan (this session is the planner only: do not read, grep, ls, bash, edit, or write yourself):",
      "1. Call cheater_reliability_start with the goal; it builds the commitlet plan and returns the first fresh-call prompt.",
      "2. After each fresh worker finishes its one-file commitlet, call cheater_commitlet_next to grade it and get the next commitlet or the final review.",
      "3. When cheater_commitlet_next reports the final review, call cheater_verification_run then cheater_finish_gate before telling the user it is done."
    );
    return lines.join("\n");
  }
  if (decision.executionMode === "mission_control") {
    lines.push("Cheater: reproduce the bug and gather evidence first, then run the commitlet flow below.");
  }
  lines.push(
    "Cheater plan:",
    "1. Call cheater_reliability_start with the goal; it builds the commitlet plan and returns the first fresh-call prompt.",
    "2. Edit only the allowed files, then call cheater_commitlet_next (it grades the edit in code). Repeat until it reports the final review.",
    "3. Call cheater_verification_run then cheater_finish_gate before telling the user it is done. If verification cannot run, say so explicitly."
  );
  return lines.join("\n");
}
