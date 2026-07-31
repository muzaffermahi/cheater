// Task Compiler — evaluation harness and its fixtures.
//
// These assert the properties the compiler is only allowed to ship WITH: it never invents a
// requirement, it never inflates an already-precise request, it classifies families stably, and the
// grounded arm actually uses the repository rather than merely claiming to.
//
// Compile-side metrics need no model, so they run in CI on every commit — which is the point. The
// runtime metrics (verified%, main-model calls, wall clock) require live inference and are reported
// as "not measured" rather than as zeros.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVALUATION_ARMS, EVALUATION_FIXTURES, measureCompileSide, renderArm,
  renderEvaluation, summarizeArm, summarizeByFamily,
  type EvaluationOutcome,
} from "../src/core/taskCompiler/index.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "kitten-tce-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture", scripts: { test: "node --test", typecheck: "tsc --noEmit" },
    dependencies: { express: "^4.0.0" },
  }, null, 2));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "export.ts"), "export function exportJson(): string { return '{}'; }\n");
  return root;
}

test("no arm invents a requirement on any fixture", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    const offenders = measurements.filter((m) => m.inventedTerms.length > 0);
    assert.deepEqual(
      offenders.map((m) => `${m.caseId}/${m.arm}: ${m.inventedTerms.join(", ")}`),
      [],
      "a compiler that invents features is worse than no compiler",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the grounded arm never inflates an already-precise request", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    const summary = summarizeArm(measurements, EVALUATION_FIXTURES, "grounded");
    assert.equal(summary.inflatedPreciseCases, 0, "a precise request must pass through untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("family classification matches expectation across the fixture set", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    for (const arm of ["contract", "grounded"] as const) {
      const wrong = measurements.filter((m) => m.arm === arm && !m.familyMatchedExpectation);
      assert.deepEqual(wrong.map((m) => `${m.caseId}: got ${m.family}`), [], `${arm}: family drift`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clarification fires on the contradiction fixture and nowhere else", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    const wrong = measurements.filter((m) => m.arm === "grounded" && !m.clarificationCorrect);
    assert.deepEqual(wrong.map((m) => `${m.caseId}: clarified=${m.clarificationRequested}`), [],
      "clarification must fire exactly where a blocking ambiguity exists");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the grounded arm actually reads the repository and the ungrounded arm does not", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    const grounded = measurements.filter((m) => m.arm === "grounded");
    const contract = measurements.filter((m) => m.arm === "contract");

    assert.ok(grounded.some((m) => m.evidenceCount > 0), "the grounded arm produces evidence");
    assert.ok(grounded.every((m) => m.repositoryQueries > 0), "the grounded arm queries the repository");
    // The ungrounded arm must report honestly that it looked at nothing.
    assert.ok(contract.every((m) => m.evidenceCount === 0), "the ungrounded arm cites no evidence");
    assert.ok(contract.every((m) => m.repositoryQueries === 0), "the ungrounded arm performs no queries");

    // And grounding must make a visible difference somewhere, or it is not earning its cost.
    const groundedTokens = grounded.reduce((n, m) => n + m.contractTokens, 0);
    const contractTokens = contract.reduce((n, m) => n + m.contractTokens, 0);
    assert.notEqual(groundedTokens, contractTokens, "grounding changes the contract");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("arm A is the untouched baseline", () => {
  const root = repo();
  try {
    const { block, measurement } = renderArm(EVALUATION_FIXTURES[0], root, "raw");
    assert.equal(block, "", "the raw arm injects nothing");
    assert.equal(measurement.contractTokens, 0);
    assert.equal(measurement.repositoryQueries, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per-family breakdown is produced, because one arm can help one family and hurt another", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    const byFamily = summarizeByFamily(measurements, "grounded");
    assert.ok(byFamily.size >= 5, `expected several families, got ${byFamily.size}`);
    assert.ok(byFamily.has("bug_fix") && byFamily.has("new_application"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the report says 'not measured' rather than printing zeros for unmeasured runtime metrics", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    const withoutOutcomes = renderEvaluation(measurements, EVALUATION_FIXTURES);
    assert.match(withoutOutcomes, /not measured in this run/, "unmeasured metrics must not read as results");
    assert.doesNotMatch(withoutOutcomes, /verified%\s+first-patch%/, "no runtime table without runtime data");

    const outcomes: EvaluationOutcome[] = EVALUATION_ARMS.map((arm) => ({
      caseId: "bug-health-500", arm, verified: arm === "grounded", firstPatchVerified: arm === "grounded",
      mainModelCalls: 3, repairIterations: 1, promptTokens: 100, reasoningTokens: 50, answerTokens: 25,
      wallMs: 1000, malformedToolCalls: 0, incorrectFileSelections: 0, userCorrections: 0,
    }));
    const withOutcomes = renderEvaluation(measurements, EVALUATION_FIXTURES, outcomes);
    assert.match(withOutcomes, /verified%/, "supplied runtime data is rendered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the harness reports facts, never an aggregate quality score", () => {
  const root = repo();
  try {
    const measurements = measureCompileSide(EVALUATION_FIXTURES, root);
    const rendered = renderEvaluation(measurements, EVALUATION_FIXTURES).toLowerCase();
    for (const banned of ["quality score", "confidence", "overall score", "grade:"]) {
      assert.ok(!rendered.includes(banned), `evaluation output leaks "${banned}"`);
    }
    for (const row of measurements) {
      assert.ok(!Object.keys(row).some((k) => /confidence|certainty|probability/i.test(k)));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
