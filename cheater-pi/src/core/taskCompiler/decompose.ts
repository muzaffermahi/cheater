// Task Compiler — deterministic decomposition of a compiled contract into a subagent plan.
//
// WHY: reliability is multiplicative in trajectory length. At a 95% per-step success rate a 10-step
// task completes ~60% of the time and a 25-step task ~28%. The consistently-reported highest-leverage
// intervention in the long-horizon literature is to split the work into short sub-tasks and RESTART
// the agent at each boundary — a restart discards the accumulated error state instead of carrying it.
//
// Kitten already had both halves and no bridge between them: `taskGraph.ts` executes a durable DAG
// with per-node acceptance criteria and bounded file scopes, and the Task Compiler produces typed
// deliverables, affected surfaces and a verification contract. Nothing turned the second into the
// first, so a plan only existed if a human made one.
//
// THE DECOMPOSITION IS DETERMINISTIC. No model decides the split. A model-authored plan would be one
// more thing to verify, and a wrong split is expensive: it fans out bounded workers against the wrong
// boundaries and every one of them has to be paid for at ~20 tok/s. Deliverables and affected
// surfaces are already the natural seams, so the split falls out of the contract rather than being
// invented on top of it.
//
// IT ALSO DECLINES OFTEN, ON PURPOSE. Decomposition only wins when the pieces are genuinely
// low-coupling; below that threshold the coordination overhead exceeds a 3B-active model's useful
// work. A single-file change is not a DAG, and pretending otherwise is organizational cosplay.

import type { CompiledTask, Deliverable } from "./ir.js";
import { executableChecks } from "./verification.js";

/** One node of a derived plan, in the shape `TaskGraphController.createPlan` consumes. */
export interface DerivedTaskNode {
  id: string;
  agent: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  modelTier: "main" | "sidecar";
  workspaceMode: "shared-readonly" | "isolated-worktree";
}

export interface DecompositionResult {
  /** Empty when decomposition was declined — the caller then runs the task normally. */
  nodes: DerivedTaskNode[];
  /** Why it split, or why it refused. Recorded in receipts; never sent to the model. */
  reason: string;
}

/**
 * Minimum independent write surfaces before a split is worth it. Two pieces is the smallest number
 * where per-piece verification can catch what a single trajectory would have shipped, and below it
 * the restart overhead buys nothing.
 */
const MIN_PIECES = 2;
/** Above this, the coordination and integration cost dominates on a serialized local model. */
const MAX_PIECES = 4;

/** Deliverables that correspond to a distinct, writable surface. */
function writableDeliverables(task: CompiledTask): Deliverable[] {
  const seen = new Set<string>();
  return task.deliverables.filter((deliverable) => {
    if (deliverable.kind !== "file" && deliverable.kind !== "symbol") return false;
    // A "deliverable" that is really a sentence (the no-literal-artifact fallback) has no path and
    // cannot bound a worker's write scope.
    if (!/^[\w./@-]+$/.test(deliverable.target)) return false;
    const key = deliverable.target.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Derive a plan, or decline. Pure: no model call, no filesystem access.
 *
 * Declines when the contract is a clarification, a read-only investigation, forbids mutation, or has
 * fewer than `MIN_PIECES` independent write surfaces.
 */
export function decomposeCompiledTask(task: CompiledTask): DecompositionResult {
  if (task.compilationMode === "clarify") return { nodes: [], reason: "declined: the task is still being clarified" };
  if (!task.executionPolicy.mutationAllowed) return { nodes: [], reason: "declined: read-only task" };
  if (task.family === "repository_investigation") return { nodes: [], reason: "declined: an investigation produces one answer, not a DAG" };

  const pieces = writableDeliverables(task);
  if (pieces.length < MIN_PIECES) {
    return { nodes: [], reason: `declined: ${pieces.length} independent write surface(s) — a single trajectory is cheaper than a DAG` };
  }

  const selected = pieces.slice(0, MAX_PIECES);
  const dropped = pieces.length - selected.length;
  const allTargets = selected.map((piece) => piece.target);

  // Binding requirements and invariants are inherited by EVERY worker — they are the contract, and a
  // worker that never saw a `must not` will cheerfully violate it inside its own bounded scope.
  const binding = task.requirements
    .filter((requirement) => requirement.strength === "must" || requirement.strength === "must_not")
    .map((requirement) => (requirement.strength === "must_not" ? `Must NOT: ${requirement.text}` : requirement.text));
  const invariants = task.invariants.map((invariant) => `Preserve: ${invariant.text}`);
  const checks = executableChecks(task.verification)
    .map((check) => (check.command ? `Run \`${check.command}\` and confirm it passes.` : check.claim))
    .slice(0, 4);

  const nodes: DerivedTaskNode[] = selected.map((piece, index) => ({
    id: `tc-${String(index + 1).padStart(2, "0")}`,
    agent: "general",
    objective: `${task.goal} — specifically, deliver ${piece.target}.`,
    acceptanceCriteria: [
      `${piece.target} exists and does what the goal requires of it.`,
      ...binding.slice(0, 6),
      ...invariants.slice(0, 3),
      ...checks.slice(0, 2),
    ],
    dependencies: [],
    // Each worker owns exactly one surface. The others are FORBIDDEN, not merely unmentioned — two
    // isolated workers editing the same file is how a parallel plan produces a silent conflict.
    allowedFiles: [piece.target],
    forbiddenFiles: allTargets.filter((target) => target !== piece.target),
    modelTier: "main",
    workspaceMode: "isolated-worktree",
  }));

  // A final integration node. The literature is consistent that reconciling candidate work is
  // frequently worth more than another author: it is the only step that sees the pieces together and
  // can run the combined verification the individual workers could not.
  nodes.push({
    id: "tc-integrate",
    agent: "verify",
    objective: `Integrate the delivered pieces and verify the whole task: ${task.goal}`,
    acceptanceCriteria: [
      ...binding.slice(0, 6),
      ...invariants.slice(0, 3),
      ...(checks.length ? checks : ["Confirm the goal is satisfied end to end."]),
    ],
    dependencies: nodes.map((node) => node.id),
    allowedFiles: allTargets,
    forbiddenFiles: [],
    modelTier: "main",
    workspaceMode: "shared-readonly",
  });

  const reason = `split into ${selected.length} bounded piece(s) + integration${dropped ? ` (${dropped} further surface(s) left to the integration step)` : ""}`;
  return { nodes, reason };
}

/** Would this contract decompose? Cheap predicate for routing, without building the plan. */
export function wouldDecompose(task: CompiledTask): boolean {
  return decomposeCompiledTask(task).nodes.length > 0;
}
