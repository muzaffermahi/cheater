import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewDiffSidecar } from "../src/sidecar/jobs.js";
import { jobGate, recordSchedulerStats } from "../src/sidecar/calibration.js";
import { maxWorkerConcurrency, parallelResamplingAvailable, runPool } from "../src/commitlet/workerPool.js";
import type { SidecarClient, SidecarCompletion } from "../src/sidecar/types.js";

function fakeClient(available: boolean, complete: () => Promise<SidecarCompletion>): SidecarClient {
  return { available: () => available, complete };
}
const okClient = (text: string) => fakeClient(true, async () => ({ ok: true, text, elapsedMs: 1 }));

// --- big feature: the background reviewer ("second pair of eyes") ----------------------------

test("reviewDiffSidecar flags concerns, stays empty when clean, and needs a live sidecar", async () => {
  const diff = "+if (user.isAdmin = true) { grantAccess(); }\n";
  const flagged = await reviewDiffSidecar(okClient('{"concerns":["assignment = instead of == in the isAdmin check"]}'), diff, "add admin gate");
  assert.equal(flagged.source, "sidecar");
  assert.deepEqual(flagged.value.concerns, ["assignment = instead of == in the isAdmin check"]);

  const clean = await reviewDiffSidecar(okClient('{"concerns":[]}'), diff, "goal");
  assert.equal(clean.source, "deterministic");
  assert.deepEqual(clean.value.concerns, []);

  const off = await reviewDiffSidecar(fakeClient(false, async () => ({ ok: false, error: "x", elapsedMs: 0 })), diff, "goal");
  assert.deepEqual(off.value.concerns, [], "no reviewer without a live sidecar");
});

// --- Phase D: calibration gates low-value prefetch types --------------------------------------

test("calibration gates a prefetch type off after enough low-hit-rate samples, keeps others on", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-calib-"));
  // A type that almost never lands its prefetch (1 hit / 9 fallbacks = 10%).
  recordSchedulerStats(cwd, "qwen-3b", { compress_capsule: { hits: 1, fallbacks: 9 } });
  // A type that lands well (5 hits / 3 fallbacks).
  recordSchedulerStats(cwd, "qwen-3b", { distill_failure: { hits: 5, fallbacks: 3 } });
  const gate = jobGate(cwd, "qwen-3b");
  assert.equal(gate("compress_capsule"), false, "low-hit-rate prefetch is gated off");
  assert.equal(gate("distill_failure"), true, "a productive prefetch stays on");
  assert.equal(gate("never_seen"), true, "unknown types pass optimistically");
  // Under-sampled types pass regardless of rate.
  const cwd2 = mkdtempSync(join(tmpdir(), "cheater-calib2-"));
  recordSchedulerStats(cwd2, "qwen-3b", { compress_capsule: { hits: 0, fallbacks: 3 } });
  assert.equal(jobGate(cwd2, "qwen-3b")("compress_capsule"), true, "too few samples -> stay on");
});

// --- Phase C: WorkerPool seam ---------------------------------------------------------------

test("maxWorkerConcurrency defaults to 1 and parallel resampling is gated honestly", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-pool-"));
  assert.equal(maxWorkerConcurrency({}), 1);
  assert.equal(maxWorkerConcurrency({ maxWorkerConcurrency: 4 }), 4);
  assert.equal(maxWorkerConcurrency({ maxWorkerConcurrency: 0 }), 1, "clamps to >= 1");

  assert.equal(parallelResamplingAvailable({}, cwd).ok, false, "concurrency 1 -> sequential");
  assert.equal(parallelResamplingAvailable({ maxWorkerConcurrency: 2 }, cwd).ok, false, "no batching opt-in -> sequential");
  const noBatch = parallelResamplingAvailable({ maxWorkerConcurrency: 2 }, cwd);
  assert.match(noBatch.reason, /batching/);
  // Even with the batching opt-in, a non-git dir can't isolate worktrees.
  assert.equal(parallelResamplingAvailable({ maxWorkerConcurrency: 2, workerBackendBatches: true }, cwd).ok, false);
});

test("runPool preserves order, respects the concurrency limit, and nulls a throwing worker", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await runPool([1, 2, 3, 4, 5], 2, async (x) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (x === 3) throw new Error("boom");
    return x * 2;
  });
  assert.deepEqual(results, [2, 4, null, 8, 10]);
  assert.ok(maxInFlight <= 2, `at most 2 in flight, saw ${maxInFlight}`);
});
