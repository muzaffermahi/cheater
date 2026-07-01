import type { AutopilotDecision } from "../autopilot/types.js";
import type { BlueprintPlan, WorkPacket } from "../blueprint/types.js";
import { splitPacketsByTouchedFile } from "../reliability/perFilePackets.js";
import { defaultVerificationCommand } from "../reliability/projectCommands.js";
import { commitletConfig } from "./config.js";
import { forgeCommitletSpec } from "./spec.js";
import type { Commitlet, CommitletHealthBudget, CommitletPlan, CommitletPlanInput, VerificationStep } from "./types.js";
import { verificationFromBlueprint, workPacketToAllowedFiles } from "./types.js";
import { emptyHealthReport } from "./health.js";

export function createCommitletPlan(input: CommitletPlanInput): CommitletPlan {
  const projectTestCommand = defaultVerificationCommand(input.repoRoot);
  const commitlets = input.blueprintPlan
    ? commitletsFromBlueprint(input.blueprintPlan, input.autopilotDecision)
    : commitletsFromDecision(input.userGoal, input.autopilotDecision, projectTestCommand);
  const finalVerification = mergeFinalVerification(commitlets);
  const plan: CommitletPlan = {
    id: `commitlet-plan-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    repoRoot: input.repoRoot,
    userGoal: input.userGoal,
    summary: summarize(input.autopilotDecision, commitlets.length),
    commitlets,
    currentIndex: 0,
    status: "planning",
    globalConstraints: [
      "Cheater remains a Pi wrapper/distribution.",
      "Pi owns TUI, shell, file reading, editing, sessions, and base agent loop.",
      "Each file-change commitlet runs in a fresh worker session.",
      "Rollback is required before editing."
    ],
    finalVerification,
    finalReview: {
      accepted: false,
      summary: "Final review has not run.",
      commitlets: [],
      finalVerification,
      health: emptyHealthReport(),
      blockingIssues: ["Commitlet plan has not completed."],
      warnings: [],
      suggestedFollowups: []
    },
    risk: input.autopilotDecision.risk,
    autopilotDecision: input.autopilotDecision,
    blueprintPlanId: input.blueprintPlan?.id
  };
  return {
    ...plan,
    commitlets: plan.commitlets.map((commitlet) => ({
      ...commitlet,
      spec: forgeCommitletSpec(commitlet, input.autopilotDecision.taskKind, input.userGoal)
    }))
  };
}

export function commitletsFromBlueprint(plan: BlueprintPlan, decision: AutopilotDecision): Commitlet[] {
  const packets = splitPacketsByTouchedFile(plan.workPackets, 1).filter((packet) => packet.type !== "inspect" && packet.type !== "review");
  return packets.map((packet, index) => commitletFromPacket(packet, index, decision));
}

export function createRepairCommitlet(failed: Commitlet, failureSummary: string): Commitlet {
  return {
    ...failed,
    id: `${failed.id}-repair`,
    title: `Repair ${failed.title}`,
    purpose: `Repair failed commitlet without expanding scope: ${failureSummary.slice(0, 220)}`,
    status: "pending",
    maxModelCalls: 1,
    expectedFilesTouched: failed.expectedFilesTouched,
    spec: {
      behaviorMustHold: [`Original commitlet passes after repair: ${failed.title}`],
      behaviorMustNotChange: failed.spec?.behaviorMustNotChange ?? ["Unrelated behavior must not change."],
      edgeCases: ["Do not weaken tests or broaden the diff to hide the failure."],
      acceptanceCriteria: [`Focused verification failure is resolved: ${failureSummary.slice(0, 220)}`],
      temporaryTestsAllowed: false,
      permanentTestsAllowed: failed.healthBudget.allowTestEdits,
      observedFailure: failureSummary.slice(0, 600),
      expectedBehavior: "Focused verification passes.",
      nonGoals: [
        "Do not touch files outside the original allowedFiles.",
        "Do not add dependencies, lockfiles, generated artifacts, or broad rewrites."
      ]
    },
    result: undefined,
    // Carry the ORIGINAL commitlet's pre-edit rollback point so reverting a failed repair
    // restores the clean prior state, not the already-broken intermediate the repair started
    // from. Without this the harness reports "reverted" while leaving broken code on disk.
    rollbackPoint: failed.rollbackPoint
  };
}

export function createCleanupCommitlet(plan: CommitletPlan, healthSummary: string): Commitlet {
  const allowedFiles = cleanupAllowedFiles(plan);
  const cleanup = makeCommitlet({
    id: `c${plan.commitlets.length + 1}-cleanup-health`,
    title: "Cleanup low-risk patch health issues",
    purpose: `Resolve final review patch-health warnings without expanding scope: ${healthSummary.slice(0, 220)}`,
    scope: "cleanup",
    allowedFiles,
    expectedFilesTouched: allowedFiles,
    focusedVerification: plan.finalVerification.length
      ? plan.finalVerification
      : defaultVerification({ taskKind: "refactor" } as AutopilotDecision, defaultVerificationCommand(plan.repoRoot)),
    risk: "low",
    allowTestEdits: false
  });
  return {
    ...cleanup,
    spec: {
      behaviorMustHold: [
        "Original user goal remains satisfied after cleanup.",
        "Final review patch-health score reaches the preferred threshold."
      ],
      behaviorMustNotChange: [
        "No behavior changes, public API changes, dependency edits, lockfile edits, generated artifacts, or test weakening."
      ],
      edgeCases: [
        "Prefer deleting duplication, simplifying branches, or splitting concentrated complexity over broad rewrites."
      ],
      acceptanceCriteria: [
        `Final review health warning is resolved: ${healthSummary.slice(0, 220)}`,
        "Focused verification remains green."
      ],
      temporaryTestsAllowed: false,
      permanentTestsAllowed: false,
      observedFailure: healthSummary.slice(0, 600),
      expectedBehavior: "Cleanup is health-only and final review can pass.",
      nonGoals: [
        "Do not introduce new behavior.",
        "Do not edit tests, dependencies, lockfiles, generated artifacts, or files outside allowedFiles.",
        "Do not continue into another cleanup after this commitlet."
      ]
    }
  };
}

function commitletFromPacket(packet: WorkPacket, index: number, decision: AutopilotDecision): Commitlet {
  const allowedFiles = workPacketToAllowedFiles(packet);
  const verification = packet.verification.map(verificationFromBlueprint);
  return makeCommitlet({
    id: `c${index + 1}-${safeId(packet.id)}`,
    title: packet.title,
    purpose: packet.acceptanceCriteria.join(" ") || packet.title,
    scope: packet.type,
    allowedFiles,
    expectedFilesTouched: allowedFiles,
    focusedVerification: verification,
    risk: packet.risk,
    allowTestEdits: packet.type === "test" || decision.taskKind === "test_failure"
  });
}

function commitletsFromDecision(userGoal: string, decision: AutopilotDecision, projectTestCommand: string | null): Commitlet[] {
  if (decision.executionDiscipline === "none") return [];
  if (decision.executionDiscipline === "single_commitlet" || decision.executionDiscipline === "fast_path") {
    return [directCommitlet("c1-single", userGoal, decision, inferAllowedFiles(userGoal, decision), projectTestCommand)];
  }
  const parts = splitGoalIntoScopes(userGoal, decision);
  return parts.map((part, index) => directCommitlet(`c${index + 1}-${safeId(part.scope)}`, part.title, decision, part.files, projectTestCommand, part.scope));
}

function directCommitlet(id: string, title: string, decision: AutopilotDecision, allowedFiles: string[], projectTestCommand: string | null, scope: string = decision.taskKind): Commitlet {
  return makeCommitlet({
    id,
    title,
    purpose: title,
    scope,
    allowedFiles,
    expectedFilesTouched: allowedFiles,
    focusedVerification: defaultVerification(decision, projectTestCommand),
    risk: decision.risk,
    allowTestEdits: decision.taskKind === "test_failure" || /\btest\b/i.test(title)
  });
}

function makeCommitlet(params: {
  id: string;
  title: string;
  purpose: string;
  scope: string;
  allowedFiles: string[];
  expectedFilesTouched: string[];
  focusedVerification: VerificationStep[];
  risk: Commitlet["risk"];
  allowTestEdits?: boolean;
}): Commitlet {
  const cfg = commitletConfig();
  const healthBudget: CommitletHealthBudget = {
    maxComplexityIncrease: 12,
    maxDuplicationIncrease: 2,
    maxFunctionLengthIncrease: 60,
    allowNewLargeFunction: false,
    allowTestEdits: Boolean(params.allowTestEdits),
    allowDependencyEdits: false,
    allowLockfileEdits: false
  };
  return {
    id: params.id,
    title: params.title,
    purpose: params.purpose,
    status: "pending",
    scope: params.scope,
    allowedFiles: params.allowedFiles,
    forbiddenFiles: [],
    allowedActions: ["inspect", "edit", "run_test", "run_lint", "run_typecheck", "stop_blocked"],
    forbiddenActions: ["dependency edit without approval", "lockfile edit without approval", "test edit unless allowed", "unrelated file edit", "generated artifact edit"],
    maxFilesTouched: Math.min(cfg.maxFilesTouchedDefault, Math.max(1, params.allowedFiles.length || 1)),
    maxDiffLines: cfg.maxDiffLinesDefault,
    maxToolCalls: 10,
    maxModelCalls: cfg.maxModelCallsPerCommitlet,
    expectedFilesTouched: params.expectedFilesTouched,
    focusedVerification: params.focusedVerification,
    broaderVerification: [],
    healthBudget,
    risk: params.risk
  };
}

function splitGoalIntoScopes(userGoal: string, decision: AutopilotDecision): Array<{ scope: string; title: string; files: string[] }> {
  const lower = userGoal.toLowerCase();
  const parts: Array<{ scope: string; title: string; files: string[] }> = [];
  if (/\bconfig|setting|defaults?\b/.test(lower)) parts.push({ scope: "config", title: "Apply scoped config/default change", files: ["src/config.ts"] });
  if (/\bcommand|slash|\/[a-z]/.test(lower)) parts.push({ scope: "command_registration", title: "Register command and command help", files: ["src/commands.ts"] });
  if (/\btool|schema\b/.test(lower)) parts.push({ scope: "tool_registration", title: "Update tool registration/schema", files: ["src/tools.ts"] });
  if (/\bdocs?|readme|help\b/.test(lower)) parts.push({ scope: "docs", title: "Update docs/help separately", files: ["README.md"] });
  if (/\btest|coverage|regression\b/.test(lower)) parts.push({ scope: "tests", title: "Add or update focused tests", files: ["test/"] });
  if (!parts.length) parts.push({ scope: decision.taskKind, title: "Implement minimal scoped change", files: inferAllowedFiles(userGoal, decision) });
  return parts;
}

function inferAllowedFiles(userGoal: string, decision: AutopilotDecision): string[] {
  const lower = userGoal.toLowerCase();
  if (/\bcommand|slash|\/[a-z]/.test(lower)) return ["src/commands.ts"];
  if (/\btool\b/.test(lower)) return ["src/tools.ts"];
  if (/\bconfig|setting\b/.test(lower)) return ["src/config.ts"];
  if (/\bdocs?|readme\b/.test(lower)) return ["README.md"];
  return decision.taskKind === "docs" ? ["README.md"] : ["(select one target file after inspection)"];
}

function cleanupAllowedFiles(plan: CommitletPlan): string[] {
  const changed = plan.commitlets.flatMap((commitlet) => commitlet.result?.filesChanged ?? []);
  const expected = plan.commitlets.flatMap((commitlet) => commitlet.expectedFilesTouched);
  const allowed = [...changed, ...expected]
    .filter((file) => file && !file.startsWith("(") && !file.endsWith("/"))
    .filter((file, index, all) => all.indexOf(file) === index);
  return allowed.slice(0, Math.max(1, commitletConfig().maxFilesTouchedDefault));
}

function defaultVerification(decision: AutopilotDecision, projectTestCommand: string | null): VerificationStep[] {
  if (decision.taskKind === "docs") return [{ purpose: "Manual docs review", required: true }];
  if (!projectTestCommand) {
    // No detected command: a command-less step passes as "manual review" instead of
    // running a guessed `npm test` that reverts correct work in a non-npm repo.
    return [{ purpose: "No project test command detected; verify manually or via cheater_verification_run", required: false }];
  }
  return [{ command: projectTestCommand, purpose: "Detected local test command", required: true }];
}

function mergeFinalVerification(commitlets: Commitlet[]): VerificationStep[] {
  const seen = new Set<string>();
  return commitlets.flatMap((commitlet) => commitlet.focusedVerification).filter((step) => {
    const key = step.command ?? step.purpose;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(decision: AutopilotDecision, count: number): string {
  return `${decision.taskKind} routed as ${decision.executionDiscipline}; ${count} commitlet${count === 1 ? "" : "s"} planned.`;
}

function safeId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "commitlet";
}
