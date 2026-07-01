import { blueprintConfig } from "../blueprint/config.js";
import { isBlueprintWorkerSession } from "../blueprint/worker.js";
import { LoopGovernor } from "./loopGovernor.js";
import {
  CompletionLedger,
  NonProgressDetector,
  isTerminalVerified,
  type FailureClass,
  type NonProgressEvent
} from "./lifecycle.js";
import type { LoopBreakEvent, ToolCallRecord } from "./types.js";
import type { CheaterConfig } from "../types.js";

const MAX_NUDGES_PER_TURN = 2;

const COMMAND_TOOLS = new Set(["bash", "run_command", "run", "shell"]);
const EDIT_TOOLS = new Set(["edit", "write", "edit_file", "create_file", "apply_patch", "cheater_line_edit"]);

export interface LiveToolCallObservation {
  toolCallId: string;
  toolName: string;
  path?: string;
  query?: string;
  command?: string;
}

export interface LiveToolResultObservation {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  path?: string;
  command?: string;
  changedFiles?: string[];
  failureClass?: FailureClass;
}

export interface LiveLifecycleEvent {
  kind: "loop_break" | "non_progress";
  loopBreak?: LoopBreakEvent;
  nonProgress?: NonProgressEvent;
  message: string;
  terminal: boolean;
}

class LiveSessionState {
  private ledger: CompletionLedger | null = null;
  private governor: LoopGovernor | null = null;
  private detector: NonProgressDetector | null = null;
  private toolRecords: ToolCallRecord[] = [];
  private textSummaries: string[] = [];
  private currentPacketId = "session";
  private config: CheaterConfig | null = null;
  private lastUserGoal = "";
  private nudgeCount = 0;
  private commitletEdits: string[] = [];
  private pendingNonProgressBlock: LiveLifecycleEvent | null = null;
  private readonly pendingLoopWarnings = new Map<string, LiveLifecycleEvent>();

  reset(userGoal?: string): void {
    this.toolRecords = [];
    this.textSummaries = [];
    this.currentPacketId = "session";
    if (userGoal) {
      this.ledger = new CompletionLedger(userGoal);
    }
    this.governor = null;
    this.detector = null;
    this.nudgeCount = 0;
    this.commitletEdits = [];
    this.pendingNonProgressBlock = null;
    this.pendingLoopWarnings.clear();
  }

  /**
   * Called on every interactive (human-typed) input. Extension-generated nudges are
   * tagged source "extension" by Pi and must never reach this reset, or the nudge
   * counter would reset itself on delivery and the finish-gate nudge could loop forever.
   */
  beginInteractiveTurn(config: CheaterConfig): void {
    this.config = config;
    this.governor = null;
    this.detector = null;
    this.toolRecords = [];
    this.textSummaries = [];
    this.nudgeCount = 0;
    this.commitletEdits = [];
    this.pendingNonProgressBlock = null;
    this.pendingLoopWarnings.clear();
    if (this.ledger) {
      const state = this.ledger.get();
      if (state.done || isTerminalVerified(state.verification)) this.ledger = null;
    }
  }

  setLastUserGoal(goal: string): void {
    this.lastUserGoal = goal;
  }

  ensure(config: CheaterConfig, userGoal = "current session"): { ledger: CompletionLedger; governor: LoopGovernor; detector: NonProgressDetector } {
    this.config = config;
    if (!this.ledger) this.ledger = new CompletionLedger(userGoal);
    if (!this.governor) this.governor = new LoopGovernor(blueprintConfig(config), this.currentPacketId);
    if (!this.detector) this.detector = new NonProgressDetector();
    return { ledger: this.ledger, governor: this.governor, detector: this.detector };
  }

  getLedger(): CompletionLedger | null {
    return this.ledger;
  }

  getGovernor(): LoopGovernor | null {
    return this.governor;
  }

  getDetector(): NonProgressDetector | null {
    return this.detector;
  }

  setPacketId(packetId: string): void {
    this.currentPacketId = packetId;
    if (this.config) this.governor = new LoopGovernor(blueprintConfig(this.config), packetId);
  }

  /** Marks the start of a commitlet's edit window so auto-verification can scope observed edits to it. */
  beginCommitlet(): void {
    this.commitletEdits = [];
  }

  /** Returns and clears the files observed as edited since the last beginCommitlet() call. */
  consumeCommitletEdits(): string[] {
    const out = [...this.commitletEdits];
    this.commitletEdits = [];
    return out;
  }

  canNudge(): boolean {
    return this.nudgeCount < MAX_NUDGES_PER_TURN;
  }

  recordNudge(): void {
    this.nudgeCount += 1;
  }

  /** Pops a non-terminal loop-governor warning recorded for this toolCallId, if any. */
  consumeLoopWarning(toolCallId?: string): LiveLifecycleEvent | undefined {
    if (!toolCallId) return undefined;
    const warning = this.pendingLoopWarnings.get(toolCallId);
    if (warning) this.pendingLoopWarnings.delete(toolCallId);
    return warning;
  }

  /**
   * Call-side observation: runs before the tool executes. Pushes a provisional record
   * (success/failure of command-family tools is not known yet) and checks the loop
   * governor so a repeating action can be blocked before it runs again. Also enforces a
   * non-progress lockout recorded by the previous observeToolResult call, since a
   * non-progress verdict can only be computed after a result is seen.
   */
  observeToolCall(obs: LiveToolCallObservation, config: CheaterConfig): LiveLifecycleEvent[] {
    const { governor } = this.ensure(config);
    if (isBlueprintWorkerSession()) return [];
    const record = mapObservationToRecord(obs);
    record.toolCallId = obs.toolCallId;
    this.toolRecords.push(record);
    if (this.toolRecords.length > 40) this.toolRecords = this.toolRecords.slice(-40);

    const events: LiveLifecycleEvent[] = [];
    if (this.pendingNonProgressBlock) {
      events.push(this.pendingNonProgressBlock);
      this.pendingNonProgressBlock = null;
      this.detector?.reset();
    }
    const loopEvent = governor.observeTools(this.toolRecords);
    if (loopEvent) {
      const event: LiveLifecycleEvent = { kind: "loop_break", loopBreak: loopEvent, message: `Cheater Loop Governor: ${loopEvent.reason}`, terminal: loopEvent.terminal };
      events.push(event);
      if (!loopEvent.terminal) this.pendingLoopWarnings.set(obs.toolCallId, event);
    }
    return events;
  }

  /**
   * Result-side observation: runs after the tool executes, once ok/changedFiles/
   * failureClass are known. Enriches the matching call-side record, feeds the
   * completion ledger, and runs the non-progress detector with complete information.
   */
  observeToolResult(obs: LiveToolResultObservation, config: CheaterConfig): LiveLifecycleEvent[] {
    const { detector } = this.ensure(config);
    if (isBlueprintWorkerSession()) return [];

    const record = this.toolRecords.find((r) => r.toolCallId === obs.toolCallId) ?? this.toolRecords.at(-1);
    if (record) {
      record.ok = obs.ok;
      if (!obs.ok && COMMAND_TOOLS.has(obs.toolName) && record.kind === "other") record.kind = "failed_command";
      if (obs.changedFiles?.length) record.changedFiles = obs.changedFiles;
    }

    const changedFiles = obs.changedFiles?.length ? obs.changedFiles : obs.ok && obs.path && EDIT_TOOLS.has(obs.toolName) ? [obs.path] : [];
    if (changedFiles.length && (!this.ledger)) this.ensure(config, this.lastUserGoal || "current session");
    const ledger = this.ledger;
    if (ledger) {
      for (const file of changedFiles) {
        ledger.recordFileChange(file);
        this.commitletEdits.push(file);
      }
      if (obs.command) {
        ledger.recordCommand(obs.command);
        // Fingerprint-keyed outcome: a later success of an equivalent command clears the
        // earlier failure latch instead of wedging the finish gate.
        ledger.recordCommandResult(obs.command, obs.ok, obs.failureClass ?? "unknown");
      } else if (!obs.ok && obs.failureClass) {
        ledger.recordFailure(`${obs.path || obs.toolName} -> failed`, obs.failureClass);
      }
    }

    const events: LiveLifecycleEvent[] = [];
    const step = {
      action: obs.toolName,
      argsSig: (record?.value ?? "").slice(0, 80),
      filesRead: record?.kind === "read_file" ? [record.value] : [],
      filesChanged: changedFiles,
      failureClass: obs.failureClass,
      ok: obs.ok
    };
    const npEvent = detector.observe(step);
    if (npEvent) {
      const event: LiveLifecycleEvent = { kind: "non_progress", nonProgress: npEvent, message: `Cheater non-progress: ${npEvent.reason}`, terminal: npEvent.terminal };
      events.push(event);
      if (npEvent.terminal) this.pendingNonProgressBlock = event;
    }
    return events;
  }

  observeAssistantText(text: string, config: CheaterConfig): LiveLifecycleEvent[] {
    const { governor } = this.ensure(config);
    if (isBlueprintWorkerSession()) return [];
    this.textSummaries.push(text.slice(0, 200));
    if (this.textSummaries.length > 20) this.textSummaries = this.textSummaries.slice(-20);
    const loopEvent = governor.observeText(text);
    if (!loopEvent) return [];
    return [{ kind: "loop_break", loopBreak: loopEvent, message: `Cheater Loop Governor (text): ${loopEvent.reason}`, terminal: loopEvent.terminal }];
  }

  observeNoProgress(config: CheaterConfig): LiveLifecycleEvent[] {
    const { governor } = this.ensure(config);
    if (isBlueprintWorkerSession()) return [];
    const event = governor.observeNoProgress(this.toolRecords, this.textSummaries);
    if (!event) return [];
    return [{ kind: "loop_break", loopBreak: event, message: `Cheater Loop Governor (no-progress): ${event.reason}`, terminal: event.terminal }];
  }

  getToolRecords(): ToolCallRecord[] {
    return [...this.toolRecords];
  }
}

function mapObservationToRecord(obs: LiveToolCallObservation): ToolCallRecord {
  const tool = obs.toolName;
  if (["read", "read_file", "cat"].includes(tool)) {
    return { kind: "read_file", value: obs.path ?? tool };
  }
  if (["grep", "search", "search_code", "find", "glob"].includes(tool)) {
    return { kind: "search", value: obs.query ?? obs.path ?? tool };
  }
  if (COMMAND_TOOLS.has(tool)) {
    return { kind: "other", value: obs.command ?? tool };
  }
  if (EDIT_TOOLS.has(tool)) {
    return { kind: "patch", value: obs.path ?? tool };
  }
  return { kind: "other", value: tool };
}

export const liveSessionState = new LiveSessionState();
