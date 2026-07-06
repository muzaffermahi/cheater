import type { BlueprintPlan, BlueprintRoleSeparation } from "./types.js";

export function createRoleSeparation(planId: string, plannerSessionId?: string): BlueprintRoleSeparation {
  return {
    plannerSessionId: plannerSessionId?.trim() || `${planId}-planner`,
    plannerRole: "blueprint_planner",
    workerRole: "fresh_code_worker",
    invariant: "The blueprint planner never edits code; every code-changing packet must run in a different fresh worker session.",
    enforcement: [
      "planner file tools are blocked while an active blueprint has pending/running packets",
      "commitlet execution dispatches packets through sdkFreshAgentPacketRunner when a worker backend is available",
      "each packet prompt carries one-file worker scope and BLOCKED_NEXT_FILE handoff rules",
      "final review rejects incomplete or failed packets before accepting the plan"
    ]
  };
}

export function renderBlueprintArtifact(plan: Omit<BlueprintPlan, "artifactMarkdown">): string {
  const intelligence = plan.intelligence;
  const lines = [
    `# Cheater Blueprint: ${plan.preview.taskSummary}`,
    "",
    "## Mission",
    `- Goal: ${plan.userGoal}`,
    `- Task type: ${plan.preview.taskType}`,
    `- Selected strategy: ${plan.selectedCandidateId}`,
    `- Confidence: ${plan.confidence}`,
    `- Approval: ${plan.approval}`,
    "",
    "## Agent Separation",
    `- Planner: ${plan.roleSeparation.plannerRole} (${plan.roleSeparation.plannerSessionId})`,
    `- Workers: ${plan.roleSeparation.workerRole}`,
    `- Invariant: ${plan.roleSeparation.invariant}`,
    ...plan.roleSeparation.enforcement.map((item) => `- Enforcement: ${item}`),
    "",
    "## Quality Gate",
    `- Score: ${plan.qualityGate.score}`,
    `- Passed: ${plan.qualityGate.passed}`,
    `- Local model fit: ${plan.qualityGate.localModelFit}`,
    ...(plan.qualityGate.blockingIssues.length ? plan.qualityGate.blockingIssues.map((item) => `- Blocking: ${item}`) : ["- Blocking: none"]),
    ...(plan.qualityGate.warnings.length ? plan.qualityGate.warnings.map((item) => `- Warning: ${item}`) : ["- Warning: none"]),
    ...(plan.qualityGate.remediationActions?.length ? plan.qualityGate.remediationActions.map((item) => `- Remediate: ${item}`) : ["- Remediate: none"]),
    "",
    "## Evidence Ledger",
    ...(intelligence?.evidence.length
      ? intelligence.evidence.map((item) => `- ${item.id} [${item.kind}/${item.confidence}] ${item.claim} | source=${item.source} | packets=${item.useInPackets.join(", ") || "none"}`)
      : ["- none"]),
    "",
    "## Architecture Decisions",
    ...(intelligence?.architectureDecisions.length
      ? intelligence.architectureDecisions.map((item) => `- ${item.id}: ${item.decision} Rationale: ${item.rationale} Risk if ignored: ${item.riskIfIgnored}`)
      : ["- none"]),
    "",
    "## Invariants",
    ...(intelligence?.implementationInvariants.map((item) => `- ${item}`) ?? ["- none"]),
    "",
    "## Local Model Execution Profile",
    ...(intelligence
      ? [
          `- Model: ${intelligence.contextBudget.modelName}`,
          `- Class: ${intelligence.contextBudget.modelClass}`,
          `- Worker context budget: ${intelligence.contextBudget.workerTokens}`,
          `- Max output tokens: ${intelligence.contextBudget.maxOutputTokens}`,
          `- Max facts per packet: ${intelligence.contextBudget.maxFactsPerPacket}`,
          ...intelligence.contextBudget.compressionRules.map((item) => `- Compression: ${item}`)
        ]
      : ["- unavailable"]),
    "",
    "## Packet Runbook",
    ...plan.workPackets.map((packet, index) => [
      `### ${index + 1}. ${packet.id}: ${packet.title}`,
      `- Type: ${packet.type}`,
      `- Risk: ${packet.risk}`,
      `- Depends on: ${packet.dependsOn.join(", ") || "none"}`,
      `- Inspect: ${packet.filesToInspect.map((file) => `${file.path} (${file.reason})`).join("; ") || "none"}`,
      `- Touch: ${packet.filesToTouch.map((file) => `${file.path} (${file.reason})`).join("; ") || "none"}`,
      `- Acceptance: ${packet.acceptanceCriteria.join("; ")}`,
      `- Verification: ${packet.verification.map((step) => step.command ?? step.description).join("; ") || "manual"}`
    ].join("\n")),
    "",
    "## Packet-Local Repo Facts",
    ...(intelligence?.packetFacts.length
      ? intelligence.packetFacts.map((item) => `- ${item.packetId}:${item.file}: ${item.facts.slice(0, 5).join("; ")}`)
      : ["- none"]),
    "",
    "## Done Criteria",
    ...plan.workPackets.map((packet) => `- ${packet.id}: ${packet.acceptanceCriteria.join("; ") || "(no explicit criteria)"} ${packet.verification.length ? "| verify: " + packet.verification.map((step) => step.command ?? step.description).join("; ") : ""}`.trim()),
    "",
    "## Web And Docs",
    intelligence
      ? `- Status: ${intelligence.webSearch.status}; provider=${intelligence.webSearch.provider}; evidenceRequired=${Boolean(intelligence.webSearch.evidenceRequired)}; triggerWeight=${intelligence.webSearch.triggerWeight ?? 0}; domains=${intelligence.webSearch.allowedDomains.join(", ") || "local only"}`
      : "- none",
    ...(plan.docsFacts.length
      ? plan.docsFacts.map((fact) => `- ${fact.sourceTitle}: ${fact.claim} (${fact.sourceUrl})`)
      : ["- No docs facts gathered."]),
    "",
    "## Web Evidence",
    ...(intelligence?.webEvidence.length
      ? intelligence.webEvidence.map((card) => {
          const parts = [
            `- ${card.id} [${card.sourceTier}/${card.confidence}] ${card.packageOrLibrary}${card.version ? `@${card.version}` : ""} ${card.purpose}`,
            `  fact: ${card.fact.slice(0, 240)}`,
            `  source: ${card.sourceTitle} (${card.sourceUrl})`,
            `  rank: ${card.sourceRank} (${card.rankReason})`
          ];
          if (card.appliesTo.files?.length) parts.push(`  applies_to_files: ${card.appliesTo.files.join(", ")}`);
          if (card.appliesTo.symbols?.length) parts.push(`  applies_to_symbols: ${card.appliesTo.symbols.join(", ")}`);
          if (card.appliesTo.packetIds?.length) parts.push(`  applies_to_packets: ${card.appliesTo.packetIds.join(", ")}`);
          if (card.codeSnippet) parts.push(`  example: ${card.codeSnippet.slice(0, 220).replace(/\n/g, " ")}`);
          if (card.doNotDo) parts.push(`  do not: ${card.doNotDo}`);
          if (card.verificationHint) parts.push(`  verify with: ${card.verificationHint}`);
          return parts.join("\n");
        })
      : ["- none"]),
    ...(intelligence?.webSearchTriggers?.length
      ? ["", "Web search triggers: " + intelligence.webSearchTriggers.join("; ")]
      : []),
    "",
    "## Verification Plan",
    ...(plan.verification.length
      ? plan.verification.map((step) => `- ${step.required ? "required" : "optional"}: ${step.command ?? step.description}`)
      : ["- Manual verification required."]),
    "",
    "## Non-Goals",
    ...plan.nonGoals.map((item) => `- ${item}`),
    "",
    "## Risks",
    ...plan.risks.map((item) => `- ${item}`)
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
