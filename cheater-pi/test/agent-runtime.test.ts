import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, CacheScoutAdapter, CacheScoutPolicy, CircuitBreaker, PriorityAdmissionScheduler, ToolResultMemoCache, disaggregatedEnabled, isReadOnlySpeculation, type AgentIdentity } from "../src/core/agentRuntime.js";

const a: AgentIdentity = { role: "executor", model: "m", promptEpoch: "p", toolSchemaHash: "t" };
const b: AgentIdentity = { ...a, role: "verifier" };
const c: AgentIdentity = { ...a, role: "repair" };
const d: AgentIdentity = { ...a, role: "planner" };

test("CacheScout gates prediction until transition evidence is strong", () => {
  const policy = new CacheScoutPolicy();
  for (let i = 0; i < 100; i++) policy.observe({ kind: "transition", previousAgent: a, agent: b });
  for (let i = 0; i < 10; i++) policy.observe({ kind: "transition", previousAgent: a, agent: c });
  for (let i = 0; i < 50; i++) policy.observe({ kind: "transition", previousAgent: d, agent: b });
  for (let i = 0; i < 50; i++) policy.observe({ kind: "transition", previousAgent: d, agent: c });
  policy.observe({ kind: "transition", previousAgent: d, agent: a });
  const prediction = policy.predict("next-agent", 1);
  assert.equal(prediction.enabled, true); assert.equal(prediction.agent, `${b.role}|${b.model}|${b.promptEpoch}|${b.toolSchemaHash}`);
});

test("memo cache is revision scoped and scheduler protects foreground work", () => {
  const cache = new ToolResultMemoCache<string>(); cache.set("read:x", "ok", "r1");
  assert.equal(cache.get("read:x", "r1"), "ok"); assert.equal(cache.get("read:x", "r2"), undefined);
  const scheduler = new PriorityAdmissionScheduler<string>(1);
  scheduler.enqueue("spec", "speculative", "prefetch", 0); scheduler.enqueue("user", "foreground", "edit", 0);
  assert.equal(scheduler.drain(0)[0]?.id, "user"); assert.equal(scheduler.pending, 1);
});

test("policy flags and cache adapter preserve the safe fallback", async () => {
  const runtime = new AgentRuntime(); const policy = new CacheScoutPolicy(); runtime.register(policy); runtime.setEnabled(policy.name, false);
  runtime.observe({ kind: "transition", previousAgent: a, agent: b });
  assert.deepEqual(policy.snapshot(), {});
  let warmed = false;
  const adapter = new CacheScoutAdapter(policy, { cachePrompt: true, slotSaveRestore: true }, async () => { warmed = true; });
  assert.equal(await adapter.maybePrefetch(new AbortController().signal, false), false); assert.equal(warmed, false);
});

test("speculation, P/D, and failure hedging stay conservative", () => {
  assert.equal(isReadOnlySpeculation({ kind: "read", cancellable: true }), true);
  assert.equal(isReadOnlySpeculation({ kind: "bash", cancellable: true, data: { mutates: true } }), false);
  assert.equal(disaggregatedEnabled("", "http://decode"), false); assert.equal(disaggregatedEnabled("http://prefill", "http://decode"), true);
  const breaker = new CircuitBreaker(2, 60_000); breaker.failure(); breaker.failure(); assert.equal(breaker.state, "open"); assert.equal(breaker.allow(Date.now() + 500), false); assert.equal(breaker.allow(Date.now() + 61_000), true);
});
