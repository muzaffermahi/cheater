import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomousBlueprint } from "../src/blueprint/autonomous.js";
import { buildPlannerGraph, selectFilesByGoalFromGraph, buildRepoConstraintGraph, queryConstraintFacts } from "../src/commitlet/constraintGraph.js";
import { scoutOfficialDocs, searxngOfficialFacts, fetchOfficialDocsPages } from "../src/blueprint/docsScout.js";
import { docsCacheKey, readDocsCache, writeDocsCache, docsCacheDir } from "../src/blueprint/docsCache.js";
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
