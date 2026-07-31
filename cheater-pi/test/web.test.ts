import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer, type WebServer } from "../src/core/web/server.js";
import { KittenApp, type Runner } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";

const basicRunner: Runner = async (ctx) => {
  ctx.emit({ type: "assistant.final", runId: ctx.runId, text: "did the thing" });
  ctx.emit({ type: "file.changed", runId: ctx.runId, path: "x.py", added: 1, removed: 0 });
  return { finished: true, summary: "done", wallMs: 2, usage: { prompt: 1, completion: 1, reasoning: 0 }, receiptLines: ["reliable"], filesChanged: ["x.py"], verified: true };
};

async function serve(runner: Runner = basicRunner, policy: "ask" | "auto-allow" | "auto-deny" = "auto-allow"): Promise<{ srv: WebServer; app: KittenApp; base: string }> {
  const store = new ConversationStore(openSqlite(":memory:"));
  const app = new KittenApp({ store, runner, projectRoot: process.cwd(), approvalPolicy: policy });
  const srv = await startWebServer({ app, store, cwd: process.cwd(), port: 0 });
  return { srv, app, base: srv.url.replace(/\/$/, "") };
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "x-kitten-token": token, "content-type": "application/json", ...extra };
}

/** Read an SSE stream until `pred` sees a matching event or a timeout. Returns the collected events. */
async function readStreamUntil(url: string, pred: (e: Record<string, unknown>) => boolean, ms = 6000): Promise<Record<string, unknown>[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const events: Record<string, unknown>[] = [];
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const f of frames) {
        const line = f.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try { const e = JSON.parse(line.slice(6)); events.push(e); if (pred(e)) { clearTimeout(timer); ctrl.abort(); return events; } } catch { /* heartbeat/comment */ }
      }
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  return events;
}

test("web: /api requires the token", async () => {
  const { srv, base } = await serve();
  const res = await fetch(`${base}/api/conversations`);
  assert.equal(res.status, 401);
  const ok = await fetch(`${base}/api/conversations`, { headers: auth(srv.token) });
  assert.equal(ok.status, 200);
  await srv.close();
});

test("web: a non-object JSON body (null) does not crash the handler into a 500", async () => {
  // Regression: JSON.parse("null") returned null from readJson, which handlers destructured → 500.
  const { srv, base } = await serve();
  const res = await fetch(`${base}/api/conversations`, { method: "POST", headers: auth(srv.token), body: "null" });
  assert.notEqual(res.status, 500, "a null body must be treated as empty, not throw");
  await srv.close();
});

test("web: bad Origin is rejected", async () => {
  const { srv, base } = await serve();
  const res = await fetch(`${base}/api/conversations`, { headers: auth(srv.token, { origin: "http://evil.example" }) });
  assert.equal(res.status, 403);
  await srv.close();
});

test("web: serves the app page at /", async () => {
  const { srv, base } = await serve();
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  assert.ok(!html.includes(srv.token) === false, "page embeds the launch token for its own fetches");
  await srv.close();
});

test("web: create → message → SSE streams the run to completion", async () => {
  const { srv, base } = await serve();
  const created = await (await fetch(`${base}/api/conversations`, { method: "POST", headers: auth(srv.token), body: "{}" })).json() as { conversation: { id: string } };
  const id = created.conversation.id;

  const streamP = readStreamUntil(`${base}/api/stream?conversation=${id}&after=0&token=${srv.token}`, (e) => e.type === "run.completed");
  // Give the stream a moment to attach, then submit.
  await new Promise((r) => setTimeout(r, 100));
  const posted = await fetch(`${base}/api/message`, { method: "POST", headers: auth(srv.token), body: JSON.stringify({ conversationId: id, text: "do it" }) });
  assert.equal(posted.status, 202);

  const events = await streamP;
  const types = events.map((e) => e.type);
  assert.ok(types.includes("user.message"));
  assert.ok(types.includes("run.started"));
  assert.ok(types.includes("run.completed"));
  await srv.close();
});

test("web: SSE replays stored history after reconnect (after=seq)", async () => {
  const { srv, app, base } = await serve();
  const conv = app.createConversation({ projectRoot: process.cwd() });
  await app.submitMessage(conv.id, "first task");
  // A fresh stream from seq 0 must replay the whole conversation.
  const events = await readStreamUntil(`${base}/api/stream?conversation=${conv.id}&after=0&token=${srv.token}`, (e) => e.type === "run.completed");
  assert.ok(events.some((e) => e.type === "conversation.created"));
  assert.ok(events.some((e) => e.type === "run.completed"));
  await srv.close();
});

test("web: approval round-trip (ask → approve → run finishes)", async () => {
  const approvalRunner: Runner = async (ctx) => {
    const allowed = await ctx.requestApproval("c0", "bash", "destructive", "high");
    return { finished: allowed, summary: allowed ? "approved" : "denied", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false };
  };
  const { srv, app, base } = await serve(approvalRunner, "ask");
  const conv = app.createConversation({ projectRoot: process.cwd() });

  // Approve as soon as the request appears on the stream.
  const streamP = readStreamUntil(`${base}/api/stream?conversation=${conv.id}&after=0&token=${srv.token}`, (e) => e.type === "run.completed");
  await new Promise((r) => setTimeout(r, 100));
  // Approve via a subscriber (server-side) is not available here; drive it via the API once we see it.
  const approver = (async () => {
    const seen = await readStreamUntil(`${base}/api/stream?conversation=${conv.id}&after=0&token=${srv.token}`, (e) => e.type === "tool.approval_required");
    const req = seen.find((e) => e.type === "tool.approval_required") as { runId: string; callId: string } | undefined;
    if (req) await fetch(`${base}/api/approve`, { method: "POST", headers: auth(srv.token), body: JSON.stringify({ runId: req.runId, callId: req.callId, allowed: true }) });
  })();
  await fetch(`${base}/api/message`, { method: "POST", headers: auth(srv.token), body: JSON.stringify({ conversationId: conv.id, text: "rm the build" }) });
  await approver;
  const events = await streamP;
  const completed = events.find((e) => e.type === "run.completed") as { finished: boolean } | undefined;
  assert.ok(completed?.finished, "approved run should finish");
  await srv.close();
});
