// Kitten Ascent C3 — the budget governor. Big-N coverage is only affordable if it is BOUNDED. This is
// the per-task compute ceiling (tokens / wall-clock / dollars) that keeps N escalation from running away:
// computeBudget (src/runtime) proposes how many samples a hardness deserves; the governor caps that
// proposal to what the ceiling can still pay for, and logs spent-vs-budget into receipts so a run's cost
// is auditable. Pi-free; composes with the existing adaptive-compute dial.

export interface ComputeCeiling {
  /** Total generation-token budget for the task (prompt+completion+reasoning across all samples). */
  maxTokens?: number;
  /** Wall-clock ceiling for the whole task, ms. */
  maxWallMs?: number;
  /** Dollar ceiling (needs usdPerMTokens to convert token spend to $). */
  maxUsd?: number;
  /** Price used for the $ calc, dollars per million tokens. */
  usdPerMTokens?: number;
}

export class BudgetGovernor {
  private tokens = 0;
  private wallMs = 0;
  private startedAt: number;
  constructor(private ceiling: ComputeCeiling = {}, now = 0) {
    // `now` is injectable (Date.now is unavailable in some contexts); default 0 means wall accounting is
    // driven purely by recorded increments, which is what tests use.
    this.startedAt = now;
  }

  /** Record the token + wall-clock cost of a completed sample. */
  record(tokens: number, wallMs: number): void {
    this.tokens += Math.max(0, tokens);
    this.wallMs += Math.max(0, wallMs);
  }

  spentTokens(): number { return this.tokens; }
  spentWallMs(): number { return this.wallMs; }
  spentUsd(): number { return this.ceiling.usdPerMTokens ? (this.tokens / 1_000_000) * this.ceiling.usdPerMTokens : 0; }

  /** Is the ceiling already exhausted on any tracked dimension? */
  exhausted(): boolean {
    if (this.ceiling.maxTokens !== undefined && this.tokens >= this.ceiling.maxTokens) return true;
    if (this.ceiling.maxWallMs !== undefined && this.wallMs >= this.ceiling.maxWallMs) return true;
    if (this.ceiling.maxUsd !== undefined && this.spentUsd() >= this.ceiling.maxUsd) return true;
    return false;
  }

  /** Can we afford one more sample of the given estimated cost without blowing the ceiling? */
  canAfford(estTokensPerSample: number, estWallMsPerSample = 0): boolean {
    if (this.exhausted()) return false;
    if (this.ceiling.maxTokens !== undefined && this.tokens + estTokensPerSample > this.ceiling.maxTokens) return false;
    if (this.ceiling.maxWallMs !== undefined && this.wallMs + estWallMsPerSample > this.ceiling.maxWallMs) return false;
    if (this.ceiling.maxUsd !== undefined && this.ceiling.usdPerMTokens) {
      const projected = ((this.tokens + estTokensPerSample) / 1_000_000) * this.ceiling.usdPerMTokens;
      if (projected > this.ceiling.maxUsd) return false;
    }
    return true;
  }

  /**
   * Cap a requested sample count to what the remaining budget can pay for, given a per-sample estimate.
   * Never returns more than requested; returns at least 1 (the first sample is always attempted, so a
   * task is never zero-effort — the ceiling bounds ESCALATION, it doesn't refuse the task).
   */
  capSamples(requested: number, estTokensPerSample: number, estWallMsPerSample = 0): number {
    let affordable = requested;
    if (this.ceiling.maxTokens !== undefined && estTokensPerSample > 0) {
      affordable = Math.min(affordable, Math.floor((this.ceiling.maxTokens - this.tokens) / estTokensPerSample));
    }
    if (this.ceiling.maxWallMs !== undefined && estWallMsPerSample > 0) {
      affordable = Math.min(affordable, Math.floor((this.ceiling.maxWallMs - this.wallMs) / estWallMsPerSample));
    }
    if (this.ceiling.maxUsd !== undefined && this.ceiling.usdPerMTokens && estTokensPerSample > 0) {
      const remainingUsd = this.ceiling.maxUsd - this.spentUsd();
      const affordableByUsd = Math.floor((remainingUsd * 1_000_000) / (estTokensPerSample * this.ceiling.usdPerMTokens));
      affordable = Math.min(affordable, affordableByUsd);
    }
    return Math.max(1, Math.min(requested, affordable));
  }

  receiptLines(): string[] {
    const parts: string[] = [`tokens ${this.tokens}${this.ceiling.maxTokens !== undefined ? `/${this.ceiling.maxTokens}` : ""}`];
    if (this.ceiling.maxWallMs !== undefined) parts.push(`wall ${(this.wallMs / 1000).toFixed(1)}s/${(this.ceiling.maxWallMs / 1000).toFixed(0)}s`);
    if (this.ceiling.maxUsd !== undefined) parts.push(`$${this.spentUsd().toFixed(4)}/${this.ceiling.maxUsd}`);
    return [`budget: ${parts.join(", ")}${this.exhausted() ? " [EXHAUSTED]" : ""}`];
  }
}

/** A sensible default ceiling for a hard task at ~25 tok/s targeting a ~15-min wall-clock. */
export function defaultCeiling(usdPerMTokens?: number): ComputeCeiling {
  return { maxTokens: 400_000, maxWallMs: 15 * 60_000, maxUsd: usdPerMTokens ? 0.5 : undefined, usdPerMTokens };
}
