export type MissionType =
  | "bug_fix"
  | "test_failure"
  | "import_error"
  | "type_error"
  | "lint_warning"
  | "refactor"
  | "feature_addition"
  | "explanation_only"
  | "repo_orientation"
  | "benchmark_task"
  | "unknown";

export const MISSION_TYPES: readonly MissionType[] = [
  "bug_fix",
  "test_failure",
  "import_error",
  "type_error",
  "lint_warning",
  "refactor",
  "feature_addition",
  "explanation_only",
  "repo_orientation",
  "benchmark_task",
  "unknown"
];

export type MissionStatus =
  | "planning"
  | "orienting"
  | "reproducing"
  | "gathering_evidence"
  | "patching"
  | "verifying"
  | "waiting_for_user"
  | "complete"
  | "failed"
  | "no_change_needed"
  | "cancelled";

export const MISSION_STATUSES: readonly MissionStatus[] = [
  "planning",
  "orienting",
  "reproducing",
  "gathering_evidence",
  "patching",
  "verifying",
  "waiting_for_user",
  "complete",
  "failed",
  "no_change_needed",
  "cancelled"
];

export type RiskLevel = "low" | "medium" | "high";

export interface ClassificationResult {
  missionType: MissionType;
  confidence: number;
  why: string;
  recommendedFirstSteps: string[];
  shouldPatch: boolean;
  needsRepro: boolean;
  risk: RiskLevel;
}

export interface ReproResult {
  reproduced: boolean;
  alreadyPassing: boolean;
  environmentFailure: boolean;
  command: string;
  exitCode: number;
  failureKind: string;
  failingTests: string[];
  errorType: string;
  topStackFiles: string[];
  summary: string;
}

export interface MemoryHit {
  id: string;
  score: number;
  bugType: string;
  rootCause: string;
  fixPattern: string;
  source: string;
}

export interface ProjectFacts {
  repoRoot: string;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  testCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  importantPaths: string[];
  doNotTouch: string[];
  entrypoints: string[];
  commonFailurePatterns: string[];
  lastUpdated: string;
  confidence: Record<string, number>;
}

export interface EvidencePacket {
  failureKind: string;
  reproduced: boolean;
  memoryHits: MemoryHit[];
  projectFacts: ProjectFacts | null;
  packageFacts: string[];
  docsFacts: string[];
  stackoverflowFacts: string[];
  recommendedStrategy: string;
  doNotDo: string[];
  confidence: number;
}

export interface Playbook {
  name: string;
  trigger: string;
  steps: string[];
  allowedTools: string[];
  forbiddenActions: string[];
  verification: string[];
  saveMemoryWhen: string[];
}

export interface OracleReport {
  syntaxOk: boolean | null;
  lintOk: boolean | null;
  typecheckOk: boolean | null;
  focusedTestsOk: boolean | null;
  broadTestsOk: boolean | null;
  checks: Array<{
    name: string;
    command?: string;
    ok: boolean | null;
    skipped?: boolean;
    failure?: string;
  }>;
  failures: string[];
  summary: string;
}

export interface Mission {
  id: string;
  createdAt: string;
  updatedAt: string;
  repoRoot: string;
  userGoal: string;
  missionType: MissionType;
  status: MissionStatus;
  currentStep: string;
  evidence: EvidencePacket | null;
  projectOrientation: ProjectFacts | null;
  playbook: Playbook | null;
  repro: ReproResult | null;
  classification: ClassificationResult | null;
  commandsRun: string[];
  filesTouched: string[];
  testsRun: string[];
  patchSummary: string;
  verification: OracleReport | null;
  learned: string[];
  riskFlags: string[];
}

export interface MissionLogEntry {
  at: string;
  step: string;
  message: string;
}

export interface DeltaBenchEntry {
  at: string;
  mode: "cheater" | "vanilla";
  missionType: MissionType;
  success: boolean;
  reproductionDone: boolean;
  noOpDetected: boolean;
  memoryUsed: boolean;
  evidenceConfidence: number;
  filesRead: number;
  filesEdited: number;
  testsRun: number;
  rawCommandFailures: number;
  verification: string;
  userAccepted: boolean | null;
  notes: string;
}
