// Sidecar calibration: learn, per sidecar model, which prefetch job types actually pay off, and
// stop dispatching the ones that don't.
//
// The scheduler records per-type hits (a prefetch was ready and used) vs fallbacks (we had to run
// it live). A job type whose prefetches almost never land in time / match their premise is pure
// wasted sidecar work - so after enough samples we GATE its dispatch off (it still runs LIVE via
// getOrRun when needed; we just stop speculatively pre-running it). Local-only JSON, keyed by the
// sidecar model id so a different small model recalibrates from scratch. This is the M1 loop, in
// its simplest honest form: measured, auditable (/sidecar shows it), reversible.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface TypeStat { hits: number; fallbacks: number }
type Store = Record<string, Record<string, TypeStat>>;

const MIN_SAMPLES = 8;
const MIN_HIT_RATE = 0.12;

function calibrationFile(cwd: string): string {
  return join(resolve(cwd), ".cheater", "sidecar-calibration.json");
}

function load(cwd: string): Store {
  try {
    const file = calibrationFile(cwd);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Store) : {};
  } catch {
    return {};
  }
}

function save(cwd: string, store: Store): void {
  try {
    const file = calibrationFile(cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch {
    // calibration is best-effort; never break a run over it
  }
}

/** Merge a session's per-type scheduler stats into the durable store for `modelId`. */
export function recordSchedulerStats(cwd: string, modelId: string, byType: Record<string, TypeStat>): void {
  if (!modelId) return;
  const store = load(cwd);
  const model = (store[modelId] ??= {});
  let touched = false;
  for (const [type, stat] of Object.entries(byType)) {
    if (!stat || (stat.hits === 0 && stat.fallbacks === 0)) continue;
    const cur = (model[type] ??= { hits: 0, fallbacks: 0 });
    cur.hits += stat.hits;
    cur.fallbacks += stat.fallbacks;
    touched = true;
  }
  if (touched) save(cwd, store);
}

/**
 * A gate keyed to a sidecar model: returns false for prefetch job types whose historical hit-rate
 * is too low (after enough samples). Unknown / under-sampled types always pass (optimistic start).
 */
export function jobGate(cwd: string, modelId: string): (type: string) => boolean {
  const model = load(cwd)[modelId] ?? {};
  return (type: string): boolean => {
    const stat = model[type];
    if (!stat) return true;
    const total = stat.hits + stat.fallbacks;
    if (total < MIN_SAMPLES) return true;
    return stat.hits / total >= MIN_HIT_RATE;
  };
}

/** Human-readable calibration summary for the /sidecar status command. */
export function calibrationSummary(cwd: string, modelId: string): string[] {
  const model = load(cwd)[modelId] ?? {};
  const rows = Object.entries(model);
  if (!rows.length) return [];
  return rows.map(([type, s]) => {
    const total = s.hits + s.fallbacks;
    const rate = total ? Math.round((s.hits / total) * 100) : 0;
    const gated = total >= MIN_SAMPLES && s.hits / total < MIN_HIT_RATE;
    return `  ${type}: ${rate}% prefetch-hit over ${total}${gated ? " (prefetch gated OFF - runs live)" : ""}`;
  });
}
