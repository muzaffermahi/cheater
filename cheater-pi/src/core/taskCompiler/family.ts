// Task Compiler — Stage 2: task-family classification.
//
// The family selects a SMALL TYPED TEMPLATE, not a giant universal prompt. A bug fix needs observed
// vs expected behavior and a regression boundary; a refactor needs behavioral invariants and a
// forbidden-change list; an investigation needs a question and a completion artifact. Asking one
// prompt to carry every field for every family is how contracts turn into three-thousand-token
// requirements documents.
//
// Classification reuses the existing deterministic autopilot classifier and refines it with literal
// evidence from Stage 1. There is no model call here: the family must be reproducible, because it
// decides which fields the rest of the pipeline is even allowed to populate.

import { classifyAutopilotTask } from "../../autopilot/classifier.js";
import type { AutopilotClassification } from "../../autopilot/classifier.js";
import type { LiteralExtraction } from "./extract.js";
import type { TaskFamily } from "./ir.js";

export interface FamilyDecision {
  family: TaskFamily;
  /** Why this family — recorded in the trace, never sent to the main model. */
  reason: string;
  /** The underlying deterministic classification, reused downstream for routing/hardness. */
  classification: AutopilotClassification;
}

/** The fields a family's template is allowed to carry. Anything not listed is dropped by render.ts,
 *  which is what keeps a bug report from sprouting product requirements. */
export interface FamilyTemplate {
  family: TaskFamily;
  /** Section labels in canonical render order. */
  sections: readonly string[];
  /** Soft token budget for the rendered contract. */
  contractTokens: number;
  /** May this family mutate the workspace? */
  mutates: boolean;
}

export const FAMILY_TEMPLATES: Readonly<Record<TaskFamily, FamilyTemplate>> = {
  bug_fix: {
    family: "bug_fix",
    sections: ["observed", "expected", "reproduction", "surface", "regression", "verify"],
    contractTokens: 700,
    mutates: true,
  },
  feature_implementation: {
    family: "feature_implementation",
    sections: ["behavior", "interfaces", "persistence", "compatibility", "invariants", "verify"],
    contractTokens: 800,
    mutates: true,
  },
  refactor: {
    family: "refactor",
    sections: ["target", "invariants", "allowed", "forbidden", "boundary", "verify"],
    contractTokens: 700,
    mutates: true,
  },
  repository_investigation: {
    family: "repository_investigation",
    sections: ["question", "evidence", "scope", "excluded", "artifact"],
    contractTokens: 400,
    mutates: false,
  },
  test_creation: {
    family: "test_creation",
    sections: ["behavior", "surface", "conventions", "verify"],
    contractTokens: 600,
    mutates: true,
  },
  configuration_change: {
    family: "configuration_change",
    sections: ["target", "value", "compatibility", "verify"],
    contractTokens: 400,
    mutates: true,
  },
  new_application: {
    family: "new_application",
    sections: ["behavior", "interfaces", "stack", "invariants", "verify"],
    contractTokens: 1000,
    mutates: true,
  },
  performance_optimization: {
    family: "performance_optimization",
    sections: ["target", "budget", "invariants", "verify"],
    contractTokens: 700,
    mutates: true,
  },
  documentation: {
    family: "documentation",
    sections: ["subject", "surface", "conventions", "verify"],
    contractTokens: 400,
    mutates: true,
  },
  migration: {
    family: "migration",
    sections: ["target", "boundary", "invariants", "compatibility", "verify"],
    contractTokens: 900,
    mutates: true,
  },
};

const NEW_APP_RE = /\bfrom scratch\b|\bnew (?:app|application|project|game|website|web ?app|tool|cli)\b|\b(?:build|create|make|write)\b[^.]{0,40}\b(?:app|application|game|website|web ?app|dashboard)\b/i;
const TEST_CREATION_RE = /\b(?:add|write|create|generate)\b[^.]{0,30}\b(?:tests?|test suite|unit tests?|coverage)\b/i;
const DOC_RE = /\b(?:readme|changelog|docs?|documentation|docstring|comment)\b/i;
const CONFIG_RE = /\b(?:config|configuration|settings?|\.env|environment variable|tsconfig|eslint|dependency version|package\.json field)\b/i;
const PERF_RE = /\b(?:performance|slow|speed ?up|faster|latency|throughput|optimi[sz]e|memory usage|profil(?:e|ing)|bottleneck)\b/i;
const INVESTIGATION_RE = /^\s*(?:where|which|how does|why does|what does|find|locate|trace|investigate|audit|review|list)\b/i;

/**
 * The shared autopilot classifier calls anything matching "replace X with Y" / "move X to Y" a
 * migration, which is far too loose for a template decision: "replace spaces with hyphens" is a
 * one-line string change, not a schema migration, and routing it to the migration template attaches
 * a nonsensical data-equivalence check and triples the token budget.
 *
 * So a migration must ALSO show migration evidence — an explicit migration verb, or a
 * technology/storage/version subject. The shared classifier is deliberately left alone; the router
 * and other callers depend on its current behavior, and narrowing it here is the bounded fix.
 */
const MIGRATION_EVIDENCE_RE = /\b(migrat(?:e|es|ed|ing|ion)|schema|database|\bdb\b|sqlite|postgres|mysql|mongo|upgrade|downgrade|port(?:ed|ing)?\s+(?:the\s+)?[\w.-]+\s+(?:from|to)\b|librar(?:y|ies)|framework|dependency|dependencies|runtime|version\s*\d|deprecat)/i;

/**
 * Choose the family. Order matters: the more specific literal signals win over the generic
 * classifier kind, because "add tests for the parser" classifies as feature_addition but is a
 * test_creation task whose template has no product-behavior fields at all.
 */
export function classifyFamily(request: string, literals: LiteralExtraction, cwd: string): FamilyDecision {
  const classification = classifyAutopilotTask({ message: request, cwd });
  const text = request ?? "";

  const decide = (family: TaskFamily, reason: string): FamilyDecision => ({ family, reason, classification });

  // An explanation/orientation request never mutates, whatever else it mentions.
  if (classification.taskKind === "explanation_only" || (literals.isQuestion && !/\b(fix|add|change|implement|create|refactor|remove|update)\b/i.test(text))) {
    return decide("repository_investigation", "explanation/orientation request — no change asked for");
  }
  if (INVESTIGATION_RE.test(text) && !/\b(fix|add|implement|create|change|refactor)\b/i.test(text)) {
    return decide("repository_investigation", "locate/trace/audit request with no requested change");
  }
  if (TEST_CREATION_RE.test(text)) return decide("test_creation", "request asks for new tests");
  if (PERF_RE.test(text) && classification.taskKind !== "bug_fix") return decide("performance_optimization", "request names a performance target");
  if (classification.taskKind === "migration" && MIGRATION_EVIDENCE_RE.test(text)) {
    return decide("migration", "classifier: migration, corroborated by migration evidence");
  }
  if (NEW_APP_RE.test(text)) return decide("new_application", "request is a from-scratch build");
  if (classification.taskKind === "bug_fix" || classification.taskKind === "test_failure") {
    return decide("bug_fix", `classifier: ${classification.taskKind}`);
  }
  if (classification.taskKind === "refactor") return decide("refactor", "classifier: refactor");
  if (classification.taskKind === "docs" || (DOC_RE.test(text) && !/\bcode\b/i.test(text))) {
    return decide("documentation", "request targets documentation");
  }
  if (CONFIG_RE.test(text) && !/\b(implement|build|create)\b/i.test(text)) {
    return decide("configuration_change", "request targets configuration");
  }
  if (classification.taskKind === "feature_addition" || classification.taskKind === "tiny_edit" || classification.taskKind === "tooling") {
    return decide("feature_implementation", `classifier: ${classification.taskKind}`);
  }
  // `unknown`/`benchmark` fall here. A request that names an artifact is a change; otherwise treat it
  // as an investigation rather than guessing at a mutation the user never asked for.
  const namesArtifact = Boolean(literals.contract.files.length || literals.contract.symbols.length || literals.contract.endpoints.length);
  return namesArtifact
    ? decide("feature_implementation", "unclassified but names a concrete artifact")
    : decide("repository_investigation", "unclassified and names no artifact — treated as read-only");
}

export function familyTemplate(family: TaskFamily): FamilyTemplate {
  return FAMILY_TEMPLATES[family];
}
