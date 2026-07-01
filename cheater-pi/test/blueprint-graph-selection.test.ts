import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomousBlueprint } from "../src/blueprint/autonomous.js";
import { buildPlannerGraph, selectFilesByGoalFromGraph, buildRepoConstraintGraph, queryConstraintFacts } from "../src/commitlet/constraintGraph.js";
import { runFinalBlueprintReview } from "../src/blueprint/reviewer.js";
import { scoutOfficialDocs, searxngOfficialFacts, fetchOfficialDocsPages } from "../src/blueprint/docsScout.js";
import { docsCacheKey, readDocsCache, writeDocsCache, docsCacheDir } from "../src/blueprint/docsCache.js";
import { runBlueprintEval, summarizeEval } from "../src/blueprint/evalHarness.js";
import { buildBlueprintIntelligencePack, packetScopedWorkerBrief } from "../src/blueprint/intelligence.js";
import { inferFilePlans } from "../src/blueprint/contextSketch.js";
import { DEFAULT_BLUEPRINT_CONFIG } from "../src/blueprint/config.js";
import type { RepoOrientation, BlueprintMemoryHit } from "../src/blueprint/types.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cheater-graph-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCheaterCommands(pi: any) { pi.registerCommand('cheater', {}); }\nexport function registerHelper(pi: any) { pi.registerCommand('helper', {}); }\n");
  writeFileSync(join(dir, "src", "tools.ts"), "export function registerCheaterTools(pi: any) { pi.registerTool('cheater_tool', {}); }\n");
  writeFileSync(join(dir, "src", "parser.ts"), "export function parse(input: string) { return input; }\nexport function parseLine(line: string) { return line; }\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test';\ntest('commands', () => {});\n");
  writeFileSync(join(dir, "README.md"), "Cheater launches Pi.\n");
  return dir;
}

const orientation: RepoOrientation = {
  repoRoot: "x", languages: ["typescript"], frameworks: [], testCommands: ["npm test"],
  typecheckCommands: ["npm run build"], entrypoints: ["src/"], importantPaths: ["package.json"]
};

test("graph-driven target selection finds command registration file from goal mentioning a command", () => {
  const dir = makeRepo();
  const graph = buildPlannerGraph(dir, { ...orientation, repoRoot: dir });
  const targets = selectFilesByGoalFromGraph("add a new cheater command for hello", graph);
  assert.ok(targets.some((t) => t.path === "src/commands.ts"), targets.map((t) => t.path).join(", "));
  assert.ok(targets.some((t) => /command registration/.test(t.reason)));
  assert.ok(targets.some((t) => /registerCommand/.test(t.evidence.join(" "))));
});

test("graph-driven target selection finds tool registration file when goal mentions tools", () => {
  const dir = makeRepo();
  const graph = buildPlannerGraph(dir, { ...orientation, repoRoot: dir });
  const targets = selectFilesByGoalFromGraph("add a new cheater tool schema", graph);
  assert.ok(targets.some((t) => t.path === "src/tools.ts"));
});

test("graph-driven target selection finds files by symbol mentioned in goal", () => {
  const dir = makeRepo();
  const graph = buildPlannerGraph(dir, { ...orientation, repoRoot: dir });
  const targets = selectFilesByGoalFromGraph("fix the parse function for inputs", graph);
  assert.ok(targets.some((t) => t.path === "src/parser.ts"));
  assert.ok(targets.some((t) => /defines symbol "parse"/.test(t.reason)));
});

test("graph-driven target selection discovers co-located tests for selected implementation files", () => {
  const dir = makeRepo();
  const graph = buildPlannerGraph(dir, { ...orientation, repoRoot: dir });
  const targets = selectFilesByGoalFromGraph("add a command", graph);
  assert.ok(targets.some((t) => t.path === "test/commands.test.ts" && /likely test/.test(t.reason)));
});

test("inferFilePlans prefers graph evidence and falls back to keyword heuristics when graph is empty", () => {
  const dir = makeRepo();
  const graph = buildPlannerGraph(dir, { ...orientation, repoRoot: dir });
  const graphTargets = selectFilesByGoalFromGraph("add a command", graph);
  const plans = inferFilePlans("add a command", { ...orientation, repoRoot: dir }, graphTargets);
  assert.ok(plans.some((p) => p.path === "src/commands.ts" && /graph evidence/.test(p.reason)));

  const emptyGraphTargets: never[] = [];
  const fallbackPlans = inferFilePlans("add a command", { ...orientation, repoRoot: dir }, emptyGraphTargets);
  assert.ok(fallbackPlans.some((p) => p.path === "src/commands.ts" && /fallback/.test(p.reason)));
});

test("autonomous blueprint selects command file as implementation target via graph evidence", async () => {
  const dir = makeRepo();
  const plan = await createAutonomousBlueprint({
    cwd: dir,
    userGoal: "add a new cheater command for hello with tests",
    taskType: "tooling",
    modelName: "qwen-9b"
  });
  const implementPacket = plan.workPackets.find((p) => p.type === "implement");
  assert.ok(implementPacket, "expected an implement packet");
  assert.ok(implementPacket!.filesToTouch.some((f) => /commands\.ts/.test(f.path)), `got ${JSON.stringify(implementPacket!.filesToTouch)}`);
  assert.ok(plan.intelligence!.packetFacts.some((f) => f.file === "src/commands.ts"));
});

test("structured bug-memory worker brief renders try/do-not/verify practical constraints", () => {
  const memoryHit: BlueprintMemoryHit = {
    id: "bug-1", source: "bug",
    summary: "bug type: null deref; symptom: crash; root cause: alpha; fix pattern: guard alpha; test signal: alpha crash signal",
    confidence: "high",
    keyFiles: ["src/alpha.ts"],
    testSignal: "alpha crash signal",
    matchReason: "matched because key files src/alpha.ts overlap",
    workflowSteps: ["reproduce crash", "inspect alpha", "add guard"],
    doNotDo: ["do not swallow the error", "do not wrap in try/catch silently"]
  };
  const packets = [
    { id: "implement-src-alpha", title: "t", type: "implement", status: "pending", dependsOn: [], estimatedModelCalls: 1, maxModelCalls: 1,
      filesToInspect: [{ path: "src/alpha.ts", reason: "r" }], filesToTouch: [{ path: "src/alpha.ts", reason: "r" }],
      allowedTools: [], forbiddenActions: [], promptContract: "", acceptanceCriteria: ["alpha guard added"], verification: [{ id: "v", command: "npm test", description: "x", required: true }], simulationChecks: [], risk: "medium" } as any
  ];
  const pack = buildBlueprintIntelligencePack({
    userGoal: "fix alpha crash", orientation, docsFacts: [], memoryHits: [memoryHit], packets, packetFacts: [],
    taskType: "bug_fix", modelName: "qwen-9b", config: DEFAULT_BLUEPRINT_CONFIG
  });
  assert.equal(pack.bugWorkflows.length, 1);
  const wf = pack.bugWorkflows[0];
  assert.deepEqual(wf.workflowSteps, ["reproduce crash", "inspect alpha", "add guard"]);
  assert.deepEqual(wf.doNotDo, ["do not swallow the error", "do not wrap in try/catch silently"]);
  assert.equal(wf.risk, "medium");
  assert.match(wf.applicabilityReason ?? "", /applies to implement-src-alpha/);
  const brief = packetScopedWorkerBrief({ intelligence: pack }, packets[0])!;
  assert.match(brief, /try repair pattern: guard alpha/);
  assert.match(brief, /do not make this bad fix: do not swallow the error/);
  assert.match(brief, /verify with: alpha crash signal/);
  assert.match(brief, /why matched: matched because/);
});

test("docs cache avoids repeated network fetches and is non-fatal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-docs-cache-"));
  mkdirSync(join(dir, ".cheater"), { recursive: true });
  const key = docsCacheKey("react hooks", "react", "official_allowlist");
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCount++; return new Response("<html><title>React</title><body>hooks components</body></html>", { headers: { "content-type": "text/html" } }); };
  try {
    await fetchOfficialDocsPages("hooks", "react");
    await fetchOfficialDocsPages("hooks", "react");
    writeDocsCache(dir, key, { query: "react hooks", library: "react", provider: "official_allowlist", facts: [{ query: "react hooks", packageOrLibrary: "react", sourceTitle: "React", sourceUrl: "https://react.dev", sourceDomain: "react.dev", claim: "cached claim", confidence: "high" }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const cached = readDocsCache(dir, key);
  assert.equal(cached.hit, true);
  assert.equal(cached.facts[0].claim, "cached claim");
  assert.ok(existsSync(join(docsCacheDir(dir), `${key}.json`)));

  const staleKey = docsCacheKey("different", "react", "official_allowlist");
  const stale = readDocsCache(dir, staleKey);
  assert.equal(stale.hit, false);
});

test("scoutOfficialDocs uses cache instead of network when cache is fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-scout-cache-"));
  mkdirSync(join(dir, ".cheater"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { react: "^18" } }));
  const key = docsCacheKey("react hooks", "react", "official_allowlist");
  writeDocsCache(dir, key, { query: "react hooks", library: "react", provider: "official_allowlist", facts: [{ query: "react hooks", packageOrLibrary: "react", sourceTitle: "React docs", sourceUrl: "https://react.dev", sourceDomain: "react.dev", claim: "cached hooks fact", confidence: "high" }] });
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCount++; return new Response("nope", { status: 500 }); };
  try {
    const facts = await scoutOfficialDocs({
      cwd: dir,
      query: "react hooks",
      config: { ...DEFAULT_BLUEPRINT_CONFIG, blueprintOfficialDocsSearchEnabled: true, blueprintDocsProvider: "official_allowlist", blueprintFetchDocsPages: false }
    });
    assert.equal(fetchCount, 0, "cache must prevent any network fetch");
    assert.ok(facts.some((f) => f.claim === "cached hooks fact"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("docs cache failure is non-fatal and scout falls back to local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-scout-nofetch-"));
  mkdirSync(join(dir, ".cheater"), { recursive: true });
  const facts = await scoutOfficialDocs({
    cwd: dir,
    query: "unknown thing",
    config: { ...DEFAULT_BLUEPRINT_CONFIG, blueprintOfficialDocsSearchEnabled: false }
  });
  assert.ok(Array.isArray(facts));
});

test("final review surfaces quality-gate warnings and debug notes distinctly", async () => {
  const dir = makeRepo();
  const plan = await createAutonomousBlueprint({
    cwd: dir,
    userGoal: "add a command with tests",
    taskType: "tooling",
    modelName: "qwen-9b"
  });
  const review = runFinalBlueprintReview(plan);
  assert.ok(review.debugNotes.some((n) => /quality gate/.test(n)));
  assert.ok(Array.isArray(review.blockingIssues));
  assert.ok(Array.isArray(review.nonBlockingWarnings));
  assert.ok(Array.isArray(review.debugNotes));
  assert.ok(!review.blockingIssues.includes("No final verification steps are recorded."));
  assert.equal(review.accepted, false);
});

test("final review surfaces quality-gate blocking issues when quality gate fails", async () => {
  const dir = makeRepo();
  const plan = await createAutonomousBlueprint({
    cwd: dir,
    userGoal: "add a command with tests",
    taskType: "tooling",
    modelName: "qwen-9b"
  });
  const failingPlan = {
    ...plan,
    qualityGate: { ...plan.qualityGate, blockingIssues: ["quality gate hard block: evidence missing"], remediationActions: ["Attach evidence before dispatch"], passed: false }
  };
  const review = runFinalBlueprintReview(failingPlan);
  assert.ok(review.blockingIssues.some((b) => /quality gate hard block/.test(b)));
  assert.ok(review.remediationActions?.includes("Attach evidence before dispatch"));
  assert.ok(review.suggestedRepairPackets[0]?.acceptanceCriteria.some((item) => /Attach evidence before dispatch/.test(item)));
});

test("eval harness shows graph_intelligence beats plain and basic for target+test selection", async () => {
  const dir = makeRepo();
  const orientation: RepoOrientation = {
    repoRoot: dir, languages: ["typescript"], frameworks: [], testCommands: ["npm test"],
    typecheckCommands: ["npm run build"], entrypoints: ["src/"], importantPaths: ["package.json"]
  };
  const results = await runBlueprintEval({
    cwd: dir,
    orientation,
    task: {
      goal: "add a cheater command for hello",
      taskType: "tooling",
      expectedFiles: ["src/commands.ts"],
      expectedTests: ["test/commands.test.ts"],
      expectedSymbols: ["registerCheaterCommands"],
      modelName: "qwen-9b"
    }
  });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.variant), ["plain", "basic_blueprint", "graph_intelligence"]);
  const scores = Object.fromEntries(results.map((r) => [r.variant, r.metrics.score]));
  assert.ok(scores.graph_intelligence > scores.plain, JSON.stringify(scores));
  assert.ok(scores.graph_intelligence > scores.basic_blueprint, JSON.stringify(scores));
  const graph = results.find((r) => r.variant === "graph_intelligence")!;
  assert.equal(graph.metrics.correctFileTarget, true);
  assert.equal(graph.metrics.likelyTestDiscovered, true);
  assert.equal(graph.metrics.doneCriteriaPresent, true);
  assert.equal(graph.metrics.qualityGateSurfaced, true);
  assert.equal(graph.metrics.briefBounded, true);
  assert.equal(graph.metrics.irrelevantBugMemoryIncluded, false);
  assert.equal(graph.metrics.mockEditMatchesExpectedFile, true, `mock edit file: ${graph.mockEdit.touchedFile}`);
  assert.equal(graph.metrics.localModelReady, true);
  assert.equal(graph.metrics.packetPromptBudgetFit, true);
  assert.equal(graph.metrics.oneFileWorkerScope, true);
  assert.equal(graph.metrics.handoffDisciplinePresent, true);
  const summary = summarizeEval(results);
  assert.match(summary, /graph_intelligence: score=/);
  assert.match(summary, /localReady=true/);
});

test("eval harness reports plain context lacks done criteria and quality gate", async () => {
  const dir = makeRepo();
  const results = await runBlueprintEval({
    cwd: dir,
    orientation: { ...orientation, repoRoot: dir },
    task: { goal: "add a command", expectedFiles: ["src/commands.ts"], expectedTests: ["test/commands.test.ts"] }
  });
  const plain = results.find((r) => r.variant === "plain")!;
  assert.equal(plain.metrics.doneCriteriaPresent, false);
  assert.equal(plain.metrics.qualityGateSurfaced, false);
  assert.equal(plain.metrics.correctFileTarget, false);
  assert.equal(plain.metrics.localModelReady, false);
  assert.equal(plain.metrics.handoffDisciplinePresent, false);
});

test("eval harness pipeline variant exercises the full autonomous pipeline offline", async () => {
  const dir = makeRepo();
  const results = await runBlueprintEval({
    cwd: dir,
    orientation: { ...orientation, repoRoot: dir },
    task: {
      goal: "add a cheater command for hello with tests",
      taskType: "tooling",
      expectedFiles: ["src/commands.ts"],
      expectedTests: ["test/commands.test.ts"],
      expectedSymbols: ["registerCheaterCommands"],
      modelName: "qwen-9b"
    }
  }, { includePipeline: true });
  assert.equal(results.length, 4);
  const pipeline = results.find((r) => r.variant === "graph_intelligence_pipeline")!;
  assert.ok(pipeline, "pipeline variant should be present");
  assert.equal(pipeline.metrics.correctFileTarget, true, `selectedFiles: ${JSON.stringify(pipeline.selectedFiles)}`);
  assert.equal(pipeline.metrics.qualityGateSurfaced, true);
  assert.equal(pipeline.metrics.doneCriteriaPresent, true);
  assert.equal(pipeline.metrics.mockEditMatchesExpectedFile, true, `mock edit: ${pipeline.mockEdit.touchedFile}`);
  assert.equal(pipeline.metrics.localModelReady, true);
  assert.equal(pipeline.metrics.packetPromptBudgetFit, true);
  assert.equal(pipeline.metrics.oneFileWorkerScope, true);
  const scores = Object.fromEntries(results.map((r) => [r.variant, r.metrics.score]));
  assert.ok(scores.graph_intelligence_pipeline >= scores.basic_blueprint, JSON.stringify(scores));
});
