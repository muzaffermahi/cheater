// Kitten Task Compiler — the typed intermediate representation. NO Pi.
//
// The compiler treats the user's request as a SOURCE LANGUAGE and this IR as the compiled form: a
// minimal, repository-grounded, verifiable execution contract. Everything downstream (prompt
// rendering, lane policy, the verifier, the persisted trace) is a lowering of this one structure, so
// there is exactly one representation of "what was asked" and it can be reconstructed after a restart.
//
// TWO RULES ARE STRUCTURAL, NOT STYLISTIC:
//
// 1. NO CONFIDENCE OR SCORE FIELDS. Not on requirements, not on ambiguities, not anywhere. A model
//    emitting 0.87 is not calibrated; it is decoration that invites downstream code to threshold on
//    noise. Trust comes from `source` + `evidenceRefs` — both inspectable — never from a number.
//    validate.ts enforces this by scanning the serialized IR, so a future field cannot smuggle one in.
//
// 2. EVERY MATERIAL REQUIREMENT CARRIES ITS PROVENANCE. `source` says where it came from; a
//    requirement sourced "model_inference" is explicitly NOT the same thing as one the user stated,
//    and the validator refuses to let inference masquerade as explicit user intent.

import { canonicalJson, canonicalHash } from "../promptEpoch.js";

/** Bump only on an incompatible IR shape change; persisted traces record the version they were written at. */
export const TASK_IR_VERSION = 1;

export const TASK_FAMILIES = [
  "bug_fix",
  "feature_implementation",
  "refactor",
  "repository_investigation",
  "test_creation",
  "configuration_change",
  "new_application",
  "performance_optimization",
  "documentation",
  "migration",
] as const;

export type TaskFamily = (typeof TASK_FAMILIES)[number];

export function isTaskFamily(value: string): value is TaskFamily {
  return (TASK_FAMILIES as readonly string[]).includes(value);
}

/**
 * How binding a requirement is. RFC-2119 shaped on purpose: the distinction between "must" and
 * "should" is the difference between a contract term and a preference, and collapsing them is how a
 * six-word request turns into a mandatory feature list.
 */
export type RequirementStrength = "must" | "should" | "may" | "must_not";

/**
 * Where a requirement came from. This is the trust signal — a categorical, inspectable one.
 * `model_inference` is deliberately last and deliberately weak: inference may inform, it may not
 * silently become a product requirement (validate.ts enforces that).
 */
export type RequirementSource =
  | "user"
  | "repository"
  | "session_memory"
  | "project_policy"
  | "default"
  | "model_inference";

export interface Requirement {
  id: string;
  text: string;
  strength: RequirementStrength;
  source: RequirementSource;
  /** Ids of RepositoryEvidenceRef entries that justify this requirement. */
  evidenceRefs?: string[];
}

/**
 * `behavior` is the deliverable when the request names NO literal artifact — the thing to produce is
 * the described outcome itself. It is deliberately distinct from `file`: a described outcome has no
 * path, so asserting `file_exists:<a whole sentence>` would be a check that can never run while
 * reading like one that does.
 */
export type DeliverableKind = "file" | "symbol" | "command" | "endpoint" | "answer" | "application" | "behavior";

export interface Deliverable {
  id: string;
  kind: DeliverableKind;
  /** The literal artifact: a path, a symbol name, a command, a route, or a short noun for an answer. */
  target: string;
  source: RequirementSource;
  evidenceRefs?: string[];
}

/** A restriction on HOW the work may be done (environment, performance, compatibility). */
export interface Constraint {
  id: string;
  text: string;
  source: RequirementSource;
  evidenceRefs?: string[];
}

/** Something explicitly out of scope. Included only when it prevents a LIKELY scope expansion. */
export interface NonGoal {
  id: string;
  text: string;
}

/** Behavior that must survive the change. The single most valuable field for a refactor. */
export interface Invariant {
  id: string;
  text: string;
  evidenceRefs?: string[];
}

export type AssumptionBasis =
  | "repository_convention"
  | "project_default"
  | "reversible_choice"
  | "main_model_decision";

export interface Assumption {
  id: string;
  text: string;
  basis: AssumptionBasis;
  /** Can this be changed later without rework? Reversible assumptions never interrupt the user. */
  reversible: boolean;
  evidenceRefs?: string[];
}

export type EvidenceKind =
  | "manifest"
  | "file"
  | "symbol"
  | "test"
  | "convention"
  | "command"
  | "index"
  | "absence";

/**
 * One inspectable repository fact. `detail` is what the fact SAYS; `path` is where it was observed.
 * Evidence exists to change an implementation decision — grounding.ts refuses to record anything that
 * would only pad the prompt.
 */
export interface RepositoryEvidenceRef {
  id: string;
  kind: EvidenceKind;
  detail: string;
  /** Repository-relative, `/`-separated. Absent for facts that are not about one file. */
  path?: string;
}

export interface AffectedSurface {
  id: string;
  path: string;
  reason: string;
  evidenceRefs?: string[];
}

/**
 * Ambiguity is CATEGORICAL, never numeric.
 *   blocking   — changes the deliverable itself, or cannot be resolved safely. May interrupt the user.
 *   material   — could cause substantial rework; try repository evidence/convention before asking.
 *   reversible — pick a sane default, record it as an assumption, do not bother the user.
 *   irrelevant — does not need resolving before implementation. Never rendered.
 */
export type AmbiguityKind = "blocking" | "material" | "reversible" | "irrelevant";

export type AmbiguityResolution =
  | { type: "explicit_user_instruction"; value: string }
  | { type: "repository_evidence"; evidenceRefs: string[]; value: string }
  | { type: "project_convention"; evidenceRefs: string[]; value: string }
  | { type: "safe_default"; value: string; rationale: string }
  | { type: "ask_user"; question: string }
  | { type: "defer_to_main_model"; reason: string };

export interface TaskAmbiguity {
  id: string;
  description: string;
  kind: AmbiguityKind;
  resolution: AmbiguityResolution;
}

/** The resolution priority the compiler applies, highest authority first. Exported so the ordering is
 *  a single inspectable fact rather than an implicit chain of `if`s spread across the pipeline. */
export const RESOLUTION_PRIORITY: ReadonlyArray<AmbiguityResolution["type"]> = [
  "explicit_user_instruction",
  "repository_evidence",
  "project_convention",
  "safe_default",
  "defer_to_main_model",
  "ask_user",
];

export interface ContextPolicy {
  /** Include the durable repository capsule in the main prompt. */
  includeRepoCapsule: boolean;
  /** Soft ceiling for the rendered contract; render.ts trims lowest-value material to fit. */
  maxContractTokens: number;
  /** Cap on rendered repository facts (the full set stays in the trace). */
  maxEvidenceLines: number;
}

export interface ExecutionPolicy {
  /** May this task write to the workspace at all? An investigation may not. */
  mutationAllowed: boolean;
  /** Lane hint for the router. `null` leaves the existing deterministic routing untouched. */
  laneHint: "answer" | "direct" | "reliable" | "bon" | "ascent" | null;
  /** Why the hint was chosen — recorded in route.selected reasons. */
  laneReason: string;
  /** The compiler asks exactly one question, or none. */
  requiresClarification: boolean;
}

export type VerificationCheckKind =
  | "command"
  | "unit_test"
  | "integration_test"
  | "typecheck"
  | "lint"
  | "build"
  | "file_assertion"
  | "runtime_behavior"
  | "patch_scope"
  | "invariant"
  | "manual";

/**
 * Where a check comes from, and — crucially — whether anything can actually RUN it.
 * A check that maps to no command and no assertion is marked `not_automatically_verifiable` and is
 * never allowed to read like passing evidence. Ceremonial acceptance criteria are the thing this
 * field exists to make impossible.
 */
export type VerificationProvenance =
  | "provided_by_repository"
  | "added_by_kitten"
  | "requires_model_inspection"
  | "not_automatically_verifiable";

export interface VerificationCheck {
  id: string;
  kind: VerificationCheckKind;
  /** What this check proves, in one line. */
  claim: string;
  /** The exact command, when executable. */
  command?: string;
  /** A deterministic assertion (e.g. `file_exists:src/app.ts`) when there is no command. */
  assertion?: string;
  provenance: VerificationProvenance;
  /** Which requirement/deliverable ids this check proves. */
  proves: string[];
}

export interface EvidenceRequirement {
  id: string;
  /** What must exist in the receipt before completion is credible. */
  description: string;
}

export interface CompletionRule {
  /** Every required check must pass before the run may claim completion. */
  requireAllRequiredChecks: boolean;
  /** Completion additionally needs at least one executed check (not just assertions). */
  requireExecutionEvidence: boolean;
  text: string;
}

export interface VerificationContract {
  requiredChecks: VerificationCheck[];
  regressionChecks: VerificationCheck[];
  adversarialChecks: VerificationCheck[];
  requiredEvidence: EvidenceRequirement[];
  completionRule: CompletionRule;
}

/**
 * `passthrough` — the request is already precise, scoped and verifiable; attach metadata, rewrite nothing.
 * `enrich`      — mostly clear; add repository grounding, invariants, or the missing verification.
 * `compile`     — vague enough that a structured contract removes real decision burden from the main model.
 * `clarify`     — blocking ambiguity survived repository evidence and safe defaults; ask ONE question.
 */
export type CompilationMode = "passthrough" | "enrich" | "compile" | "clarify";

export interface CompiledTask {
  version: number;
  taskId: string;
  family: TaskFamily;

  /** The user's message, preserved verbatim for traceability. Never both this and `goal` are rendered. */
  rawRequest: string;
  /** The normalized one-line objective. */
  goal: string;

  deliverables: Deliverable[];
  requirements: Requirement[];
  constraints: Constraint[];
  nonGoals: NonGoal[];
  invariants: Invariant[];
  assumptions: Assumption[];

  repositoryEvidence: RepositoryEvidenceRef[];
  affectedSurfaces: AffectedSurface[];

  ambiguities: TaskAmbiguity[];

  contextPolicy: ContextPolicy;
  executionPolicy: ExecutionPolicy;
  verification: VerificationContract;

  compilationMode: CompilationMode;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Stable id generator: `prefix-NN`, so the IR serializes identically for identical input. Never
 *  time- or random-based — the trace must be reproducible and the bytes cache-friendly. */
export function idFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(++n).toString().padStart(2, "0")}`;
}

/** Canonical bytes of a compiled task — the identity used for trace keys and cache reasoning. */
export function compiledTaskHash(task: CompiledTask): string {
  return canonicalHash(task);
}

export function serializeCompiledTask(task: CompiledTask): string {
  return canonicalJson(task);
}

export function deserializeCompiledTask(raw: string): CompiledTask | null {
  try {
    const parsed = JSON.parse(raw) as CompiledTask;
    return parsed && typeof parsed === "object" && typeof parsed.goal === "string" && isTaskFamily(String(parsed.family)) ? parsed : null;
  } catch {
    return null;
  }
}

/** Rough token estimate (chars/4) — the same approximation the ContextBuilder budgets with. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Requirements that bind, in canonical rendering order. */
export function bindingRequirements(task: CompiledTask): Requirement[] {
  return task.requirements.filter((r) => r.strength === "must" || r.strength === "must_not");
}
