import { scanOrientation } from "./orientation.js";
import type { CheaterConfig } from "../types.js";
import { blueprintConfig } from "./config.js";
import { repoOrientationFromMissionFacts } from "./contextSketch.js";
import { scoutOfficialDocs } from "./docsScout.js";
import { retrievePlanningMemory, disagreementGate } from "./memory.js";
import { createBlueprintPreview } from "./preview.js";
import { generateBlueprintCandidates } from "./planner.js";
import { scoreBlueprintCandidates, selectBestCandidate } from "./candidateScorer.js";
import { buildPlanGraph, ensureFinalReviewNode } from "./planGraph.js";
import { simulateBlueprintPackets, reviseUnclearPacket } from "./checker.js";
import { buildBlueprintIntelligencePack } from "./intelligence.js";
import { createRoleSeparation, renderBlueprintArtifact } from "./artifact.js";
import { evaluateBlueprintQuality } from "./qualityGate.js";
import { searchBugMemories } from "../bug-memory.js";
import { buildRepoConstraintGraph, buildPlannerGraph, queryConstraintFacts, selectFilesByGoalFromGraph, symbolClustersForGoal } from "../commitlet/constraintGraph.js";
import type { BlueprintPlan } from "./types.js";
import { splitPacketsByTouchedFile } from "../reliability/perFilePackets.js";
import { runWebScout } from "./webScout.js";
import { detectSearchTriggers, shouldSearchWeb } from "./webScout.js";

export async function createAutonomousBlueprint(params: {
  cwd: string;
  userGoal: string;
  taskType?: string;
  plannerSessionId?: string;
  modelName?: string;
  config?: CheaterConfig;
}): Promise<BlueprintPlan> {
  const config = blueprintConfig(params.config);
  const missionOrientation = scanOrientation(params.cwd);
  const orientation = repoOrientationFromMissionFacts(missionOrientation);
  const preview = createBlueprintPreview({
    userGoal: params.userGoal,
    taskType: params.taskType ?? "unknown",
    repoOrientation: orientation
  });
  const docsFacts = await scoutOfficialDocs({
    cwd: params.cwd,
    query: params.userGoal,
    config
  });
  const memoryHits = [
    ...retrievePlanningMemory(params.cwd, params.userGoal, config.blueprintMemoryEnabled),
    ...await retrieveBugMemoryWorkflows(params.cwd, params.userGoal, params.taskType, config.blueprintMemoryEnabled)
  ];
  const trusted = disagreementGate({ memoryHits, docsFacts, orientation });
  const plannerGraph = buildPlannerGraph(params.cwd, orientation);
  const graphTargets = selectFilesByGoalFromGraph(params.userGoal, plannerGraph);
  const symbolClusters = symbolClustersForGoal(params.userGoal, plannerGraph);
  const candidates = generateBlueprintCandidates({
    preview,
    orientation,
    docsFacts: trusted.trustedDocs,
    memoryHits: trusted.trustedMemory,
    count: config.blueprintCandidateCount,
    maxCallsPerPacket: config.blueprintMaxCallsPerPacket,
    graphTargets,
    symbolClusters
  });
  const scores = scoreBlueprintCandidates(candidates);
  const selected = selectBestCandidate(candidates, scores);
  const simulated = simulateBlueprintPackets(selected.workPackets).map(reviseUnclearPacket);
  const splitPackets = config.packetOneFilePerWorkerEnabled
    ? splitPacketsByTouchedFile(simulated, config.packetMaxFilesToTouch)
    : simulated;
  const errorSignals = extractErrorSignals(params.userGoal, memoryHits);
  const triggerInput = {
    taskType: params.taskType,
    userGoal: params.userGoal,
    repoRoot: params.cwd,
    knownLibraries: trusted.trustedDocs.map((fact) => fact.packageOrLibrary).filter((lib) => lib && lib !== "local"),
    lastFailureSignals: errorSignals
  };
  const triggers = detectSearchTriggers(triggerInput);
  const webScout = shouldSearchWeb(triggers)
    ? await runWebScout({
        cwd: params.cwd,
        userGoal: params.userGoal,
        taskType: params.taskType,
        errorSignals,
        knownLibraries: orientation.frameworks,
        appliesToFiles: [...new Set(splitPackets.flatMap((packet) => [...packet.filesToTouch, ...packet.filesToInspect].map((f) => f.path)))].filter((f) => f && !f.startsWith("(") && !f.endsWith("/"))
      }).catch(() => null)
    : null;
  const webEvidence = webScout?.cards ?? [];
  const extraBugWorkflows = webScout && params.taskType && /bug_fix|test_failure|import_error|type_error/i.test(params.taskType)
    ? webEvidenceToBugMemoryHits(webScout)
    : [];
  const enrichedMemoryHits = extraBugWorkflows.length ? [...memoryHits, ...extraBugWorkflows] : memoryHits;
  const enrichedTrusted = { trustedDocs: trusted.trustedDocs, trustedMemory: enrichedMemoryHits, excluded: trusted.excluded };
  const planGraph = ensureFinalReviewNode(buildPlanGraph(splitPackets));
  const packetFacts = buildPacketFacts(params.cwd, splitPackets);
  const intelligence = buildBlueprintIntelligencePack({
    userGoal: params.userGoal,
    orientation,
    docsFacts: enrichedTrusted.trustedDocs,
    memoryHits: enrichedTrusted.trustedMemory,
    packets: splitPackets,
    packetFacts,
    webEvidence,
    webSearchTriggers: triggers.map((trigger) => `${trigger.kind}=${trigger.weight}`),
    modelName: params.modelName ?? params.config?.model,
    taskType: params.taskType,
    config
  });
  const highRisk = splitPackets.some((packet) => packet.risk === "high");
  const approval: BlueprintPlan["approval"] =
    config.blueprintRequireApproval === "always" ||
    (highRisk && config.blueprintRequireApproval === "high_risk_only")
      ? "needs_user"
      : "auto_approved";
  const planId = `blueprint-${Date.now().toString(36)}`;
  const roleSeparation = createRoleSeparation(planId, params.plannerSessionId);
  const planBeforeQuality = {
    id: planId,
    createdAt: new Date().toISOString(),
    repoRoot: params.cwd,
    userGoal: params.userGoal,
    preview,
    selectedCandidateId: selected.id,
    candidates,
    scores,
    summary: selected.summary,
    nonGoals: selected.nonGoals,
    assumptions: selected.assumptions,
    repoOrientation: orientation,
    docsFacts: enrichedTrusted.trustedDocs,
    memoryHits: enrichedTrusted.trustedMemory,
    intelligence,
    roleSeparation,
    planGraph,
    workPackets: splitPackets.slice(0, config.blueprintMaxPackets),
    finalReview: {
      id: "final-review",
      checks: [
        "all packets complete",
        "forbidden actions avoided",
        "tests/build verified or blocker reported",
        "Cheater remains a Pi wrapper/distribution"
      ],
      required: true
    },
    constraints: selected.constraints,
    risks: selected.risks,
    verification: selected.verification,
    approval,
    confidence: scores.find((score) => score.candidateId === selected.id)?.overall ?? 0.5
  };
  const qualityGate = evaluateBlueprintQuality(planBeforeQuality);
  const planWithoutArtifact = { ...planBeforeQuality, qualityGate };
  return {
    ...planWithoutArtifact,
    artifactMarkdown: renderBlueprintArtifact(planWithoutArtifact)
  };
}

async function retrieveBugMemoryWorkflows(cwd: string, query: string, taskType: string | undefined, enabled: boolean) {
  if (!enabled || !shouldSearchBugMemory(query, taskType)) return [];
  try {
    const result = await searchBugMemories({ cwd, query, topK: 3 });
    const queryTerms = Array.from(new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length > 3))).slice(0, 12);
    return result.hits.map((hit) => {
      const keywordOverlaps = hit.searchKeywords
        .flatMap((kw) => kw.toLowerCase().split(/\W+/))
        .filter((kw) => queryTerms.includes(kw));
      const signal = hit.testSignal?.trim();
      const reasons: string[] = [];
      if (taskType && /bug_fix|test_failure|import_error|type_error/i.test(taskType)) reasons.push(`task type ${taskType}`);
      if (signal && queryTerms.some((t) => signal.toLowerCase().includes(t))) reasons.push(`test signal "${signal}" matched the task`);
      if (keywordOverlaps.length) reasons.push(`search keywords ${keywordOverlaps.slice(0, 4).join(", ")} matched the request`);
      if (hit.keyFiles.length) reasons.push(`key files ${hit.keyFiles.join(", ")} overlap the plan target`);
      return {
        id: `bug-${hit.id}`,
        source: "bug" as const,
summary: [
        `bug type: ${hit.bugType}`,
        `symptom: ${hit.symptom}`,
        `root cause: ${hit.rootCause}`,
        `fix pattern: ${hit.fixPattern}`,
        hit.workflowSteps?.length ? `workflow steps: ${hit.workflowSteps.join(" -> ")}` : "",
        hit.doNotDo?.length ? `do not do: ${hit.doNotDo.join("; ")}` : "",
        hit.failedApproaches?.length ? `failed approaches: ${hit.failedApproaches.join("; ")}` : "",
        hit.testSignal ? `test signal: ${hit.testSignal}` : "",
        hit.keyFiles.length ? `key files: ${hit.keyFiles.join(", ")}` : ""
      ].filter(Boolean).join("; "),
        confidence: (hit.qualityTier === "high" || (hit.qualityScore ?? 0) >= 0.8 ? "high" : "medium") as "high" | "medium",
        keyFiles: hit.keyFiles,
        testSignal: signal || undefined,
        matchReason: reasons.length ? `matched because ${reasons.join("; ")}` : "matched by bug-memory retrieval ranking",
        workflowSteps: hit.workflowSteps,
        doNotDo: hit.doNotDo
      };
    });
  } catch {
    return [];
  }
}

function shouldSearchBugMemory(query: string, taskType?: string): boolean {
  if (taskType && /bug_fix|test_failure|import_error|type_error/i.test(taskType)) return true;
  return /\b(bug|fix|failing|failure|failed|traceback|exception|error|regression|crash|typeerror|valueerror|attributeerror|importerror|test fails?)\b/i.test(query);
}

export function buildPacketFactsForPackets(cwd: string, packets: BlueprintPlan["workPackets"]) {
  return buildPacketFacts(cwd, packets);
}

function buildPacketFacts(cwd: string, packets: BlueprintPlan["workPackets"]) {
  const files = [...new Set(packets.flatMap((packet) => [
    ...packet.filesToInspect.map((file) => file.path),
    ...packet.filesToTouch.map((file) => file.path)
  ]).filter((file) => file && !file.startsWith("(") && !file.endsWith("/")))];
  const graph = buildRepoConstraintGraph(cwd, files);
  return packets.flatMap((packet) => {
    const packetFiles = [...new Set([
      ...packet.filesToTouch.map((file) => file.path),
      ...packet.filesToInspect.map((file) => file.path)
    ].filter((file) => file && !file.startsWith("(") && !file.endsWith("/")))];
    return packetFiles.map((file) => ({
      packetId: packet.id,
      file,
      facts: queryConstraintFacts(graph, file).slice(0, 8)
    })).filter((item) => item.facts.length > 0);
  }).slice(0, 48);
}

function extractErrorSignals(userGoal: string, memoryHits: any[]): string[] {
  const signals = new Set<string>();
  for (const match of userGoal.matchAll(/\b(?:TypeError|ValueError|KeyError|AttributeError|ImportError|ModuleNotFoundError|SyntaxError|ReferenceError|RuntimeError|HTTPError)\b[^\n]{0,180}/gi)) {
    signals.add(match[0].trim());
  }
  for (const hit of memoryHits) {
    if (hit?.testSignal && typeof hit.testSignal === "string") signals.add(hit.testSignal);
    if (hit?.summary && typeof hit.summary === "string") {
      const m = hit.summary.match(/\b(?:TypeError|ValueError|KeyError|AttributeError|ImportError|ModuleNotFoundError)\b[^\n;]{0,180}/);
      if (m) signals.add(m[0]);
    }
  }
  return [...signals];
}

function webEvidenceToBugMemoryHits(outcome: { cards: any[] }): any[] {
  return outcome.cards.slice(0, 3).map((card: any, index: number) => ({
    id: `web-bug-${card.id ?? index}`,
    source: "bug" as const,
    summary: [
      `web evidence: ${card.fact}`,
      card.codeSnippet ? `code snippet: ${card.codeSnippet.slice(0, 240)}` : "",
      card.doNotDo ? `do not do: ${card.doNotDo}` : "",
      card.verificationHint ? `verify with: ${card.verificationHint}` : "",
      `source: ${card.sourceTitle} (${card.sourceUrl})`,
      `rank reason: ${card.rankReason}`
    ].filter(Boolean).join("; "),
    confidence: card.confidence === "high" ? "high" : "medium",
    keyFiles: card.appliesTo?.files,
    testSignal: card.verificationHint,
    matchReason: `web evidence [${card.sourceTier}/${card.purpose}] for the bug task`,
    workflowSteps: card.codeSnippet ? ["reproduce the failure with the same error class", "apply the snippet as a starting patch", "run the focused verification command"] : undefined,
    doNotDo: card.doNotDo ? [card.doNotDo] : undefined
  }));
}
