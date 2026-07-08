// Kitten Ascent D2 — the held-out transfer proof (the anti-benchmaxx firewall). The single most
// important deliverable for "reflected in real-world usage": a task set the machinery has NEVER seen —
// not in the experience store, not in any skill, not web-reachable as a solution. Every phase's lift
// must survive here. If SWE-Verified jumps but held-out doesn't, the gain is leakage, and Law 6 says
// revert it. Held-out lift IS real-world lift.
//
// The mechanism is the disjointness firewall (core/disjointness): register the held-out set as an eval
// set, so every store's load/admit assertion and the web/skill guards automatically refuse to touch it.
// This module adds the registration + the transfer test (does an eval-set lift reproduce on held-out?).

import { EvalRegistry } from "./disjointness.js";

export const HELD_OUT_SET = "held-out";

/** Register a held-out task set so ALL Law-4 assertions (stores, skills, web) cover it too. */
export function registerHeldOut(registry: EvalRegistry, ids: string[], texts: Record<string, string> = {}): void {
  registry.register(HELD_OUT_SET, ids, texts);
}

export interface FirewallReport {
  clean: boolean;
  violations: string[];
}

/**
 * Run the held-out firewall check: assert no store contains a held-out (or any eval) task, and no skill
 * playbook references one. Returns a report rather than throwing, so a rig can log it; callers that want
 * the hard guarantee use the store's own assertDisjoint (which throws).
 */
export function heldOutFirewallReport(
  registry: EvalRegistry,
  stores: { experienceIds?: string[]; skillViolations?: string[]; webQueriesRefused?: number }
): FirewallReport {
  const violations: string[] = [];
  for (const id of stores.experienceIds ?? []) if (registry.isEvalId(id)) violations.push(`experience store contains eval/held-out id: ${id}`);
  for (const v of stores.skillViolations ?? []) violations.push(`skill: ${v}`);
  return { clean: violations.length === 0, violations };
}

/**
 * The transfer test (Law 6): does an eval-set lift reproduce on the held-out set? A gain is REAL only if
 * held-out Best@1 does not fall far below the eval Best@1. A large drop means the eval number was
 * inflated by leakage — revert the lever.
 */
export function transfers(evalBest1: number, heldOutBest1: number, maxDrop = 0.1): { transfers: boolean; drop: number } {
  const drop = evalBest1 - heldOutBest1;
  return { transfers: drop <= maxDrop, drop };
}

export function renderTransfer(evalBest1: number, heldOutBest1: number, maxDrop = 0.1): string {
  const t = transfers(evalBest1, heldOutBest1, maxDrop);
  const p = (x: number) => `${(100 * x).toFixed(1)}%`;
  return `transfer: eval Best@1 ${p(evalBest1)} vs held-out ${p(heldOutBest1)} (drop ${p(t.drop)}) → ${t.transfers ? "TRANSFERS (real)" : "DOES NOT TRANSFER — leakage suspected, revert per Law 6"}`;
}
