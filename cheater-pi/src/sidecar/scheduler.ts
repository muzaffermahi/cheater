// SidecarScheduler: the mechanism that lets a small model work AHEAD of the 35B without ever
// being on the critical path.
//
// Doctrine (see the plan): the sidecar prepares INPUTS the 35B/harness will consume, never a
// DECISION, and consumers NEVER await it. This scheduler enforces that mechanically:
//   - dispatch(key, premise, job) fires a job fire-and-forget and caches its result by key.
//   - getOrRun(key, premise, fallback) returns a READY cached result if it matches the premise,
//     otherwise runs `fallback` synchronously right now. It never blocks on a pending job.
//   - a result whose premise no longer matches is simply ignored (cost: a few cheap cycles).
// So a slow / wrong / absent sidecar can never stall the run or change correctness - the worst
// case is that getOrRun falls back to exactly what the code did before the sidecar existed.
//
// Concurrency: at most one job runs at a time (a single small model can't usefully parallelize
// with itself); excess dispatches queue. "off" mode disables background work entirely (getOrRun
// always runs the fallback). "gap"/"concurrent" enable it - the difference is only WHICH call
// sites dispatch (idle-window-only vs. anytime), which the wiring decides, not this module.

import { nullSidecarClient } from "./client.js";
import type { SidecarClient } from "./types.js";

type Mode = "off" | "gap" | "concurrent";

interface CacheEntry {
  premise: string;
  status: "pending" | "done" | "error";
  result?: unknown;
}

export interface SidecarSchedulerStats {
  mode: Mode;
  available: boolean;
  dispatched: number;
  hits: number;
  fallbacks: number;
  /** Completed jobs whose result was never consumed (premise changed, or nobody read it). */
  waste: number;
  byType: Record<string, { hits: number; fallbacks: number }>;
}

class SidecarScheduler {
  private mode: Mode = "gap";
  private clientRef: SidecarClient = nullSidecarClient;
  private gate: ((type: string) => boolean) | null = null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly consumed = new Set<string>();
  private readonly queue: Array<() => void> = [];
  private inflight: Promise<void>[] = [];
  private running = 0;
  private maxConcurrent = 1;
  private dispatched = 0;
  private hits = 0;
  private fallbacks = 0;
  private readonly byType = new Map<string, { hits: number; fallbacks: number }>();
  // Track 2: per-type job latency, so the receipt/status show how fast the clerk actually is (a
  // reasoning model is slow and its prep rarely lands in time; a fast clerk lands and helps).
  private readonly latencyByType = new Map<string, { totalMs: number; count: number }>();

  /**
   * Point the scheduler at the resolved client + mode for this session. Call on each new task.
   * `gate` (from calibration) can veto PREFETCH DISPATCH for a job type whose speculation rarely
   * pays off - the type still runs live via getOrRun; we just stop pre-running it.
   */
  configure(client: SidecarClient, mode: Mode, gate?: (type: string) => boolean, maxConcurrent = 1): void {
    this.clientRef = client ?? nullSidecarClient;
    this.mode = mode;
    this.gate = gate ?? null;
    // >1 only makes sense with a separate CPU endpoint that won't contend with the GPU main model;
    // a single local model can't usefully parallelize with itself, so the wiring caps it there.
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  client(): SidecarClient { return this.clientRef; }
  mode_(): Mode { return this.mode; }

  /** Whether background jobs will actually run (mode on AND a live client). */
  enabled(): boolean {
    return this.mode !== "off" && this.clientRef.available();
  }

  /** Clear all per-task state (cache, queue, stats). Call when a new user goal starts. */
  reset(): void {
    this.cache.clear();
    this.consumed.clear();
    this.queue.length = 0;
    this.inflight = [];
    this.running = 0;
    this.dispatched = 0;
    this.hits = 0;
    this.fallbacks = 0;
    this.byType.clear();
    this.latencyByType.clear();
  }

  /**
   * Fire-and-forget a job keyed by `key` for a given `premise`. No-op when disabled or when the
   * same (key, premise) is already dispatched. The job receives the live client.
   */
  dispatch<T>(type: string, key: string, premise: string, job: (client: SidecarClient) => Promise<T>): void {
    if (!this.enabled()) return;
    if (this.gate && !this.gate(type)) return; // calibration says this prefetch type rarely pays off
    const existing = this.cache.get(key);
    if (existing && existing.premise === premise) return;
    this.cache.set(key, { premise, status: "pending" });
    this.dispatched += 1;
    const client = this.clientRef;
    const done = new Promise<void>((resolve) => {
      this.queue.push(async () => {
        this.running += 1;
        const startedAt = Date.now();
        try {
          const result = await job(client);
          // Only record a result if the premise is still the one we dispatched for.
          const entry = this.cache.get(key);
          if (entry && entry.premise === premise) this.cache.set(key, { premise, status: "done", result });
        } catch {
          const entry = this.cache.get(key);
          if (entry && entry.premise === premise) this.cache.set(key, { premise, status: "error" });
        } finally {
          this.recordLatency(type, Date.now() - startedAt);
          this.running -= 1;
          resolve();
          this.pump();
        }
      });
    });
    this.inflight.push(done);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift();
      if (next) void next();
    }
  }

  /** Wait for all in-flight + queued jobs to finish. For tests and pre-consume flush points. */
  async settle(): Promise<void> {
    while (this.inflight.length) {
      const batch = this.inflight;
      this.inflight = [];
      await Promise.allSettled(batch);
    }
  }

  /**
   * Return a READY pre-computed result for (key, premise), else run `fallback` synchronously now.
   * Never blocks on a pending job - a not-yet-ready sidecar result just means we do the work now,
   * exactly as the code did before the sidecar existed.
   */
  async getOrRun<T>(type: string, key: string, premise: string, fallback: () => Promise<T>): Promise<T> {
    const ready = this.peek<T>(key, premise);
    if (ready !== undefined) {
      this.record(type, "hits");
      return ready;
    }
    this.record(type, "fallbacks");
    return fallback();
  }

  /** Synchronous, non-blocking peek: the ready result for (key, premise), or undefined. */
  peek<T>(key: string, premise: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry && entry.premise === premise && entry.status === "done") {
      this.consumed.add(key);
      return entry.result as T;
    }
    return undefined;
  }

  private record(type: string, field: "hits" | "fallbacks"): void {
    if (field === "hits") this.hits += 1; else this.fallbacks += 1;
    const t = this.byType.get(type) ?? { hits: 0, fallbacks: 0 };
    t[field] += 1;
    this.byType.set(type, t);
  }

  private recordLatency(type: string, ms: number): void {
    const l = this.latencyByType.get(type) ?? { totalMs: 0, count: 0 };
    l.totalMs += Math.max(0, ms);
    l.count += 1;
    this.latencyByType.set(type, l);
  }

  /** Mean sidecar job latency this run (ms), or 0 when nothing ran. A slow clerk rarely lands its prep. */
  avgLatencyMs(): number {
    let totalMs = 0, count = 0;
    for (const l of this.latencyByType.values()) { totalMs += l.totalMs; count += l.count; }
    return count ? Math.round(totalMs / count) : 0;
  }

  stats(): SidecarSchedulerStats {
    let waste = 0;
    for (const [key, entry] of this.cache) {
      if (entry.status === "done" && !this.consumed.has(key)) waste += 1;
    }
    return {
      mode: this.mode,
      available: this.clientRef.available(),
      dispatched: this.dispatched,
      hits: this.hits,
      fallbacks: this.fallbacks,
      waste,
      byType: Object.fromEntries([...this.byType.entries()].map(([k, v]) => [k, { ...v }]))
    };
  }

  /** Compact one-line summary for receipts / the /sidecar status command. */
  summaryLine(): string {
    const s = this.stats();
    if (!s.dispatched && !s.fallbacks) return `sidecar scheduler: ${s.mode}${s.available ? "" : " (no model)"} - idle`;
    const avg = this.avgLatencyMs();
    return `sidecar scheduler: ${s.mode} - ${s.dispatched} prefetched, ${s.hits} used, ${s.fallbacks} ran-live, ${s.waste} wasted${avg ? `, ~${avg}ms/job` : ""}`;
  }

  /**
   * Latch/online line for /sidecar status and the run console, or "" when no real client is
   * configured this session (a disabled sidecar resolves to the shared null client). Reads the
   * client's optional state() so a self-healed transient failure shows honestly.
   */
  stateLine(): string {
    if (this.clientRef === nullSidecarClient) return "";
    const online = this.clientRef.available();
    const st = this.clientRef.state?.();
    const detail = st ? ` (latch ${st.latch}${st.failKind ? `/${st.failKind}` : ""})` : "";
    const err = st?.lastError ? ` - last error: ${st.lastError}` : "";
    return `clerk: ${online ? "ONLINE" : "OFFLINE"}${detail}${err}`;
  }

  /** One compact line for the live run console: online state + this session's prefetch tally. */
  consoleLine(): string {
    const s = this.stats();
    const online = this.clientRef === nullSidecarClient ? "off" : (this.clientRef.available() ? "ONLINE" : "OFFLINE");
    if (!s.dispatched && !s.fallbacks) return `sidecar: ${online} (${s.mode}) - idle`;
    return `sidecar: ${online} (${s.mode}) - ${s.dispatched} prepared, ${s.hits} used, ${s.fallbacks} ran-live${s.waste ? `, ${s.waste} wasted` : ""}`;
  }
}

/** Process-level singleton: one scheduler per Cheater session. */
export const sidecarScheduler = new SidecarScheduler();
