// Kitten Core — the application service. NO Pi.
//
// This is the ONE shared backend (Goal §2): every client (headless CLI now; TUI and web later) drives
// the product through this small typed API and never re-implements conversation state, routing,
// execution orchestration, or persistence. The service:
//   • owns the durable store (conversations/events/runs),
//   • routes each user message to a lane (answer/direct/reliable/bon/ascent),
//   • executes via an injectable Runner (default wraps the core engines; tests inject a scripted one),
//   • persists every state change as an event AND broadcasts it to subscribers, in that order,
//   • recovers crash-interrupted runs at startup.
//
// UI code may submit user actions and render events. It may not decide candidate eligibility, mutate
// the run ledger, or infer completion from text — those are the service's job.

import {
  ConversationStore, type ConversationRow, type RunRow,
} from "./store/conversationStore.js";
import type { EventPayload, KittenEvent, Lane } from "./events.js";
import { routeMessage, type RouteDecision } from "./router.js";
import { captureSnapshot, restoreSnapshot, type RunSnapshot, type UndoResult } from "./undo.js";
import { ContextBuilder } from "./context.js";

/** Everything a Runner needs to execute one run, plus the sink it emits progress into. */
export interface RunContext {
  runId: string;
  conversationId: string;
  task: string;
  cwd: string;
  lane: Lane;
  k: number;
  model: string;
  signal: AbortSignal;
  /** The model-facing conversation context (prior turns + current repo truth), assembled by the
   *  ContextBuilder from durable state. Empty on a brand-new conversation's first turn. Every lane
   *  injects this so a resumed/multi-turn conversation actually informs the model. */
  conversationContext: string;
  /** Pre-run git snapshot ref (or null), so a lane that isolates its work (Ascent) can derive the
   *  winner's changed files via git after adoption. */
  snapshotRef: string | null;
  /** Persist + broadcast a run-scoped event. The app stamps envelope + ordering. */
  emit(payload: EventPayload): void;
  /** Ask the client/policy to approve a risky action. Emits tool.approval_required and resolves per the
   *  app's approvalPolicy ("ask" waits for resolveApproval; auto-* decides immediately). */
  requestApproval(callId: string, name: string, reason: string, risk: "low" | "medium" | "high"): Promise<boolean>;
}

/** How the app resolves approval requests. Interactive clients (TUI/web) use "ask" and respond via
 *  resolveApproval; unattended headless runs default to "auto-deny" (safe) unless the user opts in. */
export type ApprovalPolicy = "ask" | "auto-allow" | "auto-deny";

/** The result a Runner reports; the app turns it into `run.completed` + `receipt.finalized`. */
export interface RunOutcome {
  finished: boolean;
  summary: string;
  wallMs: number;
  usage: { prompt: number; completion: number; reasoning: number };
  receiptLines: string[];
  filesChanged: string[];
  verified: boolean;
}

/** The execution seam. Default = engine-backed (runner.ts); tests inject a deterministic scripted one. */
export type Runner = (ctx: RunContext) => Promise<RunOutcome>;

export interface KittenAppOptions {
  store: ConversationStore;
  runner: Runner;
  /** Default project root for new conversations (a conversation records its own). */
  projectRoot?: string;
  /** Default model for new conversations. */
  model?: string;
  /** Injectable clock (epoch ms). Tests pass a deterministic one. */
  now?: () => number;
  /** Injectable id generator. Tests pass a deterministic one; default is time+counter, collision-free. */
  newId?: (prefix: string) => string;
  /** How risky actions are approved. Default "auto-deny" (safe for unattended runs). */
  approvalPolicy?: ApprovalPolicy;
}

export interface CreateConversationInput {
  title?: string;
  projectRoot?: string;
  model?: string;
  /** Default lane for the conversation; "auto" (default) lets the router decide per message. */
  mode?: Lane | "auto";
}

export interface SubmitOptions {
  /** Force a lane, bypassing the router (advanced override; the normal path is "auto"). */
  lane?: Lane;
  /** Force the sample count for bon/ascent. */
  k?: number;
}

export type EventListener = (event: KittenEvent) => void;

export class KittenApp {
  private readonly store: ConversationStore;
  private readonly runner: Runner;
  private readonly projectRoot: string;
  private readonly model: string;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;
  private readonly listeners = new Set<EventListener>();
  /** In-flight runs, so cancel() can abort them. */
  private readonly inflight = new Map<string, AbortController>();
  private approvalPolicy: ApprovalPolicy;
  /** Pending interactive approvals keyed by `${runId}:${callId}`, resolved by resolveApproval(). */
  private readonly pendingApprovals = new Map<string, (allowed: boolean) => void>();
  private readonly context: ContextBuilder;

  constructor(opts: KittenAppOptions) {
    this.store = opts.store;
    this.runner = opts.runner;
    this.context = new ContextBuilder(opts.store);
    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.model = opts.model ?? "ornith-1.0-35b";
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? defaultIdGen();
    this.approvalPolicy = opts.approvalPolicy ?? "auto-deny";
  }

  /** Change the approval policy (e.g. a TUI sets "ask", a --dangerous headless run sets "auto-allow"). */
  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy;
  }

  /** An interactive client's answer to a tool.approval_required. Returns false if nothing was pending. */
  resolveApproval(runId: string, callId: string, allowed: boolean): boolean {
    const key = `${runId}:${callId}`;
    const resolve = this.pendingApprovals.get(key);
    if (!resolve) return false;
    this.pendingApprovals.delete(key);
    resolve(allowed);
    return true;
  }

  /** Implements RunContext.requestApproval: records the request, then resolves per policy. */
  private requestApproval(conversationId: string, runId: string, callId: string, name: string, reason: string, risk: "low" | "medium" | "high"): Promise<boolean> {
    if (this.approvalPolicy === "auto-allow") { this.emit(conversationId, { type: "tool.approval_required", runId, callId, name, reason, risk }); return Promise.resolve(true); }
    if (this.approvalPolicy === "auto-deny") { this.emit(conversationId, { type: "tool.approval_required", runId, callId, name, reason, risk }); return Promise.resolve(false); }
    // "ask": register the resolver BEFORE emitting, so a synchronous client answer during the broadcast
    // isn't lost (the same ordering guarantee cancel() relies on).
    const p = new Promise<boolean>((resolve) => { this.pendingApprovals.set(`${runId}:${callId}`, resolve); });
    this.emit(conversationId, { type: "tool.approval_required", runId, callId, name, reason, risk });
    return p;
  }

  /** Release the underlying store (the app owns its lifecycle). */
  close(): void {
    this.store.close();
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────────────
  /** Subscribe to every event the app persists. Returns an unsubscribe fn. */
  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Persist an event, then broadcast it. Persistence-before-broadcast guarantees a late subscriber
   *  can replay from the store and see exactly what earlier subscribers saw. */
  private emit(conversationId: string, payload: EventPayload): KittenEvent {
    const event = this.store.appendEvent(conversationId, payload, this.now());
    for (const fn of this.listeners) { try { fn(event); } catch { /* a bad listener never breaks a run */ } }
    return event;
  }

  // ── Crash recovery ──────────────────────────────────────────────────────────────────────────
  /** Flip any run left transient by a crash to `interrupted`, and broadcast those events. Call once
   *  at startup before serving clients (Goal §6). */
  recover(): KittenEvent[] {
    const events = this.store.recoverInterruptedRuns(this.now());
    for (const event of events) for (const fn of this.listeners) { try { fn(event); } catch { /* ignore */ } }
    return events;
  }

  // ── Conversations ────────────────────────────────────────────────────────────────────────────
  createConversation(input: CreateConversationInput = {}): ConversationRow {
    const id = this.newId("conv");
    const { conversation } = this.store.createConversation({
      id,
      title: input.title?.trim() || "New conversation",
      projectRoot: input.projectRoot ?? this.projectRoot,
      projectId: normalizeProjectId(input.projectRoot ?? this.projectRoot),
      model: input.model ?? this.model,
      mode: input.mode ?? "auto",
      ts: this.now(),
    });
    // Broadcast the creation event the store already appended (seq 1).
    const created = this.store.readEvents(id, 0)[0];
    if (created) for (const fn of this.listeners) { try { fn(created); } catch { /* ignore */ } }
    return conversation;
  }

  listConversations(opts?: { projectId?: string; includeArchived?: boolean; search?: string; limit?: number }): ConversationRow[] {
    return this.store.listConversations(opts ?? {});
  }

  getConversation(id: string): ConversationRow | null {
    return this.store.getConversation(id);
  }

  /** Full ordered event history for replay/restoration (Goal §6). `afterSeq` enables reconnect. */
  getEvents(id: string, afterSeq = 0): KittenEvent[] {
    return this.store.readEvents(id, afterSeq);
  }

  getRuns(id: string): RunRow[] {
    return this.store.listRuns(id);
  }

  rename(id: string, title: string): void {
    this.store.renameConversation(id, title.trim() || "Untitled", this.now());
    const ev = lastEventOfType(this.store, id, "conversation.renamed");
    if (ev) for (const fn of this.listeners) { try { fn(ev); } catch { /* ignore */ } }
  }

  archive(id: string, archived = true): void {
    this.store.setArchived(id, archived, this.now());
    const ev = lastEventOfType(this.store, id, "conversation.archived");
    if (ev) for (const fn of this.listeners) { try { fn(ev); } catch { /* ignore */ } }
  }

  // ── Execution ────────────────────────────────────────────────────────────────────────────────
  /**
   * Submit a user message: persist it, route it, run it (via the injectable Runner), persisting and
   * broadcasting every state change, and return the finished run. This is the single entry a client
   * uses to make the agent do work.
   */
  async submitMessage(conversationId: string, text: string, opts: SubmitOptions = {}): Promise<RunRow> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error(`submitMessage: unknown conversation ${conversationId}`);

    // Assemble the model-facing conversation context from PRIOR turns BEFORE persisting the new message
    // (so the current request isn't duplicated into its own context). This is what makes resume real.
    const built = this.context.build(conversationId, conv.projectRoot);

    this.emit(conversationId, { type: "user.message", text });

    const decision: RouteDecision = routeMessage(text, { lane: opts.lane ?? (conv.mode === "auto" ? undefined : conv.mode), k: opts.k, cwd: conv.projectRoot });
    const runId = this.newId("run");
    // Register the abort controller BEFORE emitting run events, so a synchronous subscriber can cancel
    // the instant the run appears (the run row already exists by the time run.started broadcasts).
    const controller = new AbortController();
    this.inflight.set(runId, controller);
    this.emit(conversationId, { type: "route.selected", runId, lane: decision.lane, reasons: decision.reasons, k: decision.k });
    this.emit(conversationId, { type: "run.started", runId, request: text, lane: decision.lane });

    // Capture a pre-run snapshot for /undo BEFORE the runner mutates anything (cheap; never touches the
    // tree). Only meaningful for lanes that write files; harmless (git:false) otherwise.
    let snapshotRef: string | null = null;
    if (decision.lane !== "answer") {
      try { const snap = captureSnapshot(conv.projectRoot); snapshotRef = snap.ref; this.store.setRunSnapshot(runId, JSON.stringify(snap)); } catch { /* snapshot best-effort */ }
    }
    try {
      const ctx: RunContext = {
        runId, conversationId, task: text, cwd: conv.projectRoot,
        lane: decision.lane, k: decision.k, model: conv.model, signal: controller.signal,
        conversationContext: built.preamble,
        snapshotRef,
        emit: (payload) => { this.emit(conversationId, payload); },
        requestApproval: (callId, name, reason, risk) => this.requestApproval(conversationId, runId, callId, name, reason, risk),
      };
      const outcome = await this.runner(ctx);

      if (controller.signal.aborted) {
        this.emit(conversationId, { type: "run.cancelled", runId });
      } else {
        this.emit(conversationId, {
          type: "run.completed", runId, finished: outcome.finished, verified: outcome.verified, lane: decision.lane,
          summary: outcome.summary, wallMs: outcome.wallMs, usage: outcome.usage,
        });
        this.emit(conversationId, {
          type: "receipt.finalized", runId, lines: outcome.receiptLines,
          filesChanged: outcome.filesChanged, verified: outcome.verified,
        });
      }
    } catch (e) {
      if (controller.signal.aborted) {
        this.emit(conversationId, { type: "run.cancelled", runId });
      } else {
        this.emit(conversationId, { type: "run.failed", runId, error: (e as Error).message.slice(0, 500) });
      }
    } finally {
      this.inflight.delete(runId);
    }
    return this.store.getRun(runId)!;
  }

  /** Signal an in-flight run to stop. The Runner observes ctx.signal; the app records run.cancelled. */
  cancel(runId: string): boolean {
    const c = this.inflight.get(runId);
    if (!c) return false;
    this.emit(this.runConversation(runId), { type: "run.status", runId, status: "cancelling" });
    c.abort();
    // Unblock any interactive ("ask") approval this run is parked on — abort alone doesn't resolve it, so
    // the agent stays awaiting a resolver that never comes and the run would hang forever (never terminal).
    // Deny the pending approvals; the agent then returns and the aborted signal drives it to a clean stop.
    for (const key of [...this.pendingApprovals.keys()]) {
      if (key.startsWith(`${runId}:`)) { this.pendingApprovals.get(key)!(false); this.pendingApprovals.delete(key); }
    }
    return true;
  }

  private runConversation(runId: string): string {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run.conversationId;
  }

  // ── Undo ──────────────────────────────────────────────────────────────────────────────────────
  /** Roll back a specific run's file changes to its pre-run snapshot (Goal §8). Only that run's files
   *  are touched; the user's pre-existing dirty work in other files is preserved. Records the evidence. */
  undoRun(runId: string): UndoResult {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, restored: [], deleted: [], skipped: [], reason: `unknown run ${runId}` };
    if (!run.filesChanged.length) return { ok: false, restored: [], deleted: [], skipped: [], reason: "this run changed no files" };
    const conv = this.store.getConversation(run.conversationId);
    if (!conv) return { ok: false, restored: [], deleted: [], skipped: [], reason: "conversation gone" };
    const snap: RunSnapshot = run.snapshot ? (JSON.parse(run.snapshot) as RunSnapshot) : { git: false, ref: null };
    const res = restoreSnapshot(conv.projectRoot, snap, run.filesChanged);
    this.emit(run.conversationId, { type: "run.undone", runId, restored: res.restored, deleted: res.deleted, skipped: res.skipped });
    return res;
  }

  /** Undo the most recent run in a conversation that changed files. */
  undoLast(conversationId: string): UndoResult {
    const runs = this.store.listRuns(conversationId);
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].filesChanged.length) return this.undoRun(runs[i].id);
    }
    return { ok: false, restored: [], deleted: [], skipped: [], reason: "no run with file changes to undo" };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A collision-free id: prefix + base36 time + a per-process counter. */
function defaultIdGen(): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => `${prefix}_${Date.now().toString(36)}${(n++).toString(36).padStart(2, "0")}`;
}

/** Normalize a project root into a stable identity for grouping conversations by project (Goal §6). */
export function normalizeProjectId(root: string): string {
  return root.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function lastEventOfType(store: ConversationStore, conversationId: string, type: EventPayload["type"]): KittenEvent | null {
  const evs = store.readEvents(conversationId, 0);
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].type === type) return evs[i];
  return null;
}
