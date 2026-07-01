import type { BlueprintPlan, BlueprintQualityRepairDraft } from "./types.js";

const PLAN_LEVEL_PATTERNS = [
  /role separation/i,
  /packet runbook/i,
  /worker packets respect file scope|oversized packets|split oversized/i,
  /verification plan is missing/i,
  /external evidence is required/i,
  /configured web\/docs provider is missing/i
];

export function buildQualityRepairDraft(plan: BlueprintPlan): BlueprintQualityRepairDraft {
  const actions = plan.qualityGate.remediationActions ?? [];
  const blockers = plan.qualityGate.blockingIssues;
  const warnings = plan.qualityGate.warnings;
  const allSignals = [...blockers, ...warnings, ...actions];
  const packetFocus = plan.workPackets
    .map((packet) => {
      const packetActions = allSignals.filter((item) => mentionsPacket(item, packet.id));
      return packetActions.length ? { packetId: packet.id, actions: unique(packetActions) } : undefined;
    })
    .filter((item): item is { packetId: string; actions: string[] } => Boolean(item));
  const mustRegeneratePlan = blockers.some((issue) => PLAN_LEVEL_PATTERNS.some((pattern) => pattern.test(issue)))
    || actions.some((action) => PLAN_LEVEL_PATTERNS.some((pattern) => pattern.test(action)));

  const plannerInstructions = [
    mustRegeneratePlan
      ? "Regenerate the Blueprint plan before dispatch; do not patch code from the planner session."
      : "Amend the active Blueprint metadata before dispatch; do not patch code from the planner session.",
    "Apply every remediation action as planning work, then re-run the quality gate.",
    "Keep planner and worker roles separate; only fresh worker sessions may edit project files.",
    "Preserve one touched file per worker unless the model profile explicitly allows more.",
    "If external evidence is required, attach official docs or ranked web evidence before dispatch.",
    ...packetFocus.map((item) => `For ${item.packetId}: ${item.actions.join(" | ")}`)
  ];

  return {
    id: `quality-repair-${Date.now().toString(36)}`,
    planId: plan.id,
    createdAt: new Date().toISOString(),
    mustRegeneratePlan,
    blockers,
    warnings,
    remediationActions: actions,
    packetFocus,
    plannerInstructions: unique(plannerInstructions),
    acceptanceCriteria: [
      "Quality gate passes before cheater_blueprint_next_packet dispatches any worker.",
      "Blueprint artifact shows no blocking quality-gate issues.",
      "Every listed remediation action is either resolved or explicitly made irrelevant by regenerated evidence.",
      "Planner still never reads, edits, shells, or writes project files while workers own code changes."
    ]
  };
}

export function formatQualityRepairDraft(draft: BlueprintQualityRepairDraft): string {
  return [
    "Cheater Blueprint planner-only repair draft",
    `plan: ${draft.planId}`,
    `mustRegeneratePlan: ${draft.mustRegeneratePlan}`,
    `blockers: ${draft.blockers.join("; ") || "none"}`,
    `warnings: ${draft.warnings.join("; ") || "none"}`,
    "remediation:",
    ...(draft.remediationActions.length ? draft.remediationActions.map((item) => `- ${item}`) : ["- none"]),
    "packet focus:",
    ...(draft.packetFocus.length ? draft.packetFocus.map((item) => `- ${item.packetId}: ${item.actions.join(" | ")}`) : ["- none"]),
    "planner instructions:",
    ...draft.plannerInstructions.map((item) => `- ${item}`),
    "acceptance:",
    ...draft.acceptanceCriteria.map((item) => `- ${item}`)
  ].join("\n");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function mentionsPacket(text: string, packetId: string): boolean {
  const escaped = packetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\bpacket\\s+|\\bpacketId=|\\s)${escaped}(?=$|[\\s.;:,])`).test(text);
}
