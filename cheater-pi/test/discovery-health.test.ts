import test from "node:test";
import assert from "node:assert/strict";
import { KittenLLM } from "../src/core/llm.js";
import { estimateModelB, inspectModelHealth } from "../src/core/discovery.js";

test("model size parsing stays conservative for unknown ids", () => {
  assert.equal(estimateModelB("ornith-1.0-35b-Q5_K_M"), 35);
  assert.equal(estimateModelB("qwen3.5-2b"), 2);
  assert.equal(estimateModelB("mystery-coder"), undefined);
});

test("health scan identifies an unloaded main and proposes only a same-tier reachable model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "ornith-35b" }, { id: "qwen3.5-2b" }, { id: "qwen3.6-35b-a3b" }] }), { headers: { "content-type": "application/json" } });
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    if (body.model === "ornith-35b") return new Response("unloaded", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await inspectModelHealth(new KittenLLM({ baseUrl: "http://local/v1", main: "ornith-35b" }), "main", "ornith-35b", { timeoutMs: 500, maxCandidates: 5 });
    assert.equal(result.endpointReachable, true);
    assert.equal(result.rows.find((row) => row.id === "ornith-35b")?.reachable, false);
    assert.ok(result.recommendations.some((item) => item.model === "qwen3.6-35b-a3b"));
    assert.ok(!result.recommendations.some((item) => item.model === "qwen3.5-2b"));
  } finally { globalThis.fetch = originalFetch; }
});

test("sidecar health prefers a reachable 2B-9B candidate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "qwen3.5-2b" }, { id: "gemma-4-35b" }] }), { headers: { "content-type": "application/json" } });
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return body.model === "qwen3.5-2b"
      ? new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { headers: { "content-type": "application/json" } })
      : new Response("unloaded", { status: 503 });
  }) as typeof fetch;
  try {
    const result = await inspectModelHealth(new KittenLLM({ baseUrl: "http://local/v1", main: "gemma-4-35b" }), "sidecar", "gemma-4-35b", { timeoutMs: 500, maxCandidates: 5 });
    assert.deepEqual(result.recommendations[0]?.model, "qwen3.5-2b");
    assert.equal(result.rows.find((row) => row.id === "qwen3.5-2b")?.tierFit, "preferred");
    assert.equal(result.rows.find((row) => row.id === "gemma-4-35b")?.tierFit, "mismatch");
  } finally { globalThis.fetch = originalFetch; }
});

test("health scan labels a timed-out local model as slow/loading", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "ornith-35b" }] }), { headers: { "content-type": "application/json" } });
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { headers: { "content-type": "application/json" } })), 650);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
  }) as typeof fetch;
  try {
    const result = await inspectModelHealth(new KittenLLM({ baseUrl: "http://local/v1", main: "ornith-35b" }), "main", "ornith-35b", { timeoutMs: 500, maxCandidates: 1 });
    assert.equal(result.rows[0]?.state, "slow/loading");
    assert.equal(result.rows[0]?.reachable, false);
  } finally { globalThis.fetch = originalFetch; }
});
