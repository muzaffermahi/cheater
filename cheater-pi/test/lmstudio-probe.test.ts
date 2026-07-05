import test from "node:test";
import assert from "node:assert/strict";
import { probeLmStudioStateful, benchmarkPrefixReuse, lmStudioRoot, type ProviderStateCapability } from "../src/providers/lmStudioStateful.js";

/** A scripted fetch that records request bodies, so the probe is tested without a real server. */
function mockFetch(script: Array<{ ok?: boolean; status?: number; body?: any; throw?: boolean }>) {
  const calls: Array<{ url: string; body: any }> = [];
  let i = 0;
  const impl = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.throw) throw new Error("ECONNREFUSED");
    return { ok: step.ok ?? true, status: step.status ?? 200, json: async () => step.body ?? {} };
  };
  return { impl, calls };
}

test("lmStudioRoot strips a trailing /v1 to reach the native /api path", () => {
  assert.equal(lmStudioRoot("http://localhost:1234/v1"), "http://localhost:1234");
  assert.equal(lmStudioRoot("http://localhost:1234/"), "http://localhost:1234");
  assert.equal(lmStudioRoot("http://localhost:1234"), "http://localhost:1234");
});

test("LM Studio probe detects native stateful chat, uses previous_response_id, and records stats", async () => {
  const { impl, calls } = mockFetch([
    { body: { response_id: "r1", stats: { input_tokens: 42, time_to_first_token_seconds: 0.5, tokens_per_second: 20, model_load_time_seconds: 3 } } },
    { body: { response_id: "r2" } }
  ]);
  const cap = await probeLmStudioStateful({ baseUrl: "http://localhost:1234/v1", model: "qwen", fetchImpl: impl });

  assert.equal(cap.statefulChatAvailable, true);
  assert.equal(cap.responseIdSupported, true);
  assert.equal(cap.statsAvailable, true);
  assert.equal(cap.ttftSeconds, 0.5);
  assert.equal(cap.inputTokens, 42);
  assert.equal(cap.tokensPerSecond, 20);
  assert.equal(cap.chatCompletionsStateful, false, "the OpenAI-compat path is treated stateless");
  assert.match(calls[0].url, /\/api\/v1\/chat$/, "probes the native endpoint derived from the /v1 base");
  assert.equal(typeof calls[0].body.input, "string", "native /api/v1/chat takes `input`, not `messages` (else HTTP 400)");
  assert.equal(calls[0].body.messages, undefined, "must not send the OpenAI `messages` shape to /api/v1/chat");
  assert.equal(calls[0].body.store, true, "first call requests a stored (stateful) response");
  assert.equal(calls[1].body.previous_response_id, "r1", "the follow-up passes previous_response_id (no history resend)");
});

test("LM Studio /v1/chat/completions stays stateless; an unreachable or erroring native API falls back safely", async () => {
  const unreachable = mockFetch([{ throw: true }]);
  const capA = await probeLmStudioStateful({ baseUrl: "http://localhost:9/v1", fetchImpl: unreachable.impl });
  assert.equal(capA.statefulChatAvailable, false);
  assert.equal(capA.chatCompletionsStateful, false, "never claim stateless-path is stateful");
  assert.match(capA.notes.join(" "), /unreachable|stateless/i);

  const http404 = mockFetch([{ ok: false, status: 404 }]);
  const capB = await probeLmStudioStateful({ baseUrl: "http://localhost:1234", fetchImpl: http404.impl });
  assert.equal(capB.statefulChatAvailable, false, "a 404 on the native path is not stateful");
  assert.match(capB.notes.join(" "), /not available/i);
});

test("prefix-reuse benchmark records a measured benefit without claiming KV-cache", async () => {
  const { impl } = mockFetch([
    { body: { stats: { time_to_first_token_seconds: 1.0 } } },
    { body: { stats: { time_to_first_token_seconds: 0.4 } } }
  ]);
  const base: ProviderStateCapability = { provider: "lmstudio", statefulChatAvailable: true, statsAvailable: true, chatCompletionsStateful: false, measuredPrefixReuseBenefit: "unknown", notes: [] };
  const cap = await benchmarkPrefixReuse(base, { baseUrl: "http://localhost:1234", fetchImpl: impl });
  assert.equal(cap.measuredPrefixReuseBenefit, "large", "2nd TTFT half of the 1st -> measured 'large' benefit");
  assert.match(cap.notes.join(" "), /not proof of KV-cache/i, "reports an observation, never a KV-cache claim");

  // No stats -> honest 'unknown', never a fabricated number.
  const noStats = mockFetch([{ body: {} }, { body: {} }]);
  const cap2 = await benchmarkPrefixReuse({ ...base, notes: [] }, { baseUrl: "http://localhost:1234", fetchImpl: noStats.impl });
  assert.equal(cap2.measuredPrefixReuseBenefit, "unknown");
});
