import type { AutopilotDecision, ExecutionDiscipline, ExecutionMode, RoutePolicyInput } from "./types.js";

export function decideExecutionMode(input: RoutePolicyInput): Omit<AutopilotDecision, "userVisibleSummary"> {
  const text = input.message.toLowerCase();
  const explicitFast = /\b(just do it quickly|quickly|quick fix|no plan|fast path)\b/i.test(text);
  const explicitCareful = /\b(plan this carefully|carefully|blueprint|design first|architecture)\b/i.test(text);
  const failureEscalation = input.repoHints?.previousFastPathFailed || input.repoHints?.repeatedFailure;
  const highComplexity = input.complexitySignals.length >= 2 || input.risk === "high";

  let executionMode: ExecutionMode;
  if (input.taskKind === "explanation_only") {
    executionMode = "answer_only";
  } else if (input.taskKind === "bug_fix" || input.taskKind === "test_failure") {
    executionMode = failureEscalation || explicitCareful ? "blueprint_orchestrator" : "mission_control";
  } else if (explicitCareful || failureEscalation) {
    executionMode = "blueprint_orchestrator";
  } else if (input.taskKind === "tiny_edit" && !highComplexity) {
    executionMode = explicitFast ? "vanilla_pi" : "mission_control";
  } else if (input.confidence < 0.55 && input.taskKind !== "unknown") {
    executionMode = "blueprint_orchestrator";
  } else if (explicitFast && input.risk !== "high" && input.complexitySignals.length <= 1) {
    executionMode = "mission_control";
  } else if (highComplexity || ["feature_addition", "refactor", "tooling", "migration", "benchmark"].includes(input.taskKind)) {
    executionMode = "blueprint_orchestrator";
  } else if (input.taskKind === "docs") {
    executionMode = input.complexitySignals.length > 1 ? "blueprint_orchestrator" : "vanilla_pi";
  } else {
    executionMode = input.confidence < 0.45 ? "answer_only" : "mission_control";
  }

  return {
    taskKind: input.taskKind,
    executionMode,
    executionDiscipline: decideExecutionDiscipline(executionMode, input, failureEscalation),
    confidence: input.confidence,
    reason: explainMode(executionMode, input),
    needsBlueprint: executionMode === "blueprint_orchestrator",
    needsRepro: input.needsRepro,
    risk: input.risk,
    complexitySignals: input.complexitySignals
  };
}

function decideExecutionDiscipline(mode: ExecutionMode, input: RoutePolicyInput, failureEscalation?: boolean): ExecutionDiscipline {
  if (mode === "answer_only") return "none";
  if (input.risk === "high" && /\b(lockfile|package-lock|dependency|dependencies|delete|remove file|destructive)\b/i.test(input.message)) {
    return "blocked_needs_user";
  }
  if (mode === "blueprint_orchestrator") return "blueprint_backed_commitlet_chain";
  if (failureEscalation || input.complexitySignals.length >= 2) return "commitlet_chain";
  if (input.taskKind === "tiny_edit" || mode === "vanilla_pi") return "single_commitlet";
  if (input.taskKind === "bug_fix" || input.taskKind === "test_failure") return "single_commitlet";
  if (["feature_addition", "refactor", "tooling", "migration", "benchmark"].includes(input.taskKind)) return "commitlet_chain";
  return "fast_path";
}

function explainMode(mode: ExecutionMode, input: RoutePolicyInput): string {
  if (mode === "answer_only") return "No code change is implied, so Pi should answer directly.";
  if (mode === "vanilla_pi") return "Task is small enough for Pi's normal path with focused verification.";
  if (mode === "mission_control") return input.needsRepro
    ? "Bug/test signal should use Mission Control with repro and evidence."
    : "Task is bounded enough for Mission Control fast path.";
  return input.complexitySignals.length
    ? `Planning path selected because: ${input.complexitySignals.join(", ")}.`
    : "Planning path selected because the request is code-changing and classifier confidence is low.";
}
