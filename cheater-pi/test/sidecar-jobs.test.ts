import test from "node:test";
import assert from "node:assert/strict";
import { deterministicSidecar, extractSidecarJson, sidecarJobDefaults, validateSidecarValue, SIDECAR_WORKFLOWS } from "../src/core/sidecarJobs.js";

test("sidecar catalog exposes useful deterministic floors", () => {
  assert.equal(deterministicSidecar({ id: "1", type: "classify_task", premise: "v1", text: "fix the failing parser" }).value, "bug");
  const contract = deterministicSidecar({ id: "2", type: "extract_contract", premise: "v1", text: "The parser must preserve order. Do not edit tests." }).value as { requirements: string[]; forbidden: string[] };
  assert.match(contract.requirements[0], /must preserve/);
  assert.match(contract.forbidden[0], /edit tests/);
  assert.equal(sidecarJobDefaults({ id: "3", type: "review_diff", premise: "v1" }).tier, "specialist");
});

test("sidecar floors detect loops and audit evidence", () => {
  const loop = deterministicSidecar({ id: "4", type: "detect_loop", premise: "v1", text: "read parser\nread parser\nread parser\nread parser" }).value as { repeated: boolean };
  assert.equal(loop.repeated, true);
  const audit = deterministicSidecar({ id: "5", type: "audit_evidence", premise: "v1", diff: "changed", facts: [] }).value as { warnings: string[] };
  assert.match(audit.warnings.join(" "), /evidence/);
});

test("sidecar model output is parsed, bounded, and cannot widen candidate files", () => {
  assert.deepEqual(extractSidecarJson("Here is the answer:\n```json\n{\"label\":\"bug\"}\n```"), { label: "bug" });
  assert.equal(extractSidecarJson("not json"), null);
  const ranked = validateSidecarValue({ id: "r", type: "rank_files", premise: "p", files: ["src/a.ts"] }, [{ path: "src/a.ts", score: 1 }, { path: "secret.env", score: 9 }]) as Array<{ path: string }>;
  assert.deepEqual(ranked.map((item) => item.path), ["src/a.ts"]);
  assert.equal(validateSidecarValue({ id: "c", type: "classify_task", premise: "p" }, { label: "unknown" }), null);
});

test("sidecar catalog covers model choice, risk, diff, commands, and error explanation", () => {
  assert.equal((deterministicSidecar({ id: "m", type: "choose_model", premise: "p", text: "implement a cross-file migration", files: ["a", "b"] }).value as { tier: string }).tier, "main");
  assert.equal((deterministicSidecar({ id: "r", type: "estimate_risk", premise: "p", diff: "added api_key" }).value as { level: string }).level, "high");
  assert.deepEqual(deterministicSidecar({ id: "c", type: "suggest_commands", premise: "p", files: ["package.json"] }).value, ["npm test", "npm run typecheck", "npm run build"]);
  assert.match((deterministicSidecar({ id: "e", type: "explain_error", premise: "p", output: "TypeError: missing member" }).value as { likelyCause: string }).likelyCause, /unexpected value/);
});

test("expanded sidecar clerical jobs have useful deterministic floors", () => {
  const secrets = deterministicSidecar({ id: "s", type: "detect_secrets", premise: "p", diff: "api_key = 'abcdefghijklmnopqrstuvwxyz'" }).value as { findings: string[] };
  assert.match(secrets.findings.join(" "), /credential/);
  const tests = deterministicSidecar({ id: "t", type: "generate_test_cases", premise: "p", text: "The parser must preserve order." }).value as { cases: string[] };
  assert.match(tests.cases[0], /preserve order/);
  const tokens = deterministicSidecar({ id: "k", type: "estimate_tokens", premise: "p", text: "abcd" }).value as { estimatedTokens: number };
  assert.equal(tokens.estimatedTokens, 1);
  const tree = deterministicSidecar({ id: "tree", type: "summarize_tree", premise: "p" }).value as { files: number };
  assert.equal(tree.files, 0);
  const orientation = deterministicSidecar({ id: "o", type: "orient_task", premise: "p", text: "fix the parser" }).value as { classification: string; files: unknown[]; requirements: string[] };
  assert.equal(orientation.classification, "bug");
  assert.ok(Array.isArray(orientation.files));
});

test("expanded sidecar outputs reject malformed structured responses", () => {
  assert.equal(validateSidecarValue({ id: "d", type: "draft_commit", premise: "p" }, { title: "ok" }), null);
  assert.equal(validateSidecarValue({ id: "m", type: "map_dependencies", premise: "p" }, { edges: [{ from: "a", to: 3 }] }), null);
  assert.deepEqual(validateSidecarValue({ id: "e", type: "estimate_tokens", premise: "p" }, { characters: 12.9, estimatedTokens: 4.2 }), { characters: 12, estimatedTokens: 4 });
  const orientation = validateSidecarValue({ id: "o", type: "orient_task", premise: "p", files: ["src/parser.ts"] }, { classification: "bug", files: [{ path: "other.ts" }], requirements: [] }) as { files: unknown[] };
  assert.deepEqual(orientation.files, []);
});

test("postflight review composes the complete deterministic audit packet", () => {
  const review = deterministicSidecar({ id: "pf", type: "postflight_review", premise: "run-1", diff: "api_key = 'abcdefghijklmnopqrstuvwxyz'", files: ["src/parser.ts"], tests: ["test/parser.test.ts"], facts: [] }).value as { secrets: string[]; risk: string; recommendedTests: string[]; generatedTestCases: string[] };
  assert.match(review.secrets.join(" "), /credential/);
  assert.equal(review.risk, "high");
  assert.ok(Array.isArray(review.recommendedTests));
  assert.ok(Array.isArray(review.generatedTestCases));
});

test("postflight review rejects incomplete or out-of-scope model packets", () => {
  const input = { id: "pf", type: "postflight_review" as const, premise: "run-1", tests: ["test/parser.test.ts"] };
  assert.equal(validateSidecarValue(input, { risk: "high" }), null);
  const value = validateSidecarValue(input, { secrets: [], warnings: [], evidenceWarnings: [], recommendedTests: ["test/other.test.ts", "test/parser.test.ts"], suggestedCommands: [], risk: "low", riskReasons: [], generatedTestCases: [] }) as { recommendedTests: string[] };
  assert.deepEqual(value.recommendedTests, ["test/parser.test.ts"]);
});

test("sidecar workflows compose bounded jobs without duplicate step ids", () => {
  assert.deepEqual(SIDECAR_WORKFLOWS.map((workflow) => workflow.id), ["task-intake", "change-review", "failure-triage", "release-readiness", "refactor-plan", "test-hardening", "dependency-audit"]);
  for (const workflow of SIDECAR_WORKFLOWS) {
    assert.ok(workflow.steps.length >= 5);
    assert.equal(new Set(workflow.steps.map((step) => step.id)).size, workflow.steps.length);
    assert.ok(workflow.steps.every((step) => typeof step.label === "string" && step.label.length > 0));
  }
});
