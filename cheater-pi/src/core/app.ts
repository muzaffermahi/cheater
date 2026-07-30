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
import { captureSnapshot, captureSnapshotAfter, restoreSnapshot, redoSnapshot, type RunSnapshot, type UndoResult } from "./undo.js";
import { ContextBuilder, contextBudgetForWindow } from "./context.js";
import { TaskGraphController, type TaskGraphPlan } from "./taskGraph.js";
import type { TaskNodeRow } from "./store/conversationStore.js";
import { exportConversationMarkdown } from "./export.js";
import { getAgent } from "./agents.js";

/** Everything a Runner needs to execute one run, plus the sink it emits progress into. */
export interface RunContext {
  runId: string;
  conversationId: string;
  task: string;
  cwd: string;
  lane: Lane;
  k: number;
  model: string;
  /** Named agent profile (for example explore/review/verify/general). */
  agent?: string;
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
  /** Delegate a self-contained child task; the app supplies lineage and cancellation automatically. */
  spawnTask?(input: { agent: string; prompt: string; model?: string }): Promise<{ conversationId: string; runId: string; status: string; summary: string }>;
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
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
    /** Effective model used for the run. */
    model?: string;
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
  /** Configured model context window; controls how much durable history is sent to the model. */
  contextWindowTokens?: number;
  /** Fast model tier used for clerical/read-only subagent nodes. Falls back to the parent model when absent. */
  sidecarModel?: string;
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
  agent?: string;
}

export interface SubmitOptions {
  /** Force a lane, bypassing the router (advanced override; the normal path is "auto"). */
  lane?: Lane;
  /** Force the sample count for bon/ascent. */
  k?: number;
  /** Parent/task-plan cancellation signal, linked to the app-owned run controller. */
  signal?: AbortSignal;
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
  /** Optional bounded context prepared by the local sidecar before the foreground model starts. */
  contextPreamble?: string;
}

export interface SpawnChildInput {
  parentConversationId: string;
  parentRunId: string;
  agent: string;
  prompt: string;
  model?: string;
  projectRoot?: string;
  signal?: AbortSignal;
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
}

export type EventListener = (event: KittenEvent) => void;

export class KittenApp {
  private readonly store: ConversationStore;
  private readonly runner: Runner;
  private readonly projectRoot: string;
  private model: string;
  private sidecarModel?: string;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;
  private readonly listeners = new Set<EventListener>();
  /** In-flight runs, so cancel() can abort them. */
  private readonly inflight = new Map<string, AbortController>();
  private approvalPolicy: ApprovalPolicy;
  /** Pending interactive approvals keyed by `${runId}:${callId}`, resolved by resolveApproval(). */
  private readonly pendingApprovals = new Map<string, (allowed: boolean) => void>();
  private readonly context: ContextBuilder;
  private readonly tasks: TaskGraphController;

  constructor(opts: KittenAppOptions) {
    this.store = opts.store;
    this.runner = opts.runner;
    this.context = new ContextBuilder(opts.store, contextBudgetForWindow(opts.contextWindowTokens ?? 16384));
    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.model = opts.model ?? "ornith-1.0-35b";
    this.sidecarModel = opts.sidecarModel?.trim() || undefined;
    this.now = opts.now ?? (() => Date.now());
    this.tasks = new TaskGraphController(opts.store, this.now);
    this.newId = opts.newId ?? defaultIdGen();
    this.approvalPolicy = opts.approvalPolicy ?? "auto-deny";
  }

  /** Change the approval policy (e.g. a TUI sets "ask", a --dangerous headless run sets "auto-allow"). */
  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy;
  }

  setDefaultModel(model: string): void {
    if (model.trim()) this.model = model.trim();
  }

  setSidecarModel(model: string | undefined): void {
    this.sidecarModel = model?.trim() || undefined;
  }

  setContextWindowTokens(tokens: number): void {
    this.context.setWindowTokens(tokens);
  }

  /** An interactive client's answer to a tool.approval_required. Returns false if nothing was pending. */
  resolveApproval(runId: string, callId: string, allowed: boolean): boolean {
    const key = `${runId}:${callId}`;
    const resolve = this.pendingApprovals.get(key);
    if (!resolve) return false;
    this.pendingApprovals.delete(key);
    resolve(allowed);
    // Find the conversation for this run to emit the event
    const convId = this.runConversationId(runId);
    if (convId) this.emit(convId, { type: "tool.approval_resolved", runId, callId, allowed, source: "user" });
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
      agent: input.agent ?? "general",
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

  /** Render a durable conversation, tools, verification, and run grades for a native export. */
  exportConversationMarkdown(id: string): string {
    return exportConversationMarkdown(this.store, id);
  }

  /** Persist an advisory postflight packet so the native Evidence pane can replay it after restart. */
  recordSidecarPostflight(conversationId: string, input: { runId: string; source: "sidecar" | "deterministic"; secrets: string[]; warnings: string[]; evidenceWarnings: string[]; recommendedTests: string[]; suggestedCommands: string[]; risk: "low" | "medium" | "high"; riskReasons: string[]; generatedTestCases: string[] }): KittenEvent {
    return this.emit(conversationId, {
      type: "sidecar.postflight",
      runId: input.runId,
      source: input.source,
      secrets: input.secrets.slice(0, 12),
      warnings: input.warnings.slice(0, 12),
      evidenceWarnings: input.evidenceWarnings.slice(0, 12),
      recommendedTests: input.recommendedTests.slice(0, 12),
      suggestedCommands: input.suggestedCommands.slice(0, 8),
      risk: input.risk,
      riskReasons: input.riskReasons.slice(0, 12),
      generatedTestCases: input.generatedTestCases.slice(0, 12),
    });
  }

  /** Persist a bounded sidecar explanation for a failed run without changing its status or grade. */
  recordSidecarFailure(conversationId: string, input: { runId: string; source: "sidecar" | "deterministic"; severity: "error" | "warning" | "info"; signature: string; likelyCause: string; salientLines: string[] }): KittenEvent {
    return this.emit(conversationId, {
      type: "sidecar.failure",
      runId: input.runId,
      source: input.source,
      severity: input.severity,
      signature: input.signature.slice(0, 240),
      likelyCause: input.likelyCause.slice(0, 500),
      salientLines: input.salientLines.slice(0, 12).map((line) => line.slice(0, 500)),
    });
  }

  /** Persist user-approved native verification receipts without changing the original run grade. */
  recordWorkspaceVerification(conversationId: string, input: { runId: string; passed: boolean; cancelled: boolean; commands: string[]; results: Array<{ command: string; passed: boolean; allowed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; output: string }> }): KittenEvent {
    return this.emit(conversationId, {
      type: "workspace.verification",
      runId: input.runId,
      passed: input.passed,
      cancelled: input.cancelled,
      commands: input.commands.slice(0, 4),
      results: input.results.slice(0, 4).map((result) => ({ ...result, output: result.output.slice(-12_000) })),
    });
  }

  /** Persist a dependency-aware subagent plan. Execution remains owned by the orchestration layer. */
  createTaskPlan(plan: TaskGraphPlan): TaskNodeRow[] {
    return this.tasks.createPlan(plan);
  }

  /** Resume the incomplete portion of a durable plan; completed nodes remain untouched. */
  async resumeTaskPlan(conversationId: string, parentRunId = "task-resume", signal?: AbortSignal): Promise<TaskNodeRow[]> {
    this.tasks.resume(conversationId);
    return this.runTaskPlan(conversationId, parentRunId, signal);
  }

  listTasks(conversationId: string): TaskNodeRow[] {
    return this.tasks.list(conversationId);
  }

  /** Execute a durable task plan through the same child-conversation path used by the task tool. */
  async runTaskPlan(conversationId: string, parentRunId = "task-plan", signal?: AbortSignal): Promise<TaskNodeRow[]> {
    const parent = this.store.getConversation(conversationId);
    if (!parent) throw new Error(`runTaskPlan: unknown conversation ${conversationId}`);
    return this.tasks.runUntilSettled(conversationId, async (node, capsule, childSignal) => {
      if (childSignal.aborted) throw new Error("task plan cancelled");
      const prompt = [
        `Work only on this self-contained subtask: ${capsule.objective}`,
        capsule.acceptanceCriteria.length ? `Acceptance criteria:\n- ${capsule.acceptanceCriteria.join("\n- ")}` : "",
        capsule.allowedFiles.length ? `Allowed files: ${capsule.allowedFiles.join(", ")}` : "",
        capsule.forbiddenFiles.length ? `Forbidden files: ${capsule.forbiddenFiles.join(", ")}` : "",
        (() => {
          const byId = new Map(this.tasks.list(conversationId).map((row) => [row.id, row]));
          const reports = node.dependencies.map((dependency) => {
            const row = byId.get(dependency);
            if (!row) return "";
            const report = (row.report ?? "").slice(0, 2400);
            const evidence = row.evidence.slice(0, 16).join(", ");
            return `Dependency ${dependency} report:\n${report || "(no report)"}${evidence ? `\nEvidence: ${evidence}` : ""}`;
          }).filter(Boolean);
          return reports.length ? `Prior dependency reports (bounded handoff; verify before relying on them):\n\n${reports.join("\n\n").slice(0, 7000)}` : "";
        })(),
        `Report exact work and execution evidence. Parent transcript is intentionally unavailable.`,
      ].filter(Boolean).join("\n\n");
      const child = await this.spawnChild({
        parentConversationId: conversationId,
        parentRunId,
        agent: node.agent,
        prompt,
        model: node.modelTier === "main" ? parent.model : this.sidecarModel,
        projectRoot: parent.projectRoot,
        signal: childSignal,
        allowedFiles: node.allowedFiles,
        forbiddenFiles: node.forbiddenFiles,
      });
      if (childSignal.aborted || signal?.aborted) throw new Error("task plan cancelled");
      return { report: child.run.summary, evidence: child.run.filesChanged, verified: child.run.status === "completed" && child.run.verified };
    }, {
      signal,
      repoBrief: parent.projectRoot,
      // Independent clerical scouts can fan out, while any ready main-model worker
      // keeps the local GPU/context budget serialized. This makes subagent plans
      // faster without sending two heavyweight coding turns into one runtime.
      maxConcurrent: 2,
      maxConcurrentFor: (ready) => ready.some((node) => node.modelTier === "main") ? 1 : 2,
    });
  }

  /** Spawn a durable child conversation and return only after its first run has a terminal receipt. */
  async spawnChild(input: SpawnChildInput): Promise<{ conversation: ConversationRow; run: RunRow }> {
    const parent = this.store.getConversation(input.parentConversationId);
    if (!parent) throw new Error(`spawnChild: unknown parent conversation ${input.parentConversationId}`);
    if (!input.prompt.trim()) throw new Error("spawnChild: prompt is empty");
    const childId = this.newId("conv");
    const created = this.store.createConversation({
      id: childId,
      title: `${input.agent}: ${input.prompt.trim().slice(0, 72)}`,
      projectRoot: input.projectRoot ?? parent.projectRoot,
      projectId: normalizeProjectId(input.projectRoot ?? parent.projectRoot),
      model: input.model ?? parent.model,
      mode: "auto",
      agent: input.agent,
      parentConversationId: parent.id,
      parentRunId: input.parentRunId,
      ts: this.now(),
    });
    for (const fn of this.listeners) { try { fn(created.event); } catch {} }
    this.emit(parent.id, { type: "task.started", runId: input.parentRunId, childConversationId: childId, agent: input.agent, prompt: input.prompt.slice(0, 4000) });
    try {
      // Specialist prompts must enter the bounded tool loop; natural-language routing can otherwise
      // classify "find/review/verify" as an answer and never invoke their read/bash tools.
      // Every declared subagent profile enters the bounded direct lane. Without this, a new
      // read-only sidecar role can be misrouted to answer-only and never receive its tools.
      const specialist = getAgent(input.agent, input.projectRoot ?? parent.projectRoot)?.mode === "subagent";
      const run = await this.submitMessage(childId, input.prompt, specialist ? { lane: "direct", signal: input.signal, allowedFiles: input.allowedFiles, forbiddenFiles: input.forbiddenFiles } : { signal: input.signal, allowedFiles: input.allowedFiles, forbiddenFiles: input.forbiddenFiles });
      this.emit(parent.id, { type: "task.completed", runId: input.parentRunId, childConversationId: childId, childRunId: run.id, status: run.status, summary: run.summary, usage: run.usage });
      return { conversation: created.conversation, run };
    } catch (error) {
      this.emit(parent.id, { type: "task.completed", runId: input.parentRunId, childConversationId: childId, childRunId: "", status: "failed", summary: error instanceof Error ? error.message : String(error), usage: { prompt: 0, completion: 0, reasoning: 0 } });
      throw error;
    }
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
    const sidecarContext = typeof opts.contextPreamble === "string" ? opts.contextPreamble.trim().slice(0, 12_000) : "";
    const conversationContext = [built.preamble, sidecarContext].filter(Boolean).join("\n\n");

    this.emit(conversationId, { type: "user.message", text });

    const decision: RouteDecision = routeMessage(text, { lane: opts.lane ?? (conv.mode === "auto" ? undefined : conv.mode), k: opts.k, cwd: conv.projectRoot });
    const runId = this.newId("run");
    // Register the abort controller BEFORE emitting run events, so a synchronous subscriber can cancel
    // the instant the run appears (the run row already exists by the time run.started broadcasts).
    const controller = new AbortController();
    this.inflight.set(runId, controller);
    const externalSignal = opts.signal;
    const externalAbort = externalSignal ? () => controller.abort(externalSignal.reason) : undefined;
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else if (externalAbort && externalSignal) externalSignal.addEventListener("abort", externalAbort, { once: true });
    this.emit(conversationId, { type: "route.selected", runId, lane: decision.lane, reasons: decision.reasons, k: decision.k });
    this.emit(conversationId, { type: "run.started", runId, request: text, lane: decision.lane, model: conv.model, agent: conv.agent ?? "general" });

    // Capture a pre-run snapshot for /undo BEFORE the runner mutates anything (cheap; never touches the
    // tree). Only meaningful for lanes that write files; harmless (git:false) otherwise.
    let snapshotRef: string | null = null;
    if (decision.lane !== "answer") {
      try { const snap = captureSnapshot(conv.projectRoot); snapshotRef = snap.ref; this.store.setRunSnapshot(runId, JSON.stringify(snap)); } catch { /* snapshot best-effort */ }
    }
    try {
      const ctx: RunContext = {
        runId, conversationId, task: text, cwd: conv.projectRoot,
        lane: decision.lane, k: decision.k, model: conv.model, agent: conv.agent ?? "general", signal: controller.signal, allowedFiles: opts.allowedFiles, forbiddenFiles: opts.forbiddenFiles,
        conversationContext,
        snapshotRef,
        emit: (payload) => { this.emit(conversationId, payload); },
        requestApproval: (callId, name, reason, risk) => this.requestApproval(conversationId, runId, callId, name, reason, risk),
        spawnTask: (input) => this.spawnChild({ parentConversationId: conversationId, parentRunId: runId, agent: input.agent, prompt: input.prompt, model: input.model }).then((child) => ({ conversationId: child.conversation.id, runId: child.run.id, status: child.run.status, summary: child.run.summary })),
      };
      const outcome = await this.runner(ctx);

      if (controller.signal.aborted) {
        this.emit(conversationId, { type: "run.cancelled", runId });
      } else {
        if (decision.lane !== "answer") {
          try { const snap = captureSnapshotAfter(conv.projectRoot); this.store.setRunSnapshotAfter(runId, JSON.stringify(snap)); } catch { /* best-effort */ }
        }
        this.emit(conversationId, {
          type: "run.completed", runId, finished: outcome.finished, verified: outcome.verified, lane: decision.lane,
          model: outcome.model ?? conv.model, summary: outcome.summary, wallMs: outcome.wallMs, usage: outcome.usage,
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
      if (externalSignal && externalAbort) externalSignal.removeEventListener("abort", externalAbort);
      this.inflight.delete(runId);
    }
    return this.store.getRun(runId)!;
  }

  /** Signal an in-flight run to stop. The Runner observes ctx.signal; the app records run.cancelled. */
  cancel(runId: string): boolean {
    const root = this.store.getRun(runId);
    if (!root) return false;
    const conversations = [root.conversationId];
    const seen = new Set<string>();
    let cancelled = false;
    while (conversations.length) {
      const conversationId = conversations.shift()!;
      if (seen.has(conversationId)) continue;
      seen.add(conversationId);
      for (const child of this.store.listChildConversations(conversationId)) conversations.push(child.id);
      for (const run of this.store.listRuns(conversationId)) {
        if (this.inflight.has(run.id)) cancelled = this.cancelInflight(run.id) || cancelled;
      }
    }
    return cancelled;
  }

  private cancelInflight(runId: string): boolean {
    const c = this.inflight.get(runId);
    if (!c) return false;
    this.emit(this.runConversation(runId), { type: "run.status", runId, status: "cancelling" });
    c.abort();
    // Unblock any interactive ("ask") approval this run is parked on — abort alone doesn't resolve it, so
    // the agent stays awaiting a resolver that never comes and the run would hang forever (never terminal).
    // Deny the pending approvals; the agent then returns and the aborted signal drives it to a clean stop.
    for (const key of [...this.pendingApprovals.keys()]) {
      if (key.startsWith(`${runId}:`)) {
        this.pendingApprovals.get(key)!(false);
        this.pendingApprovals.delete(key);
        const callId = key.slice(runId.length + 1);
        this.emit(this.runConversation(runId), { type: "tool.approval_resolved", runId, callId, allowed: false, source: "auto-deny-cancel" });
      }
    }
    return true;
  }

  private runConversation(runId: string): string {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run.conversationId;
  }

  private runConversationId(runId: string): string | null {
    const run = this.store.getRun(runId);
    return run ? run.conversationId : null;
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
    this.store.setRunUndone(runId, true);
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

  redoLast(conversationId: string): UndoResult {
    const runs = this.store.listRuns(conversationId);
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      if (run.undone && run.snapshotAfter) {
        const conv = this.store.getConversation(run.conversationId);
        if (!conv) return { ok: false, restored: [], deleted: [], skipped: [], reason: "conversation gone" };
        const preSnap: RunSnapshot = JSON.parse(run.snapshot!) as RunSnapshot;
        const postSnap: RunSnapshot = JSON.parse(run.snapshotAfter) as RunSnapshot;
        const res = redoSnapshot(conv.projectRoot, preSnap, postSnap, run.filesChanged);
        if (res.ok) {
          this.store.setRunUndone(run.id, false);
          this.emit(run.conversationId, { type: "run.redone", runId: run.id, restored: res.restored, deleted: res.deleted, skipped: res.skipped });
        }
        return res;
      }
    }
    return { ok: false, restored: [], deleted: [], skipped: [], reason: "no undone run with snapshot to redo" };
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
