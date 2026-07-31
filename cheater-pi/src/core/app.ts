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
import { EVENT_SCHEMA_VERSION, type EventPayload, type KittenEvent, type Lane } from "./events.js";
import { routeMessage, type RouteDecision } from "./router.js";
import type { HardnessSignal } from "../runtime/computeBudget.js";
import { captureSnapshot, captureSnapshotAfter, restoreSnapshot, redoSnapshot, type RunSnapshot, type UndoResult } from "./undo.js";
import { ContextBuilder, contextBudgetForWindow } from "./context.js";
import { TaskGraphController, type TaskGraphPlan, type TaskGraphEvent } from "./taskGraph.js";
import type { TaskNodeRow } from "./store/conversationStore.js";
import { exportConversationMarkdown } from "./export.js";
import { getAgent } from "./agents.js";
import type { WorkspaceIndex } from "./workspaceIndex.js";
import { promptEpoch } from "./promptEpoch.js";
import {
  compileTask, serializeCompiledTask,
  type CompileResult, type TaskCompilerFlag,
} from "./taskCompiler/index.js";
import { SidecarAssist, type RunFacts } from "./sidecarAssist.js";

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
  /** The router's hardness evidence, threaded so the ascent budget sees what the router saw. */
  hardness: HardnessSignal;
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
  /** Task Compiler participation. "off" preserves pre-compiler behavior exactly. Default "auto". */
  taskCompiler?: TaskCompilerFlag;
  /**
   * Advisory sidecar work after a run reaches a terminal state (postflight review, failure triage).
   * Supplied by a client that has an LLM; absent ⇒ no assist, exactly as before. Scheduled only
   * once the main model is idle — on a single-model endpoint the "sidecar" IS the main model.
   */
  sidecarAssist?: SidecarAssist;
  /** Optional workspace index for candidate-file ranking during compilation, resolved per project
   *  root. A client that already owns one (the desktop engine does) passes it; absent, grounding
   *  stays deterministic — ranking degrades, correctness does not. */
  workspaceIndex?: (projectRoot: string) => WorkspaceIndex | undefined;
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

/** The durable Task Compiler record for one run, as clients and the verifier read it back. */
export interface CompiledTaskRecord {
  runId: string;
  mode: string;
  family: string;
  /** Canonical CompiledTask JSON — the contract the run was actually held to. */
  ir: string;
  /** Full provenance (literals, repository facts, stage timings, validation). Debugging only. */
  trace: string;
  /** The exact bytes injected into the model-facing context. */
  rendered: string;
  promptEpoch: string;
}

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
  private taskCompiler: TaskCompilerFlag;
  private readonly workspaceIndex?: (projectRoot: string) => WorkspaceIndex | undefined;
  private readonly assist?: SidecarAssist;
  /** In-flight advisory passes, so tests and shutdown can await them without blocking submitMessage. */
  private readonly assistInFlight = new Set<Promise<void>>();

  constructor(opts: KittenAppOptions) {
    this.store = opts.store;
    this.runner = opts.runner;
    this.context = new ContextBuilder(opts.store, contextBudgetForWindow(opts.contextWindowTokens ?? 16384));
    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.model = opts.model ?? "ornith-1.0-35b";
    this.sidecarModel = opts.sidecarModel?.trim() || undefined;
    this.now = opts.now ?? (() => Date.now());
    this.tasks = new TaskGraphController(opts.store, this.now);
    // Bridge the task graph's own bus into the durable event stream: DAG progress used to live and die
    // on an in-memory listener set, so no client (or replay) ever saw a subagent step change state.
    this.tasks.subscribe((e) => this.bridgeTaskGraphEvent(e));
    this.newId = opts.newId ?? defaultIdGen();
    this.approvalPolicy = opts.approvalPolicy ?? "auto-deny";
    this.taskCompiler = opts.taskCompiler ?? "auto";
    this.workspaceIndex = opts.workspaceIndex;
    this.assist = opts.sidecarAssist;
  }

  /** Change Task Compiler participation at runtime (a settings change must not need a restart). */
  setTaskCompiler(flag: TaskCompilerFlag): void {
    this.taskCompiler = flag;
  }

  getTaskCompiler(): TaskCompilerFlag {
    return this.taskCompiler;
  }

  /** The compiled contract a run was held to, reconstructed from the durable trace. */
  getCompiledTask(runId: string): CompiledTaskRecord | null {
    const row = this.store.getTaskCompilation(runId);
    if (!row) return null;
    return { runId: row.runId, mode: row.mode, family: row.family, ir: row.ir, trace: row.trace, rendered: row.rendered, promptEpoch: row.promptEpoch };
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
    this.emit(conversationId, { type: "run.status", runId, status: "waiting_approval", detail: reason.slice(0, 200) });
    this.emit(conversationId, { type: "tool.approval_required", runId, callId, name, reason, risk });
    return p.then((allowed) => {
      // The run resumes either way (a denial feeds back to the model as guidance, not a terminal stop).
      if (this.inflight.has(runId) && !this.inflight.get(runId)!.signal.aborted) {
        this.emit(conversationId, { type: "run.status", runId, status: "running" });
      }
      return allowed;
    });
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

  /** Map a TaskGraphEvent onto the canonical step.* events, persisted on the node's conversation. */
  private bridgeTaskGraphEvent(e: TaskGraphEvent): void {
    const runId = e.runId ?? "task-plan";
    try {
      if (e.type === "task.started") {
        // resume() re-queues nodes with status "queued" — that is a plan snapshot change, not a step start.
        if (e.status === "running") this.emit(e.conversationId, { type: "step.started", runId, stepId: e.taskNodeId, label: e.label, agent: e.agent });
        return;
      }
      const status = (["completed", "waiting", "failed", "blocked", "cancelled"] as const).find((s) => s === e.status) ?? "failed";
      this.emit(e.conversationId, {
        type: "step.completed", runId, stepId: e.taskNodeId, status,
        ...(e.report ? { report: e.report.slice(0, 2000) } : {}),
        ...(e.evidence?.length ? { evidence: e.evidence.slice(0, 16) } : {}),
      });
    } catch { /* bridging must never break the graph run */ }
  }

  /** Emit the current DAG as a plan.updated snapshot (renderers replace, never append). */
  private emitPlanSnapshot(conversationId: string, runId: string, reason?: string): void {
    const nodes = this.tasks.list(conversationId);
    if (!nodes.length) return;
    this.emit(conversationId, {
      type: "plan.updated", runId, source: "task-graph", ...(reason ? { reason } : {}),
      steps: nodes.slice(0, 24).map((n) => ({ id: n.id, label: n.objective.slice(0, 120), status: n.status, dependsOn: n.dependencies, agent: n.agent })),
    });
  }

  /** Persist a dependency-aware subagent plan. Execution remains owned by the orchestration layer. */
  createTaskPlan(plan: TaskGraphPlan, runId = "task-plan"): TaskNodeRow[] {
    const rows = this.tasks.createPlan(plan);
    this.emitPlanSnapshot(plan.conversationId, runId, "plan created");
    return rows;
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
    this.emitPlanSnapshot(conversationId, parentRunId, "plan execution started");
    const settled = await this.tasks.runUntilSettled(conversationId, async (node, capsule, childSignal) => {
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
      runId: parentRunId,
      repoBrief: parent.projectRoot,
      // Independent clerical scouts can fan out, while any ready main-model worker
      // keeps the local GPU/context budget serialized. This makes subagent plans
      // faster without sending two heavyweight coding turns into one runtime.
      maxConcurrent: 2,
      maxConcurrentFor: (ready) => ready.some((node) => node.modelTier === "main") ? 1 : 2,
    });
    this.emitPlanSnapshot(conversationId, parentRunId, "plan settled");
    return settled;
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

  // ── Task Compiler ────────────────────────────────────────────────────────────────────────────
  /**
   * Compile the request into an execution contract, persist the trace, and record the decision.
   *
   * Two safety properties matter more than the compiler's usefulness:
   *   • `off` is a true no-op — no compilation, no event, no context change, no store write.
   *   • A compiler that throws, or produces an INVALID contract, is discarded rather than applied.
   *     A malformed contract is worse than none: it would point the main model somewhere specific
   *     and wrong, with a contract's authority behind it.
   */
  private compile(
    runId: string,
    conversationId: string,
    projectRoot: string,
    text: string,
    hasHistory: boolean,
    explicitLane: Lane | undefined,
  ): CompileResult | null {
    if (this.taskCompiler === "off") return null;
    try {
      const result = compileTask({
        taskId: runId,
        request: text,
        cwd: projectRoot,
        index: this.workspaceIndex?.(projectRoot),
        flag: this.taskCompiler,
        hasConversationHistory: hasHistory,
      });
      if (!result.validation.ok) {
        // Record WHY it was discarded — a silently dropped compiler is an unobservable one.
        this.emit(conversationId, {
          type: "task.compiled", runId, mode: result.task.compilationMode, family: result.task.family,
          goal: result.task.goal.slice(0, 300), reason: "discarded: contract failed validation",
          requirementCount: 0, assumptionCount: 0, evidenceCount: 0,
          ambiguityCounts: {}, rawRequestTokens: result.telemetry.rawRequestTokens, renderedContractTokens: 0,
          repositoryQueries: result.telemetry.repositoryQueries, sidecarCalls: result.telemetry.sidecarCalls,
          totalMs: result.telemetry.totalMs, promptEpoch: "",
          warnings: result.validation.errors.map((e) => `${e.code}: ${e.message}`).slice(0, 8),
        });
        return null;
      }
      // The epoch identifies the stable prefix this turn was rendered against. It is recorded, not
      // acted on yet: claiming cache compatibility requires the runtime to actually pin the prefix.
      const epoch = promptEpoch({
        templateVersion: `kitten-core/${EVENT_SCHEMA_VERSION}`,
        systemPrompt: "",
        toolNames: [],
        repoCapsule: projectRoot,
      });
      this.store.saveTaskCompilation({
        runId, conversationId,
        mode: result.task.compilationMode, family: result.task.family,
        ir: serializeCompiledTask(result.task),
        trace: JSON.stringify(result.trace),
        rendered: result.contractBlock,
        promptEpoch: epoch.id,
        ts: this.now(),
      });
      this.emit(conversationId, {
        type: "task.compiled", runId,
        mode: result.task.compilationMode, family: result.task.family, goal: result.task.goal.slice(0, 300),
        reason: result.trace.familyReason.slice(0, 300),
        requirementCount: result.telemetry.requirementCount,
        assumptionCount: result.telemetry.assumptionCount,
        evidenceCount: result.telemetry.evidenceCount,
        ambiguityCounts: result.telemetry.ambiguityCounts,
        rawRequestTokens: result.telemetry.rawRequestTokens,
        renderedContractTokens: result.telemetry.renderedContractTokens,
        repositoryQueries: result.telemetry.repositoryQueries,
        sidecarCalls: result.telemetry.sidecarCalls,
        totalMs: result.telemetry.totalMs,
        promptEpoch: epoch.id,
        warnings: result.validation.warnings.map((w) => `${w.code}: ${w.message}`).slice(0, 8),
      });
      // A lightweight plan outline derived from the contract (deliverables + executable checks), so a
      // client can show "what Kitten intends to produce" even when no subagent DAG exists. Advisory:
      // statuses stay "planned"; a task-graph plan later replaces it.
      const deliverables = result.task.deliverables.slice(0, 6);
      if (deliverables.length) {
        const checks = result.task.verification.requiredChecks.filter((c) => c.command).slice(0, 2);
        this.emit(conversationId, {
          type: "plan.updated", runId, source: "compiled-contract", reason: "outline from the compiled contract",
          steps: [
            ...deliverables.map((d) => ({ id: d.id, label: `${d.kind}: ${d.target}`.slice(0, 120), status: "planned", dependsOn: [] as string[] })),
            ...checks.map((c) => ({ id: c.id, label: `verify: ${c.command ?? c.claim}`.slice(0, 120), status: "planned", dependsOn: [] as string[] })),
          ],
        });
      }
      // An explicit lane override means the user chose the execution shape themselves; the contract
      // still grounds the prompt, but it must not redirect a lane the user asked for.
      if (explicitLane) result.task.executionPolicy.laneHint = null;
      return result;
    } catch {
      return null; // never fail a user's run because the compiler could not analyze the request
    }
  }

  /** Route, letting a compiled contract supply a lane hint the deterministic router does not have. */
  private route(text: string, conv: ConversationRow, opts: SubmitOptions, compiled: CompileResult | null): RouteDecision {
    const explicit = opts.lane ?? (conv.mode === "auto" ? undefined : conv.mode);
    const decision = routeMessage(text, { lane: explicit, k: opts.k, cwd: conv.projectRoot });
    const hint = compiled?.task.executionPolicy.laneHint;
    if (explicit || !hint || hint === decision.lane) return decision;
    return { ...decision, lane: hint, reasons: [...decision.reasons, compiled!.task.executionPolicy.laneReason] };
  }

  /** Ask the one blocking question and terminate the turn honestly: an answer, not a change. */
  private requestClarification(conversationId: string, runId: string, text: string, compiled: CompileResult): RunRow {
    const question = compiled.clarification ?? "What should change, and what should be true when it works?";
    const blocking = compiled.task.ambiguities.find((a) => a.kind === "blocking");
    this.emit(conversationId, { type: "route.selected", runId, lane: "answer", reasons: [compiled.task.executionPolicy.laneReason], k: 1 });
    this.emit(conversationId, { type: "run.started", runId, request: text, lane: "answer", model: "", agent: "task-compiler" });
    this.emit(conversationId, { type: "task.clarification_requested", runId, question, ambiguityId: blocking?.id ?? "", detail: blocking?.description ?? "" });
    this.emit(conversationId, { type: "assistant.final", runId, text: question });
    this.emit(conversationId, {
      type: "run.completed", runId, finished: true, verified: false, lane: "answer",
      summary: `clarification requested: ${question}`.slice(0, 300), wallMs: compiled.telemetry.totalMs,
      usage: { prompt: 0, completion: 0, reasoning: 0 },
    });
    this.emit(conversationId, {
      type: "receipt.finalized", runId,
      lines: [
        "task compiler: blocking ambiguity — asked one question instead of guessing",
        ...(blocking ? [blocking.description] : []),
        "no model call was made and no file was changed",
      ],
      filesChanged: [], verified: false,
    });
    return this.store.getRun(runId)!;
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

    this.emit(conversationId, { type: "user.message", text });

    const runId = this.newId("run");

    // ── Task Compiler ────────────────────────────────────────────────────────────────────────────
    // Compile BEFORE routing, so the contract can inform the lane, and before the expensive model
    // runs, so the main call receives a narrower problem instead of a longer paraphrase. An explicit
    // lane override is the user speaking directly — the compiler still grounds the task but never
    // overrides that choice. A compiler failure is never allowed to fail the user's run.
    const compiled = this.compile(runId, conversationId, conv.projectRoot, text, built.hasPriorTurns, opts.lane);

    // Volatile-last: durable history and the sidecar capsule stay ahead of the per-turn contract, so
    // the stable prefix survives across turns instead of being re-prefilled every time.
    const conversationContext = [built.preamble, sidecarContext, compiled?.contractBlock ?? ""].filter(Boolean).join("\n\n");

    // A blocking ambiguity is answered with ONE question rather than an expensive guess. This is a
    // terminal, honest outcome — the turn produced an answer, it just did not produce a change.
    if (compiled?.task.executionPolicy.requiresClarification && !opts.lane) {
      return this.requestClarification(conversationId, runId, text, compiled);
    }

    const decision: RouteDecision = this.route(text, conv, opts, compiled);
    // Register the abort controller BEFORE emitting run events, so a synchronous subscriber can cancel
    // the instant the run appears (the run row already exists by the time run.started broadcasts).
    const controller = new AbortController();
    this.inflight.set(runId, controller);
    const externalSignal = opts.signal;
    const externalAbort = externalSignal ? () => controller.abort(externalSignal.reason) : undefined;
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else if (externalAbort && externalSignal) externalSignal.addEventListener("abort", externalAbort, { once: true });
    this.emit(conversationId, { type: "route.selected", runId, lane: decision.lane, reasons: decision.reasons, k: decision.k, hardness: decision.hardness });
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
        hardness: decision.signal,
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
        // The main model is now idle and the user is reading the result — the one window on a
        // single-model endpoint where advisory work costs no foreground latency.
        this.startAssist(conversationId, {
          runId, status: "completed", summary: outcome.summary, verified: outcome.verified,
          filesChanged: outcome.filesChanged, projectRoot: conv.projectRoot, evidence: outcome.receiptLines,
        });
      }
    } catch (e) {
      if (controller.signal.aborted) {
        this.emit(conversationId, { type: "run.cancelled", runId });
      } else {
        const error = (e as Error).message.slice(0, 500);
        this.emit(conversationId, { type: "run.failed", runId, error });
        // A failed run is the case where triage is worth the most: the next turn gets a compact
        // signature instead of re-deriving one from raw output.
        this.startAssist(conversationId, {
          runId, status: "failed", summary: error, verified: false, filesChanged: [],
          projectRoot: conv.projectRoot, evidence: [], error,
        });
      }
    } finally {
      if (externalSignal && externalAbort) externalSignal.removeEventListener("abort", externalAbort);
      this.inflight.delete(runId);
    }
    return this.store.getRun(runId)!;
  }

  /**
   * Run the advisory sidecar pass for a terminal run and persist what it found.
   *
   * Advisory means advisory: this NEVER changes a run's status, grade, or `verified` flag, and a
   * failure here is swallowed. The run is already finished and recorded — an advisory pass that
   * could fail it would make the sidecar a liability rather than a control plane.
   */
  private startAssist(conversationId: string, facts: RunFacts): void {
    if (!this.assist) return;
    // Fire-and-forget ON PURPOSE. run.completed and receipt.finalized have already been emitted, so a
    // subscribed UI shows the finished run immediately; blocking submitMessage on an advisory pass
    // would add its whole deadline budget to every request's perceived latency.
    const task = this.runAssist(conversationId, facts).finally(() => { this.assistInFlight.delete(task); });
    this.assistInFlight.add(task);
  }

  /** Await any in-flight advisory work. For tests and orderly shutdown — never on the hot path. */
  async whenAssistSettled(): Promise<void> {
    while (this.assistInFlight.size) await Promise.all([...this.assistInFlight]);
  }

  private async runAssist(conversationId: string, facts: RunFacts): Promise<void> {
    if (!this.assist) return;
    try {
      if (SidecarAssist.needsReview(facts)) {
        const review = await this.assist.reviewRun(facts);
        this.recordSidecarPostflight(conversationId, { runId: facts.runId, ...review });
      }
      if (SidecarAssist.needsTriage(facts)) {
        const triage = await this.assist.triageFailure(facts);
        this.recordSidecarFailure(conversationId, { runId: facts.runId, ...triage });
        // Label the trajectory step by step. A failed run is mostly productive exploration (SRFT
        // measured ~76%), and until now Kitten wrote that trajectory to its receipts and never read
        // it back — so the failure was a dead end rather than the cheapest data it owns.
        const steps = this.runStepsFor(facts);
        if (steps.length) {
          const critique = await this.assist.critiqueSteps(facts, steps);
          if (critique.steps.length) {
            this.emit(conversationId, {
              type: "run.step_critique", runId: facts.runId, source: critique.source,
              steps: critique.steps.slice(0, 64), productiveRatio: critique.productiveRatio,
            });
          }
        }
      }
    } catch { /* advisory work never affects the run it describes */ }
  }

  /** The run's tool trajectory, reconstructed from durable events — the input the step critic labels. */
  private runStepsFor(facts: RunFacts): string[] {
    const conversationId = this.runConversationId(facts.runId);
    if (!conversationId) return [];
    const steps: string[] = [];
    for (const event of this.store.readEvents(conversationId, 0)) {
      if (event.type !== "tool.completed" || event.runId !== facts.runId) continue;
      const target = event.target ? ` ${event.target}` : "";
      steps.push(`${event.name}${target} -> ${event.ok ? "ok" : "FAILED"}${event.output ? `: ${event.output.slice(0, 300)}` : ""}`);
      if (steps.length >= 64) break;
    }
    return steps;
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
