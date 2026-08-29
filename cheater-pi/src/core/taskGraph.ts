// Durable, dependency-aware subagent orchestration. The controller owns this graph; workers receive
// bounded capsules and report structured evidence back. No worker is allowed to infer completion from
// prose alone.

import { ConversationStore, type TaskNodeRow, type CreateTaskNodeInput, type TaskNodeStatus } from "./store/conversationStore.js";

export interface TaskCapsule {
  taskNodeId: string;
  agent: string;
  objective: string;
  acceptanceCriteria: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  workspaceMode: TaskNodeRow["workspaceMode"];
  modelTier: string;
  repoBrief: string;
  knownFacts: string[];
  parentTranscriptIncluded: false;
}

export interface TaskExecutionResult {
  report: string;
  evidence: string[];
  verified?: boolean;
}

export interface TaskGraphEvent {
  type: "task.started" | "task.completed" | "task.failed" | "task.blocked";
  taskNodeId: string;
  status: TaskNodeStatus;
  report?: string;
  evidence?: string[];
  /** The conversation the node belongs to — lets a subscriber bridge into the durable event stream. */
  conversationId: string;
  /** The parent run driving this settle (from runUntilSettled opts); absent for resume/plan edits. */
  runId?: string;
  /** Bounded objective + agent, so a bridge can label the step without a store round-trip. */
  label: string;
  agent: string;
}

export interface TaskGraphPlan {
  conversationId: string;
  nodes: Array<Omit<CreateTaskNodeInput, "conversationId" | "ts"> & { id: string }>;
  ts?: number;
}

export function validateTaskPlan(plan: TaskGraphPlan): void {
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) throw new Error(`duplicate task node: ${node.id}`);
    ids.add(node.id);
    if (!node.objective.trim()) throw new Error(`task ${node.id} has no objective`);
    const editCapable = /\b(edit|write|modify|implement|delete|create)\b/i.test(`${node.agent} ${node.objective}`) && node.agent !== "review" && node.agent !== "explore" && node.agent !== "verify";
    if (node.workspaceMode === "shared-readonly" && editCapable) {
      throw new Error(`edit-capable task ${node.id} must use isolated-worktree`);
    }
    if (node.workspaceMode === "isolated-worktree" && editCapable && !(node.allowedFiles?.length)) {
      throw new Error(`isolated edit task ${node.id} must declare allowedFiles for a bounded write scope`);
    }
  }
  for (const node of plan.nodes) for (const dep of node.dependencies ?? []) if (!ids.has(dep)) throw new Error(`task ${node.id} depends on unknown node ${dep}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`task graph cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const node of plan.nodes) visit(node.id);
}

export function buildTaskCapsule(node: TaskNodeRow, repoBrief: string, knownFacts: string[] = [], maxChars = 12_000): TaskCapsule {
  const bounded = (s: string, n: number): string => s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
  return {
    taskNodeId: node.id,
    agent: node.agent,
    objective: bounded(node.objective, 4000),
    acceptanceCriteria: node.acceptanceCriteria.slice(0, 32).map((s) => bounded(s, 500)),
    allowedFiles: node.allowedFiles.slice(0, 64),
    forbiddenFiles: node.forbiddenFiles.slice(0, 64),
    workspaceMode: node.workspaceMode,
    modelTier: node.modelTier,
    repoBrief: bounded(repoBrief, Math.floor(maxChars * 0.35)),
    knownFacts: knownFacts.slice(0, 48).map((s) => bounded(s, 500)),
    parentTranscriptIncluded: false,
  };
}

export class TaskGraphController {
  private readonly listeners = new Set<(event: TaskGraphEvent) => void>();

  constructor(private readonly store: ConversationStore, private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: (event: TaskGraphEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  createPlan(plan: TaskGraphPlan): TaskNodeRow[] {
    validateTaskPlan(plan);
    const ts = plan.ts ?? this.now();
    return plan.nodes.map((node) => this.store.createTaskNode({ ...node, conversationId: plan.conversationId, ts }));
  }

  list(conversationId: string): TaskNodeRow[] { return this.store.listTaskNodes(conversationId); }

  /** Requeue only unfinished work so a cancelled/crashed plan can continue without rerunning
   * completed nodes. Reports/evidence from the previous attempt are cleared because they are
   * provisional and must not masquerade as fresh receipts. */
  resume(conversationId: string): TaskNodeRow[] {
    const recoverable: TaskNodeStatus[] = ["queued", "blocked", "running", "waiting", "verifying", "failed", "cancelled", "interrupted"];
    for (const node of this.list(conversationId)) {
      if (!recoverable.includes(node.status) || node.status === "queued") continue;
      this.store.updateTaskNode(node.id, { status: "queued", report: "", evidence: [], ts: this.now() });
      this.emit({ type: "task.started", taskNodeId: node.id, status: "queued", ...identity(node) });
    }
    return this.list(conversationId);
  }

  ready(conversationId: string): TaskNodeRow[] {
    const nodes = this.list(conversationId);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return nodes.filter((node) => node.status === "queued" && node.dependencies.every((id) => byId.get(id)?.status === "completed"));
  }

  /** Run all currently runnable nodes until the graph reaches a terminal state. */
  async runUntilSettled(conversationId: string, executor: (node: TaskNodeRow, capsule: TaskCapsule, signal: AbortSignal) => Promise<TaskExecutionResult>, opts: { maxConcurrent?: number; /** Adapt concurrency to the currently-ready work (for example, serialize main-model nodes but fan out sidecar scouts). */ maxConcurrentFor?: (ready: TaskNodeRow[]) => number; repoBrief?: string; knownFacts?: string[]; signal?: AbortSignal; /** The parent run driving this settle; stamped on every emitted TaskGraphEvent. */ runId?: string } = {}): Promise<TaskNodeRow[]> {
    const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? 1));
    const active = new Map<string, Promise<void>>();
    const runOne = async (node: TaskNodeRow): Promise<void> => {
      const controller = new AbortController();
      const cancel = (): void => controller.abort(opts.signal?.reason ?? "cancelled");
      if (opts.signal?.aborted) cancel(); else opts.signal?.addEventListener("abort", cancel, { once: true });
      this.update(node.id, "running");
      this.emit({ type: "task.started", taskNodeId: node.id, status: "running", ...identity(node, opts.runId) });
      try {
        const result = await executor(node, buildTaskCapsule(node, opts.repoBrief ?? "", opts.knownFacts), controller.signal);
        this.store.updateTaskNode(node.id, { status: result.verified === false ? "waiting" : "completed", report: result.report, evidence: result.evidence, ts: this.now() });
        const status = result.verified === false ? "waiting" : "completed";
        this.emit({ type: "task.completed", taskNodeId: node.id, status, report: result.report, evidence: result.evidence, ...identity(node, opts.runId) });
      } catch (error) {
        const report = error instanceof Error ? error.message : String(error);
        this.store.updateTaskNode(node.id, { status: controller.signal.aborted ? "cancelled" : "failed", report, evidence: [], ts: this.now() });
        this.emit({ type: "task.failed", taskNodeId: node.id, status: controller.signal.aborted ? "cancelled" : "failed", report, ...identity(node, opts.runId) });
      } finally {
        if (opts.signal?.aborted) controller.abort(opts.signal.reason);
        active.delete(node.id);
      }
    };

    while (true) {
      const nodes = this.list(conversationId);
      const terminal = nodes.every((n) => ["completed", "failed", "cancelled", "blocked", "interrupted", "waiting"].includes(n.status));
      if (terminal) break;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const node of nodes) {
        if (node.status === "queued" && node.dependencies.some((id) => ["failed", "cancelled", "blocked", "interrupted"].includes(byId.get(id)?.status ?? ""))) {
          this.update(node.id, "blocked");
          this.emit({ type: "task.blocked", taskNodeId: node.id, status: "blocked", report: "dependency did not complete", ...identity(node, opts.runId) });
        }
      }
      const ready = this.ready(conversationId);
      const concurrency = Math.max(1, Math.min(maxConcurrent, Math.floor(opts.maxConcurrentFor?.(ready) ?? maxConcurrent)));
      for (const node of ready) {
        if (active.size >= concurrency) break;
        active.set(node.id, runOne(node));
      }
      if (!active.size) {
        // Remaining queued nodes are necessarily cyclic or depend on a non-terminal waiting node.
        for (const node of this.list(conversationId).filter((n) => n.status === "queued")) {
          this.update(node.id, "blocked");
          this.emit({ type: "task.blocked", taskNodeId: node.id, status: "blocked", report: "no runnable dependency path", ...identity(node, opts.runId) });
        }
        break;
      }
      await Promise.race(active.values());
    }
    return this.list(conversationId);
  }

  private update(id: string, status: TaskNodeStatus): void { this.store.updateTaskNode(id, { status, ts: this.now() }); }
  private emit(event: TaskGraphEvent): void { for (const listener of this.listeners) { try { listener(event); } catch {} } }
}

/** The identity fields every TaskGraphEvent carries, derived from the node row itself. */
function identity(node: TaskNodeRow, runId?: string): { conversationId: string; runId?: string; label: string; agent: string } {
  return { conversationId: node.conversationId, ...(runId ? { runId } : {}), label: node.objective.slice(0, 120), agent: node.agent };
}
