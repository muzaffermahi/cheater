import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomousBlueprint } from "../src/blueprint/autonomous.js";
import { buildBlueprintIntelligencePack, packetScopedWorkerBrief, doneCriteriaFor } from "../src/blueprint/intelligence.js";
import { evaluateBlueprintQuality } from "../src/blueprint/qualityGate.js";
import { DEFAULT_BLUEPRINT_CONFIG } from "../src/blueprint/config.js";
import { buildRepoConstraintGraph, queryConstraintFacts } from "../src/commitlet/constraintGraph.js";
import { renderBlueprintArtifact } from "../src/blueprint/artifact.js";
import type {
  BlueprintArchitectureDecision,
  BlueprintEvidenceItem,
  BlueprintMemoryHit,
  BlueprintPacketFact,
  OfficialDocsFact,
  RepoOrientation,
  WorkPacket
} from "../src/blueprint/types.js";

const orientation: RepoOrientation = {
  repoRoot: "x",
  languages: ["typescript"],
  frameworks: [],
  testCommands: ["npm test"],
  typecheckCommands: ["npm run build"],
  entrypoints: ["src/extension.ts"],
  importantPaths: ["package.json"]
};

function makePacket(overrides: Partial<WorkPacket> & Pick<WorkPacket, "id" | "filesToTouch" | "filesToInspect">): WorkPacket {
  return {
    title: overrides.id,
    type: "implement",
    status: "pending",
    dependsOn: [],
    estimatedModelCalls: 1,
    maxModelCalls: 1,
    allowedTools: ["read", "edit"],
    forbiddenActions: ["standalone TUI"],
    promptContract: "fresh-agent run",
    acceptanceCriteria: [`${overrides.id} behavior implemented`],
    verification: [{ id: "v", command: "npm test", description: "run tests", required: true }],
    simulationChecks: [
      {
        packetId: overrides.id,
        expectedFileChanges: overrides.filesToTouch.map((file) => file.path),
        expectedBehaviorChanges: [`${overrides.id} behavior implemented`],
        edgeCases: ["existing behavior should remain intact"],
        failureModes: ["wrong file touched", "verification omitted", "packet scope expands"],
        verificationMethod: "npm test",
        clear: true
      }
    ],
    risk: "low",
    ...overrides
  };
}

test("packetScopedWorkerBrief is bounded, packet-local, and carries failure modes + done criteria", () => {
  const packets = [
    makePacket({ id: "implement-src-alpha", filesToInspect: [{ path: "src/alpha.ts", reason: "r" }], filesToTouch: [{ path: "src/alpha.ts", reason: "r" }] }),
    makePacket({ id: "implement-src-beta", filesToInspect: [{ path: "src/beta.ts", reason: "r" }], filesToTouch: [{ path: "src/beta.ts", reason: "r" }] })
  ];
  const packetFacts: BlueprintPacketFact[] = [
    { packetId: "implement-src-alpha", file: "src/alpha.ts", facts: ["src/alpha.ts registers commands", "test/alpha.test.ts likely tests src/alpha.ts"] },
    { packetId: "implement-src-beta", file: "src/beta.ts", facts: ["src/beta.ts registers tools"] }
  ];
  const decisions: BlueprintArchitectureDecision[] = [
    { id: "d1", decision: "workers stay isolated", rationale: "r", appliesTo: ["implement-src-alpha"], riskIfIgnored: "drift" }
  ];
  const pack = buildBlueprintIntelligencePack({
    userGoal: "add alpha and beta features",
    orientation,
    docsFacts: [],
    memoryHits: [],
    packets,
    packetFacts,
    modelName: "qwen-9b",
    config: DEFAULT_BLUEPRINT_CONFIG
  });
  pack.architectureDecisions = decisions;
  const alphaBrief = packetScopedWorkerBrief({ intelligence: pack }, packets[0])!;
  const betaBrief = packetScopedWorkerBrief({ intelligence: pack }, packets[1])!;

  assert.match(alphaBrief, /Packet: implement-src-alpha/);
  assert.match(alphaBrief, /src\/alpha\.ts registers commands/);
  assert.match(alphaBrief, /test\/alpha\.test\.ts likely tests/);
  assert.doesNotMatch(alphaBrief, /registers tools/);
  assert.doesNotMatch(betaBrief, /alpha\.test\.ts/);
  assert.match(alphaBrief, /workers stay isolated/);
  assert.doesNotMatch(betaBrief, /workers stay isolated/);
  assert.match(alphaBrief, /Likely failure modes:/);
  assert.match(alphaBrief, /wrong file touched/);
  assert.match(alphaBrief, /Done criteria:/);
  assert.match(alphaBrief, /verification passes: npm test/);

  const fullBrief = pack.workerBrief;
  assert.ok(alphaBrief.length <= 4000, "scoped worker brief stays small for a 9b-class model");
  assert.ok(!/src\/beta\.ts/.test(alphaBrief), "scoped brief must not dump another packet's file facts");
  assert.ok(fullBrief.length > 0);
});

test("bug-memory workflows apply only to packets overlapping key files or test signals", () => {
  const memoryHits: BlueprintMemoryHit[] = [
    {
      id: "bug-alpha-rootcause",
      source: "bug",
      summary: "bug type: null deref; symptom: crash; root cause: alpha; fix pattern: guard alpha; test signal: alpha crash signal",
      confidence: "high",
      keyFiles: ["src/alpha.ts"],
      testSignal: "alpha crash signal",
      matchReason: "matched because key files src/alpha.ts overlap the plan target"
    }
  ];
  const packets = [
    makePacket({ id: "implement-src-alpha", filesToInspect: [{ path: "src/alpha.ts", reason: "r" }], filesToTouch: [{ path: "src/alpha.ts", reason: "r" }] }),
    makePacket({ id: "implement-src-beta", filesToInspect: [{ path: "src/beta.ts", reason: "r" }], filesToTouch: [{ path: "src/beta.ts", reason: "r" }] })
  ];
  const pack = buildBlueprintIntelligencePack({
    userGoal: "fix the alpha crash",
    orientation,
    docsFacts: [],
    memoryHits,
    packets,
    packetFacts: [],
    taskType: "bug_fix",
    modelName: "qwen-9b",
    config: DEFAULT_BLUEPRINT_CONFIG
  });

  assert.equal(pack.bugWorkflows.length, 1);
  const workflow = pack.bugWorkflows[0];
  assert.ok(workflow.appliesTo.includes("implement-src-alpha"), `${JSON.stringify(workflow.appliesTo)}`);
  assert.ok(!workflow.appliesTo.includes("implement-src-beta"));
  assert.match(workflow.matchReason, /key files/i);
  assert.match(workflow.matchReason, /applies to implement-src-alpha/);

  const alphaBrief = packetScopedWorkerBrief({ intelligence: pack }, packets[0])!;
  const betaBrief = packetScopedWorkerBrief({ intelligence: pack }, packets[1])!;
  assert.match(alphaBrief, /Bug-memory workflows \(1\):/);
  assert.match(alphaBrief, /guard alpha/);
  assert.match(alphaBrief, /matched because/);
  assert.match(betaBrief, /Bug-memory workflows: none/);
});

test("irrelevant bug memory does not pollute a normal feature task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-bug-irrelevance-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, ".cheater"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCheaterCommands(pi: any) { pi.registerCommand('cheater', {}); }\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test';\ntest('commands', () => {});\n");
  writeFileSync(join(dir, ".cheater", "bug_memories.jsonl"), JSON.stringify({
    id: "unrelated-flask-bug",
    repo: "other/project",
    language: "Python",
    bug_type: "flask KeyError",
    symptom: "KeyError in flask templates",
    root_cause: "flask template context missing key",
    fix_pattern: "provide template context default",
    failed_approaches: [],
    key_files: ["app/views.py"],
    search_keywords: ["flask", "template", "keyerror"],
    test_signal: "KeyError templates",
    embedding_text: "flask KeyError",
    quality_score: 1,
    quality_tier: "high"
  }) + "\n");

  const plan = await createAutonomousBlueprint({
    cwd: dir,
    userGoal: "add a hello user command with tests",
    taskType: "tooling",
    modelName: "qwen-9b"
  });

  assert.equal(plan.intelligence!.bugWorkflows.length, 0);
  assert.ok(!plan.intelligence!.evidence.some((item) => item.kind === "memory"));
  assert.ok(!plan.memoryHits.some((hit) => hit.source === "bug"));
});

test("bug-memory retrieval for a bug-fix task produces a workflow with a match reason and targeted appliesTo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-bug-relevance-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, ".cheater"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
  writeFileSync(join(dir, "src", "commands.ts"), "export function registerCheaterCommands(pi: any) { pi.registerCommand('cheater', {}); }\n");
  writeFileSync(join(dir, "test", "commands.test.ts"), "import test from 'node:test';\ntest('commands', () => {});\n");
  writeFileSync(join(dir, ".cheater", "bug_memories.jsonl"), JSON.stringify({
    id: "command-registration-crash",
    repo: "other/cli",
    language: "TypeScript",
    bug_type: "command registration TypeError",
    symptom: "TypeError when registerCommand called twice",
    root_cause: "command id reused without guard",
    fix_pattern: "guard duplicate command registration",
    failed_approaches: [],
    key_files: ["src/commands.ts"],
    search_keywords: ["registercommand", "typeerror", "commands", "registration"],
    test_signal: "TypeError registerCommand commands",
    embedding_text: "registerCommand TypeError",
    quality_score: 0.95,
    quality_tier: "high"
  }) + "\n");

  const plan = await createAutonomousBlueprint({
    cwd: dir,
    userGoal: "fix the TypeError when registerCommand is called twice for the commands file",
    taskType: "bug_fix",
    modelName: "qwen-9b"
  });

  const commandPacket = plan.workPackets.find((p) => p.type === "implement" && p.filesToTouch.some((f) => /commands\.ts/.test(f.path)));
  assert.ok(commandPacket, "expected an implement packet touching commands.ts");
  assert.equal(plan.intelligence!.bugWorkflows.length, 1);
  const workflow = plan.intelligence!.bugWorkflows[0];
  assert.match(workflow.matchReason, /matched because/);
  assert.ok(workflow.appliesTo.includes(commandPacket!.id));
});

test("constraint graph discovers co-located test files for touched source files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-constraint-tests-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src", "parser.ts"), "export function parse(input: string) { return input; }\n");
  writeFileSync(join(dir, "test", "parser.test.ts"), "import test from 'node:test';\ntest('parse', () => {});\n");
  const graph = buildRepoConstraintGraph(dir, ["src/parser.ts"]);
  const facts = queryConstraintFacts(graph, "src/parser.ts");
  assert.ok(facts.some((fact) => /test\/parser\.test\.ts likely tests src\/parser\.ts/.test(fact)), facts.join(" | "));
});

test("quality gate flags missing test signal, vague criteria, and risky API guesses with concise warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-qg-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
  writeFileSync(join(dir, "src", "feature.ts"), "export function feature() { return 1; }\n");
  const implementNoSignal = makePacket({
    id: "implement-src-feature",
    type: "implement",
    filesToInspect: [{ path: "src/feature.ts", reason: "r" }],
    filesToTouch: [{ path: "src/feature.ts", reason: "r" }],
    acceptanceCriteria: ["Use React.useState hook for state in feature"],
    verification: [{ id: "manual-review", description: "manual review", required: true }]
  });
  const implementVague = makePacket({
    id: "implement-src-vague",
    type: "implement",
    filesToInspect: [{ path: "src/vague.ts", reason: "r" }],
    filesToTouch: [{ path: "src/vague.ts", reason: "r" }],
    acceptanceCriteria: ["Packet outcome is explicitly verified before proceeding."],
    verification: [{ id: "manual-review", description: "manual review", required: true }],
    risk: "low"
  });
  const plan = {
    id: "plan",
    createdAt: new Date(0).toISOString(),
    repoRoot: dir,
    userGoal: "add a feature",
    preview: {
      id: "p", userGoal: "", taskType: "feature_addition", taskSummary: "",
      hiddenComplexitySignals: [], likelyRelevantAreas: [], likelyRisks: [], shouldUseBlueprint: true, reason: ""
    },
    selectedCandidateId: "c",
    candidates: [],
    scores: [],
    summary: "",
    nonGoals: ["none"],
    assumptions: ["none"],
    repoOrientation: { ...orientation, repoRoot: dir, frameworks: [], languages: ["typescript"] },
    docsFacts: [] as OfficialDocsFact[],
    memoryHits: [] as BlueprintMemoryHit[],
    intelligence: {
      title: "", evidence: [
        { id: "e1", kind: "repo", claim: "Languages: typescript", source: "x", confidence: "high", useInPackets: ["implement-src-feature"] },
        { id: "e2", kind: "repo", claim: "Tests: npm test", source: "x", confidence: "high", useInPackets: ["implement-src-feature"] },
        { id: "e3", kind: "repo", claim: "Build: npm run build", source: "x", confidence: "high", useInPackets: ["implement-src-feature"] }
      ], architectureDecisions: [
        { id: "d1", decision: "dec1", rationale: "r", appliesTo: ["implement-src-feature"], riskIfIgnored: "x" },
        { id: "d2", decision: "dec2", rationale: "r", appliesTo: ["implement-src-feature"], riskIfIgnored: "x" },
        { id: "d3", decision: "dec3", rationale: "r", appliesTo: ["implement-src-feature"], riskIfIgnored: "x" }
      ], implementationInvariants: ["a", "b", "c", "d"],
      bugWorkflows: [], packetFacts: [
        { packetId: "implement-src-feature", file: "src/feature.ts", facts: ["src/feature.ts registers commands"] }
      ],
      contextBudget: {
        modelName: "qwen-9b", modelClass: "9b", plannerTokens: 12000, workerTokens: 10000,
        maxFactsPerPacket: 4, maxFilesPerWorker: 1, maxOutputTokens: 500, compressionRules: []
      },
      webSearch: { required: false, provider: "local", queries: [], allowedDomains: [], status: "local_only" },
      workerBrief: "BLUEPRINT INTELLIGENCE PACK"
    },
    roleSeparation: {
      plannerSessionId: "p", plannerRole: "blueprint_planner", workerRole: "fresh_code_worker",
      invariant: "planner never edits; workers are fresh",
      enforcement: ["a", "b", "c", "d"]
    },
    planGraph: { nodes: [], edges: [] },
    workPackets: [implementNoSignal, implementVague, makePacket({ id: "review", type: "review", filesToInspect: [], filesToTouch: [], verification: [{ id: "final", command: "npm test", description: "x", required: true }] })],
    finalReview: { id: "final", checks: [], required: true },
    constraints: ["c"], risks: ["r"],
    verification: [{ id: "v", command: "npm test", description: "x", required: true }],
    approval: "auto_approved" as const,
    confidence: 0.5
  };

  const quality = evaluateBlueprintQuality(plan as any);
  const joined = [...quality.warnings, ...quality.blockingIssues].join(" | ");
  assert.match(joined, /implement-src-feature.*no test signal/);
  assert.match(joined, /implement-src-vague.*vague success criteria/);
  assert.match(joined, /implement-src-feature.*references React\.useState without repo or docs evidence/);
  assert.ok(quality.remediationActions?.some((action) => /focused test mapping.*implement-src-feature/.test(action)));
  assert.ok(quality.remediationActions?.some((action) => /React\.useState/.test(action)));
  assert.equal(quality.passed, true, "these are warnings, not blockers: " + JSON.stringify(quality.blockingIssues));
});

test("quality gate blocks evidence-required web tasks without remote evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-web-qg-"));
  const packets = [
    makePacket({ id: "inspect", type: "inspect", filesToInspect: [{ path: "package.json", reason: "manifest" }], filesToTouch: [] }),
    makePacket({ id: "implement-src-api", filesToInspect: [{ path: "src/api.ts", reason: "api" }], filesToTouch: [{ path: "src/api.ts", reason: "api" }] }),
    makePacket({ id: "review", type: "review", filesToInspect: [], filesToTouch: [] })
  ];
  const basePlan = {
    id: "plan",
    createdAt: new Date(0).toISOString(),
    repoRoot: dir,
    userGoal: "migrate to the latest React API; search the web",
    preview: {
      id: "p", userGoal: "", taskType: "migration", taskSummary: "",
      hiddenComplexitySignals: [], likelyRelevantAreas: [], likelyRisks: [], shouldUseBlueprint: true, reason: ""
    },
    selectedCandidateId: "c",
    candidates: [],
    scores: [],
    summary: "latest API migration",
    nonGoals: ["do not guess external APIs"],
    assumptions: ["official docs are authoritative"],
    repoOrientation: { ...orientation, repoRoot: dir, frameworks: ["react"], languages: ["typescript"] },
    docsFacts: [] as OfficialDocsFact[],
    memoryHits: [] as BlueprintMemoryHit[],
    intelligence: {
      title: "web required", evidence: [
        { id: "e1", kind: "repo", claim: "Languages: typescript", source: "x", confidence: "high", useInPackets: ["implement-src-api"] },
        { id: "e2", kind: "repo", claim: "Tests: npm test", source: "x", confidence: "high", useInPackets: ["implement-src-api"] },
        { id: "e3", kind: "risk", claim: "External API migration needs docs", source: "x", confidence: "medium", useInPackets: ["implement-src-api"] }
      ] as BlueprintEvidenceItem[],
      architectureDecisions: [
        { id: "d1", decision: "use official docs", rationale: "r", appliesTo: ["implement-src-api"], riskIfIgnored: "API guess" },
        { id: "d2", decision: "keep one worker file", rationale: "r", appliesTo: ["implement-src-api"], riskIfIgnored: "scope creep" },
        { id: "d3", decision: "verify focused", rationale: "r", appliesTo: ["implement-src-api"], riskIfIgnored: "regression" }
      ] as BlueprintArchitectureDecision[],
      implementationInvariants: ["planner never edits", "one touched file", "verify before broad checks", "stop with handoff"],
      bugWorkflows: [],
      packetFacts: [{ packetId: "implement-src-api", file: "src/api.ts", facts: ["likely tests: test/api.test.ts"] }] as BlueprintPacketFact[],
      webEvidence: [],
      webSearchTriggers: ["user_requested_search=3", "version_sensitive=3"],
      contextBudget: {
        modelName: "qwen-9b", modelClass: "9b", plannerTokens: 12000, workerTokens: 10000,
        maxFactsPerPacket: 4, maxFilesPerWorker: 1, maxOutputTokens: 500, compressionRules: []
      },
      webSearch: {
        required: true,
        evidenceRequired: true,
        triggerWeight: 6,
        provider: "official_allowlist",
        queries: ["react latest api migration"],
        allowedDomains: ["react.dev"],
        status: "ready"
      },
      workerBrief: "BLUEPRINT INTELLIGENCE PACK"
    },
    roleSeparation: {
      plannerSessionId: "p", plannerRole: "blueprint_planner", workerRole: "fresh_code_worker",
      invariant: "planner never edits; workers are fresh",
      enforcement: ["planner blocked from file tools", "fresh worker dispatch", "one packet per worker"]
    },
    planGraph: { nodes: [], edges: [] },
    workPackets: packets,
    finalReview: { id: "final", checks: [], required: true },
    constraints: ["official docs only"], risks: ["API guess"],
    verification: [{ id: "v", command: "npm test", description: "x", required: true }],
    approval: "auto_approved" as const,
    confidence: 0.8
  };

  const missing = evaluateBlueprintQuality(basePlan as any);
  assert.equal(missing.passed, false);
  assert.ok(missing.blockingIssues.some((issue) => /external evidence is required but no remote docs or web evidence/.test(issue)));
  assert.ok(missing.remediationActions?.some((action) => /official docs or ranked web evidence/.test(action)));

  const withEvidence = {
    ...basePlan,
    intelligence: {
      ...basePlan.intelligence,
      webEvidence: [{
        id: "web-1", fact: "React migration fact from official docs", sourceUrl: "https://react.dev/reference/react",
        sourceTitle: "React docs", sourceDomain: "react.dev", sourceTier: "official", sourceRank: 1,
        rankReason: "official docs", packageOrLibrary: "react", appliesTo: { packetIds: ["implement-src-api"] },
        confidence: "high", purpose: "official", query: "react latest api migration"
      }],
      webSearch: { ...basePlan.intelligence.webSearch, status: "completed" }
    }
  };
  const quality = evaluateBlueprintQuality(withEvidence as any);
  assert.equal(quality.blockingIssues.some((issue) => /external evidence is required/.test(issue)), false);
  assert.equal(quality.passed, true, JSON.stringify(quality.blockingIssues));
});

test("artifact renders done criteria per packet and bug-workflow match reasons", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-artifact-"));
  const packets = [
    makePacket({ id: "implement-src-alpha", filesToInspect: [{ path: "src/alpha.ts", reason: "r" }], filesToTouch: [{ path: "src/alpha.ts", reason: "r" }] })
  ];
  const memoryHits: BlueprintMemoryHit[] = [
    { id: "bug-1", source: "bug", summary: "fix pattern: guard alpha; test signal: alpha crash", confidence: "high", keyFiles: ["src/alpha.ts"], testSignal: "alpha crash", matchReason: "matched because key files src/alpha.ts overlap" }
  ];
  const pack = buildBlueprintIntelligencePack({
    userGoal: "fix alpha crash",
    orientation,
    docsFacts: [],
    memoryHits,
    packets,
    packetFacts: [{ packetId: "implement-src-alpha", file: "src/alpha.ts", facts: ["src/alpha.ts registers commands"] }],
    taskType: "bug_fix",
    modelName: "qwen-9b",
    config: DEFAULT_BLUEPRINT_CONFIG
  });
  const plan = {
    id: "plan", createdAt: new Date(0).toISOString(), repoRoot: dir, userGoal: "fix alpha crash",
    preview: { id: "p", userGoal: "", taskType: "bug_fix", taskSummary: "", hiddenComplexitySignals: [], likelyRelevantAreas: [], likelyRisks: [], shouldUseBlueprint: true, reason: "" },
    selectedCandidateId: "c", candidates: [], scores: [], summary: "", nonGoals: [], assumptions: [],
    repoOrientation: orientation, docsFacts: [], memoryHits,
    intelligence: pack,
    roleSeparation: { plannerSessionId: "p", plannerRole: "blueprint_planner", workerRole: "fresh_code_worker", invariant: "x", enforcement: ["a", "b", "c"] },
    qualityGate: { score: 90, passed: true, strengths: [], blockingIssues: [], warnings: [], requiredSections: [], localModelFit: "excellent" as const },
    planGraph: { nodes: [], edges: [] }, workPackets: packets, finalReview: { id: "f", checks: [], required: true },
    constraints: [], risks: [], verification: [{ id: "v", command: "npm test", description: "x", required: true }],
    approval: "auto_approved" as const, confidence: 0.9
  } as any;
  const md = renderBlueprintArtifact(plan);
  assert.match(md, /## Done Criteria/);
  assert.match(md, /implement-src-alpha: implement-src-alpha behavior implemented \| verify: npm test/);
  assert.match(md, /## Bug-Memory Workflows/);
  assert.match(md, /matched because key files src\/alpha\.ts overlap/);
  assert.match(md, /applies_to=implement-src-alpha/);
  assert.match(md, /- Remediate: none/);
});

test("artifact renders evidence-required web search posture", () => {
  const packets = [
    makePacket({ id: "implement-src-api", filesToInspect: [{ path: "src/api.ts", reason: "r" }], filesToTouch: [{ path: "src/api.ts", reason: "r" }] })
  ];
  const pack = buildBlueprintIntelligencePack({
    userGoal: "migrate to latest React API and search the web",
    orientation,
    docsFacts: [],
    memoryHits: [],
    packets,
    packetFacts: [{ packetId: "implement-src-api", file: "src/api.ts", facts: ["likely tests: test/api.test.ts"] }],
    webSearchTriggers: ["user_requested_search=3", "version_sensitive=3"],
    taskType: "migration",
    modelName: "qwen-9b",
    config: DEFAULT_BLUEPRINT_CONFIG
  });
  const plan = {
    id: "plan", createdAt: new Date(0).toISOString(), repoRoot: "x", userGoal: "migrate to latest React API",
    preview: { id: "p", userGoal: "", taskType: "migration", taskSummary: "", hiddenComplexitySignals: [], likelyRelevantAreas: [], likelyRisks: [], shouldUseBlueprint: true, reason: "" },
    selectedCandidateId: "c", candidates: [], scores: [], summary: "", nonGoals: [], assumptions: [],
    repoOrientation: orientation, docsFacts: [], memoryHits: [], intelligence: pack,
    roleSeparation: { plannerSessionId: "p", plannerRole: "blueprint_planner", workerRole: "fresh_code_worker", invariant: "x", enforcement: ["a", "b", "c"] },
    qualityGate: { score: 80, passed: true, strengths: [], blockingIssues: [], warnings: [], requiredSections: [], localModelFit: "good" as const },
    planGraph: { nodes: [], edges: [] }, workPackets: packets, finalReview: { id: "f", checks: [], required: true },
    constraints: [], risks: [], verification: [{ id: "v", command: "npm test", description: "x", required: true }],
    approval: "auto_approved" as const, confidence: 0.9
  } as any;
  const md = renderBlueprintArtifact(plan);
  assert.equal(pack.webSearch.evidenceRequired, true);
  assert.equal(pack.webSearch.triggerWeight, 6);
  assert.match(md, /evidenceRequired=true; triggerWeight=6/);
});

test("doneCriteriaFor combines acceptance and verification without inventing new command", () => {
  const packet = makePacket({
    id: "p", filesToInspect: [], filesToTouch: [],
    acceptanceCriteria: ["feature X added"],
    verification: [{ id: "v", command: "npm test", description: "run tests", required: true }]
  });
  assert.deepEqual(doneCriteriaFor(packet), ["feature X added", "verification passes: npm test"]);
  const empty = makePacket({ id: "p2", filesToInspect: [], filesToTouch: [], acceptanceCriteria: [], verification: [] });
  assert.ok(doneCriteriaFor(empty).length >= 1);
});
