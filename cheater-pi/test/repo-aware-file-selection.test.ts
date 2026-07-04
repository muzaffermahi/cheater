import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeAutopilot } from "../src/autopilot/router.js";
import { createCommitletPlan } from "../src/commitlet/planner.js";
import { buildRepoConstraintGraph, selectFilesByGoalFromGraph, selectSingleFileForGoal } from "../src/commitlet/constraintGraph.js";
import { runDiffGuard, hasResolvedScope, fileMatchesScope } from "../src/commitlet/guard.js";

// Audit finding: for a generic bug-fix/feature request with no blueprint (the single most
// common routing path - "fix the off-by-one in sum_range"), the planner used to guess from a
// hardcoded literal filename list that only happened to match CHEATER's OWN repo layout
// (src/commands.ts, src/tools.ts, src/config.ts). Every other project's request fell through
// to the placeholder "(select one target file after inspection)", which executor.ts then
// filters out entirely - shipping a worker packet with zero code and zero repo facts. These
// tests pin the fix: real repo scanning replaces the guess.

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-file-select-"));
}

test("selectSingleFileForGoal finds a Python function by name, not by guessed filename", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "mathutils.py"), "def sum_range(start, end):\n    return sum(range(start, end))\n", "utf8");
  const target = selectSingleFileForGoal(root, "fix the off-by-one in sum_range");
  assert.equal(target, "src/mathutils.py");
});

test("selectSingleFileForGoal finds a TS export by name", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "widgets.ts"), "export function renderWidget(items: string[]) {\n  return items.join(',');\n}\n", "utf8");
  const target = selectSingleFileForGoal(root, "renderWidget crashes on an empty array, fix it");
  assert.equal(target, "src/widgets.ts");
});

test("selectSingleFileForGoal returns null (not a wrong guess) when nothing matches", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "widgets.ts"), "export function renderWidget() {}\n", "utf8");
  assert.equal(selectSingleFileForGoal(root, "improve the onboarding flow copy"), null);
});

test("a generic bug-fix goal with no blueprint resolves to the real target file, not the inspect-first placeholder", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "mathutils.py"), "def sum_range(start, end):\n    return sum(range(start, end))\n", "utf8");
  writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n", "utf8");
  const decision = routeAutopilot({ cwd: root, message: "fix the off-by-one in sum_range" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "fix the off-by-one in sum_range", autopilotDecision: decision });
  const allowed = plan.commitlets[0].allowedFiles;
  assert.deepEqual(allowed, ["src/mathutils.py"]);
  assert.doesNotMatch(allowed.join(","), /select one target file after inspection/);
});

test("with no repo match, the plan still falls back to the honest inspect-first placeholder", () => {
  const root = tmpRepo();
  const decision = routeAutopilot({ cwd: root, message: "fix the weird onboarding glitch" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "fix the weird onboarding glitch", autopilotDecision: decision });
  assert.match(plan.commitlets[0].allowedFiles.join(","), /select one target file after inspection/);
});

test("a placeholder-only commitlet is self-localizing: the diff guard does NOT block its edit as out-of-scope", () => {
  const root = tmpRepo();
  const decision = routeAutopilot({ cwd: root, message: "fix the weird onboarding glitch" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "fix the weird onboarding glitch", autopilotDecision: decision });
  const commitlet = plan.commitlets[0];
  assert.equal(hasResolvedScope(commitlet.allowedFiles), false, "the placeholder is not a resolved scope");
  // Before this fix, the model was told to edit but every edit was rejected here as "outside
  // allowedFiles" - a hard deadlock. Now the self-localized edit passes scope (health/verify
  // still gate it), and maxFilesTouched keeps it to one file.
  const guard = runDiffGuard(commitlet, { touchedFiles: ["src/onboarding.ts"], diffText: "--- a\n+++ b\n+const fixed = true;\n" });
  assert.equal(guard.blockingIssues.some((issue) => /outside allowedFiles/.test(issue)), false);
});

test("a resolved-scope commitlet still blocks an out-of-scope edit", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "widgets.ts"), "export function renderWidget() {}\n", "utf8");
  const decision = routeAutopilot({ cwd: root, message: "renderWidget crashes, fix it" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "renderWidget crashes, fix it", autopilotDecision: decision });
  const commitlet = plan.commitlets[0];
  assert.equal(hasResolvedScope(commitlet.allowedFiles), true);
  const guard = runDiffGuard(commitlet, { touchedFiles: ["src/unrelated.ts"], diffText: "+x\n" });
  assert.equal(guard.blockingIssues.some((issue) => /outside allowedFiles/.test(issue)), true);
});

test("fileMatchesScope honors exact files and directory scopes", () => {
  assert.equal(fileMatchesScope("src/export.ts", "src/export.ts"), true);
  assert.equal(fileMatchesScope("pkg/src/export.ts", "src/export.ts"), true, "suffix match for nested layouts");
  assert.equal(fileMatchesScope("src/other.ts", "src/export.ts"), false);
  assert.equal(fileMatchesScope("test/a.spec.ts", "test/"), true, "directory scope covers files beneath it");
  assert.equal(fileMatchesScope("src/a.ts", "test/"), false);
  assert.equal(fileMatchesScope("anything.ts", "(select one target file after inspection)"), false, "placeholder is never a scope");
});

test("constraint graph extracts Python def/class as symbols and exports (not just signatures)", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "parser.py"), "class TokenStream:\n    pass\n\ndef parse_line(line):\n    return line.strip()\n", "utf8");
  const graph = buildRepoConstraintGraph(root, ["src/parser.py"]);
  assert.ok(graph.symbols.includes("src/parser.py:parse_line"), "graph.symbols must include Python def, not just signatures");
  assert.ok(graph.symbols.includes("src/parser.py:TokenStream"));
  assert.ok(graph.exports.includes("src/parser.py:parse_line"), "Python has no export keyword; public def/class counts as exported");
  const targets = selectFilesByGoalFromGraph("parse_line returns the wrong value", graph);
  assert.ok(targets.some((t) => t.path === "src/parser.py" && t.role === "touch"));
});

test("constraint graph extracts Python imports (from X import Y / import X)", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.py"), "from src.mathutils import sum_range\nimport json\n", "utf8");
  const graph = buildRepoConstraintGraph(root, ["src/app.py"]);
  assert.ok(graph.imports.some((i) => i.file === "src/app.py" && i.importPath === "src.mathutils"));
  assert.ok(graph.imports.some((i) => i.file === "src/app.py" && i.importPath === "json"));
});
