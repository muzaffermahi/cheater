import type { AutopilotDecision, RiskLevel } from "../autopilot/types.js";
import type { BlueprintPlan, VerificationStep as BlueprintVerificationStep, WorkPacket } from "../blueprint/types.js";

export type CommitletStatus = "pending" | "running" | "passed" | "failed" | "repaired" | "reverted" | "skipped";
export type CommitletPlanStatus = "planning" | "running" | "paused" | "complete" | "failed" | "reverted";
export type CommitletAction = "inspect" | "edit" | "run_test" | "run_lint" | "run_typecheck" | "update_docs" | "stop_blocked";

// The execution LANE of a commitlet plan - the single source of truth every layer (worker-mode
// resolver, pre-write guard, diff guard, prompt builder, loop detector, grader) switches on so they
// can never disagree about how a plan runs. Distinct from AutopilotDecision.executionMode, which is
// an unrelated ROUTING concept (answer_only/careful_repro/blueprint_orchestrator/vanilla_pi).
//   surgical - strict one-/few-file edits to an existing repo; real fresh workers allowed.
//   scaffold - from-scratch build; in-session, sticky, phase-grouped, plan-wide scope, one prompt.
//   repair   - strict narrow fix after a failed build/verify; applies per-commitlet in any plan.
export type CommitletExecutionMode = "surgical" | "scaffold" | "repair";

export interface VerificationStep {
  command?: string;
  purpose: string;
  required: boolean;
  timeoutSeconds?: number;
}

export interface CommitletSpec {
  behaviorMustHold: string[];
  behaviorMustNotChange: string[];
  edgeCases: string[];
  acceptanceCriteria: string[];
  temporaryTestsAllowed: boolean;
  permanentTestsAllowed: boolean;
  reproductionCommand?: string;
  observedFailure?: string;
  expectedBehavior?: string;
  nonGoals: string[];
}

export interface CommitletHealthBudget {
  maxComplexityIncrease: number;
  maxDuplicationIncrease: number;
  maxFunctionLengthIncrease: number;
  allowNewLargeFunction: boolean;
  allowTestEdits: boolean;
  allowDependencyEdits: boolean;
  allowLockfileEdits: boolean;
}

export interface RollbackPoint {
  id: string;
  createdAt: string;
  gitRef?: string;
  patchFile?: string;
  snapshotDir?: string;
  existedFiles?: string[];
  description: string;
}

export interface CommitletResult {
  filesChanged: string[];
  diffLines: number;
  testsRun: string[];
  verificationPassed: boolean;
  healthPassed: boolean;
  rollbackAvailable: boolean;
  summary: string;
  issues: string[];
}

export interface Commitlet {
  id: string;
  title: string;
  purpose: string;
  status: CommitletStatus;
  scope: string;
  allowedFiles: string[];
  forbiddenFiles: string[];
  allowedActions: CommitletAction[];
  forbiddenActions: string[];
  maxFilesTouched: number;
  maxDiffLines: number;
  maxToolCalls: number;
  maxModelCalls: number;
  expectedFilesTouched: string[];
  focusedVerification: VerificationStep[];
  broaderVerification: VerificationStep[];
  healthBudget: CommitletHealthBudget;
  rollbackPoint?: RollbackPoint;
  spec?: CommitletSpec;
  result?: CommitletResult;
  risk: RiskLevel;
}

export interface PatchHealthReport {
  score: number;
  passed: boolean;
  warnings: string[];
  blockingIssues: string[];
  metrics: {
    diffLines: number;
    filesTouched: number;
    duplicationDelta: number;
    complexityDelta: number;
    largeFunctionDelta: number;
    assertionDelta: number;
  };
}

export interface TestAuditReport {
  passed: boolean;
  warnings: string[];
  blockingIssues: string[];
}

export interface DiffGuardReport {
  passed: boolean;
  touchedFiles: string[];
  diffLines: number;
  blockingIssues: string[];
  warnings: string[];
}

export interface CommitletFinalReview {
  accepted: boolean;
  summary: string;
  commitlets: string[];
  finalVerification: VerificationStep[];
  health: PatchHealthReport;
  blockingIssues: string[];
  warnings: string[];
  suggestedFollowups: string[];
}

export interface CommitletPlan {
  id: string;
  createdAt: string;
  repoRoot: string;
  userGoal: string;
  summary: string;
  commitlets: Commitlet[];
  currentIndex: number;
  status: CommitletPlanStatus;
  globalConstraints: string[];
  finalVerification: VerificationStep[];
  finalReview: CommitletFinalReview;
  risk: RiskLevel;
  autopilotDecision?: AutopilotDecision;
  blueprintPlanId?: string;
  // Execution lane for the whole plan (defaults to "surgical" when unset). Set to "scaffold" for
  // from-scratch builds so every layer runs the in-session/plan-wide/one-prompt path.
  buildMode?: CommitletExecutionMode;
}

export interface CommitletPlanInput {
  repoRoot: string;
  userGoal: string;
  autopilotDecision: AutopilotDecision;
  blueprintPlan?: BlueprintPlan;
  // Pre-built commitlets to use verbatim instead of inferring them (the from-scratch scaffold path
  // passes model-derived create-commitlets here). Spec-forging + plan assembly still run over them.
  commitlets?: Commitlet[];
  // Execution lane for the plan; createCommitletPlan stamps it onto the plan (defaults to surgical).
  buildMode?: CommitletExecutionMode;
}

export interface CommitletTelemetryEvent {
  startedAt: string;
  finishedAt: string;
  taskKind: string;
  executionDiscipline: string;
  modelProfile?: string;
  contextBudget?: number;
  commitletCount: number;
  toolCalls?: number;
  loopEvents: number;
  verificationPassed: boolean;
  healthScore: number;
  testAuditPassed: boolean;
  repairCount: number;
  rollbackCount: number;
  finalOutcome: string;
  tokenInput?: number;
  tokenOutput?: number;
  userIntervention?: number;
  wallMs: number;
}

export function verificationFromBlueprint(step: BlueprintVerificationStep): VerificationStep {
  return {
    command: step.command,
    purpose: step.description,
    required: step.required
  };
}

export function workPacketToAllowedFiles(packet: WorkPacket): string[] {
  return packet.filesToTouch.map((file) => file.path);
}

/** A repair/cleanup commitlet is always run in the strict "repair" lane (narrow scope), whatever
 *  the plan's lane is. Created by createRepairCommitlet (`-repair`) / createCleanupCommitlet
 *  (`-cleanup-health`). */
export function isRepairCommitlet(commitlet: Pick<Commitlet, "id" | "scope">): boolean {
  return /-repair$/.test(commitlet.id) || /-cleanup-health$/.test(commitlet.id) || commitlet.scope === "cleanup";
}

/** The effective execution lane for one commitlet: a repair always overrides the plan lane, so a
 *  repair inside a scaffold plan runs strict-narrow. Everything (guards, worker mode, prompt, loop
 *  detector, grader) reads THIS, never plan.buildMode directly, so the three lanes stay consistent. */
export function effectiveMode(plan: Pick<CommitletPlan, "buildMode"> | null | undefined, commitlet: Pick<Commitlet, "id" | "scope"> | null | undefined): CommitletExecutionMode {
  if (commitlet && isRepairCommitlet(commitlet)) return "repair";
  return plan?.buildMode ?? "surgical";
}

/** Union of every concrete (non-placeholder, non-directory) file the plan's commitlets may touch -
 *  the plan-wide allow-set the scaffold lane uses so building any planned file is never blocked as
 *  "out of scope" just because a different phase is the running commitlet. */
export function planAllowedFileUnion(plan: Pick<CommitletPlan, "commitlets">): string[] {
  const files = new Set<string>();
  for (const commitlet of plan.commitlets) {
    for (const file of commitlet.allowedFiles) {
      if (file && !file.startsWith("(") && !file.endsWith("/")) files.add(file.replace(/\\/g, "/"));
    }
  }
  return [...files];
}
