// Task Compiler — the pipeline.
//
//   raw request → literal extraction → family → repository grounding → ambiguity resolution →
//   task-contract synthesis → verification contract → validation → canonical rendering →
//   execution policy
//
// The governing rule, and the reason this layer exists at all:
//
//   Do not make the expensive model infer anything that deterministic code, repository evidence, an
//   established convention, a small sidecar model, or an explicit user instruction can settle first.
//
// Every stage is deterministic by default. The optional sidecar refines extraction and classification
// but can never be the sole authority for anything: its output is validated against the deterministic
// result and discarded when it disagrees in a way the evidence does not support. A compiler that can
// hallucinate a requirement is worse than no compiler, because the hallucination arrives wearing a
// contract's authority.

import type { WorkspaceIndex } from "../workspaceIndex.js";
import { approxTokens, idFactory, TASK_IR_VERSION,
  type Assumption, type CompilationMode, type CompiledTask, type Constraint, type Deliverable,
  type Invariant, type NonGoal, type Requirement, type TaskFamily,
} from "./ir.js";
import { extractLiterals, namesConcreteArtifact, type LiteralExtraction } from "./extract.js";
import { classifyFamily, familyTemplate } from "./family.js";
import { groundTask, type RepositoryFacts } from "./grounding.js";
import { resolveAmbiguities, unresolvedMaterialCount } from "./ambiguity.js";
import { compileVerification } from "./verification.js";
import { validateCompiledTask, type ValidationResult } from "./validate.js";
import { renderContractBlock, renderClarification, type ContractSlice } from "./render.js";

/** `off` preserves existing behavior exactly. `auto` selects the mode categorically. `force` compiles
 *  except where doing so would violate an explicit task requirement (it never downgrades to
 *  passthrough, and it never overrides a blocking ambiguity). */
export type TaskCompilerFlag = "off" | "auto" | "force";

export function isTaskCompilerFlag(value: string): value is TaskCompilerFlag {
  return value === "off" || value === "auto" || value === "force";
}

export interface CompileInput {
  taskId: string;
  request: string;
  cwd: string;
  /** Optional index for candidate-file ranking. Absent ⇒ deterministic grounding only. */
  index?: WorkspaceIndex;
  /** `auto` by default. */
  flag?: TaskCompilerFlag;
  /** Prior conversation context; presence means "it"/"that" can resolve, so a bare follow-up is not
   *  a blocking ambiguity. */
  hasConversationHistory?: boolean;
  /**
   * Ablation knob: compile the contract WITHOUT reading the repository. This is arm B of the
   * evaluation (structured contract, no grounding) and exists so the value of grounding can be
   * measured rather than assumed — the report is explicit that a compiler which helps vague feature
   * prompts may hurt precise bug reports. Production always leaves this on.
   */
  groundingEnabled?: boolean;
}

/** Stage-level observability. Facts, never an aggregate quality number. */
export interface CompilerTelemetry {
  stageMs: Record<string, number>;
  totalMs: number;
  sidecarCalls: number;
  repositoryQueries: number;
  rawRequestTokens: number;
  renderedContractTokens: number;
  mode: CompilationMode;
  family: TaskFamily;
  clarificationRequested: boolean;
  assumptionCount: number;
  requirementCount: number;
  evidenceCount: number;
  ambiguityCounts: Record<string, number>;
}

export interface CompileResult {
  task: CompiledTask;
  /** The block to inject into the model-facing context. Empty for `passthrough` and `clarify`. */
  contractBlock: string;
  /** The single question, when the mode is `clarify`. */
  clarification: string | null;
  validation: ValidationResult;
  telemetry: CompilerTelemetry;
  /** Full provenance for debugging and evaluation — persisted, never sent to the model. */
  trace: CompilerTrace;
}

export interface CompilerTrace {
  version: number;
  taskId: string;
  literals: LiteralExtraction;
  facts: RepositoryFacts;
  familyReason: string;
  validation: ValidationResult;
  telemetry: CompilerTelemetry;
}

/** The "we did not look" facts for the ungrounded evaluation arm. Every field is honestly empty —
 *  an ungrounded compile must not report a stack it never read. */
function ungroundedFacts(root: string): RepositoryFacts {
  return {
    root, manifests: [], stack: null, dependencies: [],
    testCommand: null, typecheckCommand: null, buildCommand: null, lintCommand: null,
    sourceDirs: [], testDirs: [], existingNamedFiles: [], missingNamedFiles: [], empty: false,
  };
}

/** Synthesize the requirement set. Provenance is assigned here and never upgraded later: a sentence
 *  the user wrote is `user`; a fact read from the repository is `repository` and cites its evidence. */
function synthesizeRequirements(
  literals: LiteralExtraction,
  facts: RepositoryFacts,
  evidenceIds: { manifest: string[]; convention: string[]; existing: Map<string, string[]>; dependency: string | null },
): { requirements: Requirement[]; constraints: Constraint[]; nonGoals: NonGoal[]; invariants: Invariant[] } {
  const nextRequirementId = idFactory("rq");
  const nextConstraintId = idFactory("cn");
  const nextNonGoalId = idFactory("ng");
  const nextInvariantId = idFactory("iv");
  const requirements: Requirement[] = [];
  const constraints: Constraint[] = [];
  const nonGoals: NonGoal[] = [];
  const invariants: Invariant[] = [];

  // The user's own obligations are the contract's spine. Normalized wording only — never reinterpreted.
  for (const text of literals.explicitConstraints) {
    requirements.push({ id: nextRequirementId(), text, strength: "must", source: "user" });
  }
  // A bulleted spec is an obligation list, and it is how most people actually write one. These are
  // the user's own words, copied — the same standard the obligation sentences above are held to.
  for (const text of literals.specBullets) {
    if (requirements.some((r) => r.text === text)) continue;
    requirements.push({ id: nextRequirementId(), text, strength: "must", source: "user" });
  }
  // A stated outcome with no explicit obligation sentence is still a `must`: the user asked for it.
  if (!requirements.length && literals.statedOutcome) {
    requirements.push({ id: nextRequirementId(), text: literals.statedOutcome, strength: "must", source: "user" });
  }
  for (const text of literals.prohibitions) {
    requirements.push({ id: nextRequirementId(), text, strength: "must_not", source: "user" });
    nonGoals.push({ id: nextNonGoalId(), text });
  }
  // Compatibility demands are invariants: they describe what must survive, not what to build.
  for (const text of literals.compatibility) {
    invariants.push({ id: nextInvariantId(), text });
  }
  for (const text of literals.contract.outputFormat) {
    requirements.push({ id: nextRequirementId(), text: `Output format: ${text}`, strength: "must", source: "user" });
  }
  for (const text of literals.contract.environment) {
    constraints.push({ id: nextConstraintId(), text: `Environment: ${text}`, source: "user" });
  }
  for (const text of literals.contract.performance) {
    constraints.push({ id: nextConstraintId(), text: `Performance: ${text}`, source: "user" });
  }
  for (const technology of literals.requestedTechnologies) {
    requirements.push({ id: nextRequirementId(), text: `Use ${technology}.`, strength: "must", source: "user" });
  }

  // Repository-derived requirements. Each cites evidence — the validator rejects one that does not,
  // which is what stops "the repo says so" from becoming an unfalsifiable claim.
  if (facts.dependencies.length && evidenceIds.dependency) {
    // FRAMING MATTERS, and this line was observed getting it wrong on a live run: phrased as "reuse
    // the existing zod setup", a 35B read it as an instruction to USE zod and injected schema
    // validation into a task that asked only for a string transform. The requirement is a constraint
    // on ADDING dependencies, not an invitation to adopt one — so it is written as a prohibition,
    // and the dependency list stays a plain fact rather than a suggestion.
    requirements.push({
      id: nextRequirementId(),
      text: `Do not add a new dependency for functionality the project already has available (${facts.dependencies.slice(0, 3).join(", ")}). Use an existing one only if this task actually needs it.`,
      strength: "should",
      source: "repository",
      evidenceRefs: [evidenceIds.dependency],
    });
  }
  for (const [path, refs] of evidenceIds.existing) {
    requirements.push({
      id: nextRequirementId(),
      text: `Modify the existing ${path} instead of creating a parallel file.`,
      strength: "must",
      source: "repository",
      evidenceRefs: refs,
    });
  }

  return { requirements, constraints, nonGoals, invariants };
}

function synthesizeDeliverables(literals: LiteralExtraction, family: TaskFamily): Deliverable[] {
  const nextId = idFactory("dl");
  const deliverables: Deliverable[] = [];
  const seen = new Set<string>();
  const add = (kind: Deliverable["kind"], target: string): void => {
    const key = `${kind}:${target.toLowerCase()}`;
    if (!target.trim() || seen.has(key)) return;
    seen.add(key);
    deliverables.push({ id: nextId(), kind, target, source: "user" });
  };
  for (const path of literals.contract.outputPaths) add("file", path);
  for (const path of literals.contract.files) if (!literals.contract.outputPaths.includes(path)) add("file", path);
  for (const symbol of literals.contract.symbols) add("symbol", symbol);
  for (const endpoint of literals.contract.endpoints) add("endpoint", endpoint);
  for (const command of literals.contract.commands) add("command", command);
  if (!deliverables.length) {
    // No literal artifact: the deliverable is the described outcome itself. It is `behavior`, NOT
    // `file` — there is no path to assert, and pretending otherwise manufactures an unrunnable check.
    add(family === "repository_investigation" ? "answer" : family === "new_application" ? "application" : "behavior",
      literals.statedOutcome.slice(0, 120));
  }
  return deliverables.slice(0, 10);
}

/**
 * Categorical mode selection. No numeric quality score anywhere — the mode falls out of explicit
 * missing-field checks, in a fixed order, so the same request always compiles the same way.
 */
function selectMode(
  literals: LiteralExtraction,
  family: TaskFamily,
  hasBlocking: boolean,
  materialCount: number,
  flag: TaskCompilerFlag,
  hasHistory: boolean,
): { mode: CompilationMode; reason: string } {
  if (hasBlocking) return { mode: "clarify", reason: "a blocking ambiguity survived repository evidence and safe defaults" };
  if (!literals.rawRequest.trim()) return { mode: "clarify", reason: "the request is empty" };

  const hasDeliverable = namesConcreteArtifact(literals) || literals.statedOutcome.split(/\s+/).length >= 4;
  const hasScope = namesConcreteArtifact(literals) || family === "repository_investigation" || hasHistory;
  const hasVerification = literals.requestedVerification.length > 0;
  const hasConstraints = literals.explicitConstraints.length > 0 || literals.prohibitions.length > 0;

  // Already an engineering contract: precise, scoped, constrained, and it says how to check the work.
  // Rewriting this would add tokens and remove nothing. `force` still declines to pass it through.
  if (hasDeliverable && hasScope && hasVerification && hasConstraints && !materialCount) {
    return flag === "force"
      ? { mode: "enrich", reason: "already precise, but the compiler is forced — grounding only, no rewrite" }
      : { mode: "passthrough", reason: "request already specifies deliverable, scope, constraints and verification" };
  }
  // Several product-level decisions are still open — a structured contract removes real burden.
  if (materialCount >= 1 || !hasDeliverable || (!hasConstraints && !hasScope)) {
    return { mode: "compile", reason: materialCount ? `${materialCount} material decision(s) unresolved` : "deliverable or scope is underspecified" };
  }
  return { mode: "enrich", reason: hasVerification ? "clear request needing repository grounding" : "clear request with no stated verification" };
}

/** Compile a request into an execution contract. Pure with respect to the model: the only I/O is
 *  bounded, deterministic repository reads. */
export function compileTask(input: CompileInput): CompileResult {
  const started = Date.now();
  const stageMs: Record<string, number> = {};
  const stage = <T>(name: string, fn: () => T): T => {
    const at = Date.now();
    const value = fn();
    stageMs[name] = Date.now() - at;
    return value;
  };

  const flag: TaskCompilerFlag = input.flag ?? "auto";
  const literals = stage("extract", () => extractLiterals(input.request));
  const familyDecision = stage("classify", () => classifyFamily(input.request, literals, input.cwd));
  const family = familyDecision.family;
  const grounding = stage("ground", () => input.groundingEnabled === false
    // Ungrounded arm: no repository reads at all, so `queries` is honestly 0 rather than reporting
    // work that did not happen.
    ? { facts: ungroundedFacts(input.cwd), evidence: [], affectedSurfaces: [], dependencyEvidenceId: null, queries: 0 }
    : groundTask(input.cwd, literals, family, input.index));
  const ambiguity = stage("ambiguity", () =>
    resolveAmbiguities(literals, family, grounding.facts, grounding.evidence, Boolean(input.hasConversationHistory)));

  const template = familyTemplate(family);
  const evidenceIds = {
    manifest: grounding.evidence.filter((e) => e.kind === "manifest").map((e) => e.id),
    convention: grounding.evidence.filter((e) => e.kind === "convention").map((e) => e.id),
    existing: new Map(
      grounding.evidence.filter((e) => e.kind === "file" && e.path).map((e) => [e.path as string, [e.id]]),
    ),
    dependency: grounding.dependencyEvidenceId,
  };

  const synthesized = stage("synthesize", () => synthesizeRequirements(literals, grounding.facts, evidenceIds));
  const deliverables = stage("deliverables", () => synthesizeDeliverables(literals, family));
  const hasBlocking = ambiguity.ambiguities.some((a) => a.kind === "blocking");
  const materialCount = unresolvedMaterialCount(ambiguity.ambiguities);
  const { mode, reason } = stage("mode", () =>
    selectMode(literals, family, hasBlocking, materialCount, flag, Boolean(input.hasConversationHistory)));

  const verification = stage("verify", () => compileVerification({
    family, facts: grounding.facts, literals, deliverables, requirements: synthesized.requirements,
  }));

  const assumptions: Assumption[] = ambiguity.assumptions;
  const mutationAllowed = template.mutates && mode !== "clarify";

  const task: CompiledTask = {
    version: TASK_IR_VERSION,
    taskId: input.taskId,
    family,
    rawRequest: literals.rawRequest,
    goal: literals.statedOutcome || literals.rawRequest.slice(0, 240),
    deliverables,
    requirements: synthesized.requirements,
    constraints: synthesized.constraints,
    nonGoals: synthesized.nonGoals,
    invariants: synthesized.invariants,
    assumptions,
    repositoryEvidence: grounding.evidence,
    affectedSurfaces: grounding.affectedSurfaces,
    ambiguities: ambiguity.ambiguities,
    contextPolicy: {
      includeRepoCapsule: mode !== "passthrough",
      maxContractTokens: template.contractTokens,
      maxEvidenceLines: family === "repository_investigation" ? 4 : 8,
    },
    executionPolicy: {
      mutationAllowed,
      laneHint: mode === "clarify" ? "answer" : family === "repository_investigation" ? "answer" : null,
      laneReason: mode === "clarify"
        ? "task compiler: blocking ambiguity — asking one question instead of guessing"
        : family === "repository_investigation"
          ? "task compiler: investigation produces an answer, not a change"
          : "task compiler: no lane override",
      requiresClarification: mode === "clarify",
    },
    verification,
    compilationMode: mode,
  };

  const validation = stage("validate", () => validateCompiledTask(task));
  // `passthrough` deliberately renders nothing: the request was already a contract, and injecting a
  // restatement of it would be the prompt inflation this layer exists to prevent.
  const contractBlock = stage("render", () => (mode === "passthrough" || mode === "clarify" ? "" : renderContractBlock(task)));

  const telemetry: CompilerTelemetry = {
    stageMs,
    totalMs: Date.now() - started,
    sidecarCalls: 0,
    repositoryQueries: grounding.queries,
    rawRequestTokens: approxTokens(literals.rawRequest),
    renderedContractTokens: approxTokens(contractBlock),
    mode,
    family,
    clarificationRequested: mode === "clarify",
    assumptionCount: assumptions.length,
    requirementCount: task.requirements.length,
    evidenceCount: task.repositoryEvidence.length,
    ambiguityCounts: {
      blocking: task.ambiguities.filter((a) => a.kind === "blocking").length,
      material: task.ambiguities.filter((a) => a.kind === "material").length,
      reversible: task.ambiguities.filter((a) => a.kind === "reversible").length,
      irrelevant: task.ambiguities.filter((a) => a.kind === "irrelevant").length,
    },
  };

  return {
    task,
    contractBlock,
    clarification: mode === "clarify" ? renderClarification(task) : null,
    validation,
    telemetry,
    trace: {
      version: TASK_IR_VERSION,
      taskId: input.taskId,
      literals,
      facts: grounding.facts,
      familyReason: `${familyDecision.reason}; mode: ${reason}`,
      validation,
      telemetry,
    },
  };
}

/** Render a bounded slice of an already-compiled task for a typed subagent. */
export function sliceContract(task: CompiledTask, slice: ContractSlice): string {
  return renderContractBlock(task, slice);
}
