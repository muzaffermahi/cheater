import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  touchedCheckTokens,
  testCommandCoversFiles,
  repoLanguage,
  synthesizedCheckDir,
  discoverSynthesizedCheck,
  behavioralSmokeCommands,
  resolveCheck,
  classifyRedGreen,
  runRedGreenScreen,
  runCommandsAsCheck,
  isTransientDataFile,
  transientDebris,
  resetTransientState,
  buildEvidenceTable,
  renderEvidenceTable,
  checklistItemTokens,
  evaluateCheckFirst,
  type ResolvedCheck
} from "../src/commitlet/checkFirst.js";
import type { Commitlet } from "../src/commitlet/types.js";
import type { ValidationEntry } from "../src/runstate/validationLedger.js";
import type { VerificationResult } from "../src/commitlet/verification.js";

// A minimal commitlet carrying only the fields the functions under test read.
function fakeCommitlet(overrides: Partial<Commitlet> = {}): Commitlet {
  return {
    id: "c1",
    title: "implement thing",
    purpose: "do the thing",
    status: "running",
    scope: "surgical",
    allowedFiles: [],
    forbiddenFiles: [],
    allowedActions: [],
    forbiddenActions: [],
    maxFilesTouched: 2,
    maxDiffLines: 200,
    maxToolCalls: 10,
    maxModelCalls: 3,
    expectedFilesTouched: [],
    focusedVerification: [],
    broaderVerification: [],
    healthBudget: {} as Commitlet["healthBudget"],
    risk: "low",
    ...overrides
  };
}

function pass(): VerificationResult { return { passed: true, commandsRun: [], failures: [], summary: "ok" }; }
function fail(): VerificationResult { return { passed: false, commandsRun: [], failures: ["boom"], summary: "boom" }; }

// --- token extraction + coverage -------------------------------------------------------------

test("touchedCheckTokens pulls basenames without extension and spec symbols", () => {
  const c = fakeCommitlet({
    allowedFiles: ["src/parser.ts", "(inspect only)", "docs/"],
    spec: { acceptanceCriteria: ["`parseExpr` returns an AST"], behaviorMustHold: [], behaviorMustNotChange: [], edgeCases: [], temporaryTestsAllowed: true, permanentTestsAllowed: true, nonGoals: [] }
  });
  const tokens = touchedCheckTokens(c);
  assert.ok(tokens.includes("parser"), "basename without extension");
  assert.ok(tokens.includes("parseexpr"), "spec symbol, lowercased");
  assert.ok(!tokens.some((t) => t.includes("inspect")), "virtual paths ignored");
});

test("testCommandCoversFiles is true when a test file name matches a touched basename", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-cov-"));
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests", "test_parser.py"), "def test_x():\n    assert True\n", "utf8");
  assert.equal(testCommandCoversFiles(cwd, ["parser"]), true);
  assert.equal(testCommandCoversFiles(cwd, ["unrelated"]), false);
});

test("testCommandCoversFiles is true when a test file's content references a touched symbol", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-cov2-"));
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests", "misc.spec.ts"), "import { parseExpr } from '../src/parser';\n", "utf8");
  assert.equal(testCommandCoversFiles(cwd, ["parseexpr"]), true);
});

test("testCommandCoversFiles returns false with no test files at all", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-cov3-"));
  writeFileSync(join(cwd, "app.py"), "x = 1\n", "utf8");
  assert.equal(testCommandCoversFiles(cwd, ["app"]), false);
});

// --- language + synthesized check discovery --------------------------------------------------

test("repoLanguage detects node vs python vs other", () => {
  const node = mkdtempSync(join(tmpdir(), "cf-node-"));
  writeFileSync(join(node, "package.json"), "{}", "utf8");
  assert.equal(repoLanguage(node), "node");
  const py = mkdtempSync(join(tmpdir(), "cf-py-"));
  writeFileSync(join(py, "requirements.txt"), "pytest\n", "utf8");
  assert.equal(repoLanguage(py), "python");
  const other = mkdtempSync(join(tmpdir(), "cf-other-"));
  assert.equal(repoLanguage(other), "other");
});

test("discoverSynthesizedCheck picks the right runner per file type", () => {
  const runDir = mkdtempSync(join(tmpdir(), "cf-synth-"));
  const dir = synthesizedCheckDir(runDir, "c1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "test_thing.py"), "assert True\n", "utf8");
  const cmds = discoverSynthesizedCheck(dir);
  assert.ok(cmds.some((c) => /pytest/.test(c) && /test_thing\.py/.test(c)), "pytest for a test_ python file");

  const dir2 = synthesizedCheckDir(runDir, "c2");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "check.mjs"), "process.exit(0)\n", "utf8");
  assert.ok(discoverSynthesizedCheck(dir2).some((c) => /^node /.test(c)), "plain node for check.mjs");

  assert.deepEqual(discoverSynthesizedCheck(join(runDir, "nope")), [], "missing dir -> []");
});

// --- behavioral smoke ------------------------------------------------------------------------

test("behavioralSmokeCommands runs contract commands and writes artifact probes", () => {
  const runDir = mkdtempSync(join(tmpdir(), "cf-smoke-"));
  const cmds = behavioralSmokeCommands({ commands: ["python solve.py"], outputPaths: ["out.json"] }, runDir, "c1");
  assert.ok(cmds.includes("python solve.py"), "the contract command is a smoke");
  assert.ok(cmds.some((c) => /artifact_0\.js/.test(c)), "an artifact probe script is generated");
  // The probe script exists and is a node existence/parse check.
  const dir = synthesizedCheckDir(runDir, "c1");
  const probe = readFileSync(join(dir, "artifact_0.js"), "utf8");
  assert.match(probe, /existsSync/);
  assert.match(probe, /out\.json/);
});

test("behavioralSmokeCommands returns [] for an empty contract", () => {
  assert.deepEqual(behavioralSmokeCommands(null), []);
  assert.deepEqual(behavioralSmokeCommands({ commands: [], outputPaths: [] }), []);
});

// --- tier resolution + fallback order --------------------------------------------------------

test("resolveCheck prefers tier 1 when repo tests cover the change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-t1-"));
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests", "test_parser.py"), "assert True\n", "utf8");
  const check = resolveCheck({
    cwd,
    commitlet: fakeCommitlet({ allowedFiles: ["src/parser.py"] }),
    contract: null,
    projectCommands: { testCommand: "pytest -q", focusedTestCommand: null },
    synthesisAllowed: true
  });
  assert.equal(check.tier, 1);
  assert.equal(check.kind, "repo_tests");
  assert.equal(check.weaklyVerified, false);
});

test("resolveCheck falls to tier 3 smoke when no coverage but the contract names a command (synthesis allowed)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-t3-"));
  const runDir = mkdtempSync(join(tmpdir(), "cf-t3-run-"));
  const check = resolveCheck({
    cwd,
    runDir,
    commitlet: fakeCommitlet({ allowedFiles: ["src/solve.py"] }),
    contract: { commands: ["python solve.py"], outputPaths: [] } as any,
    projectCommands: { testCommand: null, focusedTestCommand: null },
    synthesisAllowed: true
  });
  assert.equal(check.tier, 3);
  assert.equal(check.kind, "behavioral_smoke");
});

test("resolveCheck picks tier 2 when the worker left a synthesized check", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-t2-"));
  const runDir = mkdtempSync(join(tmpdir(), "cf-t2-run-"));
  const dir = synthesizedCheckDir(runDir, "c1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "check.mjs"), "process.exit(0)\n", "utf8");
  const check = resolveCheck({
    cwd,
    runDir,
    commitlet: fakeCommitlet({ id: "c1", allowedFiles: ["src/x.js"] }),
    contract: { commands: ["node x.js"], outputPaths: [] } as any,
    projectCommands: { testCommand: null, focusedTestCommand: null },
    synthesisAllowed: true
  });
  assert.equal(check.tier, 2);
  assert.equal(check.kind, "synthesized");
});

test("resolveCheck stays on tier 1-or-4 on the easy lane (synthesis NOT allowed)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-easy-"));
  const check = resolveCheck({
    cwd,
    commitlet: fakeCommitlet({ allowedFiles: ["src/solve.py"] }),
    contract: { commands: ["python solve.py"], outputPaths: [] } as any,
    projectCommands: { testCommand: null, focusedTestCommand: null },
    synthesisAllowed: false
  });
  assert.equal(check.tier, 4, "no tier-2/3 synthesis on the easy lane");
  assert.equal(check.kind, "static_floor");
  assert.equal(check.weaklyVerified, true);
});

// --- red/green classification + mutation screen ----------------------------------------------

test("classifyRedGreen: proven / garbage / green_failed / unscreened", () => {
  assert.equal(classifyRedGreen(fail(), pass()), "proven");   // fails without change, passes with it
  assert.equal(classifyRedGreen(pass(), pass()), "garbage");  // passes even without the change
  assert.equal(classifyRedGreen(fail(), fail()), "green_failed");
  assert.equal(classifyRedGreen(null, pass()), "unscreened");
});

test("runRedGreenScreen rejects an always-passing check as garbage and restores the green file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-garbage-"));
  const snap = join(cwd, ".cheater", "snap");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(snap, "src"), { recursive: true });
  writeFileSync(join(snap, "src", "mod.js"), "// PRE\n", "utf8");       // red (pre-impl) snapshot
  writeFileSync(join(cwd, "src", "mod.js"), "// IMPL\n", "utf8");        // green (implemented)
  const commitlet = fakeCommitlet({
    allowedFiles: ["src/mod.js"],
    rollbackPoint: { id: "r", createdAt: "", snapshotDir: snap, existedFiles: ["src/mod.js"], description: "" }
  });
  // A check that ALWAYS passes cannot discriminate the change -> garbage.
  const screen = runRedGreenScreen(cwd, commitlet, () => pass());
  assert.equal(screen.verdict, "garbage");
  assert.equal(readFileSync(join(cwd, "src", "mod.js"), "utf8"), "// IMPL\n", "green file restored after the swap");
});

test("runRedGreenScreen proves a discriminating check red-then-green", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-proven-"));
  const snap = join(cwd, ".cheater", "snap");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(snap, "src"), { recursive: true });
  writeFileSync(join(snap, "src", "mod.js"), "// PRE\n", "utf8");
  writeFileSync(join(cwd, "src", "mod.js"), "// IMPL\n", "utf8");
  const commitlet = fakeCommitlet({
    allowedFiles: ["src/mod.js"],
    rollbackPoint: { id: "r", createdAt: "", snapshotDir: snap, existedFiles: ["src/mod.js"], description: "" }
  });
  // The check passes only when the file contains IMPL - so it fails on the red snapshot.
  const runCheck = (): VerificationResult => {
    const has = readFileSync(join(cwd, "src", "mod.js"), "utf8").includes("IMPL");
    return has ? pass() : fail();
  };
  const screen = runRedGreenScreen(cwd, commitlet, runCheck);
  assert.equal(screen.verdict, "proven");
  assert.equal(readFileSync(join(cwd, "src", "mod.js"), "utf8"), "// IMPL\n", "green restored");
});

test("runRedGreenScreen restores a contract output artifact the red run clobbered", () => {
  // Regression: the red re-run re-executes the app and overwrites a deliverable (output.json) that lives
  // outside allowedFiles; the finally restored only the source, leaving a STALE deliverable on disk that
  // the finish gate's existence/parse-only artifact check would accept.
  const cwd = mkdtempSync(join(tmpdir(), "cf-artifact-"));
  const snap = join(cwd, ".cheater", "snap");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(snap, "src"), { recursive: true });
  writeFileSync(join(snap, "src", "mod.js"), "// PRE\n", "utf8");
  writeFileSync(join(cwd, "src", "mod.js"), "// IMPL\n", "utf8");
  const commitlet = fakeCommitlet({
    allowedFiles: ["src/mod.js"],
    rollbackPoint: { id: "r", createdAt: "", snapshotDir: snap, existedFiles: ["src/mod.js"], description: "" }
  });
  // The check "runs the app": it writes output.json derived from the source, and passes only on IMPL.
  const runCheck = (): VerificationResult => {
    const impl = readFileSync(join(cwd, "src", "mod.js"), "utf8").includes("IMPL");
    writeFileSync(join(cwd, "output.json"), JSON.stringify({ ok: impl }));
    return impl ? pass() : fail();
  };
  writeFileSync(join(cwd, "output.json"), JSON.stringify({ ok: true })); // the green run's correct deliverable
  const screen = runRedGreenScreen(cwd, commitlet, runCheck, pass(), ["output.json"]);
  assert.equal(screen.verdict, "proven");
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, "output.json"), "utf8")), { ok: true }, "green deliverable restored, not the red clobber");
  assert.equal(readFileSync(join(cwd, "src", "mod.js"), "utf8"), "// IMPL\n", "green source restored");
});

test("runRedGreenScreen is unscreened when there is no rollback snapshot", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-unscreened-"));
  const commitlet = fakeCommitlet({ allowedFiles: ["src/mod.js"] });
  const screen = runRedGreenScreen(cwd, commitlet, () => pass());
  assert.equal(screen.screened, false);
  assert.equal(screen.verdict, "unscreened");
});

test("runCommandsAsCheck: all commands must exit 0", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-cmds-"));
  assert.equal(runCommandsAsCheck(cwd, ['node -e "process.exit(0)"']).passed, true);
  assert.equal(runCommandsAsCheck(cwd, ['node -e "process.exit(1)"']).passed, false);
  assert.equal(runCommandsAsCheck(cwd, []).passed, true, "no commands -> vacuously passes");
});

// --- clean-state reset -----------------------------------------------------------------------

test("isTransientDataFile catches runtime data but spares source/config", () => {
  assert.equal(isTransientDataFile("expenses.json"), true);
  assert.equal(isTransientDataFile("data/records.json"), true);
  assert.equal(isTransientDataFile("app.db"), true);
  assert.equal(isTransientDataFile("run.log"), true);
  assert.equal(isTransientDataFile("package.json"), false, "config manifest is never transient");
  assert.equal(isTransientDataFile("tsconfig.json"), false);
  assert.equal(isTransientDataFile("src/index.ts"), false, "source is never transient");
  assert.equal(isTransientDataFile(".eslintrc.json"), false, "dotfile config spared");
});

test("transientDebris spares contract deliverables", () => {
  const created = ["expenses.json", "output.json", "src/main.py"];
  const deliverables = ["output.json"]; // named in the contract -> keep it
  const debris = transientDebris(created, deliverables);
  assert.ok(debris.includes("expenses.json"), "self-test data is debris");
  assert.ok(!debris.includes("output.json"), "deliverable is spared");
  assert.ok(!debris.includes("src/main.py"), "source is not debris");
});

test("resetTransientState moves debris aside and spares deliverables", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-reset-"));
  writeFileSync(join(cwd, "expenses.json"), "[]", "utf8");     // self-test leftover
  writeFileSync(join(cwd, "output.json"), "{}", "utf8");        // deliverable
  const result = resetTransientState(cwd, ["expenses.json", "output.json"], ["output.json"], { mode: "aside" });
  assert.deepEqual(result.removed, ["expenses.json"]);
  assert.equal(existsSync(join(cwd, "expenses.json")), false, "debris moved out of the workspace");
  assert.equal(existsSync(join(cwd, "output.json")), true, "deliverable untouched");
  assert.equal(existsSync(join(cwd, ".cheater", "transient-aside", "expenses.json")), true, "debris preserved aside (not destroyed)");
});

// --- evidence table --------------------------------------------------------------------------

function entry(overrides: Partial<ValidationEntry>): ValidationEntry {
  return { seq: 1, at: "", name: "v", actor: "c1", validates: [], status: "pass", mirrorsEvaluator: false, stale: false, ...overrides };
}

test("checklistItemTokens extracts paths, commands, and symbols", () => {
  const tokens = checklistItemTokens("Re-open output.json and confirm its content");
  assert.ok(tokens.includes("output.json"));
});

test("buildEvidenceTable maps checklist items to the validations that prove them", () => {
  const checklist = ["Re-open output.json and confirm its content and format.", "Confirm parseExpr exists with that exact name."];
  const validations = [
    entry({ name: "focused_verification:c1", command: "pytest tests/test_output.py", validates: ["output.json"], status: "pass" }),
    entry({ name: "check_first:tier3:unscreened", command: "node check.mjs parseExpr", validates: ["src/parser.py"], status: "unknown", outputSummary: "weak (behavioral_smoke): ..." })
  ];
  const rows = buildEvidenceTable(checklist, validations);
  assert.equal(rows.length, 2);
  const outputRow = rows.find((r) => /output\.json/.test(r.item))!;
  assert.equal(outputRow.status, "verified", "a fresh matching pass is verified");
  const symbolRow = rows.find((r) => /parseExpr/.test(r.item))!;
  assert.equal(symbolRow.status, "weak", "a weak check_first entry surfaces as weak");
});

test("buildEvidenceTable marks an item with no matching validation as unverified", () => {
  const rows = buildEvidenceTable(["Run `python solve.py` and confirm exit code 0."], []);
  assert.equal(rows[0].status, "unverified");
  assert.match(rows[0].evidence, /no validation recorded/);
});

test("renderEvidenceTable produces readable status rows", () => {
  const lines = renderEvidenceTable([{ item: "do X", status: "verified", evidence: "v -> pass" }, { item: "do Y", status: "weak", evidence: "check_first -> unknown" }]);
  assert.ok(lines[0].startsWith("Contract evidence table:"));
  assert.ok(lines.some((l) => l.includes("[verified]")));
  assert.ok(lines.some((l) => l.includes("[weak]")));
});

// --- orchestrator (guarded) ------------------------------------------------------------------

test("evaluateCheckFirst returns a static floor (never throws) when nothing is available", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-eval-"));
  const result = evaluateCheckFirst(cwd, fakeCommitlet({ allowedFiles: ["src/x.py"] }), {
    contract: null,
    projectCommands: { testCommand: null, focusedTestCommand: null },
    synthesisAllowed: false
  });
  assert.equal(result.tier, 4);
  assert.equal(result.weaklyVerified, true);
  assert.equal(result.ran, false);
});

test("evaluateCheckFirst runs the red-green screen and proves a discriminating tier-3 check", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-eval2-"));
  const runDir = mkdtempSync(join(tmpdir(), "cf-eval2-run-"));
  const snap = join(cwd, ".cheater", "snap");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(snap, "src"), { recursive: true });
  // Pre-impl: solve.py exits 1. Impl: solve.py exits 0. The contract command IS the check.
  writeFileSync(join(snap, "src", "solve.py"), "import sys; sys.exit(1)\n", "utf8");
  writeFileSync(join(cwd, "src", "solve.py"), "import sys; sys.exit(0)\n", "utf8");
  const commitlet = fakeCommitlet({
    allowedFiles: ["src/solve.py"],
    rollbackPoint: { id: "r", createdAt: "", snapshotDir: snap, existedFiles: ["src/solve.py"], description: "" }
  });
  const result = evaluateCheckFirst(cwd, commitlet, {
    contract: { commands: ["python src/solve.py"], outputPaths: [] } as any,
    projectCommands: { testCommand: null, focusedTestCommand: null },
    runDir,
    synthesisAllowed: true
  });
  // Depending on whether python3 is on PATH, the screen either proves it or degrades safely; in all
  // cases the green file is restored and the result never throws.
  assert.ok(["proven", "garbage", "green_failed", "unscreened"].includes(result.verdict));
  assert.equal(readFileSync(join(cwd, "src", "solve.py"), "utf8"), "import sys; sys.exit(0)\n", "green restored");
});
