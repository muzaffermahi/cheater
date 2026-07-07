import test from "node:test";
import assert from "node:assert/strict";
import { localControlClient, resampleTemperature, localControlBaseUrl } from "../src/providers/localControl.js";

// A recording fetch mock: captures request bodies and replays queued responses.
type Resp = { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; body?: AsyncIterable<Uint8Array> | null };
function mockFetch(responses: Resp[]) {
  const bodies: any[] = [];
  let i = 0;
  const fetchImpl = async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { fetchImpl, bodies };
}
const ok200 = (content: string): Resp => ({ ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { content }, logprobs: { tokens: [] } }] }) });
const err400 = (msg: string): Resp => ({ ok: false, status: 400, text: async () => msg, json: async () => ({}) });
async function* sse(chunks: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for (const c of chunks) yield enc.encode(c);
}
const stream = (chunks: string[]): Resp => ({ ok: true, status: 200, text: async () => "", json: async () => ({}), body: sse(chunks) });

// --- config + schedule -----------------------------------------------------------------------

test("resampleTemperature schedule warms up after attempt 1", () => {
  assert.equal(resampleTemperature(1), undefined, "attempt 1 keeps the session default");
  assert.equal(resampleTemperature(2), 0.4);
  assert.equal(resampleTemperature(3), 0.8);
  assert.equal(resampleTemperature(4), 1.0);
  assert.equal(resampleTemperature(9), 1.0, "clamped");
});

test("localControlClient is null without a base URL", () => {
  assert.equal(localControlClient({ baseUrl: undefined }), null);
  assert.equal(localControlBaseUrl({}), undefined);
});

// --- request construction --------------------------------------------------------------------

test("complete includes temperature / json_schema / logprobs only when requested", async () => {
  const { fetchImpl, bodies } = mockFetch([ok200("hi")]);
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl })!;
  await client.complete({ prompt: "go", temperature: 0.5, jsonSchema: { name: "s", schema: { type: "object" } }, logprobs: true });
  assert.equal(bodies[0].temperature, 0.5);
  assert.equal(bodies[0].response_format?.type, "json_schema");
  assert.equal(bodies[0].logprobs, true);
  assert.equal(bodies[0].messages[0].content, "go");
});

// --- probe-record-never-assume: 400 downgrades a feature, retries once -----------------------

test("a 400 naming temperature marks it unsupported and retries without it", async () => {
  const { fetchImpl, bodies } = mockFetch([err400("temperature is not supported by this model"), ok200("done")]);
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl })!;
  const res = await client.complete({ prompt: "go", temperature: 0.7 });
  assert.equal(res.ok, true);
  assert.equal(res.text, "done");
  assert.equal(bodies[0].temperature, 0.7, "first attempt sent temperature");
  assert.equal(bodies[1].temperature, undefined, "retry dropped temperature");
  assert.equal(client.capability().temperature, "unsupported", "latch recorded");
});

test("schema-constrained happy path records json_schema supported", async () => {
  const { fetchImpl } = mockFetch([ok200('{"answer": 1}')]);
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl })!;
  const res = await client.complete({ prompt: "go", jsonSchema: { name: "s", schema: { type: "object" } } });
  assert.equal(res.ok, true);
  assert.equal(res.usedFeatures.jsonSchema, true);
  assert.equal(client.capability().jsonSchema, "supported");
});

test("schema-constrained gracefully falls back to unconstrained when unsupported", async () => {
  const { fetchImpl, bodies } = mockFetch([err400("response_format json_schema not supported"), ok200("plain text answer")]);
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl })!;
  const res = await client.complete({ prompt: "go", jsonSchema: { name: "s", schema: {} } });
  assert.equal(res.ok, true);
  assert.equal(res.text, "plain text answer");
  assert.equal(bodies[1].response_format, undefined, "retry dropped the schema");
  assert.equal(client.capability().jsonSchema, "unsupported");
});

test("a subsequent call omits a known-unsupported feature up front (no wasted 400)", async () => {
  const { fetchImpl, bodies } = mockFetch([err400("temperature unsupported"), ok200("a"), ok200("b")]);
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl })!;
  await client.complete({ prompt: "1", temperature: 0.5 }); // learns temperature is unsupported
  await client.complete({ prompt: "2", temperature: 0.9 }); // should NOT send temperature now
  assert.equal(bodies[2].temperature, undefined, "cached latch skips the unsupported feature");
});

// --- stream-gating ---------------------------------------------------------------------------

test("completeStreamGated aborts early when a guard trips on a planted phantom path", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"cat /app/"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"PHANTOM/x"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" more text"}}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const { fetchImpl } = mockFetch([stream(chunks)]);
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl })!;
  const result = await client.completeStreamGated({ prompt: "go" }, (acc) => (acc.includes("PHANTOM") ? "phantom path in output" : null));
  assert.equal(result.aborted, true);
  assert.match(result.reason ?? "", /phantom/);
});

test("completeStreamGated runs to completion when no guard trips", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"all "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"good"}}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const { fetchImpl } = mockFetch([stream(chunks)]);
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl })!;
  const result = await client.completeStreamGated({ prompt: "go" }, () => null);
  assert.equal(result.ok, true);
  assert.equal(result.aborted, undefined);
  assert.equal(result.text, "all good");
});

test("a network error is reported, not thrown", async () => {
  const client = localControlClient({ baseUrl: "http://localhost:1234/v1", model: "m", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })!;
  const res = await client.complete({ prompt: "go" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /network|ECONNREFUSED/);
});
