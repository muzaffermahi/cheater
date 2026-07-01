import type { AutopilotDecision, RiskLevel } from "../autopilot/types.js";
import type { BlueprintPlan, VerificationStep as BlueprintVerificationStep, WorkPacket } from "../blueprint/types.js";

export type CommitletStatus = "pending" | "running" | "passed" | "failed" | "repaired" | "reverted" | "skipped";
export type CommitletPlanStatus = "planning" | "running" | "paused" | "complete" | "failed" | "reverted";
export type CommitletAction = "inspect" | "edit" | "run_test" | "run_lint" | "run_typecheck" | "update_docs" | "stop_blocked";

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
}

export interface CommitletPlanInput {
  repoRoot: string;
  userGoal: string;
  autopilotDecision: AutopilotDecision;
  blueprintPlan?: BlueprintPlan;
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
