import { buildPlannerGraph, selectFilesByGoalFromGraph, type GraphFileTarget } from "../commitlet/constraintGraph.js";
import { buildBlueprintIntelligencePack, packetScopedWorkerBrief, doneCriteriaFor } from "./intelligence.js";
import { inferFilePlans } from "./contextSketch.js";
import { generateBlueprintCandidates } from "./planner.js";
import { buildPacketFactsForPackets, createAutonomousBlueprint } from "./autonomous.js";
import { evaluateBlueprintQuality } from "./qualityGate.js";
import { DEFAULT_BLUEPRINT_CONFIG } from "./config.js";
import { freshCallPacketFromWorkPacket, renderFreshCallPacket } from "../reliability/packetPrompt.js";
import { modelProfile } from "../reliability/modelProfile.js";
import type { RepoOrientation, BlueprintPlan, WorkPacket } from "./types.js";

export type EvalVariant = "plain" | "basic_blueprint" | "graph_intelligence" | "graph_intelligence_pipeline";

export interface EvalTask {
  goal: string;
  taskType?: string;
  expectedFiles: string[];
  expectedTests?: string[];
  expectedSymbols?: string[];
  modelName?: string;
}

export interface EvalMetrics {
  correctFileTarget: boolean;
  likelyTestDiscovered: boolean;
  briefChars: number;
  briefBounded: boolean;
  irrelevantBugMemoryIncluded: boolean;
  doneCriteriaPresent: boolean;
  riskyApiFlagged: boolean;
  qualityGateSurfaced: boolean;
  mockEditMatchesExpectedFile: boolean;
  mockEditMatchesExpectedSymbol: boolean;
  localModelReady: boolean;
  packetPromptChars: number;
  packetPromptBudgetFit: boolean;
  oneFileWorkerScope: boolean;
  handoffDisciplinePresent: boolean;
  score: number;
}

export interface EvalResult {
  variant: EvalVariant;
  selectedFiles: string[];
  mockEdit: MockEdit;
  metrics: EvalMetrics;
  workerBrief: string;
  notes: string[];
}

export interface MockEdit {
  touchedFile: string | undefined;
  referencedSymbols: string[];
  hasHandoff: boolean;
  blocked: boolean;
}

export interface EvalCase {
  cwd: string;
  orientation: RepoOrientation;
  task: EvalTask;
  irrelevantBugMemory?: { summary: string; keyFiles: string[] };
}

export async function runBlueprintEval(caseData: EvalCase, options?: { includePipeline?: boolean }): Promise<EvalResult[]> {
  const { cwd, orientation, task } = caseData;
  const expected = new Set(task.expectedFiles.map((f) => normalizeRel(f)));
  const expectedTests = new Set((task.expectedTests ?? []).map((f) => normalizeRel(f)));
  const expectedSymbols = new Set((task.expectedSymbols ?? []).map((s) => s.toLowerCase()));
  const config = DEFAULT_BLUEPRINT_CONFIG;
  const results: EvalResult[] = [];

  results.push(evalPlain(cwd, orientation, task, expected, expectedTests, expectedSymbols, config));
  results.push(evalBasicBlueprint(cwd, orientation, task, expected, expectedTests, expectedSymbols, config));
  results.push(evalGraphIntelligence(cwd, orientation, task, expected, expectedTests, expectedSymbols, config));
  if (options?.includePipeline) {
    results.push(await evalGraphIntelligencePipeline(cwd, orientation, task, expected, expectedTests, expectedSymbols, config));
  }
  return results;
}

function evalPlain(cwd: string, orientation: RepoOrientation, task: EvalTask, expected: Set<string>, expectedTests: Set<string>, expectedSymbols: Set<string>, config: typeof DEFAULT_BLUEPRINT_CONFIG): EvalResult {
  const brief = [
    "PLAIN DIRECT WORKER CONTEXT",
    `goal: ${task.goal}`,
    `repo: ${orientation.repoRoot}`,
    `languages: ${orientation.languages.join(", ")}`,
    `tests: ${orientation.testCommands.join(" | ") || "(none)"}`
  ].join("\n");
  const notes = ["plain context carries no packet structure, no test discovery, no done criteria"];
  const mockEdit = mockModelStub({ brief, touchFiles: [] });
  return {
    variant: "plain",
    selectedFiles: [],
    mockEdit,
    workerBrief: brief,
    notes,
    metrics: {
      correctFileTarget: expected.size === 0,
      likelyTestDiscovered: expectedTests.size === 0,
      briefChars: brief.length,
      briefBounded: brief.length <= 8000,
      irrelevantBugMemoryIncluded: false,
      doneCriteriaPresent: false,
      riskyApiFlagged: false,
      qualityGateSurfaced: false,
      mockEditMatchesExpectedFile: expected.size === 0,
      mockEditMatchesExpectedSymbol: expectedSymbols.size === 0,
      localModelReady: false,
      packetPromptChars: brief.length,
      packetPromptBudgetFit: brief.length <= modelProfile(task.modelName, config).packetContextBudget * 4,
      oneFileWorkerScope: false,
      handoffDisciplinePresent: false,
      score: 0
    }
  };
}

function evalBasicBlueprint(cwd: string, orientation: RepoOrientation, task: EvalTask, expected: Set<string>, expectedTests: Set<string>, expectedSymbols: Set<string>, config: typeof DEFAULT_BLUEPRINT_CONFIG): EvalResult {
  const files = inferFilePlans(task.goal, orientation);
  const implementFile = files.find((f) => !f.path.endsWith("/") && !f.path.startsWith("(")) ?? files[0];
  const touchFiles = implementFile && !implementFile.path.startsWith("(") && !implementFile.path.endsWith("/") ? [implementFile.path] : [];
  const selectedFiles = files.map((f) => f.path);
  const brief = [
    "BASIC BLUEPRINT WORKER CONTEXT (keyword heuristics only)",
    `goal: ${task.goal}`,
    `touch: ${implementFile?.path ?? "(none)"}`,
    `acceptance: behavior implemented`
  ].join("\n");
  const notes = ["basic blueprint uses keyword heuristics; no graph evidence, no test discovery, no quality gate"];
  const correct = implementFile ? expected.has(normalizeRel(implementFile.path)) : false;
  const testDiscovered = files.some((f) => expectedTests.has(normalizeRel(f.path)));
  const mockEdit = mockModelStub({ brief, touchFiles });
  return {
    variant: "basic_blueprint",
    selectedFiles,
    mockEdit,
    workerBrief: brief,
    notes,
    metrics: {
      correctFileTarget: correct,
      likelyTestDiscovered: testDiscovered,
      briefChars: brief.length,
      briefBounded: brief.length <= 8000,
      irrelevantBugMemoryIncluded: false,
      doneCriteriaPresent: false,
      riskyApiFlagged: false,
      qualityGateSurfaced: false,
      mockEditMatchesExpectedFile: mockEdit.touchedFile ? expected.has(normalizeRel(mockEdit.touchedFile)) : false,
      mockEditMatchesExpectedSymbol: mockEditMatchesSymbols(mockEdit, expectedSymbols),
      localModelReady: false,
      packetPromptChars: brief.length,
      packetPromptBudgetFit: brief.length <= modelProfile(task.modelName, config).packetContextBudget * 4,
      oneFileWorkerScope: touchFiles.length === 1,
      handoffDisciplinePresent: false,
      score: (correct ? 2 : 0) + (testDiscovered ? 2 : 0)
    }
  };
}

function evalGraphIntelligence(cwd: string, orientation: RepoOrientation, task: EvalTask, expected: Set<string>, expectedTests: Set<string>, expectedSymbols: Set<string>, config: typeof DEFAULT_BLUEPRINT_CONFIG): EvalResult {
  const graph = buildPlannerGraph(cwd, orientation);
  const graphTargets = selectFilesByGoalFromGraph(task.goal, graph);
  const candidates = generateBlueprintCandidates({
    preview: { id: "eval", userGoal: task.goal, taskType: task.taskType ?? "unknown", taskSummary: task.goal, hiddenComplexitySignals: [], likelyRelevantAreas: [], likelyRisks: [], shouldUseBlueprint: true, reason: "" } as any,
    orientation,
    count: 1,
    maxCallsPerPacket: 1,
    graphTargets
  });
  const selected = candidates[0];
  const workPackets = selected.workPackets;
  const packetFacts = buildPacketFactsForPackets(cwd, workPackets);
  const intelligence = buildBlueprintIntelligencePack({
    userGoal: task.goal,
    orientation,
    docsFacts: [],
    memoryHits: [],
    packets: workPackets,
    packetFacts,
    modelName: task.modelName,
    taskType: task.taskType,
    config
  });
  const implementPacket = workPackets.find((p) => p.type === "implement") ?? workPackets[0];
  const brief = packetScopedWorkerBrief({ intelligence }, implementPacket) ?? "";
  const plan = synthesizePlan(cwd, task, orientation, selected, workPackets, intelligence);
  const qualityGate = evaluateBlueprintQuality(plan);

  const selectedFiles = [...new Set([...graphTargets.map((t) => t.path), ...workPackets.flatMap((p) => p.filesToTouch.map((f) => f.path))])].filter((f) => f && !f.startsWith("(") && !f.endsWith("/"));
  const correct = selectedFiles.some((f) => expected.has(normalizeRel(f)));
  const testDiscovered = graph.testMappings.some((m) => expectedTests.has(normalizeRel(m.testFile))) || workPackets.some((p) => p.filesToTouch.some((f) => expectedTests.has(normalizeRel(f.path))));
  const doneCriteria = doneCriteriaFor(implementPacket);
  const donePresent = doneCriteria.length > 0;
  const briefBounded = brief.length <= 4000;
  const riskyFlagged = qualityGate.warnings.some((w) => /references .+ without repo or docs evidence/.test(w));
  const qualitySurfaced = qualityGate.score > 0;
  const touchFiles = implementPacket.filesToTouch.map((f) => f.path).filter((f) => f && !f.startsWith("(") && !f.endsWith("/"));
  const mockEdit = mockModelStub({ brief, touchFiles });
  const readiness = localModelReadiness({ plan, packet: implementPacket, task, config, mockEdit });

  let score = 0;
  if (correct) score += 3;
  if (testDiscovered) score += 3;
  if (donePresent) score += 2;
  if (briefBounded) score += 2;
  if (riskyFlagged) score += 2;
  if (qualitySurfaced) score += 2;
  if (mockEdit.touchedFile && expected.has(normalizeRel(mockEdit.touchedFile))) score += 2;
  if (mockEditMatchesSymbols(mockEdit, expectedSymbols)) score += 2;
  if (readiness.localModelReady) score += 3;

  const notes = [
    `graph targets: ${graphTargets.length}`,
    `packet facts: ${packetFacts.length}`,
    `quality gate: score=${qualityGate.score} fit=${qualityGate.localModelFit}`,
    `mock edit: ${mockEdit.touchedFile ?? "(none)"} symbols=${mockEdit.referencedSymbols.join(",") || "(none)"}`,
    `local model ready: ${readiness.localModelReady} promptChars=${readiness.packetPromptChars}`
  ];

  return {
    variant: "graph_intelligence",
    selectedFiles,
    mockEdit,
    workerBrief: brief,
    notes,
    metrics: {
      correctFileTarget: correct,
      likelyTestDiscovered: testDiscovered,
      briefChars: brief.length,
      briefBounded,
      irrelevantBugMemoryIncluded: false,
      doneCriteriaPresent: donePresent,
      riskyApiFlagged: riskyFlagged,
      qualityGateSurfaced: qualitySurfaced,
      mockEditMatchesExpectedFile: mockEdit.touchedFile ? expected.has(normalizeRel(mockEdit.touchedFile)) : false,
      mockEditMatchesExpectedSymbol: mockEditMatchesSymbols(mockEdit, expectedSymbols),
      ...readiness,
      score
    }
  };
}

async function evalGraphIntelligencePipeline(cwd: string, orientation: RepoOrientation, task: EvalTask, expected: Set<string>, expectedTests: Set<string>, expectedSymbols: Set<string>, config: typeof DEFAULT_BLUEPRINT_CONFIG): Promise<EvalResult> {
  const offlineConfig = { ...config, blueprintOfficialDocsSearchEnabled: false, blueprintMemoryEnabled: false } as any;
  const plan = await createAutonomousBlueprint({ cwd, userGoal: task.goal, taskType: task.taskType, modelName: task.modelName, config: offlineConfig });
  const implementPacket = plan.workPackets.find((p) => p.type === "implement") ?? plan.workPackets[0];
  const brief = packetScopedWorkerBrief(plan, implementPacket) ?? "";
  const touchFiles = implementPacket.filesToTouch.map((f) => f.path).filter((f) => f && !f.startsWith("(") && !f.endsWith("/"));
  const mockEdit = mockModelStub({ brief, touchFiles });
  const selectedFiles = [...new Set(plan.workPackets.flatMap((p) => p.filesToTouch.map((f) => f.path)))].filter((f) => f && !f.startsWith("(") && !f.endsWith("/"));
  const correct = selectedFiles.some((f) => expected.has(normalizeRel(f)));
  const testDiscovered = plan.intelligence?.packetFacts.some((pf) => /likely tests/.test(pf.facts.join(" "))) || false;
  const donePresent = doneCriteriaFor(implementPacket).length > 0;
  const briefBounded = brief.length <= 4000;
  const riskyFlagged = plan.qualityGate.warnings.some((w) => /references .+ without repo or docs evidence/.test(w));
  const qualitySurfaced = plan.qualityGate.score > 0;
  const readiness = localModelReadiness({ plan, packet: implementPacket, task, config, mockEdit });

  let score = 0;
  if (correct) score += 3;
  if (testDiscovered) score += 3;
  if (donePresent) score += 2;
  if (briefBounded) score += 2;
  if (riskyFlagged) score += 2;
  if (qualitySurfaced) score += 2;
  if (mockEdit.touchedFile && expected.has(normalizeRel(mockEdit.touchedFile))) score += 2;
  if (mockEditMatchesSymbols(mockEdit, expectedSymbols)) score += 2;
  if (readiness.localModelReady) score += 3;

  const notes = [
    `pipeline plan: ${plan.id} packets=${plan.workPackets.length}`,
    `quality gate: score=${plan.qualityGate.score} fit=${plan.qualityGate.localModelFit}`,
    `mock edit: ${mockEdit.touchedFile ?? "(none)"} symbols=${mockEdit.referencedSymbols.join(",") || "(none)"}`,
    `local model ready: ${readiness.localModelReady} promptChars=${readiness.packetPromptChars}`
  ];

  return {
    variant: "graph_intelligence_pipeline",
    selectedFiles,
    mockEdit,
    workerBrief: brief,
    notes,
    metrics: {
      correctFileTarget: correct,
      likelyTestDiscovered: testDiscovered,
      briefChars: brief.length,
      briefBounded,
      irrelevantBugMemoryIncluded: false,
      doneCriteriaPresent: donePresent,
      riskyApiFlagged: riskyFlagged,
      qualityGateSurfaced: qualitySurfaced,
      mockEditMatchesExpectedFile: mockEdit.touchedFile ? expected.has(normalizeRel(mockEdit.touchedFile)) : false,
      mockEditMatchesExpectedSymbol: mockEditMatchesSymbols(mockEdit, expectedSymbols),
      ...readiness,
      score
    }
  };
}

function localModelReadiness(params: {
  plan: BlueprintPlan;
  packet: WorkPacket;
  task: EvalTask;
  config: typeof DEFAULT_BLUEPRINT_CONFIG;
  mockEdit: MockEdit;
}): Pick<EvalMetrics, "localModelReady" | "packetPromptChars" | "packetPromptBudgetFit" | "oneFileWorkerScope" | "handoffDisciplinePresent"> {
  const config = { ...params.config, model: params.task.modelName } as typeof DEFAULT_BLUEPRINT_CONFIG & { model?: string };
  const profile = modelProfile(params.task.modelName, params.config);
  const packet = freshCallPacketFromWorkPacket({
    plan: params.plan,
    packet: params.packet,
    previousState: [],
    contextBudgetTokens: profile.packetContextBudget,
    config
  });
  const rendered = renderFreshCallPacket(packet);
  const packetPromptBudgetFit = rendered.length <= profile.packetContextBudget * 4;
  const oneFileWorkerScope = packet.filesToTouch.length === 1 && (profile.class === "9b" ? packet.relevantSnippets.length <= 1 : packet.relevantSnippets.length <= 2);
  const hasDoneCriteria = /Done criteria:|acceptanceCriteria:|verification passes:/i.test(rendered);
  const hasVerificationSignal = /verification passes:|Run the focused verification command|acceptanceCriteria:/i.test(rendered);
  const handoffDisciplinePresent = /endSentinel:|compact handoff|BLOCKED_NEXT_FILE|One file-change worker/i.test(rendered) && params.mockEdit.hasHandoff;
  return {
    localModelReady: packetPromptBudgetFit && oneFileWorkerScope && hasDoneCriteria && hasVerificationSignal && handoffDisciplinePresent,
    packetPromptChars: rendered.length,
    packetPromptBudgetFit,
    oneFileWorkerScope,
    handoffDisciplinePresent
  };
}

function synthesizePlan(cwd: string, task: EvalTask, orientation: RepoOrientation, selected: any, workPackets: WorkPacket[], intelligence: any): BlueprintPlan {
  return {
    id: "eval", createdAt: new Date(0).toISOString(), repoRoot: cwd, userGoal: task.goal,
    preview: { id: "p", userGoal: task.goal, taskType: task.taskType ?? "unknown", taskSummary: task.goal, hiddenComplexitySignals: [], likelyRelevantAreas: [], likelyRisks: [], shouldUseBlueprint: true, reason: "" },
    selectedCandidateId: selected.id, candidates: [selected], scores: [], summary: selected.summary, nonGoals: selected.nonGoals, assumptions: selected.assumptions,
    repoOrientation: orientation, docsFacts: [], memoryHits: [],
    intelligence,
    roleSeparation: { plannerSessionId: "p", plannerRole: "blueprint_planner", workerRole: "fresh_code_worker", invariant: "x", enforcement: ["a", "b", "c"] },
    qualityGate: { score: 0, passed: false, strengths: [], blockingIssues: [], warnings: [], requiredSections: [], localModelFit: "weak" },
    artifactMarkdown: "",
    planGraph: { nodes: [], edges: [] }, workPackets, finalReview: { id: "f", checks: [], required: true },
    constraints: selected.constraints, risks: selected.risks, verification: selected.verification,
    approval: "auto_approved" as const, confidence: 1
  } as unknown as BlueprintPlan;
}

export interface MockModelInput {
  brief: string;
  touchFiles: string[];
}

export function mockModelStub(input: MockModelInput): MockEdit {
  const lower = input.brief.toLowerCase();
  const blocked = /BLOCKED_NEXT_FILE|stop with a blocker|no packet-level overlap/.test(lower);
  const touchedFile = input.touchFiles.find((file) => new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(input.brief))
    ?? input.touchFiles[0];
  const referencedSymbols: string[] = [];
  const symbolPattern = /(?:defines symbol|exports|symbol cluster|try repair pattern)[^:]*?:?\s*([A-Za-z_][\w]*)/gi;
  let match;
  while ((match = symbolPattern.exec(input.brief)) !== null) {
    const name = match[1].trim();
    if (name && !referencedSymbols.includes(name)) referencedSymbols.push(name);
  }
  const hasHandoff = /PACKET_RESULT|SUMMARY|FILES_TOUCHED|VERIFY|handoff/i.test(input.brief);
  return { touchedFile, referencedSymbols: referencedSymbols.slice(0, 5), hasHandoff, blocked };
}

function mockEditMatchesSymbols(edit: MockEdit, expected: Set<string>): boolean {
  if (expected.size === 0) return false;
  return edit.referencedSymbols.some((s) => expected.has(s.toLowerCase()));
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function summarizeEval(results: EvalResult[]): string {
  return [
    "Cheater Blueprint eval",
    ...results.map((r) => `${r.variant}: score=${r.metrics.score} correctFile=${r.metrics.correctFileTarget} test=${r.metrics.likelyTestDiscovered} done=${r.metrics.doneCriteriaPresent} bounded=${r.metrics.briefBounded} flagged=${r.metrics.riskyApiFlagged} qg=${r.metrics.qualityGateSurfaced} mockFile=${r.metrics.mockEditMatchesExpectedFile} mockSymbol=${r.metrics.mockEditMatchesExpectedSymbol} localReady=${r.metrics.localModelReady} promptFit=${r.metrics.packetPromptBudgetFit} oneFile=${r.metrics.oneFileWorkerScope} handoff=${r.metrics.handoffDisciplinePresent} briefChars=${r.metrics.briefChars} packetChars=${r.metrics.packetPromptChars}`)
  ].join("\n");
}
