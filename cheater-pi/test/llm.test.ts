import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { KittenLLM } from "../src/core/llm.js";

test("shared local endpoint serializes main and sidecar requests without blocking cancellation", async () => {
  let active = 0;
  let peak = 0;
  const server = createServer((_req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active -= 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }, 30);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const llm = new KittenLLM({ baseUrl: endpoint, main: "main-35b", sidecar: "sidecar-2b" });
  // Separate clients model project-local runtime resolution; the process-wide gate must still hold.
  const separateClient = new KittenLLM({ baseUrl: endpoint, main: "main-35b", sidecar: "sidecar-2b" });
  const first = separateClient.chat({ model: "main-35b", messages: [{ role: "user", content: "first" }], timeoutMs: 1000 });
  const cancelled = new AbortController();
  const second = llm.sidecar({ model: "sidecar-2b", messages: [{ role: "user", content: "second" }], timeoutMs: 1000, signal: cancelled.signal });
  cancelled.abort();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.error, "cancelled");
  assert.equal(peak, 1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("chat retries transient local-runtime loading responses within the request budget", async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("model is loading");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ready" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${address.port}/v1`, main: "main-35b" });
  const result = await llm.chat({ messages: [{ role: "user", content: "hello" }], timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.content, "ready");
  assert.equal(calls, 2);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("chat survives a runtime that 500s on its own tool-call parse", async () => {
  // Verbatim from the bakeoff: llama.cpp answered 500 because *its* parser broke on the arguments
  // string the model produced for a large file write. Before this was retryable, one such response
  // ended the run and discarded 513 s of work — the "model randomly stops" report.
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 500, message: "Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 12863: syntax error while parsing value - invalid string: missing closing quote" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "recovered" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${address.port}/v1`, main: "main-35b" });
  const result = await llm.chat({ messages: [{ role: "user", content: "write a big file" }], timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.content, "recovered");
  assert.equal(calls, 2);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("a runtime that 500s every time still fails, bounded, with the server's reason intact", async () => {
  // The other half of the contract: retrying must not turn a genuinely broken endpoint into a hang,
  // and the operator still needs to read what the server actually said.
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("model failed to load");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${address.port}/v1`, main: "main-35b" });
  const result = await llm.chat({ messages: [{ role: "user", content: "hello" }], timeoutMs: 4000 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /HTTP 500/);
  assert.match(result.error ?? "", /model failed to load/);
  assert.equal(calls, 3, "bounded at the existing three-attempt budget, not retried forever");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("chat rescues a server that rejects optional structured-output constraints", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls += 1;
    const body = JSON.parse(await new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => { text += chunk; });
      req.on("end", () => resolve(text));
    }));
    if (body.response_format) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${address.port}/v1`, main: "main-35b" });
  const result = await llm.chat({
    messages: [{ role: "user", content: "return JSON" }],
    jsonSchema: { name: "answer", schema: { type: "object", additionalProperties: false } },
    timeoutMs: 2000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.formatRescues, 1);
  assert.equal(calls, 2);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

// `reasoning_effort` is not a reliable control: on llama.cpp only "none" dependably disables thinking,
// so a harness that sends "low" and believes it has cut the reasoning tax may have changed nothing.
// `reasoning_budget` is the mechanism that actually bites, and it must travel with the hint.
test("a reasoning budget reaches the endpoint as a real bound, not just an effort hint", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      try { bodies.push(JSON.parse(raw)); } catch { bodies.push({}); }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${port}/v1`, main: "main-35b" });
  try {
    await llm.chat({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "low" });
    assert.equal(bodies[0].reasoning_effort, "low");
    assert.equal(bodies[0].reasoning_budget, undefined, "an effort hint alone must not imply a bound");

    await llm.chat({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "low", reasoningBudget: 256 });
    assert.equal(bodies[1].reasoning_budget, 256);
    assert.equal(bodies[1].reasoning_effort, "low");

    // Zero is the one value dependable across endpoints, so it is stated both ways.
    await llm.chat({ messages: [{ role: "user", content: "hi" }], reasoningBudget: 0 });
    assert.equal(bodies[2].reasoning_budget, 0);
    assert.equal(bodies[2].reasoning_effort, "none");

    // A negative budget is a caller bug, not an instruction to disable reasoning.
    await llm.chat({ messages: [{ role: "user", content: "hi" }], reasoningBudget: -5 });
    assert.equal(bodies[3].reasoning_budget, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
