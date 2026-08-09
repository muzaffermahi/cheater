// Kitten Core — the canonical application event model. NO Pi.
//
// This is the single versioned contract that ties the whole product together: the durable store
// appends these events, the application service emits them, the headless CLI prints them, and the
// (future) TUI and web UI render them. There is exactly ONE state machine — this one — and UI code
// renders it; it never invents its own. (Goal §7.)
//
// Every event carries an envelope (id, conversationId, monotonically-increasing seq within the
// conversation, ts, schemaVersion) plus a typed, discriminated payload. `seq` is assigned by the
// store (the ordering source of truth), and `id` is derived as `${conversationId}:${seq}` so it is
// stable and reproducible — no randomness, which keeps replay and tests deterministic.

/**
 * Bump ONLY for an incompatible change: renaming/removing/retyping an existing field, or changing a
 * field's semantics. Adding a new event type or a new OPTIONAL field does NOT bump — renderers are
 * required to ignore unknown `type`s and tolerate absent optional fields (the desktop shell replays
 * stored history through the same dispatch as live events, so this is what keeps old sessions
 * rendering). See docs/engine-events.md for the renderer-facing contract.
 *
 * Reserved (declared, no emitter yet — do not build UI against them): `tool.proposed`, `diff.updated`.
 */
export const EVENT_SCHEMA_VERSION = 1;

/** A run's lifecycle status (Goal §6 state machine). Transient states become `interrupted` on
 *  recovery; only `completed`/`failed`/`cancelled`/`interrupted` are terminal. */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "completed";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["cancelled", "interrupted", "failed", "completed"];
export const TRANSIENT_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "waiting_approval", "cancelling"];

export function isTerminalRunStatus(s: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}

/** The execution lane the router chose. `answer` = no write tools; the rest map to core/ engines. */
export type Lane = "answer" | "direct" | "reliable" | "bon" | "ascent";

/** The kinds of message a conversation can hold (for the durable human-visible history). */
export type MessageRole = "user" | "assistant" | "system";

// ── Payloads ────────────────────────────────────────────────────────────────────────────────────
// One interface per event type, all discriminated on `type`. Payloads are deliberately lean: enough
// to reconstruct history + drive a UI, never the full model transcript (that is bounded separately).

export interface ConversationCreated {
  type: "conversation.created";
  title: string;
  projectRoot: string;
  projectId: string;
  model: string;
  mode: Lane | "auto";
}
export interface ConversationRenamed {
  type: "conversation.renamed";
  title: string;
}
export interface ConversationArchived {
  type: "conversation.archived";
  archived: boolean;
}

export interface UserMessage {
  type: "user.message";
  text: string;
}

/** The router's decision, recorded before the run starts so the choice is always inspectable. */
export interface RouteSelected {
  type: "route.selected";
  runId: string;
  lane: Lane;
  /** Human-readable reasons the lane was chosen (Goal §3 "expose why it was selected"). */
  reasons: string[];
  /** Planned sample count for bon/ascent (1 otherwise). */
  k: number;
  /** The deterministic hardness score behind the choice. Optional: stored events predate it. */
  hardness?: number;
  /** The user's effort level for this run (fast|balanced|careful|think-hard), when one was set. */
  effort?: string;
}

export interface RunStarted {
  type: "run.started";
  runId: string;
  request: string;
  lane: Lane;
  model?: string;
  agent?: string;
}
export interface RunStatusChanged {
  type: "run.status";
  runId: string;
  status: RunStatus;
  detail?: string;
}

/** Streamed assistant content. Deltas are coalesced by the store's caller; the `final` carries the
 *  whole committed message so replay never depends on having every delta. */
export interface AssistantDelta {
  type: "assistant.delta";
  runId: string;
  text: string;
}
export interface AssistantFinal {
  type: "assistant.final";
  runId: string;
  text: string;
}
/** Reasoning/status stream — persisted per the product's privacy policy (may be dropped). */
export interface ReasoningDelta {
  type: "reasoning.delta";
  runId: string;
  text: string;
}

export interface ToolProposed {
  type: "tool.proposed";
  runId: string;
  callId: string;
  name: string;
  /** Sanitized/bounded argument preview — never raw secrets. */
  args: string;
}
export interface ToolApprovalRequired {
  type: "tool.approval_required";
  runId: string;
  callId: string;
  name: string;
  reason: string;
  risk: "low" | "medium" | "high";
}
export interface ToolStarted {
  type: "tool.started";
  runId: string;
  callId: string;
  name: string;
  /** What the call is acting on — a path, a command, a pattern. Optional: stored events predate it. */
  target?: string;
}
export interface ToolOutput {
  type: "tool.output";
  runId: string;
  callId: string;
  /** Bounded output preview. */
  chunk: string;
}
export interface ToolCompleted {
  type: "tool.completed";
  runId: string;
  callId: string;
  name: string;
  /**
   * What the call acted on — a path, a command, a pattern. Optional because stored events predate it.
   * Without it a UI can only say "read", which tells the user nothing about what was read.
   */
  target?: string;
  ok: boolean;
  durationMs: number;
  /** Bounded final output. */
  output: string;
}

/** One bounded model-call timing record; optional for older providers without llama.cpp timings. */
export interface InferenceCompleted {
  type: "inference.completed";
  runId: string;
  role: string;
  cacheTokens: number;
  promptTokens: number;
  promptMs: number;
  predictedTokens: number;
  predictedMs: number;
  decodeTokensPerSecond: number;
  /** Truthful Runtime Director acknowledgement; optional for pre-director persisted events. */
  runtimeReceipt?: {
    phase: string;
    role: string;
    ownership: "managed-native" | "external-compatible";
    evidence: "verified" | "sent-only";
    requested: Record<string, unknown>;
    applied: Record<string, unknown>;
    dropped: string[];
    unverifiable: string[];
  };
}

export interface CandidateStarted {
  type: "candidate.started";
  runId: string;
  index: number;
  /** The candidate whose reasoning and tool calls are being streamed live. */
  lead?: boolean;
}
export interface CandidateCompleted {
  type: "candidate.completed";
  runId: string;
  index: number;
  finished: boolean;
  summary: string;
  usage?: { prompt: number; completion: number; reasoning: number };
}
export interface CandidateRejected {
  type: "candidate.rejected";
  runId: string;
  index: number;
  reason: string;
}

export interface VerificationStarted {
  type: "verification.started";
  runId: string;
  what: string;
}
export interface VerificationEvidence {
  type: "verification.evidence";
  runId: string;
  /** The check/command run. */
  check: string;
  passed: boolean;
  durationMs: number;
  /** What contract item this proves, if known (Goal §4 "what contract item it proves"). */
  proves?: string;
}
export interface VerificationFailed {
  type: "verification.failed";
  runId: string;
  detail: string;
}
export interface VerificationPassed {
  type: "verification.passed";
  runId: string;
  detail: string;
}

export interface FileChanged {
  type: "file.changed";
  runId: string;
  path: string;
  added: number;
  removed: number;
  /** Which candidate produced this change, when relevant (winner provenance). */
  candidate?: number;
}
export interface DiffUpdated {
  type: "diff.updated";
  runId: string;
  files: number;
  added: number;
  removed: number;
}

export interface RepairStarted {
  type: "repair.started";
  runId: string;
  round: number;
  seed: string;
}

export interface RunCancelled {
  type: "run.cancelled";
  runId: string;
}
export interface RunInterrupted {
  type: "run.interrupted";
  runId: string;
  /** Where recovery decided the run was left mid-flight. */
  fromStatus: RunStatus;
}
export interface RunFailed {
  type: "run.failed";
  runId: string;
  error: string;
}
export interface RunCompleted {
  type: "run.completed";
  runId: string;
  /** The run produced/adopted work and stopped intentionally (NOT the same as verified). */
  finished: boolean;
  /** Independent execution evidence confirmed the change (finished && !verified = "checked", §4). */
  verified: boolean;
  lane: Lane;
  model?: string;
  summary: string;
  wallMs: number;
  usage: { prompt: number; completion: number; reasoning: number };
  /** The engine's effort timer ended the run; the user did not press Stop. */
  stoppedByCeiling?: boolean;
  executionStrategy?: "compiled-fast" | "compiled-fast-to-reliable" | "agent";
  performance?: {
    modelCalls: number;
    cacheTokens: number;
    promptTokens: number;
    promptMs: number;
    predictedTokens: number;
    predictedMs: number;
    decodeTokensPerSecond: number;
    effectiveOutputRate: number;
  };
}

/** A run's file changes were rolled back by `/undo` (Goal §8). Records what was reverted/deleted. */
export interface RunUndone {
  type: "run.undone";
  runId: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
}

export interface ToolApprovalResolved {
  type: "tool.approval_resolved";
  runId: string;
  callId: string;
  allowed: boolean;
  source: "user" | "auto-deny-cancel";
}

export interface RunRedone {
  type: "run.redone";
  runId: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
}

export interface TaskStarted {
  type: "task.started";
  runId: string;
  childConversationId: string;
  agent: string;
  prompt: string;
}

export interface TaskCompleted {
  type: "task.completed";
  runId: string;
  childConversationId: string;
  childRunId: string;
  status: string;
  summary: string;
  usage: { prompt: number; completion: number; reasoning: number };
}

/** The finish receipt: the honest audit trail of what happened (Goal §4/§9 "honest receipts"). */
export interface ReceiptFinalized {
  type: "receipt.finalized";
  runId: string;
  lines: string[];
  filesChanged: string[];
  verified: boolean;
}

/** Advisory small-model review persisted after a file-changing run. It never changes the run grade. */
export interface SidecarPostflight {
  type: "sidecar.postflight";
  runId: string;
  source: "sidecar" | "deterministic";
  secrets: string[];
  warnings: string[];
  evidenceWarnings: string[];
  recommendedTests: string[];
  suggestedCommands: string[];
  risk: "low" | "medium" | "high";
  riskReasons: string[];
  generatedTestCases: string[];
}

/** Advisory failure explanation generated after a failed run; it is never verification evidence. */
export interface SidecarFailure {
  type: "sidecar.failure";
  runId: string;
  source: "sidecar" | "deterministic";
  severity: "error" | "warning" | "info";
  signature: string;
  likelyCause: string;
  salientLines: string[];
}

/**
 * The Task Compiler's decision, recorded BEFORE the expensive model runs so the contract that shaped
 * the run is always inspectable. Deliberately carries facts and counts — never an aggregate quality
 * score, and never the rendered contract prose (the full IR lives in the task_compilations table).
 */
export interface TaskCompiled {
  type: "task.compiled";
  runId: string;
  mode: "passthrough" | "enrich" | "compile" | "clarify";
  family: string;
  goal: string;
  /** Why this family and mode — inspectable, not sent to the model. */
  reason: string;
  requirementCount: number;
  assumptionCount: number;
  evidenceCount: number;
  ambiguityCounts: Record<string, number>;
  rawRequestTokens: number;
  renderedContractTokens: number;
  repositoryQueries: number;
  sidecarCalls: number;
  totalMs: number;
  /** Stable prefix identity this turn was rendered against. */
  promptEpoch: string;
  /** Validation problems that did not block use (an erroring compile is never applied). */
  warnings: string[];
}

/** The compiler asked exactly one question instead of guessing at a blocking ambiguity. */
export interface TaskClarificationRequested {
  type: "task.clarification_requested";
  runId: string;
  question: string;
  /** The blocking ambiguity that forced the question. */
  ambiguityId: string;
  detail: string;
}

/**
 * Per-step labels over a run's trajectory (good/unnecessary/mistake/recover), persisted so a failed
 * run stops being a dead end. Advisory: it never changes the run's grade. `productiveRatio` is the
 * share of steps that were not mistakes — in the SRFT results this stays high even in failed runs,
 * which is precisely why discarding a failure wholesale throws away mostly-usable data.
 */
export interface RunStepCritique {
  type: "run.step_critique";
  runId: string;
  source: "sidecar" | "deterministic";
  steps: Array<{ step: number; label: string; why: string }>;
  productiveRatio: number;
}

/**
 * The current plan for a run, as a bounded step list. Two sources: the durable task DAG
 * ("task-graph": real subagent nodes with dependencies + live statuses) and the compiled contract
 * ("compiled-contract": an advisory outline derived from deliverables + checks, statuses stay
 * "planned"). Re-emitted on material change; renderers replace, never append.
 */
export interface PlanUpdated {
  type: "plan.updated";
  runId: string;
  source: "task-graph" | "compiled-contract";
  reason?: string;
  steps: Array<{ id: string; label: string; status: string; dependsOn: string[]; agent?: string }>;
}

/** Immutable user-facing plan lifecycle. The revision/hash pair is the approval boundary. */
export interface PlanLifecycle {
  type: "plan.created" | "plan.revised" | "plan.approved" | "plan.started" | "plan.drifted" | "plan.completed" | "plan.cancelled";
  runId: string;
  planId: string;
  revision: number;
  hash: string;
  status: string;
  detail?: string;
}
/** A plan step began executing (task-graph source only). */
export interface StepStarted {
  type: "step.started";
  runId: string;
  stepId: string;
  label: string;
  agent?: string;
}
/** A plan step reached a resting state. Failure/blockage folds in via `status`. */
export interface StepCompleted {
  type: "step.completed";
  runId: string;
  stepId: string;
  status: "completed" | "waiting" | "failed" | "blocked" | "cancelled";
  /** Bounded worker report (≤2000 chars). */
  report?: string;
  /** Bounded evidence list (≤16 items). */
  evidence?: string[];
}

/** A user-approved native verification run, persisted as bounded execution evidence. */
export interface WorkspaceVerification {
  type: "workspace.verification";
  runId: string;
  passed: boolean;
  cancelled: boolean;
  commands: string[];
  results: Array<{ command: string; passed: boolean; allowed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; output: string }>;
}

export type EventPayload =
  | ConversationCreated
  | ConversationRenamed
  | ConversationArchived
  | UserMessage
  | RouteSelected
  | RunStarted
  | RunStatusChanged
  | AssistantDelta
  | AssistantFinal
  | ReasoningDelta
  | ToolProposed
  | ToolApprovalRequired
  | ToolStarted
  | ToolOutput
  | ToolCompleted
  | InferenceCompleted
  | CandidateStarted
  | CandidateCompleted
  | CandidateRejected
  | VerificationStarted
  | VerificationEvidence
  | VerificationFailed
  | VerificationPassed
  | FileChanged
  | DiffUpdated
  | RepairStarted
  | RunCancelled
  | RunInterrupted
  | RunFailed
  | RunCompleted
  | RunUndone
  | RunRedone
  | ToolApprovalResolved
  | TaskStarted
  | TaskCompleted
  | ReceiptFinalized
  | SidecarPostflight
  | SidecarFailure
  | TaskCompiled
  | TaskClarificationRequested
  | RunStepCritique
  | PlanUpdated
  | PlanLifecycle
  | StepStarted
  | StepCompleted
  | WorkspaceVerification;

export type EventType = EventPayload["type"];

/** The envelope the store stamps onto every persisted payload. */
export interface EventEnvelope {
  /** `${conversationId}:${seq}` — stable, reproducible, unique within a conversation. */
  id: string;
  conversationId: string;
  /** 1-based, strictly increasing, gap-free within a conversation. Assigned by the store. */
  seq: number;
  /** Epoch ms. Supplied by the caller (the app injects a clock) so tests stay deterministic. */
  ts: number;
  schemaVersion: number;
}

export type KittenEvent = EventEnvelope & EventPayload;

/**
 * Events that are broadcast to live listeners but never written to the durable log.
 *
 * Reasoning is the only member today, and it qualifies on its own terms: the renderer contract says
 * it is "streamed live, not replayed", so every row written for it is disk spent on something no
 * reader will ever ask for. Keeping it out of the log is also what makes a fine-grained stream
 * affordable — the coarse 300-character flush existed to protect the store, not the reader.
 */
export const TRANSIENT_EVENTS: ReadonlySet<string> = new Set(["reasoning.delta"]);

/** Derive the canonical event id from its coordinates. */
export function eventId(conversationId: string, seq: number): string {
  return `${conversationId}:${seq}`;
}

/** Narrowing helper: does this payload carry a `runId`? (Everything except conversation.* does.) */
export function eventRunId(e: EventPayload): string | undefined {
  return "runId" in e ? (e as { runId: string }).runId : undefined;
}

/** Terminal run events — used by recovery and the app to know a run is finished. */
const RUN_TERMINAL_EVENTS: readonly EventType[] = ["run.completed", "run.failed", "run.cancelled", "run.interrupted"];
export function isRunTerminalEvent(t: EventType): boolean {
  return RUN_TERMINAL_EVENTS.includes(t);
}
