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
import { buildRepoConstraintGraph, buildPlannerGraph, queryConstraintFacts, selectFilesByGoalFromGraph, symbolClustersForGoal } from "../commitlet/constraintGraph.js";
import type { BlueprintPlan } from "./types.js";
import { splitPacketsByTouchedFile } from "../reliability/perFilePackets.js";
import { isCheaterOwnRepo } from "../runstate/repoIdentity.js";
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
  const memoryHits = retrievePlanningMemory(params.cwd, params.userGoal, config.blueprintMemoryEnabled);
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
  const enrichedMemoryHits = memoryHits;
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
        ...(isCheaterOwnRepo(params.cwd) ? ["Cheater remains a Pi wrapper/distribution"] : ["changes match the project's own stack and conventions"])
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

