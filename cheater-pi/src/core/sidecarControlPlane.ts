// Resource-aware sidecar control plane. The existing sidecar jobs remain backwards compatible; this
// scheduler adds typed leases, priorities, cancellation, premise invalidation, and honest telemetry.

export type SidecarPriority = "user-blocking" | "verification" | "context" | "speculative";
export type SidecarTier = "clerk" | "scout" | "specialist";

export interface SidecarJobSpec<T> {
  id: string;
  type: string;
  tier: SidecarTier;
  priority: SidecarPriority;
  premise: string;
  deadlineMs?: number;
  run(signal: AbortSignal): Promise<T>;
  fallback(): T | Promise<T>;
}

export interface SidecarResult<T> {
  ok: boolean;
  value: T;
  source: "sidecar" | "deterministic";
  elapsedMs: number;
  jobId: string;
  type: string;
}

export interface SidecarControlStats {
  queued: number;
  running: number;
  completed: number;
  cancelled: number;
  fallback: number;
  byType: Record<string, { completed: number; fallback: number; averageMs: number }>;
}

interface QueueEntry<T> {
  spec: SidecarJobSpec<T>;
  resolve: (result: SidecarResult<T>) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
}

const PRIORITY: Record<SidecarPriority, number> = { "user-blocking": 0, verification: 1, context: 2, speculative: 3 };

export class SidecarControlPlane {
  private readonly queue: Array<QueueEntry<unknown>> = [];
  private readonly active = new Map<string, AbortController>();
  private readonly cancelledIds = new Set<string>();
  private readonly premises = new Map<string, string>();
  private readonly statsByType = new Map<string, { completed: number; fallback: number; totalMs: number }>();
  private completed = 0;
  private cancelled = 0;
  private fallbackCount = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = Math.max(1, Math.min(4, Math.floor(maxConcurrent)));
  }

  /** Change the bounded worker count when the endpoint topology changes. Shared local
   * endpoints stay serialized; a dedicated sidecar endpoint can safely fan out clerical work. */
  setMaxConcurrent(maxConcurrent: number): void {
    this.maxConcurrent = Math.max(1, Math.min(4, Math.floor(maxConcurrent)));
    this.pump();
  }

  enqueue<T>(spec: SidecarJobSpec<T>): Promise<SidecarResult<T>> {
    this.premises.set(spec.id, spec.premise);
    return new Promise<SidecarResult<T>>((resolve, reject) => {
      this.queue.push({ spec: spec as SidecarJobSpec<unknown>, resolve: resolve as (r: SidecarResult<unknown>) => void, reject, enqueuedAt: Date.now() });
      this.queue.sort((a, b) => PRIORITY[a.spec.priority] - PRIORITY[b.spec.priority] || a.enqueuedAt - b.enqueuedAt);
      this.pump();
    });
  }

  invalidate(id: string, premise?: string): void {
    if (premise === undefined || this.premises.get(id) === premise) this.premises.delete(id);
    const controller = this.active.get(id);
    if (controller) controller.abort("premise-invalidated");
  }

  /** Cancel one user-visible job. Cancellation rejects the request instead of silently returning a fallback. */
  cancel(id: string): boolean {
    let found = false;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].spec.id !== id) continue;
      const entry = this.queue.splice(i, 1)[0];
      this.premises.delete(id);
      this.cancelled += 1;
      entry.reject(new Error("sidecar job cancelled"));
      found = true;
    }
    const controller = this.active.get(id);
    if (controller) {
      this.cancelledIds.add(id);
      this.cancelled += 1;
      controller.abort("cancelled");
      found = true;
    }
    return found;
  }

  cancelAll(): void {
    for (const id of this.active.keys()) this.cancelledIds.add(id);
    for (const controller of this.active.values()) controller.abort("cancelled");
    this.cancelled += this.active.size;
    this.queue.splice(0).forEach((entry) => { this.premises.delete(entry.spec.id); this.cancelled += 1; entry.reject(new Error("sidecar queue cancelled")); });
  }

  snapshot(): SidecarControlStats {
    return {
      queued: this.queue.length,
      running: this.active.size,
      completed: this.completed,
      cancelled: this.cancelled,
      fallback: this.fallbackCount,
      byType: Object.fromEntries([...this.statsByType.entries()].map(([type, s]) => [type, { completed: s.completed, fallback: s.fallback, averageMs: s.completed ? Math.round(s.totalMs / s.completed) : 0 }])),
    };
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift()!;
      void this.run(next);
    }
  }

  private async run(entry: QueueEntry<unknown>): Promise<void> {
    const { spec } = entry;
    const controller = new AbortController();
    this.active.set(spec.id, controller);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    if (spec.deadlineMs && spec.deadlineMs > 0) timer = setTimeout(() => controller.abort("deadline"), spec.deadlineMs);
    try {
      const value = await spec.run(controller.signal);
      // A local runtime may ignore AbortSignal and resolve after the user pressed Stop or the
      // scheduler deadline elapsed. Never publish that stale success: cancellation must reject,
      // while a deadline is allowed to take the normal deterministic fallback path below.
      if (controller.signal.aborted) {
        if (this.cancelledIds.delete(spec.id) || controller.signal.reason === "cancelled") throw new Error("sidecar job cancelled");
        throw new Error("sidecar job deadline exceeded");
      }
      const currentPremise = this.premises.get(spec.id);
      if (currentPremise !== spec.premise) throw new Error("sidecar result invalidated by a newer premise");
      const result: SidecarResult<unknown> = { ok: true, value, source: "sidecar", elapsedMs: Date.now() - started, jobId: spec.id, type: spec.type };
      this.record(spec.type, "completed", result.elapsedMs);
      entry.resolve(result);
    } catch (error) {
      if (this.cancelledIds.delete(spec.id) || (controller.signal.aborted && controller.signal.reason === "cancelled")) {
        entry.reject(new Error("sidecar job cancelled"));
        return;
      }
      try {
        const value = await spec.fallback();
        const result: SidecarResult<unknown> = { ok: false, value, source: "deterministic", elapsedMs: Date.now() - started, jobId: spec.id, type: spec.type };
        this.record(spec.type, "fallback", result.elapsedMs);
        entry.resolve(result);
      } catch (fallbackError) {
        entry.reject(fallbackError);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(spec.id);
      this.premises.delete(spec.id);
      this.pump();
    }
  }

  private record(type: string, kind: "completed" | "fallback", elapsedMs: number): void {
    if (kind === "completed") this.completed += 1; else this.fallbackCount += 1;
    const s = this.statsByType.get(type) ?? { completed: 0, fallback: 0, totalMs: 0 };
    s[kind] += 1;
    if (kind === "completed") s.totalMs += elapsedMs;
    this.statsByType.set(type, s);
  }
}
