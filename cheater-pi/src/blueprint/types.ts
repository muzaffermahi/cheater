export type BlueprintTaskType =
  | "explanation_only"
  | "tiny_edit"
  | "bug_fix"
  | "test_failure"
  | "feature_addition"
  | "refactor"
  | "tooling"
  | "docs"
  | "migration"
  | "benchmark"
  | "unknown";

export type PacketType = "inspect" | "implement" | "test" | "docs" | "review" | "repair";
export type PacketStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type RiskLevel = "low" | "medium" | "high";
export type ApprovalState = "auto_approved" | "approved" | "needs_user" | "blocked" | "cancelled";

export interface FilePlan {
  path: string;
  reason: string;
}

export interface VerificationStep {
  id: string;
  command?: string;
  description: string;
  required: boolean;
}

export interface SimulationCheck {
  packetId: string;
  expectedFileChanges: string[];
  expectedBehaviorChanges: string[];
  edgeCases: string[];
  failureModes: string[];
  verificationMethod: string;
  clear: boolean;
}

export interface BlueprintPreview {
  id: string;
  userGoal: string;
  taskType: string;
  taskSummary: string;
  hiddenComplexitySignals: string[];
  likelyRelevantAreas: string[];
  likelyRisks: string[];
  shouldUseBlueprint: boolean;
  reason: string;
}

export interface RepoOrientation {
  repoRoot: string;
  languages: string[];
  frameworks: string[];
  testCommands: string[];
  typecheckCommands: string[];
  entrypoints: string[];
  importantPaths: string[];
}

export interface OfficialDocsFact {
  query: string;
  packageOrLibrary: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDomain: string;
  claim: string;
  confidence: "high" | "medium" | "low";
}

export interface BlueprintMemoryHit {
  id: string;
  source: "project" | "bug" | "plan";
  summary: string;
  confidence: "high" | "medium" | "low";
  matchReason?: string;
  keyFiles?: string[];
  testSignal?: string;
  workflowSteps?: string[];
  doNotDo?: string[];
}

export interface BlueprintEvidenceItem {
  id: string;
  kind: "repo" | "docs" | "memory" | "web" | "risk";
  claim: string;
  source: string;
  confidence: "high" | "medium" | "low";
  useInPackets: string[];
}

export interface BlueprintArchitectureDecision {
  id: string;
  decision: string;
  rationale: string;
  appliesTo: string[];
  riskIfIgnored: string;
}

export interface BlueprintBugWorkflow {
  id: string;
  trigger: string;
  diagnosticSteps: string[];
  fixPattern: string;
  verificationSignal: string;
  appliesTo: string[];
  matchReason: string;
  workflowSteps?: string[];
  doNotDo?: string[];
  applicabilityReason?: string;
  risk?: "low" | "medium" | "high";
}

export interface BlueprintContextBudget {
  modelName: string;
  modelClass: string;
  plannerTokens: number;
  workerTokens: number;
  maxFactsPerPacket: number;
  maxFilesPerWorker: number;
  maxOutputTokens: number;
  compressionRules: string[];
}

export interface BlueprintPacketFact {
  packetId: string;
  file: string;
  facts: string[];
}

export interface BlueprintWebSearchPlan {
  required: boolean;
  evidenceRequired?: boolean;
  triggerWeight?: number;
  provider: "local" | "official_allowlist" | "searxng";
  queries: string[];
  allowedDomains: string[];
  status: "local_only" | "ready" | "missing_provider" | "completed";
}

export type WebSourceTier = "official" | "repo" | "issues" | "changelog" | "qna" | "blog" | "other";

export interface WebEvidenceCard {
  id: string;
  fact: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDomain: string;
  sourceTier: WebSourceTier;
  sourceRank: number;
  rankReason: string;
  packageOrLibrary: string;
  version?: string;
  appliesTo: { packetIds?: string[]; files?: string[]; symbols?: string[] };
  codeSnippet?: string;
  doNotDo?: string;
  verificationHint?: string;
  confidence: "high" | "medium" | "low";
  purpose: "official" | "exact_error" | "issues" | "examples" | "changelog";
  query: string;
}

export interface BlueprintIntelligencePack {
  title: string;
  evidence: BlueprintEvidenceItem[];
  architectureDecisions: BlueprintArchitectureDecision[];
  implementationInvariants: string[];
  bugWorkflows: BlueprintBugWorkflow[];
  packetFacts: BlueprintPacketFact[];
  webEvidence: WebEvidenceCard[];
  webSearchTriggers?: string[];
  contextBudget: BlueprintContextBudget;
  webSearch: BlueprintWebSearchPlan;
  workerBrief: string;
}

export interface BlueprintRoleSeparation {
  plannerSessionId: string;
  plannerRole: "blueprint_planner";
  workerRole: "fresh_code_worker";
  invariant: string;
  enforcement: string[];
}

export interface BlueprintQualityGate {
  score: number;
  passed: boolean;
  strengths: string[];
  blockingIssues: string[];
  warnings: string[];
  remediationActions?: string[];
  requiredSections: string[];
  localModelFit: "excellent" | "good" | "weak";
}

export interface BlueprintQualityRepairDraft {
  id: string;
  planId: string;
  createdAt: string;
  mustRegeneratePlan: boolean;
  blockers: string[];
  warnings: string[];
  remediationActions: string[];
  packetFocus: Array<{ packetId: string; actions: string[] }>;
  plannerInstructions: string[];
  acceptanceCriteria: string[];
}

export interface PlanNode {
  id: string;
  label: string;
  packetId?: string;
  status: PacketStatus;
}

export interface PlanEdge {
  from: string;
  to: string;
  reason: string;
}

export interface PlanGraph {
  nodes: PlanNode[];
  edges: PlanEdge[];
}

export interface WorkPacketResult {
  summary: string;
  filesTouched: string[];
  verificationPassed: boolean;
  output?: string;
}

export interface WorkPacket {
  id: string;
  title: string;
  type: PacketType;
  status: PacketStatus;
  dependsOn: string[];
  estimatedModelCalls: number;
  maxModelCalls: number;
  filesToInspect: FilePlan[];
  filesToTouch: FilePlan[];
  allowedTools: string[];
  forbiddenActions: string[];
  promptContract: string;
  acceptanceCriteria: string[];
  verification: VerificationStep[];
  simulationChecks: SimulationCheck[];
  risk: RiskLevel;
  result?: WorkPacketResult;
}

export interface BlueprintCandidate {
  id: string;
  name: string;
  strategy: "minimal" | "architecture_clean" | "test_safety_first";
  summary: string;
  nonGoals: string[];
  assumptions: string[];
  constraints: string[];
  risks: string[];
  verification: VerificationStep[];
  workPackets: WorkPacket[];
  estimatedModelCalls: number;
}

export interface BlueprintScore {
  candidateId: string;
  completeness: number;
  feasibility: number;
  edgeCaseCoverage: number;
  efficiency: number;
  repoFit: number;
  overall: number;
  penalties: string[];
  valid: boolean;
}

export interface FinalReviewPlan {
  id: string;
  checks: string[];
  required: boolean;
}

export type ReviewIssueOrigin = "execution" | "planning";

export interface ReviewIssue {
  text: string;
  origin: ReviewIssueOrigin;
}

export interface FinalReviewResult {
  accepted: boolean;
  blockingIssues: string[];
  blockingIssueOrigins: ReviewIssue[];
  nonBlockingWarnings: string[];
  debugNotes: string[];
  remediationActions?: string[];
  suggestedRepairPackets: WorkPacket[];
  finalVerification: VerificationStep[];
  summary: string;
}

export interface BlueprintPlan {
  id: string;
  createdAt: string;
  repoRoot: string;
  userGoal: string;
  preview: BlueprintPreview;
  selectedCandidateId: string;
  candidates: BlueprintCandidate[];
  scores: BlueprintScore[];
  summary: string;
  nonGoals: string[];
  assumptions: string[];
  repoOrientation: RepoOrientation;
  docsFacts: OfficialDocsFact[];
  memoryHits: BlueprintMemoryHit[];
  intelligence?: BlueprintIntelligencePack;
  roleSeparation: BlueprintRoleSeparation;
  qualityGate: BlueprintQualityGate;
  artifactMarkdown: string;
  planGraph: PlanGraph;
  workPackets: WorkPacket[];
  finalReview: FinalReviewPlan;
  constraints: string[];
  risks: string[];
  verification: VerificationStep[];
  approval: ApprovalState;
  confidence: number;
}

export interface BlueprintRunState {
  currentPlan: BlueprintPlan | null;
  lastReview: FinalReviewResult | null;
  cancelled: boolean;
}
