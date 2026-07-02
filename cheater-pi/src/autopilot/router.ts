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
    repoHints,
    requireApproval: input.requireApproval
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
  if (mode === "careful_repro") return "I will reproduce and verify carefully, running the edit as a verified commitlet.";
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
  // One flow for every code mode. cheater_reliability_start returns a prompt describing the
  // first commitlet; depending on the backend it either runs a fresh worker automatically or
  // hands the packet to you to execute - EITHER WAY the model then calls cheater_commitlet_next
  // to grade and advance. This deliberately does NOT claim "you are planner only, do not
  // edit": on a local backend that can't spawn sub-sessions, you ARE the one who edits, and
  // the commitlet scope guard keeps your edits inside the allowed file.
  const lines: string[] = [];
  if (decision.executionMode === "careful_repro") {
    lines.push("Cheater: reproduce the bug and gather evidence first, then run the flow below.");
  }
  lines.push(
    "Cheater flow (run it start to finish without pausing to ask):",
    "1. Call cheater_reliability_start with the full goal; it plans and returns the first commitlet's prompt.",
    "2. Do exactly what that prompt says (edit the allowed file, or note the worker already did), then call cheater_commitlet_next - it grades in code and hands you the next commitlet. Repeat until it reports the final review.",
    "3. Call cheater_verification_run then cheater_finish_gate before telling the user it is done. If verification cannot run, say so explicitly."
  );
  return lines.join("\n");
}
