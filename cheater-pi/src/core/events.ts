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

/** Bump when a payload shape changes incompatibly; the store records this per row for migration. */
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

export interface CandidateStarted {
  type: "candidate.started";
  runId: string;
  index: number;
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
