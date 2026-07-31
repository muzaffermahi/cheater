// Task Compiler — deterministic specification validation.
//
// A compiled task is used to spend the most expensive resource in the system (a 35B main-model call
// on an 8 GB card) and to gate completion. A malformed one is worse than none: it looks authoritative
// while pointing the model at the wrong thing. So the IR is validated before use, deterministically,
// with no model in the loop.
//
// The validator also enforces the design constraint that cannot be enforced by types alone: NO
// CONFIDENCE OR SEMANTIC SCORE FIELDS. A type can be edited; this scan walks the actual serialized
// value, so a future `qualityScore` added anywhere in the IR fails the build instead of quietly
// becoming a number the router thresholds on. It is scoped to the Task Compiler's semantic layer and
// deliberately does not touch Kitten's low-level logprob infrastructure, which is real telemetry.

import type { CompiledTask } from "./ir.js";
import { executableChecks } from "./verification.js";

/** Field names that must never appear anywhere in the Task IR. Fake precision, uniformly banned. */
export const PROHIBITED_SCORE_FIELDS: readonly string[] = [
  "confidence",
  "confidencescore",
  "certainty",
  "probability",
  "likelihood",
  "qualityscore",
  "specscore",
  "score",
  "weight",
  "difficulty",
  "difficultyscore",
  "priorityscore",
];

export interface ValidationIssue {
  code: string;
  message: string;
  /** `error` blocks use of the compiled task; `warning` is recorded and rendered nowhere. */
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Recursively find prohibited field names in any value. Returns the dotted paths that offend. */
export function findProhibitedScoreFields(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (PROHIBITED_SCORE_FIELDS.includes(key.toLowerCase())) found.push(`${at}.${key}`);
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
  return found;
}

export function validateCompiledTask(task: CompiledTask): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const error = (code: string, message: string): void => { errors.push({ code, message, severity: "error" }); };
  const warn = (code: string, message: string): void => { warnings.push({ code, message, severity: "warning" }); };

  // ── forbidden score fields ──────────────────────────────────────────────────────────────────────
  const offenders = findProhibitedScoreFields(task);
  if (offenders.length) error("prohibited_score_field", `Task IR contains prohibited score field(s): ${offenders.join(", ")}`);

  // ── structural minimum ──────────────────────────────────────────────────────────────────────────
  if (!task.goal.trim()) error("empty_goal", "Compiled task has an empty goal.");
  if (task.version !== 1) warn("ir_version", `Task IR version ${task.version} is not the current version.`);
  if (!task.taskId.trim()) error("missing_task_id", "Compiled task has no taskId.");

  // ── contradictions ──────────────────────────────────────────────────────────────────────────────
  // A `must` and a `must_not` with identical text is a contract that cannot be satisfied. Detected on
  // normalized text so trivial punctuation differences do not hide it.
  const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const musts = new Map(task.requirements.filter((r) => r.strength === "must").map((r) => [normalize(r.text), r]));
  for (const requirement of task.requirements) {
    if (requirement.strength !== "must_not") continue;
    const conflict = musts.get(normalize(requirement.text));
    if (conflict) error("contradictory_requirements", `Requirement ${conflict.id} requires and ${requirement.id} forbids the same thing: "${requirement.text}"`);
  }

  // ── duplicates ──────────────────────────────────────────────────────────────────────────────────
  const seenRequirements = new Set<string>();
  for (const requirement of task.requirements) {
    const key = `${requirement.strength}:${normalize(requirement.text)}`;
    if (seenRequirements.has(key)) warn("duplicate_requirement", `Duplicate requirement dropped at render time: "${requirement.text}"`);
    seenRequirements.add(key);
  }
  const deliverableKeys = new Set<string>();
  for (const deliverable of task.deliverables) {
    const key = `${deliverable.kind}:${deliverable.target.toLowerCase()}`;
    if (deliverableKeys.has(key)) warn("duplicate_deliverable", `Duplicate deliverable: ${deliverable.target}`);
    deliverableKeys.add(key);
  }

  // ── evidence references must resolve ────────────────────────────────────────────────────────────
  // A dangling reference is how "grounded in the repository" becomes a claim nobody can check.
  const evidenceIds = new Set(task.repositoryEvidence.map((ref) => ref.id));
  const checkRefs = (refs: string[] | undefined, owner: string): void => {
    for (const ref of refs ?? []) if (!evidenceIds.has(ref)) error("dangling_evidence_ref", `${owner} references unknown evidence ${ref}.`);
  };
  for (const requirement of task.requirements) checkRefs(requirement.evidenceRefs, `Requirement ${requirement.id}`);
  for (const assumption of task.assumptions) checkRefs(assumption.evidenceRefs, `Assumption ${assumption.id}`);
  for (const surface of task.affectedSurfaces) checkRefs(surface.evidenceRefs, `Surface ${surface.id}`);
  for (const constraint of task.constraints) checkRefs(constraint.evidenceRefs, `Constraint ${constraint.id}`);
  for (const ambiguity of task.ambiguities) {
    if (ambiguity.resolution.type === "repository_evidence" || ambiguity.resolution.type === "project_convention") {
      checkRefs(ambiguity.resolution.evidenceRefs, `Ambiguity ${ambiguity.id}`);
    }
  }

  // ── inference must not masquerade as user intent ────────────────────────────────────────────────
  // The single most damaging failure mode: a detail the compiler invented, rendered to the main model
  // as something the user demanded. A `must` may only come from the user, the repository, or policy.
  for (const requirement of task.requirements) {
    if (requirement.strength === "must" && requirement.source === "model_inference") {
      error("inferred_requirement_as_mandatory", `Requirement ${requirement.id} is model-inferred but marked "must": "${requirement.text}"`);
    }
    if (requirement.source === "repository" && !(requirement.evidenceRefs ?? []).length) {
      error("unsupported_repository_requirement", `Requirement ${requirement.id} claims repository provenance but cites no evidence.`);
    }
  }

  // ── ambiguity bookkeeping ───────────────────────────────────────────────────────────────────────
  for (const ambiguity of task.ambiguities) {
    if (ambiguity.kind === "blocking" && ambiguity.resolution.type !== "ask_user" && ambiguity.resolution.type !== "explicit_user_instruction") {
      error("blocking_ambiguity_unresolved", `Ambiguity ${ambiguity.id} is blocking but was resolved as "${ambiguity.resolution.type}" without asking.`);
    }
  }
  const blocking = task.ambiguities.some((a) => a.kind === "blocking");
  if (blocking && task.compilationMode !== "clarify") {
    error("blocking_without_clarify", "A blocking ambiguity exists but the compilation mode is not \"clarify\".");
  }
  if (task.compilationMode === "clarify" && !task.executionPolicy.requiresClarification) {
    error("clarify_without_question", "Mode is \"clarify\" but the execution policy does not require clarification.");
  }

  // ── verification must be executable or honestly labelled ────────────────────────────────────────
  for (const check of [...task.verification.requiredChecks, ...task.verification.regressionChecks, ...task.verification.adversarialChecks]) {
    const hasPath = Boolean(check.command || check.assertion);
    if (!hasPath && check.provenance !== "not_automatically_verifiable" && check.provenance !== "requires_model_inspection") {
      error("unexecutable_check", `Check ${check.id} has neither a command nor an assertion but claims provenance "${check.provenance}".`);
    }
  }
  if (task.compilationMode !== "clarify" && !executableChecks(task.verification).length && task.family !== "repository_investigation") {
    warn("no_executable_verification", "No executable verification check could be derived for this task.");
  }

  // ── mutation surface ────────────────────────────────────────────────────────────────────────────
  // A `clarify` turn is exempt: it legitimately has a file deliverable AND no mutation, because it
  // asks a question instead of doing the work. Flagging that would make every clarification invalid.
  if (task.compilationMode !== "clarify" && task.executionPolicy.mutationAllowed === false && task.deliverables.some((d) => d.kind === "file")) {
    error("mutation_denied_with_file_deliverable", "The task must produce a file but mutation is not allowed.");
  }
  if (task.executionPolicy.mutationAllowed && task.family === "repository_investigation") {
    error("investigation_may_not_mutate", "A repository investigation must not be granted mutation.");
  }

  return { ok: errors.length === 0, errors, warnings };
}
