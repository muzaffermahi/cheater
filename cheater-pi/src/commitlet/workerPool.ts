// WorkerPool: the concurrency seam for best-of-N resampling.
//
// Honest reality (see the plan): on a single-slot GPU, running N fresh-worker attempts "in
// parallel" just serializes at the backend and contends for VRAM - sequential is optimal. So the
// DEFAULT is maxWorkerConcurrency=1 (today's behavior, byte-identical), and true parallel attempts
// are gated behind an explicit batching opt-in AND a git repo (needed for isolated worktrees so
// attempts don't clobber the shared working tree). `runPool` is a generic bounded-concurrency
// runner ready for the batching path; until then, resampling stays sequential and says why.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CheaterConfig } from "../types.js";

/** How many fresh-worker attempts may run at once. Default 1 (sequential). Always >= 1. */
export function maxWorkerConcurrency(config: CheaterConfig): number {
  const n = Math.trunc(config.maxWorkerConcurrency ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isGitRepo(cwd: string): boolean {
  if (existsSync(join(resolve(cwd), ".git"))) return true;
  try {
    return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

export interface ParallelAvailability {
  ok: boolean;
  reason: string;
}

/**
 * Whether parallel best-of-N attempts are worth running. Requires: concurrency > 1, an explicit
 * batching opt-in (a single GPU serializes, so this cannot be auto-detected), and a git repo for
 * isolated worktrees. Any failure => run sequentially (and the caller reports the reason).
 */
export function parallelResamplingAvailable(config: CheaterConfig, cwd: string): ParallelAvailability {
  if (maxWorkerConcurrency(config) <= 1) return { ok: false, reason: "maxWorkerConcurrency=1 (sequential; optimal on a single GPU)" };
  if (config.workerBackendBatches !== true) return { ok: false, reason: "backend not marked as batching (set workerBackendBatches:true for vLLM/TGI); a single GPU serializes concurrent calls anyway" };
  if (!isGitRepo(cwd)) return { ok: false, reason: "parallel attempts need a git repo for isolated worktrees" };
  return { ok: true, reason: `parallel resampling available (up to ${maxWorkerConcurrency(config)} at once)` };
}

/**
 * Generic bounded-concurrency runner: run `worker` over `items` with at most `limit` in flight,
 * preserving input order in the result array. A worker that throws yields `null` for that slot
 * (the call itself never rejects). This is the primitive the batching resampling path will use;
 * with limit=1 it is a plain sequential map.
 */
export async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<Array<R | null>> {
  const width = Math.max(1, Math.trunc(limit) || 1);
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  async function lane(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => lane()));
  return results;
}
