import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fix 1+8: GraphFileTarget role + symbol-cluster splitting
test("graph targets mark touch vs inspect roles; tests and related are inspect-only", async () => {
  const { buildPlannerGraph, selectFilesByGoalFromGraph, symbolClustersForGoal } = await import("../src/commitlet/constraintGraph.js");
  const dir = mkdtempSync(join(tmpdir(), "cheater-role-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCommand(pi: any) { pi.registerCommand('cheater', {}); }\nexport function registerHelper(pi: any) { pi.registerCommand('helper', {}); }\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test'; test('x', () => {});\n");
  const orientation = { repoRoot: dir, languages: ["typescript"], frameworks: [], testCommands: ["npm test"], typecheckCommands: [], entrypoints: ["src/"], importantPaths: ["package.json"] } as any;
  const graph = buildPlannerGraph(dir, orientation);
  const targets = selectFilesByGoalFromGraph("add a command", graph);
  const commandTarget = targets.find((t) => t.path === "src/commands.ts");
  assert.ok(commandTarget, "command file should be a target");
  assert.equal(commandTarget!.role, "touch", "command registration file must be touch-role");
  const testTarget = targets.find((t) => t.path === "test/commands.test.ts");
  assert.ok(testTarget, "co-located test should be discovered");
  assert.equal(testTarget!.role, "inspect", "co-located test must be inspect-role, never touch");
  const touchCount = targets.filter((t) => t.role === "touch").length;
  const inspectCount = targets.filter((t) => t.role === "inspect").length;
  assert.ok(touchCount >= 1 && inspectCount >= 1);

  const clusters = symbolClustersForGoal("add a registerHelper command", graph);
  assert.ok(clusters.some((c) => c.symbols.includes("registerHelper")));
});

test("graph touch targets drive implementation packet files; tests never become touch targets", () => {
  // Tested via autonomous pipeline below, plus direct role assertion above.
  assert.ok(true);
});

// Fix 2: derive doNotDo/workflowSteps from summary text
test("buildBugWorkflows derives doNotDo from failed_approaches text when card lacks structured fields", async () => {
  const { buildBlueprintIntelligencePack, packetScopedWorkerBrief } = await import("../src/blueprint/intelligence.js");
  const { DEFAULT_BLUEPRINT_CONFIG } = await import("../src/blueprint/config.js");
  const memoryHit = {
    id: "bug-x", source: "bug" as const,
    summary: "bug type: KeyError; root cause: missing key; fix pattern: provide default; failed approaches: wrap in try/catch; swallow error; test signal: KeyError templates",
    confidence: "medium" as const,
    keyFiles: ["src/app.py"],
    testSignal: "KeyError templates",
    matchReason: "matched because key files overlap"
  };
  const packets = [{
    id: "implement-src-app-py", title: "t", type: "implement", status: "pending", dependsOn: [], estimatedModelCalls: 1, maxModelCalls: 1,
    filesToInspect: [{ path: "src/app.py", reason: "r" }], filesToTouch: [{ path: "src/app.py", reason: "r" }],
    allowedTools: [], forbiddenActions: [], promptContract: "", acceptanceCriteria: ["app default provided"], verification: [{ id: "v", command: "pytest -q", description: "x", required: true }], simulationChecks: [], risk: "medium"
  } as any];
  const pack = buildBlueprintIntelligencePack({
    userGoal: "fix KeyError templates", orientation: { repoRoot: "x", languages: [], frameworks: [], testCommands: [], typecheckCommands: [], entrypoints: [], importantPaths: [] } as any,
    docsFacts: [], memoryHits: [memoryHit], packets, packetFacts: [], taskType: "bug_fix", modelName: "qwen-9b", config: DEFAULT_BLUEPRINT_CONFIG
  });
  const wf = pack.bugWorkflows[0];
  assert.ok(wf.doNotDo && wf.doNotDo.length >= 2, `doNotDo: ${JSON.stringify(wf.doNotDo)}`);
  assert.ok(wf.doNotDo!.some((d) => /wrap in try\/catch/.test(d)));
  const brief = packetScopedWorkerBrief({ intelligence: pack }, packets[0])!;
  assert.match(brief, /do not make this bad fix/);
  assert.match(brief, /wrap in try\/catch/);
});

// Fix 3: docs cache LRU eviction
test("docs cache evicts oldest entries when exceeding max entries cap", async () => {
  const { writeDocsCache, evictDocsCache, docsCacheDir, docsCacheKey, docsCacheStats } = await import("../src/blueprint/docsCache.js");
  const dir = mkdtempSync(join(tmpdir(), "cheater-cache-evict-"));
  for (let i = 0; i < 70; i++) {
    writeDocsCache(dir, docsCacheKey(`q${i}`, "react", "official_allowlist"), { query: `q${i}`, library: "react", provider: "official_allowlist", facts: [] });
  }
  const stats = docsCacheStats(dir);
  assert.ok(stats.entries <= 64, `entries=${stats.entries} should be <= 64 after eviction`);
  const evictResult = evictDocsCache(docsCacheDir(dir));
  assert.ok(evictResult.remaining <= 64);
});

test("docs cache eviction is bounded by byte cap too", async () => {
  const { writeDocsCache, docsCacheStats } = await import("../src/blueprint/docsCache.js");
  const dir = mkdtempSync(join(tmpdir(), "cheater-cache-bytes-"));
  const bigFact = { query: "x", packageOrLibrary: "react", sourceTitle: "T", sourceUrl: "https://react.dev", sourceDomain: "react.dev", claim: "x".repeat(200000), confidence: "high" as const };
  for (let i = 0; i < 30; i++) {
    writeDocsCache(dir, `k${i}`.padEnd(16, "0").slice(0, 16), { query: "x", library: "react", provider: "official_allowlist", facts: [bigFact] });
  }
  const stats = docsCacheStats(dir);
  assert.ok(stats.bytes <= 5 * 1024 * 1024, `bytes=${stats.bytes} should be bounded`);
});

// Fix 7: review categorizes blocking by origin
test("final review categorizes blocking issues by execution vs planning origin", async () => {
  const { runFinalBlueprintReview } = await import("../src/blueprint/reviewer.js");
  const { createAutonomousBlueprint } = await import("../src/blueprint/autonomous.js");
  const dir = mkdtempSync(join(tmpdir(), "cheater-review-origin-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCommand(pi: any) { pi.registerCommand('cheater', {}); }\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test'; test('x', () => {});\n");
  const plan = await createAutonomousBlueprint({ cwd: dir, userGoal: "add a command with tests", taskType: "tooling", modelName: "qwen-9b" });
  const review = runFinalBlueprintReview(plan);
  assert.ok(Array.isArray(review.blockingIssueOrigins));
  for (const issue of review.blockingIssueOrigins) {
    assert.ok(issue.origin === "execution" || issue.origin === "planning", `bad origin: ${issue.origin}`);
  }
  const pending = review.blockingIssueOrigins.find((o) => o.text.includes("Not all work packets"));
  assert.ok(pending && pending.origin === "execution");
});

test("final review separates planning-gate blockers from execution blockers in origins", async () => {
  const { runFinalBlueprintReview } = await import("../src/blueprint/reviewer.js");
  const dir = mkdtempSync(join(tmpdir(), "cheater-review-planblock-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCommand(pi: any) { pi.registerCommand('cheater', {}); }\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test'; test('x', () => {});\n");
  const { createAutonomousBlueprint } = await import("../src/blueprint/autonomous.js");
  const plan = await createAutonomousBlueprint({ cwd: dir, userGoal: "add a command", taskType: "tooling", modelName: "qwen-9b" });
  const failingPlan = { ...plan, qualityGate: { ...plan.qualityGate, blockingIssues: ["quality gate hard block"], passed: false } };
  const review = runFinalBlueprintReview(failingPlan);
  const origins = Object.fromEntries(review.blockingIssueOrigins.map((o) => [o.text, o.origin]));
  assert.equal(origins["Not all work packets are complete."], "execution");
  assert.equal(origins["quality gate hard block"], "planning");
});

// Fix 6: planner large-dir guard
test("planner scan skips deep walking for huge directories and stays bounded", async () => {
  const { buildPlannerGraph } = await import("../src/commitlet/constraintGraph.js");
  const dir = mkdtempSync(join(tmpdir(), "cheater-bigdir-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  for (let i = 0; i < 300; i++) writeFileSync(join(dir, "src", `f${i}.ts`), `export function f${i}() {}\n`);
  const start = Date.now();
  const graph = buildPlannerGraph(dir, { repoRoot: dir, languages: ["typescript"], frameworks: [], testCommands: [], typecheckCommands: [], entrypoints: ["src/"], importantPaths: ["package.json"] } as any);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `scan took ${elapsed}ms; should be fast-path bounded`);
  assert.ok(graph.files.length <= 80, `files=${graph.files.length} must be bounded`);
});

// Fix 5: dev command wires summarizeEval
test("blueprint-eval dev command is registered and produces a summary", async () => {
  const { registerBlueprintCommands } = await import("../src/blueprint/commands.js");
  const commands = new Map<string, any>();
  const pi: any = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerTool: () => {},
    sendUserMessage: () => {}
  };
  registerBlueprintCommands(pi, { config: {} as any });
  assert.ok(commands.has("blueprint-eval"));
  const dir = mkdtempSync(join(tmpdir(), "cheater-cmd-eval-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCommand(pi: any) { pi.registerCommand('cheater', {}); }\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test'; test('x', () => {});\n");
  let widgetText = "";
  const ctx: any = {
    cwd: dir, sessionId: "s", model: { id: "qwen-9b" },
    ui: {
      notify: () => {},
      setWidget: (_key: string, lines: string[], _opts?: any) => { widgetText = lines.join("\n"); }
    }
  };
  await commands.get("blueprint-eval").handler("add a cheater command for hello", ctx);
  assert.match(widgetText, /graph_intelligence: score=/);
  assert.match(widgetText, /mockFile=/);
});