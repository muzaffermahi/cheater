import type { BlueprintPlan, FinalReviewResult, ReviewIssue, WorkPacket } from "./types.js";

export function runFinalBlueprintReview(plan: BlueprintPlan): FinalReviewResult {
  const blocking: ReviewIssue[] = [];
  const warnings: string[] = [];
  const debugNotes: string[] = [];
  const remediationActions: string[] = [];
  const seenExecution = new Set<string>();
  const seenPlanning = new Set<string>();
  const addBlocking = (text: string, origin: "execution" | "planning") => {
    const key = `${origin}:${text}`;
    const seen = origin === "execution" ? seenExecution : seenPlanning;
    if (seen.has(text)) return;
    seen.add(text);
    blocking.push({ text, origin });
  };
  const addWarning = (text: string) => {
    if (!warnings.includes(text)) warnings.push(text);
  };

  const skipped = plan.workPackets.filter((packet) => packet.status === "skipped");
  const failedVerification = plan.workPackets.filter((packet) => packet.result?.verificationPassed === false);
  if (plan.approval === "needs_user") addBlocking("Blueprint is waiting for explicit user approval.", "execution");
  if (plan.workPackets.some((packet) => packet.status !== "done" && packet.status !== "skipped")) addBlocking("Not all work packets are complete.", "execution");
  if (skipped.length) addBlocking(`Skipped packets require an explicit repair or approval: ${skipped.map((packet) => packet.id).join(", ")}.`, "execution");
  if (failedVerification.length) addBlocking(`Packet verification failed: ${failedVerification.map((packet) => packet.id).join(", ")}.`, "execution");
  if (!plan.verification.length) addBlocking("No final verification steps are recorded.", "planning");
  if (plan.workPackets.some((packet) => packet.forbiddenActions.some((action) => /standalone TUI|standalone agent loop/i.test(action)) === false)) {
    addWarning("Some packets did not explicitly carry all Cheater forbidden-action constraints.");
  }
  const risky = plan.workPackets.filter((packet) => packet.risk === "high" && plan.approval === "auto_approved");
  if (risky.length) addWarning("High-risk packets were auto-approved by configuration.");

  const qualityGate = plan.qualityGate;
  if (qualityGate) {
    for (const issue of qualityGate.blockingIssues) addBlocking(issue, "planning");
    for (const warning of qualityGate.warnings) addWarning(warning);
    for (const action of qualityGate.remediationActions ?? []) {
      if (!remediationActions.includes(action)) remediationActions.push(action);
    }
    debugNotes.push(`quality gate: score=${qualityGate.score} fit=${qualityGate.localModelFit} passed=${qualityGate.passed}`);
    if (plan.intelligence?.bugWorkflows.length) {
      debugNotes.push(`bug-memory workflows: ${plan.intelligence.bugWorkflows.length} attached`);
    }
    if (plan.intelligence?.webSearch) {
      debugNotes.push(`docs scout: ${plan.intelligence.webSearch.status} via ${plan.intelligence.webSearch.provider}`);
    }
  }

  const blockingIssues = blocking.map((item) => item.text);

  return {
    accepted: blockingIssues.length === 0,
    blockingIssues,
    blockingIssueOrigins: blocking,
    nonBlockingWarnings: warnings,
    debugNotes,
    remediationActions,
    suggestedRepairPackets: blockingIssues.length ? [repairPacket([...blockingIssues, ...remediationActions])] : [],
    finalVerification: plan.verification,
    summary: blockingIssues.length ? "Final review blocked on required fixes." : "Final review accepted the completed blueprint."
  };
}

export function repairPacket(issues: string[]): WorkPacket {
  return {
    id: `repair-${Date.now().toString(36)}`,
    title: "Repair final review blockers",
    type: "repair",
    status: "pending",
    dependsOn: [],
    estimatedModelCalls: 1,
    maxModelCalls: 1,
    filesToInspect: [],
    filesToTouch: [],
    allowedTools: ["Pi search/list/read", "Pi edit", "Pi shell", "Cheater verification tools"],
    forbiddenActions: ["dependency or lockfile edits without approval", "deleting files without approval"],
    promptContract: `Repair only these final review blockers: ${issues.join("; ")}`,
    acceptanceCriteria: issues.map((issue) => `Resolved: ${issue}`),
    verification: [{ id: "repair-review", description: "Re-run final review after repair", required: true }],
    simulationChecks: [],
    risk: "medium"
  };
}
