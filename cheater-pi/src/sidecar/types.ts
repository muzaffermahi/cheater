// The sidecar: a small, cheap "clerk" model (2B-4B class) for bounded fuzzy chores the 35B
// main model should not waste latency on.
//
// Doctrine (three-layer harness): code decides truth, the small model organizes, the big
// model creates. The sidecar is NEVER an authority - it only proposes, and deterministic code
// plus the verifier remain the source of truth. Every sidecar call is bounded (timeout, tiny
// output, strict schema) and every job has a deterministic fallback, so a sidecar that is slow,
// wrong, malformed, or entirely absent can never break Cheater or trap the model in a loop.

export interface SidecarCompletionParams {
  /** Short system framing. Kept tiny - the sidecar is a clerk, not a planner. */
  system?: string;
  /** The single bounded task prompt. */
  prompt: string;
  /** Soft cap on generated tokens; also communicated to the model in-prompt. */
  maxOutputTokens?: number;
  /** Wall-clock bound. On expiry the call resolves ok:false and the caller falls back. */
  timeoutMs?: number;
  /** Telemetry/receipt label, e.g. "distill_failure" / "route_goal". */
  label?: string;
  /** Per-call reasoning-depth jitter - the one sampling knob Pi's SDK exposes (there is no
   *  temperature). Used by in-session best-of-N to diversify otherwise-identical samples; Pi
   *  clamps it to the model's capabilities. Omitted = the session/model default. */
  thinkingLevel?: "off" | "low" | "medium" | "high";
}

export type SidecarCompletion =
  | { ok: true; text: string; modelId?: string; elapsedMs: number }
  | { ok: false; error: string; elapsedMs: number };

/** Introspection of the client's latch, for /sidecar status and /sidecar doctor. */
export interface SidecarLatchState {
  /** "unknown" = not probed yet; "available" = last probe worked; "unavailable" = known-broken. */
  latch: "unknown" | "available" | "unavailable";
  /**
   * Why it went unavailable. "permanent" = a config error (no resolvable model) that a re-probe
   * cannot fix; "transient" = a session/endpoint failure that may recover (e.g. a CPU server still
   * loading), so `available()` re-opens after a cooldown to let the next call re-probe.
   */
  failKind?: "permanent" | "transient";
  /** The last completion error, receipt-safe (already redacted upstream). */
  lastError?: string;
  /** Wall-clock of the last completion attempt. */
  lastElapsedMs?: number;
}

export interface SidecarClient {
  /**
   * Cheap synchronous gate: is a sidecar model plausibly configured and not known-broken? A
   * caller checks this before attempting, so an unconfigured/disabled sidecar costs nothing. A
   * self-healing client re-opens this after a transient-failure cooldown so one bad first call
   * (e.g. a CPU endpoint still warming up) does not black the sidecar out for the whole session.
   */
  available(): boolean;
  /**
   * Run one bounded, no-tool completion. MUST never throw and MUST never hang past timeoutMs:
   * any failure resolves to { ok:false } so the caller can fall back deterministically.
   */
  complete(params: SidecarCompletionParams): Promise<SidecarCompletion>;
  /** Optional latch introspection for status/doctor. Absent on trivial (test/null) clients. */
  state?(): SidecarLatchState;
}

/** Provenance of a job result - recorded in the ledger and shown in the completion receipt. */
export type SidecarJobSource = "sidecar" | "deterministic";

export interface SidecarJobOutcome<T> {
  value: T;
  /** "sidecar" only when the sidecar actually produced a usable result; else "deterministic". */
  source: SidecarJobSource;
  /** 0-1. For a deterministic result this is the deterministic method's own confidence. */
  confidence: number;
  /** One-line, receipt-safe note on what happened (e.g. "sidecar timed out; used deterministic"). */
  note: string;
  /** The job label, for ledger/receipt grouping. */
  label: string;
}
