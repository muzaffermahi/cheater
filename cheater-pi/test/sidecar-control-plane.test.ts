import test from "node:test";
import assert from "node:assert/strict";
import { SidecarControlPlane } from "../src/core/sidecarControlPlane.js";

test("sidecar control plane prioritizes user-blocking work", async () => {
  const order: string[] = [];
  const scheduler = new SidecarControlPlane(1);
  const hold = scheduler.enqueue({ id: "hold", type: "hold", tier: "clerk", priority: "context", premise: "a", run: async () => { await new Promise((r) => setTimeout(r, 5)); order.push("hold"); return 1; }, fallback: () => 0 });
  const low = scheduler.enqueue({ id: "low", type: "low", tier: "clerk", priority: "speculative", premise: "a", run: async () => { order.push("low"); return 1; }, fallback: () => 0 });
  const high = scheduler.enqueue({ id: "high", type: "high", tier: "clerk", priority: "user-blocking", premise: "a", run: async () => { order.push("high"); return 1; }, fallback: () => 0 });
  await Promise.all([hold, low, high]);
  assert.deepEqual(order, ["hold", "high", "low"]);
});

test("sidecar falls back deterministically after a failed job", async () => {
  const scheduler = new SidecarControlPlane();
  const result = await scheduler.enqueue({ id: "broken", type: "classify", tier: "clerk", priority: "context", premise: "v1", run: async () => { throw new Error("offline"); }, fallback: () => "general" });
  assert.equal(result.ok, false);
  assert.equal(result.source, "deterministic");
  assert.equal(result.value, "general");
  assert.equal(scheduler.snapshot().fallback, 1);
});

test("sidecar cancellation rejects the active job instead of fabricating a fallback", async () => {
  const scheduler = new SidecarControlPlane();
  const job = scheduler.enqueue({
    id: "cancel-me",
    type: "classify",
    tier: "clerk",
    priority: "user-blocking",
    premise: "v1",
    run: async (signal) => await new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    fallback: () => "should-not-be-used",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.cancel("cancel-me"), true);
  await assert.rejects(job, /cancelled/);
  assert.equal(scheduler.snapshot().fallback, 0);
  assert.equal(scheduler.snapshot().cancelled, 1);
});

test("sidecar cancellation removes queued jobs", async () => {
  const scheduler = new SidecarControlPlane(1);
  // Keep the first lease open long enough that cancellation is deterministic even on a busy CI host.
  const hold = scheduler.enqueue({ id: "hold-cancel", type: "hold", tier: "clerk", priority: "context", premise: "v1", run: async () => { await new Promise((r) => setTimeout(r, 100)); return 1; }, fallback: () => 0 });
  const queued = scheduler.enqueue({ id: "queued-cancel", type: "classify", tier: "clerk", priority: "context", premise: "v1", run: async () => 1, fallback: () => 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.cancel("queued-cancel"), true);
  await assert.rejects(queued, /cancelled/);
  await hold;
  assert.equal(scheduler.snapshot().queued, 0);
});

test("sidecar cancellation rejects a job that ignores the abort signal", async () => {
  const scheduler = new SidecarControlPlane();
  const job = scheduler.enqueue({
    id: "cancel-ignoring",
    type: "classify",
    tier: "clerk",
    priority: "user-blocking",
    premise: "v1",
    run: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return "stale-success"; },
    fallback: () => "should-not-be-used",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.cancel("cancel-ignoring"), true);
  await assert.rejects(job, /cancelled/);
  assert.equal(scheduler.snapshot().fallback, 0);
});

test("sidecar concurrency can fan out after a dedicated endpoint is selected", async () => {
  const scheduler = new SidecarControlPlane(1);
  let active = 0;
  let peak = 0;
  const job = (id: string) => scheduler.enqueue({
    id,
    type: "scout",
    tier: "scout",
    priority: "context",
    premise: "dedicated",
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return id;
    },
    fallback: () => "fallback",
  });
  const first = job("one");
  const second = job("two");
  const third = job("three");
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.setMaxConcurrent(3);
  await Promise.all([first, second, third]);
  assert.equal(peak, 3);
});
