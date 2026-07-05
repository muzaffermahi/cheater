// The Main LLM Call Governor: the control plane for "call the big model less, and only when being
// dumb would actually hurt."
//
// Doctrine: code decides truth, the small model organizes, the big model CREATES. The governor
// does not do any work itself - it CLASSIFIES an intended call into a role, states the policy for
// that role (main / sidecar / deterministic, and whether it may escalate to main), and RECORDS
// what actually happened so the receipt can show main calls made vs avoided. It is passive
// accounting + policy; with the feature off it changes nothing (the wiring still records, but the
// receipt section is gated on enabled).
//
// The ONLY roles that legitimately need the big model are creation/repair/strategy. Everything
// clerical, compressive, bookkeeping-ish, and non-authoritative is preferred to sidecar or
// deterministic code, and by default may NOT escalate to main (deterministic is the floor).

import type { CheaterConfig } from "../types.js";

export type MainCallRole =
  | "blueprint_planning"
  | "code_worker"
  | "repair_worker"
  | "strategic_bug_reasoning"
  | "route"
  | "failure_distill"
  | "capsule_compress"
  | "compaction_summary"
  | "receipt_summary"
  | "tool_error_normalize"
  | "scaffold_content"
  | "other";

export type MainCallTarget = "main" | "sidecar" | "deterministic";

export interface MainCallDecision {
  role: MainCallRole;
  /** Where this role SHOULD go under policy. */
  target: MainCallTarget;
  /** Is the big model permitted for this role at all. */
  allowedOnMain: boolean;
  /** May this role fall back to the big model when sidecar/deterministic is insufficient. */
  canEscalate: boolean;
  reason: string;
}

export interface MainCallRecord {
  role: MainCallRole;
  outcome: "main" | "avoided" | "escalated";
  /** For an avoided call: what handled it instead. */
  handledBy?: MainCallTarget;
  /** Number of physical calls this record represents (a resample can be several). */
  calls: number;
  reason: string;
  estTokens?: number;
  actualTokens?: number;
  ttftMs?: number;
}

export interface MainCallGovernorSnapshot {
  enabled: boolean;
  records: MainCallRecord[];
  mainByRole: Record<string, number>;
  avoidedByRole: Record<string, number>;
  escalatedByRole: Record<string, number>;
  totalMain: number;
  totalAvoided: number;
  totalEscalated: number;
  estMainTokens: number;
}

// Roles that legitimately need the big model (creation / repair / strategic reasoning).
export const DEFAULT_MAIN_ALLOWED_ROLES: MainCallRole[] = [
  "blueprint_planning", "code_worker", "repair_worker", "strategic_bug_reasoning"
];
// Clerical / compressive / bookkeeping roles: prefer sidecar or deterministic code.
export const DEFAULT_SIDECAR_PREFERRED_ROLES: MainCallRole[] = [
  "route", "failure_distill", "capsule_compress", "compaction_summary", "receipt_summary", "tool_error_normalize"
];
// By default NO clerical role may escalate to the big model - deterministic is the floor, so
// behaviour is identical to today when the governor is off.
export const DEFAULT_FALLBACK_ALLOWED_ROLES: MainCallRole[] = [];

class MainCallGovernor {
  private enabled = false;
  private allowed = new Set<MainCallRole>(DEFAULT_MAIN_ALLOWED_ROLES);
  private preferred = new Set<MainCallRole>(DEFAULT_SIDECAR_PREFERRED_ROLES);
  private fallback = new Set<MainCallRole>(DEFAULT_FALLBACK_ALLOWED_ROLES);
  private records: MainCallRecord[] = [];

  /** Point the governor at this run's config. Call on each new task (alongside reset). */
  configure(config: CheaterConfig): void {
    this.enabled = config.mainCallGovernorEnabled === true;
    if (config.mainAllowedRoles?.length) this.allowed = new Set(config.mainAllowedRoles as MainCallRole[]);
    if (config.sidecarPreferredRoles?.length) this.preferred = new Set(config.sidecarPreferredRoles as MainCallRole[]);
    // Escalation is opt-in per role; an empty/absent list keeps the deterministic floor.
    this.fallback = new Set((config.mainFallbackAllowedRoles as MainCallRole[]) ?? DEFAULT_FALLBACK_ALLOWED_ROLES);
  }

  reset(): void { this.records = []; }

  isEnabled(): boolean { return this.enabled; }

  /**
   * Policy for a role: where it should go and whether it may escalate to the big model. Pure - no
   * side effects, safe to call for a preview. A clerical role prefers sidecar/deterministic; a
   * creation/repair/strategy role goes to main; anything else falls to deterministic.
   */
  decide(role: MainCallRole): MainCallDecision {
    const allowedOnMain = this.allowed.has(role);
    const canEscalate = this.fallback.has(role);
    if (this.preferred.has(role)) {
      return {
        role, target: "sidecar", allowedOnMain, canEscalate,
        reason: canEscalate ? "clerical: sidecar/deterministic first, may escalate to main" : "clerical: sidecar/deterministic only (no main escalation)"
      };
    }
    if (allowedOnMain) {
      return { role, target: "main", allowedOnMain, canEscalate, reason: "role needs the big model (creation/repair/strategy)" };
    }
    return { role, target: "deterministic", allowedOnMain, canEscalate: false, reason: "role not main-allowed and not clerical-preferred; deterministic" };
  }

  /** Record a real big-model call (a resample may be several physical calls: pass `calls`). */
  recordMain(role: MainCallRole, opts: { calls?: number; estTokens?: number; actualTokens?: number; ttftMs?: number; reason?: string } = {}): void {
    this.records.push({
      role, outcome: "main", calls: Math.max(1, opts.calls ?? 1),
      reason: opts.reason ?? "big-model call", estTokens: opts.estTokens, actualTokens: opts.actualTokens, ttftMs: opts.ttftMs
    });
  }

  /** Record a big-model call AVOIDED because a clerical role was handled by sidecar/deterministic. */
  recordAvoided(role: MainCallRole, handledBy: "sidecar" | "deterministic", reason: string, opts: { calls?: number } = {}): void {
    this.records.push({ role, outcome: "avoided", handledBy, calls: Math.max(1, opts.calls ?? 1), reason });
  }

  /** Record a deliberate escalation of a clerical role to the big model (only when configured). */
  recordEscalated(role: MainCallRole, reason: string, opts: { calls?: number; estTokens?: number } = {}): void {
    this.records.push({ role, outcome: "escalated", calls: Math.max(1, opts.calls ?? 1), reason, estTokens: opts.estTokens });
  }

  snapshot(): MainCallGovernorSnapshot {
    const mainByRole: Record<string, number> = {};
    const avoidedByRole: Record<string, number> = {};
    const escalatedByRole: Record<string, number> = {};
    let totalMain = 0, totalAvoided = 0, totalEscalated = 0, estMainTokens = 0;
    for (const r of this.records) {
      if (r.outcome === "main") { mainByRole[r.role] = (mainByRole[r.role] ?? 0) + r.calls; totalMain += r.calls; estMainTokens += (r.estTokens ?? 0) * r.calls; }
      else if (r.outcome === "avoided") { avoidedByRole[r.role] = (avoidedByRole[r.role] ?? 0) + r.calls; totalAvoided += r.calls; }
      else { escalatedByRole[r.role] = (escalatedByRole[r.role] ?? 0) + r.calls; totalEscalated += r.calls; estMainTokens += (r.estTokens ?? 0) * r.calls; }
    }
    return { enabled: this.enabled, records: [...this.records], mainByRole, avoidedByRole, escalatedByRole, totalMain, totalAvoided, totalEscalated, estMainTokens };
  }

  /** Compact receipt lines for the "main model calls" section, or [] when off / no activity. */
  receiptLines(): string[] {
    if (!this.enabled) return [];
    const s = this.snapshot();
    if (!s.totalMain && !s.totalAvoided && !s.totalEscalated) return [];
    const lines = [`main model calls: ${s.totalMain} total${s.estMainTokens ? ` (~${s.estMainTokens} est tokens)` : ""}`];
    for (const [role, n] of Object.entries(s.mainByRole)) lines.push(`  ${role}: ${n}`);
    if (s.totalAvoided) {
      lines.push(`  avoided by sidecar/deterministic: ${s.totalAvoided}`);
      for (const [role, n] of Object.entries(s.avoidedByRole)) lines.push(`    ${role}: ${n}`);
    }
    if (s.totalEscalated) lines.push(`  escalated to main: ${s.totalEscalated}`);
    return lines;
  }
}

/** Process-level singleton: one governor per Cheater run (reset per task). */
export const mainCallGovernor = new MainCallGovernor();

/** Classify a commitlet into its worker role by id convention (repair commitlets end in -repair). */
export function workerRoleForCommitletId(commitletId: string): MainCallRole {
  return /-repair$/.test(commitletId) ? "repair_worker" : "code_worker";
}
