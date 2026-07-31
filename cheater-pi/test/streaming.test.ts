import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { KittenLLM, type StreamDelta } from "../src/core/llm.js";

// A local fake SSE server that emits a scripted chunk sequence, so the streaming parser is tested
// deterministically over the REAL chatStream path (fetch + reader + SSE framing), no live model.
function sseServer(frames: string[]): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Write frames with a tiny gap so the client sees multiple reads (incremental).
      let i = 0;
      const tick = (): void => {
        if (i >= frames.length) { res.end(); return; }
        res.write(frames[i++]);
        setTimeout(tick, 2);
      };
      tick();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

const d = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const dcrlf = (o: unknown): string => `data: ${JSON.stringify(o)}\r\n\r\n`;

test("chatStream reconstructs content from deltas and calls onDelta incrementally", async () => {
  const s = await sseServer([
    d({ choices: [{ delta: { role: "assistant", content: "" } }] }),
    d({ choices: [{ delta: { content: "Hel" } }] }),
    d({ choices: [{ delta: { content: "lo," } }] }),
    d({ choices: [{ delta: { content: " world" } }] }),
    d({ choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
    "data: [DONE]\n\n",
  ]);
  const llm = new KittenLLM({ baseUrl: s.url, main: "x" });
  const deltas: StreamDelta[] = [];
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }] }, (x) => deltas.push(x));
  s.close();
  assert.equal(r.ok, true);
  assert.equal(r.content, "Hello, world");
  assert.equal(r.finishReason, "stop");
  assert.equal(r.usage.completion, 4);
  assert.ok(deltas.length >= 3, "onDelta fired per content chunk");
  assert.equal(deltas.map((x) => x.content ?? "").join(""), "Hello, world");
});

test("chatStream separates reasoning deltas from content", async () => {
  const s = await sseServer([
    d({ choices: [{ delta: { reasoning_content: "think " } }] }),
    d({ choices: [{ delta: { reasoning_content: "more" } }] }),
    d({ choices: [{ delta: { content: "ANSWER" } }] }),
    d({ choices: [{ finish_reason: "stop", delta: {} }] }),
    "data: [DONE]\n\n",
  ]);
  const llm = new KittenLLM({ baseUrl: s.url, main: "x" });
  let reasoning = "", content = "";
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }] }, (x) => { reasoning += x.reasoning ?? ""; content += x.content ?? ""; });
  s.close();
  assert.equal(r.reasoning, "think more");
  assert.equal(r.content, "ANSWER");
  assert.equal(reasoning, "think more");
  assert.equal(content, "ANSWER"); // reasoning never leaks into content
});

test("chatStream reconstructs a tool call from fragmented arguments (never partial)", async () => {
  const s = await sseServer([
    d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "edit", arguments: "" } }] } }] }),
    d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] } }] }),
    d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.py","x":1}' } }] } }] }),
    d({ choices: [{ finish_reason: "tool_calls", delta: {} }] }),
    "data: [DONE]\n\n",
  ]);
  const llm = new KittenLLM({ baseUrl: s.url, main: "x" });
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {});
  s.close();
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "edit");
  assert.deepEqual(r.toolCalls[0].args, { path: "a.py", x: 1 }); // exact, fully assembled
});

test("chatStream handles CRLF-framed SSE (does not drop the whole stream)", async () => {
  // Regression: some gateways reframe SSE with CRLF. Splitting only on `\n\n` never matched `\r\n\r\n`,
  // so the entire response buffered and was returned as a silent empty ok:true.
  const s = await sseServer([
    dcrlf({ choices: [{ delta: { content: "Hel" } }] }),
    dcrlf({ choices: [{ delta: { content: "lo" } }] }),
    dcrlf({ choices: [{ finish_reason: "stop", delta: {} }] }),
    "data: [DONE]\r\n\r\n",
  ]);
  const llm = new KittenLLM({ baseUrl: s.url, main: "x" });
  const deltas: StreamDelta[] = [];
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }] }, (x) => deltas.push(x));
  s.close();
  assert.equal(r.ok, true);
  assert.equal(r.content, "Hello");
  assert.equal(deltas.map((x) => x.content ?? "").join(""), "Hello");
});

test("chatStream flushes a final frame that arrives without a trailing blank line", async () => {
  // The last content frame ends with a single `\n` and the server closes — it must still be folded in.
  const s = await sseServer([
    d({ choices: [{ delta: { content: "A" } }] }),
    d({ choices: [{ delta: { content: "B" } }] }),
    `data: ${JSON.stringify({ choices: [{ delta: { content: "C" }, finish_reason: "stop" }] })}\n`,
  ]);
  const llm = new KittenLLM({ baseUrl: s.url, main: "x" });
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {});
  s.close();
  assert.equal(r.content, "ABC"); // "C" would be dropped without the end-of-stream flush
});

test("chatStream skips a malformed chunk without failing", async () => {
  const s = await sseServer([
    d({ choices: [{ delta: { content: "A" } }] }),
    "data: {not json}\n\n",
    d({ choices: [{ delta: { content: "B" } }] }),
    "data: [DONE]\n\n",
  ]);
  const llm = new KittenLLM({ baseUrl: s.url, main: "x" });
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {});
  s.close();
  assert.equal(r.content, "AB");
});

test("chatStream returns ok:false on a server error, not a throw", async () => {
  const server = createServer((_req, res) => { res.writeHead(500); res.end("boom"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${port}/v1`, main: "x" });
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {});
  server.close();
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /HTTP 500/);
});

test("chat() still enforces its timeout when the caller also passes a signal", async () => {
  // Regression: the timeout timer aborted an internal controller, but fetch listened to the caller's
  // signal — so a caller-supplied signal (the normal agent/stream path) silently disabled the timeout.
  // A server that accepts the request and NEVER responds: the only bound is the client timeout.
  const server = createServer(() => { /* hang: never write, never end */ });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${port}/v1`, main: "x" });
  const caller = new AbortController(); // provided but never aborted
  const started = Date.now();
  const r = await llm.chat({ messages: [{ role: "user", content: "hi" }], signal: caller.signal, timeoutMs: 150 });
  const elapsed = Date.now() - started;
  server.close();
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  assert.equal(r.ok, false);
  assert.equal(r.error, "timeout"); // NOT "cancelled" (caller never aborted), NOT a 10-minute hang
  assert.ok(elapsed < 3000, `timed out promptly (was ${elapsed}ms)`);
});

test("chatStream() still enforces its timeout when the caller also passes a signal", async () => {
  // Server sends SSE headers, then hangs without any frame — reader.read() would block forever.
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  const llm = new KittenLLM({ baseUrl: `http://127.0.0.1:${port}/v1`, main: "x" });
  const caller = new AbortController(); // provided but never aborted
  const started = Date.now();
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }], signal: caller.signal, timeoutMs: 150 }, () => {});
  const elapsed = Date.now() - started;
  server.close();
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  assert.equal(r.ok, false);
  assert.equal(r.error, "timeout");
  assert.ok(elapsed < 3000, `timed out promptly (was ${elapsed}ms)`);
});

test("chatStream aborts as 'cancelled', not a generic network error", async () => {
  // A server that streams slowly so we can abort mid-stream.
  const s = await sseServer([
    d({ choices: [{ delta: { content: "slow" } }] }),
    d({ choices: [{ delta: { content: " ..." } }] }),
    d({ choices: [{ delta: { content: " more" } }] }),
    d({ choices: [{ finish_reason: "stop", delta: {} }] }),
    "data: [DONE]\n\n",
  ]);
  const llm = new KittenLLM({ baseUrl: s.url, main: "x" });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 4);
  const r = await llm.chatStream({ messages: [{ role: "user", content: "hi" }], signal: ctrl.signal }, () => {});
  s.close();
  assert.equal(r.ok, false);
  assert.equal(r.error, "cancelled");
});

test("sidecar calls use a separate configured endpoint when available", async () => {
  let mainCalls = 0;
  let sidecarCalls = 0;
  const response = JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const main = createServer((_req, res) => { mainCalls += 1; res.writeHead(200, { "content-type": "application/json" }); res.end(response); });
  const sidecar = createServer((_req, res) => { sidecarCalls += 1; res.writeHead(200, { "content-type": "application/json" }); res.end(response); });
  await Promise.all([
    new Promise<void>((resolve) => main.listen(0, "127.0.0.1", () => resolve())),
    new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", () => resolve())),
  ]);
  const mainAddress = main.address();
  const sidecarAddress = sidecar.address();
  if (!mainAddress || typeof mainAddress === "string" || !sidecarAddress || typeof sidecarAddress === "string") throw new Error("endpoint fixtures did not bind");
  const llm = new KittenLLM({
    baseUrl: `http://127.0.0.1:${mainAddress.port}/v1`,
    sidecarBaseUrl: `http://127.0.0.1:${sidecarAddress.port}/v1`,
    main: "main-model",
    sidecar: "sidecar-model",
  });
  const result = await llm.sidecar({ messages: [{ role: "user", content: "classify" }] });
  main.close();
  sidecar.close();
  assert.equal(result.ok, true);
  assert.equal(sidecarCalls, 1);
  assert.equal(mainCalls, 0);
});
