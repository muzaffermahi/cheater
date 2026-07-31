// Task Compiler — verification-contract synthesis.
//
// The checks are generated BEFORE the main model writes code, from the family and repository
// evidence. That ordering is the whole point: a model that knows the completion condition in advance
// writes toward it, while a model asked to justify itself afterwards writes a defense.
//
// EVERY CHECK DECLARES WHETHER ANYTHING CAN RUN IT. `provenance` is not decoration — a check with no
// command and no assertion is marked `not_automatically_verifiable`, and the completion rule refuses
// to count it as evidence. Ceremonial acceptance criteria ("ensure the code is robust") are the
// failure mode this field exists to make structurally impossible.
//
// The harness supplies the baseline; the model may add checks but may not remove the repository's own.

import {
  idFactory,
  type CompletionRule,
  type Deliverable,
  type EvidenceRequirement,
  type Requirement,
  type TaskFamily,
  type VerificationCheck,
  type VerificationContract,
} from "./ir.js";
import type { RepositoryFacts } from "./grounding.js";
import type { LiteralExtraction } from "./extract.js";

export interface VerificationInput {
  family: TaskFamily;
  facts: RepositoryFacts;
  literals: LiteralExtraction;
  deliverables: Deliverable[];
  requirements: Requirement[];
}

export function compileVerification(input: VerificationInput): VerificationContract {
  const { family, facts, literals, deliverables, requirements } = input;
  const nextCheckId = idFactory("vc");
  const nextEvidenceId = idFactory("ve");
  const required: VerificationCheck[] = [];
  const regression: VerificationCheck[] = [];
  const adversarial: VerificationCheck[] = [];

  const mustIds = requirements.filter((r) => r.strength === "must" || r.strength === "must_not").map((r) => r.id);
  const proves = (ids: string[]): string[] => (ids.length ? ids : mustIds.slice(0, 3));

  // ── the repository's own checks come first ──────────────────────────────────────────────────────
  // These exist already, cost nothing to declare, and are the strongest available evidence.
  if (facts.typecheckCommand) {
    required.push({
      id: nextCheckId(), kind: "typecheck", claim: "The project still typechecks.",
      command: facts.typecheckCommand, provenance: "provided_by_repository", proves: proves([]),
    });
  }
  if (facts.testCommand) {
    regression.push({
      id: nextCheckId(), kind: "unit_test", claim: "The existing test suite still passes.",
      command: facts.testCommand, provenance: "provided_by_repository", proves: proves([]),
    });
  }
  if (facts.buildCommand && (family === "new_application" || family === "migration")) {
    required.push({
      id: nextCheckId(), kind: "build", claim: "The project builds.",
      command: facts.buildCommand, provenance: "provided_by_repository", proves: proves([]),
    });
  }

  // ── deliverable-derived assertions ──────────────────────────────────────────────────────────────
  // A file deliverable is checkable without running anything, so it always yields a real assertion
  // rather than a sentence about diligence.
  for (const deliverable of deliverables.slice(0, 6)) {
    if (deliverable.kind === "file") {
      required.push({
        id: nextCheckId(), kind: "file_assertion", claim: `${deliverable.target} exists and contains the requested content.`,
        assertion: `file_exists:${deliverable.target}`, provenance: "added_by_kitten", proves: [deliverable.id],
      });
    } else if (deliverable.kind === "command") {
      required.push({
        id: nextCheckId(), kind: "command", claim: `\`${deliverable.target}\` exits 0.`,
        command: deliverable.target, provenance: "added_by_kitten", proves: [deliverable.id],
      });
    } else if (deliverable.kind === "endpoint") {
      required.push({
        id: nextCheckId(), kind: "runtime_behavior", claim: `${deliverable.target} responds as specified.`,
        assertion: `request:${deliverable.target}`, provenance: "added_by_kitten", proves: [deliverable.id],
      });
    } else if (deliverable.kind === "symbol") {
      required.push({
        id: nextCheckId(), kind: "file_assertion", claim: `${deliverable.target} exists with that exact name.`,
        assertion: `symbol_exists:${deliverable.target}`, provenance: "added_by_kitten", proves: [deliverable.id],
      });
    }
  }

  // Commands the user named are contract terms, not suggestions.
  for (const command of literals.contract.commands.slice(0, 3)) {
    if (required.some((check) => check.command === command)) continue;
    required.push({
      id: nextCheckId(), kind: "command", claim: `\`${command}\` exits 0.`,
      command, provenance: "added_by_kitten", proves: proves([]),
    });
  }

  // ── family-specific adversarial probe ───────────────────────────────────────────────────────────
  // One probe per family, chosen because it catches that family's characteristic false pass.
  switch (family) {
    case "bug_fix":
      adversarial.push({
        id: nextCheckId(), kind: "runtime_behavior",
        claim: "The reported failure reproduces BEFORE the change and stops reproducing after it.",
        assertion: "red_then_green", provenance: "added_by_kitten", proves: proves([]),
      });
      break;
    case "refactor":
      adversarial.push({
        id: nextCheckId(), kind: "invariant",
        claim: "The public interface is unchanged — no exported name added, removed, or re-signed.",
        assertion: "api_surface_unchanged", provenance: "added_by_kitten", proves: proves([]),
      });
      break;
    case "feature_implementation":
    case "new_application":
      adversarial.push({
        id: nextCheckId(), kind: "runtime_behavior",
        claim: "The new behavior fails cleanly on invalid input instead of appearing to succeed.",
        assertion: "invalid_input_rejected", provenance: "added_by_kitten", proves: proves([]),
      });
      break;
    case "performance_optimization":
      adversarial.push({
        id: nextCheckId(), kind: "runtime_behavior",
        claim: "Output is identical to the pre-optimization implementation on the same input.",
        assertion: "output_equivalence", provenance: "added_by_kitten", proves: proves([]),
      });
      break;
    case "test_creation":
      adversarial.push({
        id: nextCheckId(), kind: "runtime_behavior",
        claim: "Each new test fails when the behavior it covers is broken (it is not vacuous).",
        assertion: "test_is_not_vacuous", provenance: "added_by_kitten", proves: proves([]),
      });
      break;
    case "migration":
      adversarial.push({
        id: nextCheckId(), kind: "invariant",
        claim: "Data and behavior surviving the migration match the pre-migration state.",
        assertion: "migration_equivalence", provenance: "added_by_kitten", proves: proves([]),
      });
      break;
    case "repository_investigation":
      required.push({
        id: nextCheckId(), kind: "manual",
        claim: "The answer cites the exact files and lines it is drawn from.",
        provenance: "requires_model_inspection", proves: proves([]),
      });
      break;
    case "configuration_change":
    case "documentation":
      break;
  }

  // ── scope guard ─────────────────────────────────────────────────────────────────────────────────
  // Cheap, deterministic, and the thing that catches a "fix the parser" run that also rewrote the
  // build config. Requires an explicit PROHIBITION: with nothing naming a boundary, "outside the
  // identified surfaces" is vacuous, and a vacuous check is the ceremony this contract forbids.
  if (literals.prohibitions.length) {
    required.push({
      id: nextCheckId(), kind: "patch_scope",
      claim: "No file outside the identified surfaces was modified.",
      assertion: "patch_scope_respected", provenance: "added_by_kitten",
      proves: requirements.filter((r) => r.strength === "must_not").map((r) => r.id),
    });
  }

  // Performance claims are real requirements, but a threshold stated in prose has no runner here.
  // Say so, rather than emitting a check that will never be executed and will read as passing.
  for (const perf of literals.contract.performance.slice(0, 2)) {
    required.push({
      id: nextCheckId(), kind: "manual", claim: `Performance requirement: ${perf}`,
      provenance: "not_automatically_verifiable", proves: proves([]),
    });
  }

  const requiredEvidence: EvidenceRequirement[] = [];
  const executable = [...required, ...regression].filter((check) => check.command);
  if (executable.length) {
    requiredEvidence.push({ id: nextEvidenceId(), description: `Recorded output and exit code for: ${executable.map((c) => c.command).join(", ")}` });
  }
  if (family !== "repository_investigation") {
    requiredEvidence.push({ id: nextEvidenceId(), description: "The list of files changed, and a diff for each." });
  }

  const completionRule: CompletionRule = {
    requireAllRequiredChecks: true,
    // Investigation produces an answer, not a workspace mutation, so demanding execution evidence
    // would make every honest answer fail the gate.
    requireExecutionEvidence: family !== "repository_investigation" && executable.length > 0,
    text: executable.length
      ? "Complete only when every required check has been run and passed, with its output recorded."
      : "Complete only when every required assertion holds; state plainly that no executable check was available.",
  };

  return { requiredChecks: required, regressionChecks: regression, adversarialChecks: adversarial, requiredEvidence, completionRule };
}

/** Checks something can actually run or assert. The rest are honest placeholders, never evidence. */
export function executableChecks(contract: VerificationContract): VerificationCheck[] {
  return [...contract.requiredChecks, ...contract.regressionChecks, ...contract.adversarialChecks]
    .filter((check) => check.provenance !== "not_automatically_verifiable" && (check.command || check.assertion));
}
