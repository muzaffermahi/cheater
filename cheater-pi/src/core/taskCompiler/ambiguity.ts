// Task Compiler — Stage 4: ambiguity detection and resolution.
//
// Every request is ambiguous somewhere. The question is never "is this ambiguous" but "does this
// ambiguity deserve the user's attention". Asking about a reversible choice is a worse failure than
// picking wrong: the user came here to have work done, and a agent that asks which shade of blue is
// an agent that has not started.
//
// So ambiguity is CATEGORICAL and resolution follows one fixed priority (ir.ts RESOLUTION_PRIORITY):
//   explicit user instruction → repository evidence → project convention → safe default →
//   main-model judgment → ask the user.
// Only a `blocking` ambiguity that survives all of that is allowed to interrupt. Everything the
// compiler decides for itself is recorded as an inspectable Assumption, so a wrong default is visible
// and correctable rather than silent.

import { idFactory, type Assumption, type RepositoryEvidenceRef, type TaskAmbiguity, type TaskFamily } from "./ir.js";
import type { LiteralExtraction } from "./extract.js";
import type { RepositoryFacts } from "./grounding.js";
import { namesConcreteArtifact } from "./extract.js";

export interface AmbiguityResult {
  ambiguities: TaskAmbiguity[];
  assumptions: Assumption[];
  /** The single question to ask, when a blocking ambiguity survived resolution. */
  blockingQuestion: string | null;
}

/** Normalize a requirement clause so a `must` and a `must_not` about the same predicate can be
 *  compared. Deliberately crude: it catches literal self-contradiction, not semantic tension. */
function predicate(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(?:do not|don'?t|must not|never|avoid|no|not)\b/g, " ")
    .replace(/\b(?:the|a|an|any|new|also|please|should|must|need to|needs to|have to|ensure|make sure)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Do two clauses talk about the same thing? Shared content words, not string equality — "add a POST
 *  /users endpoint" vs "do not add new endpoints" share `add endpoint`. */
function overlaps(a: string, b: string): boolean {
  const wordsA = new Set(predicate(a).split(" ").filter((w) => w.length > 2));
  const wordsB = predicate(b).split(" ").filter((w) => w.length > 2);
  if (!wordsA.size || !wordsB.length) return false;
  const shared = wordsB.filter((w) => wordsA.has(w)).length;
  return shared >= 2 && shared / Math.min(wordsA.size, wordsB.length) >= 0.5;
}

const UNBOUNDED_SCOPE_RE = /\b(?:every(?:thing|where)?|all (?:the )?files|the whole (?:repo|repository|codebase|project)|across the (?:repo|codebase))\b/i;

export function resolveAmbiguities(
  literals: LiteralExtraction,
  family: TaskFamily,
  facts: RepositoryFacts,
  evidence: RepositoryEvidenceRef[],
  /** Were there ACTUAL earlier turns? A bare "fix it" is unanswerable on a fresh conversation and
   *  perfectly clear as a follow-up — the difference decides whether the user gets interrupted. */
  hasConversationHistory = false,
): AmbiguityResult {
  const nextAmbiguityId = idFactory("am");
  const nextAssumptionId = idFactory("as");
  const ambiguities: TaskAmbiguity[] = [];
  const assumptions: Assumption[] = [];
  const evidenceIdsFor = (predicateFn: (ref: RepositoryEvidenceRef) => boolean): string[] =>
    evidence.filter(predicateFn).map((ref) => ref.id);

  // ── blocking: the request contradicts itself ────────────────────────────────────────────────────
  // A contradiction cannot be resolved by evidence or by a default — either reading produces work the
  // user did not ask for. This is the one class of ambiguity that genuinely must interrupt.
  for (const obligation of literals.explicitConstraints) {
    for (const prohibition of literals.prohibitions) {
      if (!overlaps(obligation, prohibition)) continue;
      ambiguities.push({
        id: nextAmbiguityId(),
        description: `The request both requires and forbids the same change: "${obligation.slice(0, 120)}" vs "${prohibition.slice(0, 120)}".`,
        kind: "blocking",
        resolution: {
          type: "ask_user",
          question: `Your request appears to contain a contradiction: it asks to "${obligation.slice(0, 100)}" but also says "${prohibition.slice(0, 100)}". Which one should I follow?`,
        },
      });
      break;
    }
    if (ambiguities.some((a) => a.kind === "blocking")) break;
  }

  // ── blocking: no deliverable at all ─────────────────────────────────────────────────────────────
  // "Fix it" with no prior context and no named artifact is not a task. But an investigation's
  // deliverable is the ANSWER, and a from-scratch build's deliverable is the described application —
  // neither needs a named file, so neither is blocked here.
  // Prior turns give "it"/"that" a referent, so a follow-up is never blocked on this — the
  // ContextBuilder has already put the earlier turns in front of the model.
  const needsArtifact = family !== "repository_investigation" && family !== "new_application" && !hasConversationHistory;
  const hasOutcome = literals.statedOutcome.split(/\s+/).length >= 3;
  if (needsArtifact && !namesConcreteArtifact(literals) && !hasOutcome && !facts.existingNamedFiles.length) {
    ambiguities.push({
      id: nextAmbiguityId(),
      description: "The request names no artifact and describes no outcome, so the deliverable cannot be determined.",
      kind: "blocking",
      resolution: { type: "ask_user", question: "What should I change, and what should be true when it works?" },
    });
  }

  // ── material: the request names a file that is not there ────────────────────────────────────────
  // Resolved by evidence when the index found a plausible target; otherwise deferred to the main
  // model rather than asked — a wrong file choice is cheap to correct, and stopping to ask would
  // interrupt on something the model can usually settle by reading.
  if (facts.missingNamedFiles.length && family !== "new_application" && family !== "test_creation") {
    for (const missing of facts.missingNamedFiles.slice(0, 2)) {
      const indexRefs = evidenceIdsFor((ref) => ref.kind === "index");
      ambiguities.push({
        id: nextAmbiguityId(),
        description: `The request names ${missing}, which does not exist in this repository.`,
        kind: "material",
        resolution: indexRefs.length
          ? { type: "repository_evidence", evidenceRefs: indexRefs, value: "use the ranked candidate files instead of the named path" }
          : { type: "defer_to_main_model", reason: "locate the real path by reading the repository before editing" },
      });
    }
  }

  // ── material: unbounded scope ───────────────────────────────────────────────────────────────────
  if (UNBOUNDED_SCOPE_RE.test(literals.rawRequest) && family !== "repository_investigation") {
    ambiguities.push({
      id: nextAmbiguityId(),
      description: "The request describes repository-wide scope without naming a boundary.",
      kind: "material",
      resolution: {
        type: "safe_default",
        value: "apply the change only to the surfaces the request names or the evidence identifies",
        rationale: "a repository-wide sweep cannot be verified in one run, and an unverified sweep is worse than a bounded one",
      },
    });
    assumptions.push({
      id: nextAssumptionId(),
      text: "Scope is limited to the identified surfaces; a repository-wide sweep is not attempted in this run.",
      basis: "reversible_choice",
      reversible: true,
    });
  }

  // ── reversible: which stack to use ──────────────────────────────────────────────────────────────
  // Resolved by explicit instruction, then by what the repository already is. Only an empty workspace
  // with no stated technology reaches a default, and that default is recorded, not hidden.
  const buildsCode = family === "new_application" || family === "feature_implementation" || family === "test_creation";
  if (buildsCode && !literals.requestedTechnologies.length) {
    if (facts.stack || facts.dependencies.length) {
      const refs = evidenceIdsFor((ref) => ref.kind === "manifest");
      ambiguities.push({
        id: nextAmbiguityId(),
        description: "The request does not state which technology to use.",
        kind: "reversible",
        resolution: { type: "repository_evidence", evidenceRefs: refs, value: facts.stack ?? facts.dependencies.join(", ") },
      });
      assumptions.push({
        id: nextAssumptionId(),
        text: `Use the repository's existing ${facts.stack ?? facts.dependencies.join("/")} stack rather than introducing another.`,
        basis: "repository_convention",
        reversible: true,
        ...(refs.length ? { evidenceRefs: refs } : {}),
      });
    } else if (family === "new_application") {
      ambiguities.push({
        id: nextAmbiguityId(),
        description: "The workspace establishes no stack and the request names none.",
        kind: "reversible",
        resolution: {
          type: "safe_default",
          value: "a single self-contained implementation with no build step",
          rationale: "an empty workspace has no convention to honour, and a no-build implementation is the cheapest thing to run and verify",
        },
      });
      assumptions.push({
        id: nextAssumptionId(),
        text: "Build a self-contained implementation that runs without an install or build step.",
        basis: "project_default",
        reversible: true,
      });
    }
  }

  // ── reversible: where new files go ──────────────────────────────────────────────────────────────
  if (buildsCode && facts.sourceDirs.length && !literals.contract.outputPaths.length) {
    const refs = evidenceIdsFor((ref) => ref.kind === "convention");
    ambiguities.push({
      id: nextAmbiguityId(),
      description: "The request does not say where new files belong.",
      kind: "reversible",
      resolution: { type: "project_convention", evidenceRefs: refs, value: `${facts.sourceDirs[0]}/` },
    });
  }

  // ── irrelevant: verification method ─────────────────────────────────────────────────────────────
  // Never asked. The verification compiler supplies a baseline from repository evidence, so an
  // unstated verification method is not a decision the user has to make.
  if (!literals.requestedVerification.length) {
    ambiguities.push({
      id: nextAmbiguityId(),
      description: "The request does not state how the result should be verified.",
      kind: "irrelevant",
      resolution: {
        type: "safe_default",
        value: facts.testCommand ?? "targeted execution evidence",
        rationale: "the verification contract derives a baseline from repository evidence",
      },
    });
  }

  const blocking = ambiguities.find((a) => a.kind === "blocking" && a.resolution.type === "ask_user");
  return {
    ambiguities,
    assumptions,
    blockingQuestion: blocking && blocking.resolution.type === "ask_user" ? blocking.resolution.question : null,
  };
}

/** Ambiguities that still cost the main model a decision — used for categorical mode selection. */
export function unresolvedMaterialCount(ambiguities: readonly TaskAmbiguity[]): number {
  return ambiguities.filter((a) => a.kind === "material" && a.resolution.type === "defer_to_main_model").length;
}
