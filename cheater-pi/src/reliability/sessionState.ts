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

/** Normalize a goal string so a re-typed/rephrased-with-punctuation restart of the SAME task
 *  compares equal (lowercase, collapse every non-alphanumeric run to one space, trim). Used to
 *  tell "the model looped back into planning for the same goal" from "a genuinely new goal". */
function normalizeGoal(goal: string): string {
  return (goal || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const COMMAND_TOOLS = new Set(["bash", "run_command", "run", "shell"]);
const EDIT_TOOLS = new Set(["edit", "write", "edit_file", "create_file", "apply_patch", "cheater_line_edit", "cheater_replace"]);
// Driver tools ORCHESTRATE the commitlet chain; calling them repeatedly with no args is the intended
// pattern (each call grades and advances). They are not "work" steps, so they are exempt from the
// identical-call guard and the non-progress detector - which otherwise fire a false "you're stuck" on
// a perfectly healthy build loop. Real progress is measured by the read/write/command steps around
// them; if the model truly does nothing, the loop governor's total-call cap and the closed loop's
// iteration cap still bound it.
const DRIVER_TOOLS = new Set(["cheater_commitlet_next", "cheater_run", "cheater_reliability_start"]);

// A model that rewrites the SAME file this many times (with different content each time, so the
// identical-call guard never fires) is almost always second-guessing code that already works. It
// gets one advisory nudge to verify-and-finish at the limit, and a firmer one a few writes later.
const SAME_FILE_WRITE_NUDGE_LIMIT = 8;

export interface LiveToolCallObservation {
  toolCallId: string;
  toolName: string;
  path?: string;
  query?: string;
  command?: string;
  /** Full tool input, used for the identical-consecutive-call guard. */
  input?: unknown;
}

/** Canonical JSON with sorted keys (Cline-style), so arg order never hides an identical call. */
export function canonicalCallSignature(toolName: string, input: unknown): string {
  const sortKeys = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sortKeys);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  try {
    return `${toolName}:${JSON.stringify(sortKeys(input ?? {}))}`;
  } catch {
    return `${toolName}:(unserializable)`;
  }
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
  // Identical-consecutive-call guard (Cline-style): canonical (sorted-key) signature of the
  // last tool call, and how many times in a row the exact same call was made.
  private lastCallSignature = "";
  private identicalCallCount = 0;
  // Per-path count of successful edit-tool writes this session, for the over-write thrash nudge.
  private readonly fileWriteCounts = new Map<string, number>();

  /**
   * Is the current ledger a RE-ENTRY for `userGoal` - i.e. it belongs to the same task, already
   * holds real work (a file change, a command, or a verification stage), and is not finalized?
   * A weak local model, blocked by the finish gate, often loops back and re-calls the planning
   * tools (cheater_run / cheater_reliability_start) with the SAME goal. Those tools reset(), which
   * used to mint a brand-new empty ledger and ERASE the record of the files it had already written
   * and the tests it had already run - so the finish gate reported "no work was done" forever and
   * the model spun until the turn cap. Preserving the ledger on re-entry is what breaks that loop.
   */
  isReentryGoal(userGoal: string): boolean {
    if (!this.ledger) return false;
    const s = this.ledger.get();
    if (s.done) return false;
    const hasWork = s.changedFiles.length > 0 || s.commandsRun.length > 0 || s.verification.length > 0;
    if (!hasWork) return false;
    return normalizeGoal(s.userGoal) === normalizeGoal(userGoal);
  }

  reset(userGoal?: string): void {
    this.toolRecords = [];
    this.textSummaries = [];
    this.currentPacketId = "session";
    if (userGoal && !this.isReentryGoal(userGoal)) {
      // Genuinely new (or first) goal -> fresh completion ledger. A same-goal re-entry keeps the
      // existing ledger (see isReentryGoal) so the finish gate still sees the work already done.
      this.ledger = new CompletionLedger(userGoal);
    }
    this.governor = null;
    this.detector = null;
    this.nudgeCount = 0;
    this.commitletEdits = [];
    this.pendingNonProgressBlock = null;
    this.pendingLoopWarnings.clear();
    this.lastCallSignature = "";
    this.identicalCallCount = 0;
    this.fileWriteCounts.clear();
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
    this.lastCallSignature = "";
    this.identicalCallCount = 0;
    this.fileWriteCounts.clear();
    if (this.ledger) {
      const state = this.ledger.get();
      if (state.done || isTerminalVerified(state.verification)) this.ledger = null;
    }
  }

  setLastUserGoal(goal: string): void {
    this.lastUserGoal = goal;
  }

  getLastUserGoal(): string {
    return this.lastUserGoal;
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

  /** Queue a loop/non-progress event for in-band delivery on the tool's result instead of hard-
   *  blocking the call. Used to DOWNGRADE a terminal verdict that must never lock the model out:
   *  read-only tools (the model needs them to diagnose) and in-session builds (the model IS the
   *  driver - there is no outer loop to hand off to, so a hard stop just wedges the build). */
  queueLoopWarning(toolCallId: string | undefined, event: LiveLifecycleEvent): void {
    if (toolCallId) this.pendingLoopWarnings.set(toolCallId, event);
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

    // Identical-consecutive-call guard (ported from Cline): the exact same tool with the
    // exact same canonicalized args cannot produce a different result. Warn in-band on the
    // third identical call; hard-block on the sixth. This is fully generic - it also covers
    // cheater_* tools that the per-kind limits below never classified. Driver tools are exempt:
    // repeatedly calling cheater_commitlet_next IS the intended chain driver, and each call really
    // does advance the plan, so it is never a "the result will not change" loop.
    if (!DRIVER_TOOLS.has(obs.toolName)) {
      const signature = canonicalCallSignature(obs.toolName, obs.input ?? { path: obs.path, query: obs.query, command: obs.command });
      this.identicalCallCount = signature === this.lastCallSignature ? this.identicalCallCount + 1 : 1;
      this.lastCallSignature = signature;
      if (this.identicalCallCount >= 3) {
        const terminal = this.identicalCallCount >= 6;
        const event: LiveLifecycleEvent = {
          kind: "loop_break",
          message: `Cheater: ${this.identicalCallCount} consecutive identical calls to ${obs.toolName} - the result will not change. Try a different approach, or stop and report what is blocking you.`,
          terminal
        };
        events.push(event);
        if (!terminal) this.pendingLoopWarnings.set(obs.toolCallId, event);
      }
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
    // Over-write thrash guard: rewriting one file many times (each write a bit different, so the
    // identical-call guard never fires) is the csvparse failure mode - the model kept rewriting a
    // parser that ALREADY passed, never finishing, and ballooned the run. Nudge it (advisory, never
    // a hard block) to verify once and finish. Fires even when the model works "raw" without
    // cheater's tools, because observeToolResult sees every write.
    if (obs.ok && obs.path && EDIT_TOOLS.has(obs.toolName)) {
      const writes = (this.fileWriteCounts.get(obs.path) ?? 0) + 1;
      this.fileWriteCounts.set(obs.path, writes);
      if (writes === SAME_FILE_WRITE_NUDGE_LIMIT || writes === SAME_FILE_WRITE_NUDGE_LIMIT + 4) {
        events.push({
          kind: "loop_break",
          message: `Cheater: you have now written ${obs.path} ${writes} times. If it already works, STOP editing - run your verification once and call cheater_finish_gate. Repeatedly rewriting working code tends to BREAK it, not improve it.`,
          terminal: false
        });
      }
    }
    const step = {
      action: obs.toolName,
      argsSig: (record?.value ?? "").slice(0, 80),
      filesRead: record?.kind === "read_file" ? [record.value] : [],
      filesChanged: changedFiles,
      failureClass: obs.failureClass,
      ok: obs.ok
    };
    // Driver tools are orchestration, not work steps: skip the non-progress detector for them so an
    // advancing chain-driver loop (cheater_commitlet_next between phases) is never counted as a stall.
    // Progress is measured by the read/write/command steps in between.
    const npEvent = DRIVER_TOOLS.has(obs.toolName) ? undefined : detector.observe(step);
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
    // CONTENT signature, not just the path: two DIFFERENT edits to the same file (the normal way a
    // build gets fixed error-by-error) must not read as "same patch generated again". Only a
    // byte-identical repeat collapses to the same signature and can trip the governor.
    return { kind: "patch", value: obs.path ?? tool, signature: `${obs.path ?? tool}#${hashInput(obs.input)}` };
  }
  return { kind: "other", value: tool };
}

/** Tiny stable hash (djb2) of a tool call's input, used to tell distinct edits apart from a
 *  byte-identical repeat. Not cryptographic - only needs to differ when the edit content differs. */
function hashInput(input: unknown): string {
  let json = "";
  try { json = JSON.stringify(input ?? {}); } catch { json = String(input); }
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) hash = ((hash << 5) + hash + json.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

export const liveSessionState = new LiveSessionState();
