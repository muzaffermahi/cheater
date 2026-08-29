/* Policy-driven runtime primitives. These stay engine-neutral so stock llama.cpp remains the
 * required path; adapters can opt into slot save/restore or endpoint-specific actions later. */

export interface AgentIdentity {
  role: string;
  model: string;
  promptEpoch: string;
  toolSchemaHash: string;
}

export interface WorkloadIdentity extends AgentIdentity {
  project: string;
  taskFamily: string;
}

export interface RuntimeEvent {
  kind: string;
  agent?: AgentIdentity;
  previousAgent?: AgentIdentity;
  workload?: WorkloadIdentity;
  timestamp?: number;
  data?: Record<string, unknown>;
}

export interface RuntimeAction {
  kind: string;
  agent?: AgentIdentity;
  cancellable?: boolean;
  reason?: string;
  data?: Record<string, unknown>;
}

export interface RuntimePolicy {
  readonly name: string;
  observe(event: RuntimeEvent): void;
  score(decision: string, item: unknown): number;
  predict(kind: string, horizon: number): unknown;
  act(action: RuntimeAction, context?: Record<string, unknown>): void | Promise<void>;
}

export class AgentRuntime {
  private readonly policies = new Map<string, RuntimePolicy>();
  private readonly enabled = new Map<string, boolean>();
  register(policy: RuntimePolicy): this { this.policies.set(policy.name, policy); return this; }
  setEnabled(policyName: string, enabled: boolean): void { this.enabled.set(policyName, enabled); }
  isEnabled(policyName: string): boolean { return this.enabled.get(policyName) !== false; }
  observe(event: RuntimeEvent): void { for (const policy of this.policies.values()) if (this.isEnabled(policy.name)) policy.observe(event); }
  score(decision: string, item: unknown): number {
    let total = 0; for (const policy of this.policies.values()) if (this.isEnabled(policy.name)) total += policy.score(decision, item);
    return total;
  }
  predict(kind: string, horizon = 1): unknown[] { return [...this.policies.values()].filter((policy) => this.isEnabled(policy.name)).map((policy) => policy.predict(kind, horizon)); }
  async act(action: RuntimeAction, context: Record<string, unknown> = {}): Promise<void> {
    await Promise.all([...this.policies.values()].filter((policy) => this.isEnabled(policy.name)).map((policy) => policy.act(action, context)));
  }
}

function identityKey(agent: AgentIdentity): string { return `${agent.role}|${agent.model}|${agent.promptEpoch}|${agent.toolSchemaHash}`; }

/** CacheScout's bounded first-order Markov transition policy. */
export class CacheScoutPolicy implements RuntimePolicy {
  readonly name = "cache-scout";
  private readonly transitions = new Map<string, Map<string, number>>();
  private readonly recency = new Map<string, number>();
  private readonly history: string[] = [];
  private currentAgent?: string;
  constructor(private readonly windowSize = 2_048, private readonly threshold = 0.01) {}

  observe(event: RuntimeEvent): void {
    const from = event.previousAgent && identityKey(event.previousAgent);
    const to = event.agent && identityKey(event.agent);
    if (!from || !to || from === to) { if (to) this.touch(to); return; }
    const row = this.transitions.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + 1); this.transitions.set(from, row);
    this.history.push(`${from}>${to}`); if (this.history.length > this.windowSize) this.history.shift();
    this.touch(to);
  }
  private touch(key: string): void { this.recency.set(key, Date.now()); this.currentAgent = key; }
  private row(from: string): Map<string, number> { return this.transitions.get(from) ?? new Map(); }
  private entropy(row: Map<string, number>): number {
    const total = [...row.values()].reduce((a, b) => a + b, 0); if (!total) return 0;
    return [...row.values()].reduce((h, count) => { const p = count / total; return h - p * Math.log2(p); }, 0);
  }
  private evidence(from: string): { count: number; next?: string; probability: number; reduction: number } {
    const row = this.row(from); const count = [...row.values()].reduce((a, b) => a + b, 0);
    let next: string | undefined; let best = 0;
    for (const [candidate, n] of row) if (n > best) { best = n; next = candidate; }
    const global = new Map<string, number>();
    for (const values of this.transitions.values()) for (const [candidate, n] of values) global.set(candidate, (global.get(candidate) ?? 0) + n);
    const globalEntropy = this.entropy(global); const conditional = this.entropy(row);
    const reduction = globalEntropy > 0 ? Math.max(0, (globalEntropy - conditional) / globalEntropy) : 0;
    return { count, next, probability: count ? best / count : 0, reduction };
  }
  predict(kind: string, horizon: number): { enabled: boolean; agent?: string; probability: number; score: number; fallback: "recency" | "none" } {
    if (kind !== "next-agent" || !horizon) return { enabled: false, probability: 0, score: 0, fallback: "none" };
    const from = this.currentAgent;
    if (!from) return { enabled: false, probability: 0, score: 0, fallback: "none" };
    const evidence = this.evidence(from);
    if (evidence.count < 100 || evidence.reduction < 0.2 || !evidence.next || evidence.probability < 0.65) {
      return { enabled: false, probability: evidence.probability, score: 0, fallback: "recency" };
    }
    const score = this.score("prefetch", evidence.next);
    return { enabled: true, agent: evidence.next, probability: evidence.probability, score, fallback: "none" };
  }
  score(decision: string, item: unknown): number {
    if (decision !== "prefetch" || typeof item !== "string") return 0;
    const from = this.currentAgent; if (!from) return 0;
    const row = this.row(from); const total = [...row.values()].reduce((a, b) => a + b, 0); const count = row.get(item) ?? 0;
    const probability = total ? count / total : 0; const age = Math.max(0, Date.now() - (this.recency.get(item) ?? Date.now()));
    const recency = 1 / (1 + age / 60_000); return recency + probability;
  }
  act(_action: RuntimeAction, _context?: Record<string, unknown>): void { /* mutation is adapter-owned and audited */ }
  snapshot(): Record<string, Record<string, number>> {
    return Object.fromEntries([...this.transitions.entries()].map(([from, row]) => [from, Object.fromEntries(row)]));
  }
}

export interface CacheAdapterCapabilities { cachePrompt: boolean; slotSaveRestore: boolean; }

/** Stock llama.cpp adapter: prefetch is deliberately a cancellable, foreground-idle action. */
export class CacheScoutAdapter {
  constructor(private readonly policy: CacheScoutPolicy, private readonly capabilities: CacheAdapterCapabilities, private readonly warm: (agentKey: string, signal: AbortSignal) => Promise<void>) {}
  async maybePrefetch(signal: AbortSignal, foregroundPending: boolean): Promise<boolean> {
    if (foregroundPending || signal.aborted || !this.capabilities.cachePrompt || !this.capabilities.slotSaveRestore) return false;
    const prediction = this.policy.predict("next-agent", 1);
    if (!prediction.enabled || !prediction.agent) return false;
    try { await this.warm(prediction.agent, signal); return !signal.aborted; }
    catch { return false; }
  }
}

export interface MemoEntry<T> { value: T; workspaceRevision: string; expiresAt: number; }

/** Only callers that explicitly mark a read as pure can populate this cache. */
export class ToolResultMemoCache<T = unknown> {
  private readonly entries = new Map<string, MemoEntry<T>>();
  get(key: string, workspaceRevision: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key); if (!entry || entry.workspaceRevision !== workspaceRevision || entry.expiresAt <= now) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  set(key: string, value: T, workspaceRevision: string, ttlMs = 60_000): void {
    if (!key || ttlMs <= 0) return; this.entries.set(key, { value, workspaceRevision, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value as string);
  }
  invalidate(workspaceRevision?: string): void {
    if (!workspaceRevision) { this.entries.clear(); return; }
    for (const [key, entry] of this.entries) if (entry.workspaceRevision !== workspaceRevision) this.entries.delete(key);
  }
  get size(): number { return this.entries.size; }
}

export type AdmissionPriority = "foreground" | "verification" | "context" | "speculative";
export interface AdmissionItem<T> { id: string; priority: AdmissionPriority; payload: T; enqueuedAt: number; cancelled?: boolean; }

/** Foreground-first bounded admission with priority aging; no endpoint FIFO lock is required. */
export class PriorityAdmissionScheduler<T> {
  private readonly queue: AdmissionItem<T>[] = [];
  constructor(private readonly maxConcurrent = 1, private readonly agingMs = 5_000) {}
  enqueue(id: string, priority: AdmissionPriority, payload: T, now = Date.now()): void { this.queue.push({ id, priority, payload, enqueuedAt: now }); }
  cancel(id: string): boolean { const item = this.queue.find((entry) => entry.id === id); if (!item) return false; item.cancelled = true; return true; }
  drain(now = Date.now()): AdmissionItem<T>[] {
    const weight: Record<AdmissionPriority, number> = { foreground: 4, verification: 3, context: 2, speculative: 1 };
    const available = this.queue.filter((item) => !item.cancelled).sort((a, b) => {
      const pa = weight[a.priority] + Math.min(2, Math.floor((now - a.enqueuedAt) / this.agingMs));
      const pb = weight[b.priority] + Math.min(2, Math.floor((now - b.enqueuedAt) / this.agingMs));
      return pb - pa || a.enqueuedAt - b.enqueuedAt;
    }).slice(0, this.maxConcurrent);
    const selected = new Set(available); for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].cancelled || selected.has(this.queue[i])) this.queue.splice(i, 1);
    return available;
  }
  get pending(): number { return this.queue.filter((item) => !item.cancelled).length; }
}

/** Speculation is intentionally limited to read-only orientation; edits, commands, approvals, and
 * main-model calls never qualify. */
export function isReadOnlySpeculation(action: RuntimeAction): boolean {
  if (action.cancellable === false || action.data?.mutates === true) return false;
  return /^(read|search|index|probe|orient|capabilit)/i.test(action.kind);
}

export interface DisaggregatedPrefillDecodeAdapter {
  enabled: boolean;
  prefill(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>;
  decode(endpoint: string, state: unknown, signal: AbortSignal): Promise<unknown>;
}

/** P/D remains disabled unless both endpoints are explicitly configured. */
export function disaggregatedEnabled(prefillEndpoint?: string, decodeEndpoint?: string): boolean {
  return Boolean(prefillEndpoint?.trim() && decodeEndpoint?.trim());
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private readonly threshold = 3, private readonly cooldownMs = 30_000) {}
  allow(now = Date.now()): boolean { return this.openedAt === 0 || now - this.openedAt >= this.cooldownMs; }
  success(): void { this.failures = 0; this.openedAt = 0; }
  failure(now = Date.now()): void { if (++this.failures >= this.threshold) this.openedAt = now; }
  get state(): "closed" | "open" | "half-open" { return this.openedAt === 0 ? "closed" : (this.allow() ? "half-open" : "open"); }
}

/** Optional endpoint hedging. The first result wins and the independent loser is cancelled before
 * any caller can apply a mutation. Callers should only pass idempotent/read-only requests. */
export async function hedgeIndependent<T>(primary: (signal: AbortSignal) => Promise<T>, secondary: (signal: AbortSignal) => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const a = new AbortController(); const b = new AbortController();
  const timer = setTimeout(() => { a.abort(); b.abort(); }, timeoutMs);
  try {
    return await Promise.race([
      primary(a.signal).then((value) => { b.abort("hedge loser"); return value; }),
      secondary(b.signal).then((value) => { a.abort("hedge loser"); return value; }),
    ]);
  } finally { clearTimeout(timer); }
}
