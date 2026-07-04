// Sidecar liveness + usage accounting: keep the sidecar alive and honest about whether it earned
// its keep this run. The scheduler (sidecar/scheduler.ts) tracks PREFETCH timing (hit/ran-live/
// waste); this tracks JOB OUTCOMES by role - did the small model actually produce a usable result,
// or did every attempt fall back to deterministic code - plus an explicit "available but unused"
// signal so a configured-yet-idle sidecar shows up in the receipt instead of hiding.
//
// The sidecar remains non-authoritative: nothing here touches gates, truth, or the critical path.
// Keepalive is a TINY bounded JSON health check, never a large warming prompt.

import type { CheaterConfig } from "../types.js";
import type { SidecarClient } from "../sidecar/types.js";

export interface SidecarUsageAccount {
  configured: boolean;
  online: boolean;
  keepAlivePinged: boolean;
  attempted: number;
  succeeded: number;
  fellBack: number;
  roles: string[];
  /** Set when the sidecar was available but produced nothing useful this run, with the why. */
  unusedReason?: string;
}

class SidecarUsage {
  private configured = false;
  private online = false;
  private keepAlivePinged = false;
  private attempts: Array<{ role: string; source: "sidecar" | "deterministic" }> = [];

  reset(): void {
    this.configured = false;
    this.online = false;
    this.keepAlivePinged = false;
    this.attempts = [];
  }

  /** Record run-start resolution: is a sidecar configured/enabled and is the client currently up. */
  noteResolved(configured: boolean, online: boolean): void {
    this.configured = configured;
    this.online = online;
  }

  noteKeepAlive(pinged: boolean): void { this.keepAlivePinged = pinged; if (pinged) this.online = true; }

  /** Record one sidecar JOB attempt and whether the small model produced it or it fell back. */
  record(role: string, source: "sidecar" | "deterministic"): void {
    this.attempts.push({ role, source });
  }

  snapshot(): SidecarUsageAccount {
    const attempted = this.attempts.length;
    const succeeded = this.attempts.filter((a) => a.source === "sidecar").length;
    const fellBack = attempted - succeeded;
    const roles = [...new Set(this.attempts.filter((a) => a.source === "sidecar").map((a) => a.role))];
    let unusedReason: string | undefined;
    if (!this.configured) unusedReason = undefined; // nothing to report: sidecar isn't configured
    else if (!this.online) unusedReason = "configured but offline (see /sidecar doctor)";
    else if (succeeded === 0) unusedReason = attempted === 0 ? "available but unused: no eligible roles this run" : "available but unused: every attempt fell back to deterministic";
    return { configured: this.configured, online: this.online, keepAlivePinged: this.keepAlivePinged, attempted, succeeded, fellBack, roles, unusedReason };
  }

  /** Receipt lines for the sidecar section, or [] when no sidecar is configured. */
  receiptLines(): string[] {
    const s = this.snapshot();
    if (!s.configured) return [];
    const lines = [`sidecar: attempted ${s.attempted}, succeeded ${s.succeeded}, fallback ${s.fellBack}${s.roles.length ? ` (roles: ${s.roles.join(", ")})` : ""}`];
    if (s.unusedReason) lines.push(`  ${s.unusedReason}`);
    return lines;
  }
}

/** Process-level singleton: one usage account per Cheater run (reset per task). */
export const sidecarUsage = new SidecarUsage();

/**
 * Tiny, bounded keepalive: one small JSON health check to keep a CPU sidecar warm at run start.
 * Returns true on a healthy reply. Never large, never blocks the run's truth/gates. No-op unless a
 * keepalive/warm config flag is set and the client is plausibly available.
 */
export async function sidecarKeepAlive(client: SidecarClient, config: CheaterConfig): Promise<boolean> {
  if (!config.sidecarKeepAliveEnabled && !config.sidecarForceWarmOnRunStart) return false;
  if (!client.available()) return false;
  try {
    const res = await client.complete({ system: "You are a health probe.", prompt: 'Reply with exactly: {"ok":true}', maxOutputTokens: 8, label: "keepalive" });
    return res.ok;
  } catch {
    return false; // complete() is contractually safe, but never let keepalive break a run
  }
}
