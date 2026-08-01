// Task Compiler — unit and fixture tests.
//
// The fixtures are the contract of this layer: one per required task family plus the behaviors that
// distinguish a compiler from a prompt rewriter — a precise request must pass through unchanged, a
// vague one must compile, a contradiction must ask, repository evidence must beat a guess, a
// reversible choice must not interrupt the user, and NOTHING may invent a feature.
//
// Assertions are structural, not exact-string snapshots: a snapshot of rendered prose would fail on
// every wording change while still passing if the compiler started inventing requirements.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileTask, extractLiterals, classifyFamily, groundTask, collectRepositoryFacts,
  validateCompiledTask, findProhibitedScoreFields, PROHIBITED_SCORE_FIELDS,
  renderCompiledTask, executableChecks, sliceContract,
  TASK_IR_VERSION, type CompiledTask,
} from "../src/core/taskCompiler/index.js";
import { canonicalJson, promptEpoch, normalizePathForPrompt } from "../src/core/promptEpoch.js";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), "kitten-tc-empty-"));
}

/** A small but realistic Node/TypeScript repository: manifest, scripts, source and test conventions. */
function nodeRepo(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kitten-tc-node-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: { test: "node --test", typecheck: "tsc --noEmit", build: "tsc", lint: "eslint ." },
    dependencies: { express: "^4.0.0", zod: "^3.0.0" },
    devDependencies: { typescript: "^5.0.0" },
  }, null, 2));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "export.ts"), "export function exportJson(): string { return '{}'; }\n");
  for (const [path, body] of Object.entries(extra)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function cleanup(...roots: string[]): void {
  for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function compile(request: string, cwd: string, flag: "auto" | "force" = "auto") {
  return compileTask({ taskId: "run_test", request, cwd, flag });
}

// ── Stage 1: literal extraction invents nothing ──────────────────────────────────────────────────

test("literal extraction records only what the user said", () => {
  const literals = extractLiterals("Add a /health endpoint to src/server.ts. Do not change the database schema.");
  assert.ok(literals.contract.endpoints.includes("/health"), "endpoint extracted");
  assert.ok(literals.contract.files.includes("src/server.ts"), "file extracted");
  assert.equal(literals.prohibitions.length, 1, "one prohibition");
  assert.match(literals.prohibitions[0], /database schema/i);
  // Nothing about auth, logging, rate limiting or tests was said, so nothing may appear.
  const serialized = JSON.stringify(literals).toLowerCase();
  for (const invented of ["authentication", "rate limit", "logging", "swagger"]) {
    assert.ok(!serialized.includes(invented), `must not invent "${invented}"`);
  }
});

test("extraction normalizes paths but never rewrites the ask", () => {
  const literals = extractLiterals("Fix the parser in src\\core\\parse.ts");
  assert.ok(literals.contract.files.includes("src/core/parse.ts"), "backslashes canonicalized");
  assert.match(literals.statedOutcome, /fix the parser/i);
});

// ── Stage 2: families ────────────────────────────────────────────────────────────────────────────

test("task families are classified from deterministic evidence", () => {
  const root = nodeRepo();
  try {
    const cases: Array<[string, string]> = [
      ["The /health endpoint returns 500 instead of 200. Fix it.", "bug_fix"],
      ["Add Markdown export for the active conversation.", "feature_implementation"],
      ["Refactor src/export.ts to remove the duplicated formatting logic.", "refactor"],
      ["Where is the retry budget enforced?", "repository_investigation"],
      ["Write tests for the export service.", "test_creation"],
      ["Create a dinosaur jumping game from scratch.", "new_application"],
      ["Migrate the store from JSON files to sqlite.", "migration"],
      // "replace X with Y" alone is not a migration. The shared classifier says it is; the compiler
      // requires corroborating evidence, because the wrong template attaches a data-equivalence
      // check that means nothing for a string change.
      ["Make slugify replace spaces with hyphens in src/slug.js.", "feature_implementation"],
      ["Swap the logging library for pino.", "migration"],
    ];
    for (const [request, expected] of cases) {
      const family = classifyFamily(request, extractLiterals(request), root).family;
      assert.equal(family, expected, `"${request}" → ${expected}, got ${family}`);
    }
  } finally { cleanup(root); }
});

// ── Stage 3: repository grounding ────────────────────────────────────────────────────────────────

test("grounding reads the real manifest and reports real commands", () => {
  const root = nodeRepo();
  try {
    const { facts } = collectRepositoryFacts(root, extractLiterals("anything"));
    assert.equal(facts.stack, "node");
    assert.equal(facts.testCommand, "npm test");
    assert.equal(facts.typecheckCommand, "npm run typecheck");
    assert.ok(facts.dependencies.includes("express"), "significant dependency recorded");
    assert.ok(!facts.dependencies.includes("fixture"), "package name is not a dependency");
    assert.deepEqual(facts.sourceDirs, ["src"]);
    assert.deepEqual(facts.testDirs, ["test"]);
  } finally { cleanup(root); }
});

test("grounding distinguishes a file that exists from one that does not", () => {
  const root = nodeRepo();
  try {
    const literals = extractLiterals("Update src/export.ts and src/missing.ts");
    const { facts } = collectRepositoryFacts(root, literals);
    assert.deepEqual(facts.existingNamedFiles, ["src/export.ts"]);
    assert.deepEqual(facts.missingNamedFiles, ["src/missing.ts"]);
    const grounded = groundTask(root, literals, "bug_fix");
    assert.ok(grounded.evidence.some((e) => e.kind === "absence" && e.path === "src/missing.ts"), "absence is evidence");
    assert.ok(grounded.affectedSurfaces.some((s) => s.path === "src/export.ts"), "existing file becomes a surface");
  } finally { cleanup(root); }
});

// ── required fixture: bug fix ────────────────────────────────────────────────────────────────────

test("fixture: bug fix compiles with a red-then-green adversarial check", () => {
  const root = nodeRepo();
  try {
    const result = compile("The /health endpoint in src/export.ts returns 500 instead of 200. Fix it.", root);
    assert.equal(result.task.family, "bug_fix");
    assert.ok(result.validation.ok, JSON.stringify(result.validation.errors));
    assert.ok(result.task.verification.adversarialChecks.some((c) => c.assertion === "red_then_green"),
      "a bug fix must be screened red-then-green");
    assert.ok(result.task.verification.regressionChecks.some((c) => c.command === "npm test"),
      "the repository's own test command is the regression check");
  } finally { cleanup(root); }
});

// ── required fixture: feature ────────────────────────────────────────────────────────────────────

test("fixture: feature compiles, reuses the repo stack, and never invents a feature", () => {
  const root = nodeRepo();
  try {
    const result = compile("Add Markdown export for the active conversation. Keep the existing JSON export working.", root);
    assert.equal(result.task.family, "feature_implementation");
    assert.ok(result.validation.ok, JSON.stringify(result.validation.errors));
    assert.ok(result.task.invariants.some((i) => /json export/i.test(i.text)), "compatibility becomes an invariant");

    // The user asked for Markdown export. Nothing else may become a requirement.
    const rendered = renderCompiledTask(result.task).toLowerCase();
    for (const invented of ["authentication", "account", "sound", "achievement", "mobile", "pdf export", "analytics"]) {
      assert.ok(!rendered.includes(invented), `must not invent "${invented}"`);
    }
    // Repository grounding must be real: the manifest establishes the stack.
    assert.ok(result.task.repositoryEvidence.some((e) => e.kind === "manifest" && /node/i.test(e.detail)),
      "stack evidence is recorded");
  } finally { cleanup(root); }
});

// ── required fixture: refactor ───────────────────────────────────────────────────────────────────

test("fixture: refactor demands an unchanged public interface", () => {
  const root = nodeRepo();
  try {
    const result = compile("Refactor src/export.ts to remove the duplicated formatting logic without changing behavior.", root);
    assert.equal(result.task.family, "refactor");
    assert.ok(result.validation.ok, JSON.stringify(result.validation.errors));
    assert.ok(result.task.verification.adversarialChecks.some((c) => c.assertion === "api_surface_unchanged"),
      "a refactor is checked for interface drift");
  } finally { cleanup(root); }
});

// ── required fixture: repository investigation ───────────────────────────────────────────────────

test("fixture: investigation is read-only and produces an answer", () => {
  const root = nodeRepo();
  try {
    const result = compile("Where is the retry budget enforced?", root);
    assert.equal(result.task.family, "repository_investigation");
    assert.ok(result.validation.ok, JSON.stringify(result.validation.errors));
    assert.equal(result.task.executionPolicy.mutationAllowed, false, "an investigation must not mutate");
    assert.equal(result.task.executionPolicy.laneHint, "answer");
    assert.ok(result.task.deliverables.some((d) => d.kind === "answer"), "the deliverable is an answer");
  } finally { cleanup(root); }
});

// ── required fixture: an already-precise task passes through ─────────────────────────────────────

test("fixture: a precise request passes through without prompt inflation", () => {
  const root = nodeRepo();
  try {
    const request = [
      "In src/export.ts, exportJson must return an empty object literal when the conversation has no messages.",
      "Do not change the function signature.",
      "Verify with `npm test` and confirm the typecheck passes.",
    ].join(" ");
    const result = compile(request, root);
    assert.equal(result.task.compilationMode, "passthrough");
    assert.equal(result.contractBlock, "", "passthrough injects nothing");
    assert.equal(result.telemetry.renderedContractTokens, 0);
  } finally { cleanup(root); }
});

test("prompt bloat guard: a precise ~120-token request never becomes a 900-token contract", () => {
  const root = nodeRepo();
  try {
    const request = [
      "In src/export.ts, the exportJson function must return an empty object literal when the",
      "conversation has no messages, and must preserve the existing key ordering for every other case.",
      "Do not change the exported function signature and do not add a new dependency.",
      "Verify by running `npm test`, and confirm `npm run typecheck` still passes cleanly.",
    ].join(" ");
    const result = compile(request, root);
    // Whatever mode is chosen, the contract may not balloon past the raw request by a large factor.
    assert.ok(
      result.telemetry.renderedContractTokens <= result.telemetry.rawRequestTokens * 4,
      `contract ${result.telemetry.renderedContractTokens} tokens vs request ${result.telemetry.rawRequestTokens}`,
    );
    assert.ok(result.telemetry.renderedContractTokens < 900, "hard ceiling on a precise request");
  } finally { cleanup(root); }
});

// ── required fixture: a vague task compiles ──────────────────────────────────────────────────────

test("fixture: a vague request compiles into a bounded contract", () => {
  const root = nodeRepo();
  try {
    const result = compile("Create a dinosaur jumping game.", root);
    assert.equal(result.task.family, "new_application");
    assert.equal(result.task.compilationMode, "compile");
    assert.ok(result.validation.ok, JSON.stringify(result.validation.errors));
    assert.ok(result.contractBlock.length > 0, "a vague request gets a contract");
    // Bounded: a six-word request must not become a requirements document.
    assert.ok(result.telemetry.renderedContractTokens <= result.task.contextPolicy.maxContractTokens,
      `contract ${result.telemetry.renderedContractTokens} exceeded budget ${result.task.contextPolicy.maxContractTokens}`);
    // And it must not silently grow a product.
    const rendered = result.contractBlock.toLowerCase();
    for (const invented of ["sound", "achievement", "leaderboard", "account", "level select", "settings menu", "asset pipeline", "mobile controls"]) {
      assert.ok(!rendered.includes(invented), `must not invent "${invented}"`);
    }
  } finally { cleanup(root); }
});

// ── required fixture: blocking contradiction asks exactly one question ───────────────────────────

test("fixture: a contradiction asks one question instead of guessing", () => {
  const root = nodeRepo();
  try {
    const result = compile("You must add a new endpoint for user search. Do not add a new endpoint.", root);
    assert.equal(result.task.compilationMode, "clarify");
    assert.equal(result.task.executionPolicy.requiresClarification, true);
    assert.equal(result.task.executionPolicy.mutationAllowed, false, "a clarifying turn must not mutate");
    assert.ok(result.clarification && result.clarification.length > 0, "one question is produced");
    assert.equal((result.clarification!.match(/\?/g) ?? []).length, 1, "exactly one question is asked");
    assert.equal(result.contractBlock, "", "clarify injects no contract");
    assert.ok(result.validation.ok, JSON.stringify(result.validation.errors));
  } finally { cleanup(root); }
});

// ── required fixture: repository evidence resolves an ambiguity ──────────────────────────────────

test("fixture: repository evidence resolves the unstated stack without asking", () => {
  const root = nodeRepo();
  try {
    const result = compile("Add a caching layer for the export service.", root);
    const resolved = result.task.ambiguities.find((a) => /which technology|technology to use/i.test(a.description));
    assert.ok(resolved, "the unstated-technology ambiguity is detected");
    assert.equal(resolved!.kind, "reversible", "it is reversible, not blocking");
    assert.equal(resolved!.resolution.type, "repository_evidence");
    assert.notEqual(result.task.compilationMode, "clarify", "evidence resolves it — the user is not interrupted");
    // And the decision is visible as an assumption rather than hidden.
    assert.ok(result.task.assumptions.some((a) => a.basis === "repository_convention" && /node/i.test(a.text)),
      "the resolution is recorded as an inspectable assumption");
  } finally { cleanup(root); }
});

// ── required fixture: a reversible default is used without interrupting ──────────────────────────

test("fixture: an empty workspace takes a safe default and records it", () => {
  const root = emptyRepo();
  try {
    const result = compile("Create a dinosaur jumping game.", root);
    assert.notEqual(result.task.compilationMode, "clarify", "a reversible choice must not interrupt");
    const assumption = result.task.assumptions.find((a) => a.basis === "project_default");
    assert.ok(assumption, "the default is recorded as an assumption");
    assert.equal(assumption!.reversible, true);
    assert.ok(result.task.repositoryEvidence.some((e) => e.kind === "absence"), "the empty workspace is evidence");
  } finally { cleanup(root); }
});

// ── the compiler must never invent a feature ─────────────────────────────────────────────────────

test("no requirement is both model-inferred and mandatory", () => {
  const root = nodeRepo();
  try {
    for (const request of [
      "Create a dinosaur jumping game.",
      "Add Markdown export.",
      "Make the export faster.",
      "Fix the crash.",
      "Where is retry handled?",
    ]) {
      const result = compile(request, root);
      for (const requirement of result.task.requirements) {
        assert.ok(
          !(requirement.strength === "must" && requirement.source === "model_inference"),
          `"${request}": inferred requirement marked must — ${requirement.text}`,
        );
      }
      // Every repository-sourced requirement must cite evidence that exists.
      const ids = new Set(result.task.repositoryEvidence.map((e) => e.id));
      for (const requirement of result.task.requirements) {
        for (const ref of requirement.evidenceRefs ?? []) assert.ok(ids.has(ref), `dangling evidence ref ${ref}`);
      }
    }
  } finally { cleanup(root); }
});

test("the contract never reads as an instruction to adopt an existing dependency", () => {
  // Observed on a live run against ornith-1.0-35b: the line "Reuse the existing zod setup rather
  // than adding an equivalent dependency" was read as "use zod", and the model wired schema
  // validation into a task that asked only for a string transform. The compiler induced the scope
  // creep it exists to prevent — and the forbidden-term probe could not see it, because zod is a
  // real repository dependency rather than an invented feature.
  const root = nodeRepo();
  try {
    // A bounded edit to a file the user named: the dependency roster changes no decision here, so it
    // is withheld entirely. Naming an available dependency at all was measurably enough to invite it.
    const bounded = compile("Make slugify lowercase the string in src/export.ts.", root).contractBlock;
    for (const dependency of ["express", "zod", "typescript"]) {
      assert.ok(!bounded.toLowerCase().includes(dependency), `bounded edit names dependency "${dependency}"`);
    }

    // An unbounded build may see the roster — but only as a fact inside a prohibition on ADDING,
    // never as an instruction to adopt.
    const unbounded = compile("Create a dinosaur jumping game.", root).contractBlock;
    for (const directive of [/\breuse the existing\b/i, /\breuse these\b/i, /\buse the existing (?:express|zod|typescript)\b/i]) {
      assert.ok(!directive.test(unbounded), `contract directs adoption of a dependency: ${directive}`);
    }
    if (/express|zod|typescript/i.test(unbounded)) {
      assert.match(unbounded, /do not add a new dependency/i, "a named dependency appears only under a prohibition");
    }
  } finally { cleanup(root); }
});

// ── the score-field prohibition is enforced structurally ─────────────────────────────────────────

test("no compiled task contains a confidence or score field", () => {
  const root = nodeRepo();
  try {
    for (const request of [
      "Fix the /health endpoint in src/export.ts.",
      "Create a dinosaur jumping game.",
      "Where is the retry budget enforced?",
      "You must add an endpoint. Do not add an endpoint.",
    ]) {
      const result = compile(request, root);
      assert.deepEqual(findProhibitedScoreFields(result.task), [], `${request}: prohibited field present`);
      // Also scan the rendered bytes for confidence LANGUAGE reaching the main model.
      const rendered = result.contractBlock.toLowerCase();
      for (const word of ["confidence", "certainty", "probability", "likelihood", "difficulty"]) {
        assert.ok(!rendered.includes(word), `${request}: rendered contract leaks "${word}"`);
      }
    }
  } finally { cleanup(root); }
});

test("the prohibition scan actually finds an offending field", () => {
  // A guard that cannot fail proves nothing — verify the detector on a planted violation.
  const planted = { requirements: [{ id: "rq01", text: "x", confidence: 0.87 }], nested: { qualityScore: 3 } };
  const found = findProhibitedScoreFields(planted);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.ok(found.some((path) => path.endsWith(".confidence")));
  assert.ok(found.some((path) => path.endsWith(".qualityScore")));
  assert.ok(PROHIBITED_SCORE_FIELDS.includes("specscore"), "the banned list covers specScore");
});

// ── validator ────────────────────────────────────────────────────────────────────────────────────

test("validator rejects the malformed contracts it exists to catch", () => {
  const root = nodeRepo();
  try {
    const base = compile("Add Markdown export to src/export.ts.", root).task;
    const clone = (): CompiledTask => JSON.parse(JSON.stringify(base)) as CompiledTask;

    const emptyGoal = clone(); emptyGoal.goal = "";
    assert.ok(validateCompiledTask(emptyGoal).errors.some((e) => e.code === "empty_goal"));

    const contradiction = clone();
    contradiction.requirements = [
      { id: "rq01", text: "add the endpoint", strength: "must", source: "user" },
      { id: "rq02", text: "add the endpoint", strength: "must_not", source: "user" },
    ];
    assert.ok(validateCompiledTask(contradiction).errors.some((e) => e.code === "contradictory_requirements"));

    const dangling = clone();
    dangling.requirements = [{ id: "rq01", text: "x", strength: "should", source: "user", evidenceRefs: ["ev99"] }];
    assert.ok(validateCompiledTask(dangling).errors.some((e) => e.code === "dangling_evidence_ref"));

    const inferred = clone();
    inferred.requirements = [{ id: "rq01", text: "add sound effects", strength: "must", source: "model_inference" }];
    assert.ok(validateCompiledTask(inferred).errors.some((e) => e.code === "inferred_requirement_as_mandatory"));

    const unsupported = clone();
    unsupported.requirements = [{ id: "rq01", text: "use express", strength: "should", source: "repository" }];
    assert.ok(validateCompiledTask(unsupported).errors.some((e) => e.code === "unsupported_repository_requirement"));

    const ceremonial = clone();
    ceremonial.verification = { ...ceremonial.verification, requiredChecks: [
      { id: "vc99", kind: "command", claim: "the code is robust", provenance: "added_by_kitten", proves: [] },
    ] };
    assert.ok(validateCompiledTask(ceremonial).errors.some((e) => e.code === "unexecutable_check"),
      "a check with no command and no assertion must be rejected");

    const mutatingInvestigation = clone();
    mutatingInvestigation.family = "repository_investigation";
    mutatingInvestigation.executionPolicy = { ...mutatingInvestigation.executionPolicy, mutationAllowed: true };
    assert.ok(validateCompiledTask(mutatingInvestigation).errors.some((e) => e.code === "investigation_may_not_mutate"));
  } finally { cleanup(root); }
});

// ── verification contract ────────────────────────────────────────────────────────────────────────

test("every verification check either runs or is honestly labelled unverifiable", () => {
  const root = nodeRepo();
  try {
    const result = compile("Make the export complete in under 50ms. Fix src/export.ts.", root);
    const all = [
      ...result.task.verification.requiredChecks,
      ...result.task.verification.regressionChecks,
      ...result.task.verification.adversarialChecks,
    ];
    assert.ok(all.length > 0, "checks were generated");
    for (const check of all) {
      const runnable = Boolean(check.command || check.assertion);
      assert.ok(
        runnable || check.provenance === "not_automatically_verifiable" || check.provenance === "requires_model_inspection",
        `check ${check.id} ("${check.claim}") is neither runnable nor labelled unverifiable`,
      );
    }
    // A prose performance threshold has no runner here, and must say so rather than look like a pass.
    const perf = all.find((c) => /50ms/i.test(c.claim));
    assert.ok(perf, "the performance requirement produced a check");
    assert.equal(perf!.provenance, "not_automatically_verifiable");
    assert.ok(executableChecks(result.task.verification).every((c) => c.command || c.assertion));
  } finally { cleanup(root); }
});

test("verification is generated before implementation and cites the repository's own commands", () => {
  const root = nodeRepo();
  try {
    const result = compile("Add Markdown export to src/export.ts.", root);
    const commands = [...result.task.verification.requiredChecks, ...result.task.verification.regressionChecks]
      .map((c) => c.command).filter(Boolean);
    assert.ok(commands.includes("npm test"), "repo test command adopted");
    assert.ok(commands.includes("npm run typecheck"), "repo typecheck adopted");
    for (const check of result.task.verification.regressionChecks) {
      assert.equal(check.provenance, "provided_by_repository");
    }
  } finally { cleanup(root); }
});

// ── canonical rendering ──────────────────────────────────────────────────────────────────────────

test("rendering is deterministic and canonical", () => {
  const root = nodeRepo();
  try {
    const a = compile("Add Markdown export to src/export.ts. Do not break JSON export.", root);
    const b = compile("Add Markdown export to src/export.ts. Do not break JSON export.", root);
    assert.equal(a.contractBlock, b.contractBlock, "same input renders identical bytes");
    assert.ok(!a.contractBlock.includes("\r"), "no CR bytes");
    assert.ok(!/[\\]/.test(a.contractBlock.replace(/\\n/g, "")), "no Windows path separators in the prompt");
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }), "key order does not change bytes");
  } finally { cleanup(root); }
});

test("rendered contract carries no compiler commentary or resolved-ambiguity discussion", () => {
  const root = nodeRepo();
  try {
    const result = compile("Create a dinosaur jumping game.", root);
    const rendered = result.contractBlock.toLowerCase();
    for (const leak of ["ambiguity", "reversible", "compilation mode", "sidecar", "the compiler", "hardness", "this task is"]) {
      assert.ok(!rendered.includes(leak), `rendered contract leaks internal state: "${leak}"`);
    }
    // The IR still holds the analysis — it is simply not sent to the model.
    assert.ok(result.task.ambiguities.length > 0, "analysis exists in the IR");
  } finally { cleanup(root); }
});

test("adversarial probes reach the verifier only, never the implementer", () => {
  // Measured on ornith-1.0-35b: rendering "the new behavior fails cleanly on invalid input" into the
  // implementer's contract made it import a schema library and validate the input of a one-line
  // string transform. A probe is how the work gets CHECKED, not a requirement to build defenses.
  const root = nodeRepo();
  try {
    const task = compile("Add Markdown export to src/export.ts.", root).task;
    assert.ok(task.verification.adversarialChecks.length > 0, "the probe exists in the IR");
    for (const slice of ["full", "patch", "localize", "integrate"] as const) {
      assert.ok(!renderCompiledTask(task, slice).includes("adversarial:"), `${slice} slice leaks the adversarial probe`);
    }
    assert.ok(renderCompiledTask(task, "verify").includes("adversarial:"), "the verifier does receive it");
  } finally { cleanup(root); }
});

test("constraint slicing gives each consumer only what it needs", () => {
  const root = nodeRepo();
  try {
    const task = compile("Add Markdown export to src/export.ts. Do not break JSON export.", root).task;
    const localize = sliceContract(task, "localize");
    const verify = sliceContract(task, "verify");
    assert.ok(!localize.includes("verify:"), "a localizer does not receive verification commands");
    assert.ok(verify.includes("verify:") || verify.includes("regression:"), "the verifier does receive them");
    assert.ok(sliceContract(task, "full").length >= localize.length, "the full slice is a superset in size");
  } finally { cleanup(root); }
});

// ── modes ────────────────────────────────────────────────────────────────────────────────────────

test("force never selects passthrough, and never overrides a blocking ambiguity", () => {
  const root = nodeRepo();
  try {
    const precise = "In src/export.ts, exportJson must return an empty object when there are no messages. Do not change the signature. Verify with `npm test`.";
    assert.equal(compile(precise, root).task.compilationMode, "passthrough");
    assert.equal(compile(precise, root, "force").task.compilationMode, "enrich");

    const contradictory = "You must add a new endpoint for user search. Do not add a new endpoint.";
    assert.equal(compile(contradictory, root, "force").task.compilationMode, "clarify",
      "force must not compile past a contradiction");
  } finally { cleanup(root); }
});

test("compilation is reproducible: identical input yields an identical IR", () => {
  const root = nodeRepo();
  try {
    const a = compile("Fix the /health endpoint in src/export.ts.", root).task;
    const b = compile("Fix the /health endpoint in src/export.ts.", root).task;
    assert.equal(canonicalJson(a), canonicalJson(b), "the IR is deterministic");
    assert.equal(a.version, TASK_IR_VERSION);
  } finally { cleanup(root); }
});

// ── prompt epochs ────────────────────────────────────────────────────────────────────────────────

test("prompt epoch changes when and only when the stable prefix changes", () => {
  const base = { templateVersion: "t1", systemPrompt: "sys", toolNames: ["read", "edit"], repoCapsule: "capsule" };
  assert.equal(promptEpoch(base).id, promptEpoch({ ...base }).id, "identical inputs share an epoch");
  assert.notEqual(promptEpoch(base).id, promptEpoch({ ...base, systemPrompt: "sys v2" }).id, "a system prompt change mints a new epoch");
  // Trailing whitespace is normalized away on purpose: an invisible editor artifact must not cost a
  // full prefill by pretending the prefix changed.
  assert.equal(promptEpoch(base).id, promptEpoch({ ...base, systemPrompt: "sys   " }).id, "trailing whitespace is not a prefix change");
  assert.notEqual(promptEpoch(base).id, promptEpoch({ ...base, toolNames: ["edit", "read"] }).id,
    "tool ORDER is part of the bytes — reordering must not claim compatibility");
  assert.equal(normalizePathForPrompt("src\\core\\app.ts"), "src/core/app.ts");
});

test("a change request that names no file is a change, not an investigation", () => {
  // Observed live on Terminal-Bench (sanitize-git-repo). The request asks to find API keys, replace
  // them with placeholders, and "ensure that the sensitive values are not present afterwards" -- an
  // unambiguous mutation. It named no path, so the last-resort fallback called it read-only, the
  // compiler forced the ANSWER lane (which carries no tools at all), and the model ended up typing
  // <tool_call> blocks into prose. Zero files changed, zero score. "Names no file" is not the same
  // as "asks for no change".
  const cwd = mkdtempSync(join(tmpdir(), "kitten-family-"));
  const sanitize = classifyFamily(
    'Please help sanitize my github repository "dclm" of all API keys. Please find and remove all '
    + "such information and replace it with placeholder values. Please ensure that the sensitive "
    + "values are not present in the repository after the sanitization.",
    extractLiterals('Please help sanitize my github repository "dclm" of all API keys. Please find '
      + "and remove all such information and replace it with placeholder values. Please ensure that "
      + "the sensitive values are not present in the repository after the sanitization."),
    cwd,
  );
  assert.notEqual(sanitize.family, "repository_investigation",
    `a sanitize-and-replace request must not be read-only (got: ${sanitize.reason})`);

  for (const req of ["clean up the build output", "make the tests pass", "remove the debug logging"]) {
    const d = classifyFamily(req, extractLiterals(req), cwd);
    assert.notEqual(d.family, "repository_investigation", `"${req}" asks for a change (got: ${d.reason})`);
  }

  // The other half: genuine questions must STAY investigations, or every explanation request starts
  // editing files.
  for (const req of ["Where is the retry budget enforced?", "How does the router pick a lane?",
                     "Explain the finish gate.", "list the modules that import the store"]) {
    const d = classifyFamily(req, extractLiterals(req), cwd);
    assert.equal(d.family, "repository_investigation", `"${req}" is a question (got: ${d.family}/${d.reason})`);
  }
});
