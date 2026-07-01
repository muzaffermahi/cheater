import type { BlueprintPlan, BlueprintPacketFact, BlueprintQualityGate } from "./types.js";

const REQUIRED_SECTIONS = [
  "Mission",
  "Agent Separation",
  "Evidence Ledger",
  "Architecture Decisions",
  "Invariants",
  "Local Model Execution Profile",
  "Packet Runbook",
  "Packet-Local Repo Facts",
  "Web And Docs",
  "Verification Plan"
];

export function evaluateBlueprintQuality(plan: Omit<BlueprintPlan, "qualityGate" | "artifactMarkdown"> | BlueprintPlan): BlueprintQualityGate {
  const strengths: string[] = [];
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const remediationActions: string[] = [];
  let score = 0;

  const intelligence = plan.intelligence;
  add(Boolean(plan.roleSeparation?.invariant && plan.roleSeparation.enforcement.length >= 3), 14, "planner/worker separation is explicit", "planner/worker separation is under-specified", true, "Regenerate role separation with planner file-tool blocking, fresh-worker dispatch, and one-packet worker enforcement.");
  add(Boolean(intelligence && intelligence.evidence.length >= 3), 12, "evidence ledger has multiple facts", "evidence ledger is thin", false, "Add at least three concrete evidence ledger items from repo facts, docs, memory, or risk analysis.");
  add(Boolean(intelligence && intelligence.architectureDecisions.length >= 3), 10, "architecture decisions are explicit", "architecture decisions are missing or thin", false, "Record at least three architecture decisions with rationale, affected packets, and risk if ignored.");
  add(Boolean(intelligence && intelligence.implementationInvariants.length >= 4), 10, "implementation invariants are explicit", "implementation invariants are thin", false, "Add implementation invariants covering file scope, verification, external evidence, and worker handoff.");
  add(Boolean(intelligence && intelligence.packetFacts.length > 0), 10, "packet-local repo facts are available", "packet-local repo facts are missing", false, "Build packet-local repo facts for each implementation packet before dispatch.");
  add(plan.workPackets.length >= 3 && plan.workPackets.some((packet) => packet.type === "review"), 10, "packet runbook includes review", "packet runbook is too short or lacks review", true, "Regenerate the packet runbook with inspect, implement/test, and final review packets.");
  add(plan.workPackets.every((packet) => packet.filesToTouch.length <= (intelligence?.contextBudget.maxFilesPerWorker ?? 1)), 10, "worker packets respect file scope", "one or more packets exceed file scope", true, "Split oversized packets until each worker touches no more than the model profile allows.");
  add(plan.verification.length > 0 || plan.workPackets.some((packet) => packet.verification.length > 0), 8, "verification is planned", "verification plan is missing", true, "Attach focused verification commands or explicit manual verification to the plan and relevant packets.");
  add(Boolean(intelligence?.contextBudget.modelClass && intelligence.contextBudget.maxFactsPerPacket <= 8), 8, "local model budget is explicit", "local model budget is missing", false, "Attach a local model profile and bounded packet fact budget.");
  add(Boolean(intelligence?.webSearch.status), 4, "docs/web posture is recorded", "docs/web posture is missing", false, "Record whether external evidence is local-only, ready, missing provider, or completed.");
  add(plan.nonGoals.length > 0 && plan.risks.length > 0, 4, "non-goals and risks are recorded", "non-goals or risks are missing", false, "Add explicit non-goals and risks so small workers know what not to change.");

  const webSearch = intelligence?.webSearch;
  const hasRemoteDocs = plan.docsFacts.some((fact) => fact.sourceDomain !== "local");
  const hasWebEvidence = Boolean(intelligence?.webEvidence?.length);
  if (webSearch?.evidenceRequired) {
    if (webSearch.status === "missing_provider") {
      blockingIssues.push("external evidence is required but the configured web/docs provider is missing");
      remediate("Configure SearXNG or switch to the official allowlist docs provider before dispatching this Blueprint.");
    } else if (!hasRemoteDocs && !hasWebEvidence) {
      blockingIssues.push("external evidence is required but no remote docs or web evidence was gathered");
      remediate("Attach official docs or ranked web evidence for the external API/version before dispatch.");
    } else {
      strengths.push("required external evidence is attached");
      score += 4;
    }
  }

  if (plan.approval === "needs_user") {
    warnings.push("plan requires user approval before dispatch");
    remediate("Request explicit user approval or reduce the plan risk until auto-approval is allowed.");
  }
  if (plan.workPackets.some((packet) => packet.risk === "high") && plan.approval === "auto_approved") {
    blockingIssues.push("high-risk packet is auto-approved");
    remediate("Mark high-risk packets as requiring user approval or split them into lower-risk packets.");
  }

  const packetFacts = intelligence?.packetFacts ?? [];
  const docsPackages = new Set(plan.docsFacts.map((fact) => fact.packageOrLibrary.toLowerCase()).filter((item) => item && item !== "local"));
  const knownLibraries = new Set([
    ...plan.repoOrientation.frameworks.map((item) => item.toLowerCase()),
    ...plan.repoOrientation.languages.map((item) => item.toLowerCase()),
    ...docsPackages
  ]);
  for (const packet of plan.workPackets) {
    if (packet.acceptanceCriteria.length === 0) {
      blockingIssues.push(`packet ${packet.id} has no success criteria`);
      remediate(`Add concrete acceptance criteria to packet ${packet.id}.`);
      continue;
    }
    if (isVagueCriteria(packet.acceptanceCriteria)) {
      warnings.push(`packet ${packet.id} has vague success criteria`);
      remediate(`Replace vague acceptance criteria on packet ${packet.id} with observable behavior and verification.`);
    }
    if (packet.type === "implement" && !packetHasTestSignal(packet, packetFacts)) {
      warnings.push(`packet ${packet.id} has no test signal; add a focused test mapping or verification command`);
      remediate(`Add a focused test mapping or verification command to packet ${packet.id}.`);
    }
    for (const guess of riskyApiGuesses(packet, knownLibraries, docsPackages)) {
      warnings.push(`packet ${packet.id} references ${guess} without repo or docs evidence`);
      remediate(`Attach repo/docs evidence for ${guess} or remove the guessed API from packet ${packet.id}.`);
    }
  }

  score = Math.min(100, score);
  const localModelFit = score >= 88 && !blockingIssues.length
    ? "excellent"
    : score >= 72 && blockingIssues.length === 0
      ? "good"
      : "weak";
  return {
    score,
    passed: score >= 72 && blockingIssues.length === 0,
    strengths,
    blockingIssues,
    warnings,
    remediationActions,
    requiredSections: REQUIRED_SECTIONS,
    localModelFit
  };

  function add(ok: boolean, points: number, strength: string, issue: string, blocking = false, remediation?: string): void {
    if (ok) {
      score += points;
      strengths.push(strength);
    } else if (blocking) {
      blockingIssues.push(issue);
      if (remediation) remediate(remediation);
    } else {
      warnings.push(issue);
      if (remediation) remediate(remediation);
    }
  }

  function remediate(action: string): void {
    if (!remediationActions.includes(action)) remediationActions.push(action);
  }
}

const GENERIC_CRITERIA = /^(packet|this|the)\b.+(verified|reviewed|satisfies|complete|done|explicitly)/i;

function isVagueCriteria(criteria: string[]): boolean {
  if (!criteria.length) return true;
  const substantive = criteria.filter((item) => item.trim().length >= 16 && !GENERIC_CRITERIA.test(item.trim()));
  return substantive.length === 0;
}

function packetHasTestSignal(packet: BlueprintPlan["workPackets"][number], packetFacts: BlueprintPacketFact[]): boolean {
  if (packet.verification.some((step) => step.command && TEST_COMMAND_RE.test(step.command))) return true;
  const hasMapping = packetFacts.some((item) => item.packetId === packet.id && item.facts.some((fact) => /likely tests/.test(fact)));
  if (hasMapping) return true;
  if (packet.filesToTouch.some((file) => isTestPath(file.path))) return true;
  return false;
}

function riskyApiGuesses(packet: BlueprintPlan["workPackets"][number], known: Set<string>, docsPackages: Set<string>): string[] {
  const guesses = new Set<string>();
  for (const criterion of packet.acceptanceCriteria) {
    for (const match of criterion.matchAll(/\b([A-Z][A-Za-z0-9]{2,})\.([a-z][A-Za-z0-9]+)/g)) {
      const library = match[1].toLowerCase();
      if (RESERVED_WORDS.has(library)) continue;
      if (known.has(library) || docsPackages.has(library)) continue;
      guesses.add(`${match[1]}.${match[2]}`);
    }
  }
  return [...guesses].slice(0, 3);
}

const TEST_COMMAND_RE = /\b(test|pytest|jest|vitest|node --test|mocha|unittest|cargo test)\b/i;

function isTestPath(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file);
}

const RESERVED_WORDS = new Set(["the", "this", "that", "use", "add", "new", "set", "get", "all", "our", "you"]);
