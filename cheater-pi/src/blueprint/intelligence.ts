import { officialDomainsFor } from "./docsScout.js";
import type {
  BlueprintArchitectureDecision,
  BlueprintBugWorkflow,
  BlueprintEvidenceItem,
  BlueprintIntelligencePack,
  BlueprintMemoryHit,
  BlueprintPacketFact,
  OfficialDocsFact,
  RepoOrientation,
  WebEvidenceCard,
  WorkPacket
} from "./types.js";
import type { BlueprintConfig } from "./config.js";
import { modelProfile } from "../reliability/modelProfile.js";

export function buildBlueprintIntelligencePack(params: {
  userGoal: string;
  orientation: RepoOrientation;
  docsFacts: OfficialDocsFact[];
  memoryHits: BlueprintMemoryHit[];
  packets: WorkPacket[];
  packetFacts?: BlueprintPacketFact[];
  webEvidence?: WebEvidenceCard[];
  webSearchTriggers?: string[];
  modelName?: string;
  taskType?: string;
  config: BlueprintConfig;
}): BlueprintIntelligencePack {
  const evidence = buildEvidence(params);
  const architectureDecisions = buildArchitectureDecisions(params);
  const implementationInvariants = buildImplementationInvariants(params);
  const bugWorkflows = buildBugWorkflows(params.memoryHits, params.packets, params.taskType);
  const webSearch = buildWebSearchPlan(params);
  const packetFacts = params.packetFacts ?? [];
  const webEvidence = params.webEvidence ?? [];
  const webSearchTriggers = params.webSearchTriggers ?? [];
  const profile = modelProfile(params.modelName, params.config);
  const contextBudget = {
    modelName: profile.name,
    modelClass: profile.class,
    plannerTokens: params.config.maxContextTokens,
    workerTokens: profile.packetContextBudget,
    maxFactsPerPacket: profile.class === "small" ? 4 : profile.class === "medium" ? 5 : Math.max(5, Math.min(8, params.config.blueprintMaxDocsFacts)),
    maxFilesPerWorker: params.config.packetMaxFilesToTouch,
    maxOutputTokens: profile.maxOutputTokens,
    compressionRules: [
      "Carry only evidence that directly changes an edit decision.",
      "Prefer file paths, commands, failing signals, and invariants over prose.",
      "Compress completed packet state into one acceptance/result sentence.",
      "Do not include raw docs pages or full memory cards in worker prompts.",
      "Carry only the web evidence cards whose appliesTo matches this packet; never the full web evidence list.",
      profile.class === "small"
        ? "For small (<=10B) models, use one target file, one command, and one acceptance proof per packet."
        : "For 11B+ local models, allow slightly richer repo facts but keep edits one file at a time."
    ]
  };
  return {
    title: `Implementation blueprint for ${params.userGoal}`,
    evidence,
    architectureDecisions,
    implementationInvariants,
    bugWorkflows,
    packetFacts,
    webEvidence,
    webSearchTriggers,
    contextBudget,
    webSearch,
    workerBrief: renderWorkerBrief({
      evidence,
      architectureDecisions,
      implementationInvariants,
      bugWorkflows,
      packetFacts,
      webEvidence,
      webSearch
    })
  };
}

function buildEvidence(params: {
  userGoal: string;
  orientation: RepoOrientation;
  docsFacts: OfficialDocsFact[];
  memoryHits: BlueprintMemoryHit[];
  packets: WorkPacket[];
}): BlueprintEvidenceItem[] {
  const packetIds = params.packets.map((packet) => packet.id);
  const repoClaims = [
    params.orientation.languages.length ? `Languages: ${params.orientation.languages.join(", ")}` : "",
    params.orientation.frameworks.length ? `Frameworks: ${params.orientation.frameworks.join(", ")}` : "",
    params.orientation.testCommands.length ? `Tests: ${params.orientation.testCommands.join(" | ")}` : "",
    params.orientation.typecheckCommands.length ? `Typecheck/build: ${params.orientation.typecheckCommands.join(" | ")}` : "",
    params.orientation.entrypoints.length ? `Entrypoints: ${params.orientation.entrypoints.slice(0, 5).join(", ")}` : ""
  ].filter(Boolean);

  const repoEvidence = repoClaims.map((claim, index) => ({
    id: `repo-${index + 1}`,
    kind: "repo" as const,
    claim,
    source: params.orientation.repoRoot,
    confidence: "high" as const,
    useInPackets: packetIds
  }));

  const docsEvidence = params.docsFacts.slice(0, 8).map((fact, index) => ({
    id: `docs-${index + 1}`,
    kind: fact.sourceDomain === "local" ? "docs" as const : "web" as const,
    claim: `${fact.packageOrLibrary}: ${fact.claim}`,
    source: fact.sourceUrl,
    confidence: fact.confidence,
    useInPackets: packetIds.filter((id) => id !== "review").slice(0, 4)
  }));

  const memoryEvidence = params.memoryHits.slice(0, 8).map((hit, index) => ({
    id: `memory-${index + 1}`,
    kind: "memory" as const,
    claim: hit.summary,
    source: hit.id,
    confidence: hit.confidence,
    useInPackets: packetIds.filter((id) => /^inspect|^implement|^tests/.test(id)).slice(0, 5)
  }));

  const riskyPackets = params.packets.filter((packet) => packet.risk === "high");
  const riskEvidence = riskyPackets.map((packet, index) => ({
    id: `risk-${index + 1}`,
    kind: "risk" as const,
    claim: `${packet.id} is high risk: ${packet.forbiddenActions.slice(0, 3).join("; ")}`,
    source: packet.id,
    confidence: "medium" as const,
    useInPackets: [packet.id]
  }));

  return [...repoEvidence, ...docsEvidence, ...memoryEvidence, ...riskEvidence].slice(0, 24);
}

function buildArchitectureDecisions(params: {
  userGoal: string;
  orientation: RepoOrientation;
  packets: WorkPacket[];
}): BlueprintArchitectureDecision[] {
  const implementPackets = params.packets.filter((packet) => packet.type === "implement");
  return [
    {
      id: "decision-wrapper-boundary",
      decision: "Keep Cheater as a Pi distribution layer; do not fork Pi's agent loop.",
      rationale: "The active product contract says Pi owns reading, editing, shell execution, sessions, context, and the TUI.",
      appliesTo: params.packets.map((packet) => packet.id),
      riskIfIgnored: "A standalone Cheater agent would duplicate Pi behavior and reintroduce legacy product confusion."
    },
    {
      id: "decision-worker-isolation",
      decision: "Planner creates the blueprint; fresh worker sessions execute file-changing packets.",
      rationale: "Small local models perform better with one bounded file/change target and compact evidence.",
      appliesTo: implementPackets.map((packet) => packet.id),
      riskIfIgnored: "A single long session can drift, loop over files, or make broad unrelated edits."
    },
    {
      id: "decision-test-before-broadening",
      decision: "Use the narrowest verification command before broad checks.",
      rationale: params.orientation.testCommands[0]
        ? `The repo exposes ${params.orientation.testCommands[0]} as the primary test signal.`
        : "No explicit test command is known, so manual verification must stay explicit.",
      appliesTo: params.packets.filter((packet) => packet.verification.length).map((packet) => packet.id),
      riskIfIgnored: "Broad tests waste context and can hide which packet introduced a regression."
    }
  ];
}

function buildImplementationInvariants(params: {
  packets: WorkPacket[];
  docsFacts: OfficialDocsFact[];
  memoryHits: BlueprintMemoryHit[];
}): string[] {
  const invariants = [
    "Every code-changing packet is scoped to at most one touched file unless explicitly approved.",
    "Workers must stop with BLOCKED_NEXT_FILE instead of editing an unlisted file.",
    "Docs and memory are evidence, not authority; local source and tests win disagreements.",
    "Existing files should be edited surgically by line range after inspection.",
    "Each packet must end with a compact handoff summary and verification status."
  ];
  if (params.docsFacts.some((fact) => fact.sourceDomain !== "local")) {
    invariants.push("Remote docs facts must come only from official allowlisted domains or configured SearXNG official-domain filters.");
  }
  if (params.memoryHits.some((hit) => hit.source === "bug")) {
    invariants.push("Bug-memory cards should be translated into diagnostic workflows before changing code.");
  }
  if (params.packets.some((packet) => packet.risk === "high")) {
    invariants.push("Approval-sensitive packets cannot dispatch until approval is recorded.");
  }
  return invariants;
}

function buildBugWorkflows(memoryHits: BlueprintMemoryHit[], packets: WorkPacket[], taskType?: string): BlueprintBugWorkflow[] {
  const bugHits = memoryHits.filter((hit) => hit.source === "bug");
  if (!packets.length) return [];
  return bugHits
    .slice(0, 5)
    .map((hit, index) => {
      const summary = hit.summary.replace(/\s+/g, " ").trim();
      const appliesToPackets = packetsForBugHit(hit, packets, taskType);
      const appliesTo = appliesToPackets.map((packet) => packet.id);
      const baseReason = hit.matchReason?.trim() || "matched by bug-memory retrieval";
      const applicabilityReason = appliesTo.length
        ? `applies to ${appliesTo.slice(0, 4).join(", ")}`
        : "no packet-level overlap; keep as diagnostic only";
      const verificationSignal = extractAfter(summary, /test signal:?\s*/i) ?? (hit.testSignal?.slice(0, 120)) ?? "Run the focused command tied to the failure before broad checks.";
      const diagnosticSteps = hit.workflowSteps && hit.workflowSteps.length
        ? hit.workflowSteps.slice(0, 5)
        : [
            "Match the current failure signal to local stack traces, tests, or command output.",
            "Inspect the smallest local file region that can explain the signal.",
            "Reject the analogy if local source contradicts it."
          ];
      const doNotDo = hit.doNotDo && hit.doNotDo.length
        ? hit.doNotDo.slice(0, 4)
        : extractList(summary, /do not do:?\s*([^;.\n]+(?:;[^;.\n]+)*)/i)
          .concat(extractList(summary, /failed approaches:?\s*([^;.\n]+(?:;[^;.\n]+)*)/i)).slice(0, 4);
      const workflowSteps = hit.workflowSteps && hit.workflowSteps.length
        ? hit.workflowSteps.slice(0, 5)
        : extractList(summary, /workflow steps:?\s*(.+)/i).flatMap((s) => s.split(/\s*->\s*/)).filter(Boolean).slice(0, 5);
      const risk = appliesTo.length ? (hit.confidence === "high" ? "medium" : "low") : "low";
      return {
        id: `workflow-${index + 1}`,
        trigger: summary.slice(0, 180),
        diagnosticSteps,
        fixPattern: extractAfter(summary, /fix pattern:?\s*/i) ?? extractAfter(summary, /fix:?\s*/i) ?? "Apply the smallest local fix that satisfies the reproduced failure.",
        verificationSignal,
        appliesTo,
        matchReason: `${baseReason}; ${applicabilityReason}`,
        workflowSteps: workflowSteps.length ? workflowSteps : undefined,
        doNotDo: doNotDo.length ? doNotDo : undefined,
        applicabilityReason,
        risk
      };
    });
}

function extractList(text: string, pattern: RegExp): string[] {
  const match = pattern.exec(text);
  if (!match) return [];
  return match[1].split(/[;,]/).map((item) => item.trim()).filter((item) => item.length > 0).slice(0, 5);
}

function packetsForBugHit(hit: BlueprintMemoryHit, packets: WorkPacket[], taskType?: string): WorkPacket[] {
  const keyFiles = (hit.keyFiles ?? []).map((file) => normalizeFileId(file).toLowerCase());
  const signalTerms = (hit.testSignal ?? "").toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  const taskDriven = Boolean(taskType && /bug_fix|test_failure|import_error|type_error/i.test(taskType));
  const hasLocalizing = keyFiles.length > 0 || signalTerms.length > 0;
  return packets.filter((packet) => {
    if (packet.type !== "implement" && packet.type !== "repair" && packet.type !== "test") return false;
    const packetFiles = [...packet.filesToTouch, ...packet.filesToInspect]
      .map((file) => normalizeFileId(file.path).toLowerCase())
      .filter((file) => file && !file.startsWith("(") && !file.endsWith("/"));
    const fileOverlap = keyFiles.some((key) => packetFiles.some((file) => file.includes(key) || key.includes(file) || sameStem(file, key)));
    const signalOverlap = signalTerms.length > 0 && packet.acceptanceCriteria.some((crit) => signalTerms.some((t) => crit.toLowerCase().includes(t)));
    if (hasLocalizing) return fileOverlap || signalOverlap;
    return taskDriven && packet.type === "implement";
  });
}

function normalizeFileId(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sameStem(a: string, b: string): boolean {
  const sa = a.replace(/^.*\//, "").replace(/\.(test|spec)\.[jt]sx?$/, "").replace(/\.[^.]+$/, "");
  const sb = b.replace(/^.*\//, "").replace(/\.(test|spec)\.[jt]sx?$/, "").replace(/\.[^.]+$/, "");
  return sa.length > 2 && sa === sb;
}

function buildWebSearchPlan(params: {
  userGoal: string;
  docsFacts: OfficialDocsFact[];
  webEvidence?: WebEvidenceCard[];
  webSearchTriggers?: string[];
  config: BlueprintConfig;
}): BlueprintIntelligencePack["webSearch"] {
  const mentionedLibraries = [...new Set(params.docsFacts.map((fact) => fact.packageOrLibrary).filter((item) => item && item !== "local"))];
  const webDomains = (params.webEvidence ?? []).map((card) => card.sourceDomain).filter(Boolean);
  const allowedDomains = [...new Set([...mentionedLibraries.flatMap((library) => officialDomainsFor(library)), ...webDomains])];
  const hasRemoteFacts = params.docsFacts.some((fact) => fact.sourceDomain !== "local");
  const hasWebEvidence = Boolean(params.webEvidence?.length);
  const enabled = params.config.blueprintOfficialDocsSearchEnabled;
  const provider = params.config.blueprintDocsProvider;
  const triggerWeight = triggerWeightFrom(params.webSearchTriggers ?? []);
  const evidenceRequired = triggerWeight >= 3 || hasUserRequestedSearch(params.webSearchTriggers ?? []);
  return {
    required: enabled || evidenceRequired,
    evidenceRequired,
    triggerWeight,
    provider,
    queries: [
      params.userGoal,
      ...mentionedLibraries.map((library) => `${library} official docs ${params.userGoal}`)
    ].slice(0, 4),
    allowedDomains,
    status: hasRemoteFacts || hasWebEvidence ? "completed" : !enabled ? "local_only" : provider === "searxng" && !params.config.searxngBaseUrl ? "missing_provider" : "ready"
  };
}

function triggerWeightFrom(triggers: string[]): number {
  return triggers.reduce((total, item) => {
    const match = /=(\d+)/.exec(item);
    return total + (match ? Number(match[1]) : 0);
  }, 0);
}

function hasUserRequestedSearch(triggers: string[]): boolean {
  return triggers.some((item) => item.startsWith("user_requested_search="));
}

function renderWorkerBrief(params: {
  evidence: BlueprintEvidenceItem[];
  architectureDecisions: BlueprintArchitectureDecision[];
  implementationInvariants: string[];
  bugWorkflows: BlueprintBugWorkflow[];
  packetFacts: BlueprintPacketFact[];
  webEvidence: WebEvidenceCard[];
  webSearch: BlueprintIntelligencePack["webSearch"];
}): string {
  const evidence = params.evidence.slice(0, 8).map((item) => `- [${item.kind}/${item.confidence}] ${item.claim} (${item.source})`);
  const decisions = params.architectureDecisions.map((item) => `- ${item.decision}`);
  const workflows = params.bugWorkflows.slice(0, 3).map((item) => `- ${item.trigger} -> ${item.fixPattern} (${item.matchReason})`);
  const packetFacts = params.packetFacts.slice(0, 8).map((item) => `- ${item.packetId}:${item.file}: ${item.facts.slice(0, 3).join("; ")}`);
  const web = params.webEvidence.slice(0, 6).map((card) => `- [${card.sourceTier}/${card.confidence}] ${card.fact.slice(0, 180)} (${card.sourceDomain})`);
  return [
    "BLUEPRINT INTELLIGENCE PACK",
    "Evidence:",
    evidence.join("\n") || "- none",
    "Architecture decisions:",
    decisions.join("\n"),
    "Implementation invariants:",
    params.implementationInvariants.map((item) => `- ${item}`).join("\n"),
    "Bug-memory workflows:",
    workflows.join("\n") || "- none",
    "Packet-local repo facts:",
    packetFacts.join("\n") || "- none",
    "Web evidence (pack-wide):",
    web.join("\n") || "- none",
    `Web/docs search: ${params.webSearch.status} via ${params.webSearch.provider}; domains=${params.webSearch.allowedDomains.join(", ") || "(local only)"}`
  ].join("\n");
}

export function packetScopedWorkerBrief(plan: { intelligence?: BlueprintIntelligencePack }, packet: WorkPacket): string | undefined {
  const pack = plan.intelligence;
  if (!pack) return undefined;
  const packetFacts = pack.packetFacts.filter((item) => item.packetId === packet.id);
  const evidence = pack.evidence.filter((item) => item.useInPackets.includes(packet.id)).slice(0, pack.contextBudget.maxFactsPerPacket);
  const decisions = pack.architectureDecisions.filter((item) => item.appliesTo.includes(packet.id));
  const relevantWorkflows = pack.bugWorkflows.filter((item) => item.appliesTo.includes(packet.id)).slice(0, Math.max(1, Math.min(2, pack.contextBudget.maxFactsPerPacket)));
  const packetFiles = new Set([...packet.filesToTouch, ...packet.filesToInspect].map((f) => f.path));
  const packetSymbols = new Set<string>();
  for (const fact of packetFacts) for (const f of fact.facts) for (const m of f.matchAll(/["']([A-Za-z_]\w{2,})["']/g)) packetSymbols.add(m[1]);
  const relevantWebEvidence = filterWebEvidenceForPacket(pack.webEvidence, packet, packetFiles, packetSymbols).slice(0, Math.max(1, Math.min(2, pack.contextBudget.maxFactsPerPacket)));
  const check = packet.simulationChecks[0];
  const doneCriteria = doneCriteriaFor(packet);
  const lines = [
    "BLUEPRINT INTELLIGENCE PACK",
    `Packet: ${packet.id} (${packet.type})`,
    "Evidence for this packet:",
    evidence.map((item) => `- [${item.kind}/${item.confidence}] ${item.claim} (${item.source})`).join("\n") || "- none",
    "Repo facts for this packet:",
    packetFacts.flatMap((item) => item.facts.map((fact) => `- ${item.file}: ${fact}`)).slice(0, 10).join("\n") || "- none",
    "Architecture decisions for this packet:",
    decisions.map((item) => `- ${item.decision}`).join("\n") || "- none",
    "Implementation invariants:",
    pack.implementationInvariants.map((item) => `- ${item}`).join("\n"),
    "Done criteria:",
    ...doneCriteria.map((item) => `- ${item}`)
  ];
  if (check?.failureModes?.length) {
    lines.push("Likely failure modes:");
    lines.push(check.failureModes.slice(0, 4).map((item) => `- ${item}`).join("\n"));
  }
  if (check?.edgeCases?.length) {
    lines.push("Edge cases to respect:");
    lines.push(check.edgeCases.slice(0, 3).map((item) => `- ${item}`).join("\n"));
  }
  lines.push(
    "Local model operating budget:",
    `- model=${pack.contextBudget.modelName} class=${pack.contextBudget.modelClass} workerTokens=${pack.contextBudget.workerTokens} maxOutput=${pack.contextBudget.maxOutputTokens} maxFacts=${pack.contextBudget.maxFactsPerPacket}`,
    ...pack.contextBudget.compressionRules.slice(-2).map((item) => `- ${item}`)
  );
  lines.push(
    relevantWorkflows.length
      ? `Bug-memory workflows (${relevantWorkflows.length}):`
      : "Bug-memory workflows: none"
  );
  if (relevantWorkflows.length) {
    for (const item of relevantWorkflows) {
      lines.push(`- ${item.trigger}`);
      if (item.fixPattern) lines.push(`  try repair pattern: ${item.fixPattern}`);
      if (item.doNotDo?.length) lines.push(`  do not make this bad fix: ${item.doNotDo.slice(0, 3).join("; ")}`);
      if (item.verificationSignal) lines.push(`  verify with: ${item.verificationSignal}`);
      if (item.matchReason) lines.push(`  why matched: ${item.matchReason}`);
      if (item.applicabilityReason) lines.push(`  applicability: ${item.applicabilityReason}`);
    }
  }
  lines.push(relevantWebEvidence.length ? `Web evidence (${relevantWebEvidence.length}):` : "Web evidence: none");
  for (const card of relevantWebEvidence) {
    lines.push(`- [${card.sourceTier}/${card.confidence}] ${card.fact.slice(0, 200)} (${card.sourceDomain})`);
    if (card.codeSnippet) lines.push(`  example: ${card.codeSnippet.slice(0, 220).replace(/\n/g, " ")}`);
    if (card.doNotDo) lines.push(`  do not: ${card.doNotDo}`);
    if (card.verificationHint) lines.push(`  verify with: ${card.verificationHint}`);
  }
  return lines.join("\n");
}

export function filterWebEvidenceForPacket(
  cards: WebEvidenceCard[],
  packet: WorkPacket,
  packetFiles: Set<string>,
  packetSymbols: Set<string>
): WebEvidenceCard[] {
  if (!cards.length) return [];
  return cards.filter((card) => {
    if (card.appliesTo.packetIds?.length && card.appliesTo.packetIds.includes(packet.id)) return true;
    if (card.appliesTo.files?.length && card.appliesTo.files.some((file) => packetFiles.has(file))) return true;
    if (card.appliesTo.symbols?.length && card.appliesTo.symbols.some((sym) => packetSymbols.has(sym))) return true;
    if (packet.type === "review") return true;
    return false;
  });
}

export function doneCriteriaFor(packet: WorkPacket): string[] {
  const criteria: string[] = [];
  for (const item of packet.acceptanceCriteria) {
    const trimmed = item.trim();
    if (trimmed) criteria.push(trimmed);
  }
  for (const step of packet.verification) {
    const cmd = step.command?.trim();
    if (cmd) criteria.push(`verification passes: ${cmd}`);
    else if (step.description.trim()) criteria.push(`verification: ${step.description.trim()}`);
  }
  if (!criteria.length) criteria.push("Packet diff satisfies the prompt contract and is reviewed.");
  return criteria.slice(0, 6);
}

function extractAfter(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  return text.slice(match.index + match[0].length).split(/(?:\.|;|\n)/)[0]?.trim() || undefined;
}
