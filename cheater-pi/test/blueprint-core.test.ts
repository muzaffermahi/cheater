import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomousBlueprint } from "../src/blueprint/autonomous.js";
import { createBlueprintPreview } from "../src/blueprint/preview.js";
import { generateBlueprintCandidates } from "../src/blueprint/planner.js";
import { buildPacketExecutionPrompts } from "../src/blueprint/executor.js";
import { scoreBlueprintCandidates, selectBestCandidate } from "../src/blueprint/candidateScorer.js";
import { buildPlanGraph, detectPlanCycles, topologicalPackets } from "../src/blueprint/planGraph.js";
import { scoutOfficialDocs, isOfficialAllowed, searxngOfficialFacts, inferLibrary, fetchOfficialDocsPages } from "../src/blueprint/docsScout.js";
import { blueprintPlanMemoryPath, disagreementGate, persistBlueprintArtifacts, retrievePlanningMemory } from "../src/blueprint/memory.js";
import { simulatePacket } from "../src/blueprint/checker.js";
import { DEFAULT_BLUEPRINT_CONFIG } from "../src/blueprint/config.js";
import { compactSettingsForCap, effectiveAgentTokenCap } from "../src/blueprint/worker.js";
import type { RepoOrientation } from "../src/blueprint/types.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cheater-blueprint-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCheaterCommands(pi: any) {\n  pi.registerCommand('cheater', {});\n}\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test';\ntest('commands', () => {});\n");
  writeFileSync(join(dir, "README.md"), "Cheater launches Pi with extension resources.\n");
  return dir;
}

const orientation: RepoOrientation = {
  repoRoot: "x",
  languages: ["typescript"],
  frameworks: [],
  testCommands: ["npm test"],
  typecheckCommands: ["npm run build"],
  entrypoints: ["src/extension.ts"],
  importantPaths: ["package.json"]
};

test("preview extracts hidden complexity", () => {
  const preview = createBlueprintPreview({
    userGoal: "add official docs search command, config, tests, and docs",
    taskType: "feature_addition",
    repoOrientation: orientation
  });
  assert.equal(preview.shouldUseBlueprint, true);
  assert.ok(preview.hiddenComplexitySignals.includes("command registration"));
  assert.ok(preview.hiddenComplexitySignals.includes("tests expected"));
});

test("candidates generate A/B/C with non-goals and verification", () => {
  const preview = createBlueprintPreview({ userGoal: "add a /hello command with tests", taskType: "tooling", repoOrientation: orientation });
  const candidates = generateBlueprintCandidates({ preview, orientation, count: 3 });
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((candidate) => candidate.strategy), ["minimal", "architecture_clean", "test_safety_first"]);
  assert.ok(candidates.every((candidate) => candidate.nonGoals.some((goal) => /standalone/.test(goal))));
  assert.ok(candidates.every((candidate) => candidate.verification.length > 0));
  const implementationPackets = candidates[0].workPackets.filter((packet) => packet.type === "implement");
  assert.ok(implementationPackets.length >= 1);
  assert.ok(implementationPackets.every((packet) => packet.filesToTouch.length <= 1));
  assert.ok(implementationPackets.every((packet) => /fresh-agent run/.test(packet.promptContract)));
});

test("frontend modernization packets prefer surgical template/style targets", () => {
  const frontendOrientation: RepoOrientation = {
    ...orientation,
    importantPaths: ["templates/base.html", "templates/turtles.html", "static/css/style.css"],
    entrypoints: ["templates/", "static/"]
  };
  const preview = createBlueprintPreview({ userGoal: "refactor the frontend to be modern and no issues", taskType: "refactor", repoOrientation: frontendOrientation });
  const candidate = generateBlueprintCandidates({ preview, orientation: frontendOrientation, count: 1 })[0];
  const implementationPackets = candidate.workPackets.filter((packet) => packet.type === "implement");
  assert.ok(implementationPackets.some((packet) => packet.filesToTouch.some((file) => /templates\/base\.html/.test(file.path))));
  assert.ok(implementationPackets.every((packet) => packet.filesToTouch.length <= 1));
  assert.ok(implementationPackets.every((packet) => /cheater_line_edit/.test(packet.allowedTools.join(" "))));
  assert.ok(implementationPackets.every((packet) => /Do not rewrite a whole existing file/.test(packet.promptContract)));
});

test("packet execution prompts are isolated fresh-agent handoffs", () => {
  const preview = createBlueprintPreview({ userGoal: "add a command and docs", taskType: "tooling", repoOrientation: orientation });
  const candidate = generateBlueprintCandidates({ preview, orientation, count: 1 })[0];
  const prompts = buildPacketExecutionPrompts({
    id: "plan",
    createdAt: new Date(0).toISOString(),
    repoRoot: "x",
    userGoal: preview.userGoal,
    preview,
    selectedCandidateId: candidate.id,
    candidates: [candidate],
    scores: [],
    summary: candidate.summary,
    nonGoals: candidate.nonGoals,
    assumptions: candidate.assumptions,
    repoOrientation: orientation,
    docsFacts: [{ query: "react hooks", packageOrLibrary: "react", sourceTitle: "React docs", sourceUrl: "https://react.dev/reference/react", sourceDomain: "react.dev", claim: "Use official React docs.", confidence: "medium" }],
    memoryHits: [],
    roleSeparation: {
      plannerSessionId: "planner-1",
      plannerRole: "blueprint_planner",
      workerRole: "fresh_code_worker",
      invariant: "planner and workers are separate",
      enforcement: ["fresh worker session per packet"]
    },
    qualityGate: {
      score: 90,
      passed: true,
      strengths: ["planner/worker separation is explicit"],
      blockingIssues: [],
      warnings: [],
      requiredSections: ["Mission"],
      localModelFit: "excellent"
    },
    artifactMarkdown: "# Cheater Blueprint",
    intelligence: {
      title: "Implementation blueprint",
      evidence: [],
      architectureDecisions: [],
      implementationInvariants: ["Workers stay isolated."],
      bugWorkflows: [],
      packetFacts: [{ packetId: "implement-src-commands-ts", file: "src/commands.ts", facts: ["src/commands.ts registers commands"] }],
      webEvidence: [],
      webSearchTriggers: [],
      contextBudget: { modelName: "qwen3.6-9b", modelClass: "small", plannerTokens: 12000, workerTokens: 10000, maxFactsPerPacket: 4, maxFilesPerWorker: 1, maxOutputTokens: 500, compressionRules: [] },
      webSearch: { required: true, provider: "official_allowlist", queries: ["react hooks"], allowedDomains: ["react.dev"], status: "completed" },
      workerBrief: "BLUEPRINT INTELLIGENCE PACK\nImplementation invariants:\n- Workers stay isolated."
    },
    planGraph: { nodes: [], edges: [] },
    workPackets: candidate.workPackets,
    finalReview: { id: "final", checks: [], required: true },
    constraints: candidate.constraints,
    risks: candidate.risks,
    verification: candidate.verification,
    approval: "auto_approved",
    confidence: 1
  }, { model: "qwen3.6-9b" });
  assert.ok(prompts.some((prompt) => /fresh-agent packet/.test(prompt.prompt)));
  assert.ok(prompts.every((prompt) => /compact handoff summary/.test(prompt.prompt)));
  assert.ok(prompts.some((prompt) => /https:\/\/react\.dev\/reference\/react/.test(prompt.prompt)));
  assert.ok(prompts.some((prompt) => /BLUEPRINT INTELLIGENCE PACK/.test(prompt.prompt)));
  assert.ok(prompts.some((prompt) => /modelClass: small/.test(prompt.prompt)));
  assert.ok(prompts.some((prompt) => /Read at most one target file region/.test(prompt.prompt)));
});

test("fresh worker packets include model-budgeted target snippets", async () => {
  const dir = repo();
  const plan = await createAutonomousBlueprint({
    cwd: dir,
    userGoal: "add a /hello command with tests",
    taskType: "tooling",
    modelName: "qwen3.6-9b"
  });
  const prompts = buildPacketExecutionPrompts(plan, { model: "qwen3.6-9b" });
  const commandPrompt = prompts.find((prompt) => /implement-src-commands-ts/.test(prompt.packetId));
  assert.ok(commandPrompt);
  assert.match(commandPrompt!.prompt, /relevantSnippets:/);
  assert.match(commandPrompt!.prompt, /--- src\/commands\.ts excerpt ---/);
  assert.match(commandPrompt!.prompt, /registerCheaterCommands/);
  assert.match(commandPrompt!.prompt, /modelClass: small/);
});

test("worker token cap clamps to configured/model window and never exceeds 100000", () => {
  assert.equal(effectiveAgentTokenCap({ blueprintMaxAgentTokens: 120000 }), 100000);
  assert.equal(effectiveAgentTokenCap({ maxContextTokens: 120000 }), 100000);
  assert.equal(effectiveAgentTokenCap({ maxContextTokens: 90000 }, 32768), 32768);
  assert.equal(effectiveAgentTokenCap({ blueprintMaxAgentTokens: 32000 }), 32000);
  const settings = compactSettingsForCap(200000, 100000, 85000);
  assert.equal(settings.enabled, true);
  assert.equal(settings.reserveTokens, 115000);
  assert.equal(settings.keepRecentTokens, 12000);
});

test("scoring selects highest valid candidate and rejects old mistakes", () => {
  const preview = createBlueprintPreview({ userGoal: "add a command", taskType: "tooling", repoOrientation: orientation });
  const candidates = generateBlueprintCandidates({ preview, orientation, count: 3 });
  candidates[0].workPackets = candidates[0].workPackets.filter((packet) => packet.type !== "review");
  const scores = scoreBlueprintCandidates(candidates);
  assert.equal(scores.find((score) => score.candidateId === candidates[0].id)?.valid, false);
  const best = selectBestCandidate(candidates, scores);
  assert.notEqual(best.id, candidates[0].id);
});

test("plan graph orders dependencies and detects cycles", () => {
  const preview = createBlueprintPreview({ userGoal: "add a command", taskType: "tooling", repoOrientation: orientation });
  const packets = generateBlueprintCandidates({ preview, orientation, count: 1 })[0].workPackets;
  const graph = buildPlanGraph(packets);
  assert.equal(detectPlanCycles(graph).length, 0);
  assert.equal(topologicalPackets(packets)[0].id, "inspect");
  assert.ok(graph.nodes.some((node) => node.id === "review"));
});

test("simulation marks packets clear when acceptance and verification exist", () => {
  const preview = createBlueprintPreview({ userGoal: "add a command", taskType: "tooling", repoOrientation: orientation });
  const packet = generateBlueprintCandidates({ preview, orientation, count: 1 })[0].workPackets.find((item) => item.type === "implement");
  assert.ok(packet);
  const simulated = simulatePacket(packet!);
  assert.equal(simulated.simulationChecks[0].clear, true);
});

test("docs scout stays local by default and SearXNG rejects disallowed domains", async () => {
  const dir = repo();
  const facts = await scoutOfficialDocs({
    cwd: dir,
    query: "Cheater Pi extension",
    config: { ...DEFAULT_BLUEPRINT_CONFIG, blueprintOfficialDocsSearchEnabled: false }
  });
  assert.equal(facts[0].sourceDomain, "local");
  assert.equal(isOfficialAllowed("https://random.example.com/post", "react"), false);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [
      { title: "bad", url: "https://random.example.com/react", content: "nope" },
      { title: "good", url: "https://react.dev/reference/react", content: "official" }
    ]
  }), { headers: { "content-type": "application/json" } });
  const remote = await searxngOfficialFacts("hooks", "react", "https://search.example/search");
  globalThis.fetch = originalFetch;
  assert.equal(remote.length, 1);
  assert.equal(remote[0].sourceDomain, "react.dev");
  assert.deepEqual(await searxngOfficialFacts("hooks", "react", "not a url"), []);
});

test("docs scout can infer official docs target from repo manifests when enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-docs-scout-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
  assert.equal(inferLibrary("find official docs for this test runner", dir), "vitest");
  const facts = await scoutOfficialDocs({
    cwd: dir,
    query: "find official docs for this test runner",
    config: { ...DEFAULT_BLUEPRINT_CONFIG, blueprintOfficialDocsSearchEnabled: true, blueprintDocsProvider: "official_allowlist" }
  });
  assert.equal(facts.some((fact) => fact.packageOrLibrary === "vitest" && fact.sourceDomain === "vitest.dev"), true);
});

test("official docs page fetch extracts allowlisted page claims", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><head><title>React Reference</title></head><body><main>Hooks let you use different React features from your components. Components should stay pure.</main></body></html>", { headers: { "content-type": "text/html" } });
  const facts = await fetchOfficialDocsPages("React hooks components", "react");
  globalThis.fetch = originalFetch;
  assert.ok(facts.length >= 1);
  assert.equal(facts[0].sourceDomain, "react.dev");
  assert.equal(facts[0].confidence, "high");
  assert.match(facts[0].claim, /Hooks|components/i);
});

test("memory disagreement gate excludes conflicting memories", () => {
  const gated = disagreementGate({
    orientation,
    docsFacts: [],
    memoryHits: [
      { id: "1", source: "project", summary: "python flask workaround", confidence: "medium" },
      { id: "2", source: "project", summary: "typescript cheater pi command pattern", confidence: "medium" }
    ]
  });
  assert.deepEqual(gated.trustedMemory.map((hit) => hit.id), ["2"]);
  assert.deepEqual(gated.excluded, ["memory:1"]);
});

test("autonomous blueprint creates internal plan and final review blocks unfinished packets", async () => {
  const plan = await createAutonomousBlueprint({ cwd: repo(), userGoal: "add a /hello command with tests and docs", taskType: "tooling", modelName: "qwen3.6-35b-a3b" });
  assert.equal(plan.candidates.length, 3);
  assert.ok(plan.intelligence);
  assert.ok(plan.intelligence!.evidence.length > 0);
  assert.ok(plan.intelligence!.architectureDecisions.some((decision) => /fresh worker/i.test(decision.decision)));
  assert.ok(plan.intelligence!.implementationInvariants.some((invariant) => /one touched file/i.test(invariant)));
  assert.ok(plan.intelligence!.packetFacts.some((fact) => fact.file === "src/commands.ts" && fact.facts.some((item) => /registers commands/.test(item))));
  assert.equal(plan.intelligence!.webSearch.required, true);
  assert.match(plan.artifactMarkdown, /# Cheater Blueprint/);
  assert.match(plan.artifactMarkdown, /## Agent Separation/);
  assert.match(plan.artifactMarkdown, /## Packet Runbook/);
  assert.equal(plan.roleSeparation.plannerRole, "blueprint_planner");
  assert.equal(plan.roleSeparation.workerRole, "fresh_code_worker");
  assert.equal(plan.intelligence!.contextBudget.modelClass, "large");
  assert.equal(plan.qualityGate.passed, true);
  assert.ok(plan.qualityGate.score >= 72);
  assert.match(plan.artifactMarkdown, /## Local Model Execution Profile/);
  assert.match(plan.artifactMarkdown, /## Quality Gate/);
  assert.equal(plan.workPackets.some((packet) => packet.type === "review"), true);
  assert.equal(plan.approval, "auto_approved");
});

test("blueprint artifacts persist and become future planning memory", async () => {
  const dir = repo();
  const plan = await createAutonomousBlueprint({
    cwd: dir,
    userGoal: "add a /hello command with tests and docs",
    taskType: "tooling",
    modelName: "qwen3.6-35b-a3b"
  });
  const artifacts = persistBlueprintArtifacts(dir, plan);
  assert.ok(existsSync(artifacts.markdownPath));
  assert.ok(existsSync(artifacts.jsonPath));
  assert.equal(artifacts.memoryPath, blueprintPlanMemoryPath(dir));
  assert.match(readFileSync(artifacts.markdownPath, "utf8"), /# Cheater Blueprint/);
  const hits = retrievePlanningMemory(dir, "hello command tests docs", true);
  assert.ok(hits.some((hit) => hit.source === "plan" && hit.id === plan.id));
});

