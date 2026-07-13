// Kitten — the local web server. NO Pi.
//
// A dependency-free HTTP + SSE server (Node's built-in `http`) over the SAME application service and
// persistent store as the TUI (Goal §5). It is NOT a read-only trace viewer: you can start, continue,
// interrupt, approve, inspect, and resume real coding sessions from the browser.
//
// Security model (Goal §5):
//   • binds 127.0.0.1 only (never the LAN/internet) unless a future explicit flag says otherwise;
//   • every /api/* call requires a per-launch secret token (constant-time compared) — sent as the
//     `x-kitten-token` header for fetch(), or a `?token=` query for the EventSource stream (which can't
//     set headers). A cross-origin page cannot read our token, so it cannot drive the agent;
//   • Origin, when present, must be our own loopback origin;
//   • no API keys / env / secrets are ever placed in browser-delivered state; no telemetry.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { KittenApp } from "../app.js";
import type { ConversationStore } from "../store/conversationStore.js";
import { catCells, type MascotState } from "../mascot.js";
import { renderPage } from "./page.js";
import { VERSION } from "../../config.js";

export interface WebServerOptions {
  app: KittenApp;
  store: ConversationStore;
  cwd: string;
  host?: string;
  port?: number;
}

export interface WebServer {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
}

const MASCOT_STATES: MascotState[] = ["ready", "thinking", "working", "sampling", "verifying", "success", "blocked", "sleeping"];

interface SseClient { conversationId: string; res: ServerResponse; }

export function startWebServer(opts: WebServerOptions): Promise<WebServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4025;
  const token = randomBytes(24).toString("hex");
  const clients = new Set<SseClient>();

  // Precompute the mascot frames once (pure); the page embeds them so the browser paints the cat with
  // no round-trip and no external assets.
  const mascot: Record<string, string[][]> = {};
  for (const s of MASCOT_STATES) mascot[s] = catCells(s);
  const page = renderPage({ token, mascot, cwd: opts.cwd, version: VERSION });

  // Fan out every app event to the SSE clients watching that conversation.
  opts.app.subscribe((e) => {
    const frame = `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) if (c.conversationId === e.conversationId) { try { c.res.write(frame); } catch { /* dropped */ } }
  });

  let boundPort = port;
  const isAllowedOrigin = (origin: string): boolean =>
    [`http://${host}:${boundPort}`, `http://localhost:${boundPort}`, `http://127.0.0.1:${boundPort}`].includes(origin);

  const tokenOk = (given: string | undefined): boolean => {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname;

    // The page itself (no token needed — the token is embedded in it; a browser can't send a custom header
    // on a top-level navigation). Same-origin policy stops other sites from reading the token from it.
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
      return;
    }

    if (!path.startsWith("/api/")) { json(res, 404, { error: "not found" }); return; }

    // Origin check (defense in depth against cross-origin abuse): if an Origin header is present it must
    // be our own loopback origin.
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) { json(res, 403, { error: "bad origin" }); return; }

    // The SSE stream authenticates via query token (EventSource can't set headers); everything else via
    // the x-kitten-token header.
    if (path === "/api/stream") {
      if (!tokenOk(url.searchParams.get("token") ?? undefined)) { json(res, 401, { error: "unauthorized" }); return; }
      streamEvents(req, res, url);
      return;
    }
    if (!tokenOk(header(req, "x-kitten-token"))) { json(res, 401, { error: "unauthorized" }); return; }

    // ── API ──────────────────────────────────────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/api/conversations") {
      const search = url.searchParams.get("search") ?? undefined;
      json(res, 200, { conversations: opts.store.listConversations({ search, limit: 100 }) });
      return;
    }
    if (req.method === "POST" && path === "/api/conversations") {
      const body = await readJson(req);
      const conv = opts.app.createConversation({ title: typeof body.title === "string" ? body.title : undefined, projectRoot: opts.cwd });
      json(res, 200, { conversation: conv });
      return;
    }
    const convMatch = path.match(/^\/api\/conversations\/([\w-]+)$/);
    if (req.method === "GET" && convMatch) {
      const id = convMatch[1];
      const conversation = opts.store.getConversation(id);
      if (!conversation) { json(res, 404, { error: "unknown conversation" }); return; }
      json(res, 200, { conversation, events: opts.store.readEvents(id), runs: opts.store.listRuns(id) });
      return;
    }
    if (req.method === "POST" && path === "/api/message") {
      const body = await readJson(req);
      const { conversationId, text } = body;
      if (typeof conversationId !== "string" || typeof text !== "string" || !text.trim()) { json(res, 400, { error: "conversationId + text required" }); return; }
      // Fire-and-forget: the run streams over SSE. Never block the POST on the whole run.
      opts.app.submitMessage(conversationId, text).catch(() => { /* surfaced as run.failed on the stream */ });
      json(res, 202, { ok: true });
      return;
    }
    if (req.method === "POST" && path === "/api/cancel") {
      const { runId } = await readJson(req);
      json(res, 200, { ok: typeof runId === "string" ? opts.app.cancel(runId) : false });
      return;
    }
    if (req.method === "POST" && path === "/api/approve") {
      const { runId, callId, allowed } = await readJson(req);
      const ok = typeof runId === "string" && typeof callId === "string" ? opts.app.resolveApproval(runId, callId, !!allowed) : false;
      json(res, 200, { ok });
      return;
    }
    if (req.method === "POST" && path === "/api/undo") {
      const { conversationId } = await readJson(req);
      json(res, 200, { result: typeof conversationId === "string" ? opts.app.undoLast(conversationId) : { ok: false, reason: "conversationId required" } });
      return;
    }
    if (req.method === "POST" && path === "/api/rename") {
      const { conversationId, title } = await readJson(req);
      if (typeof conversationId === "string" && typeof title === "string") opts.app.rename(conversationId, title);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && path === "/api/archive") {
      const { conversationId, archived } = await readJson(req);
      if (typeof conversationId === "string") opts.app.archive(conversationId, !!archived);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && path === "/api/diff") {
      const id = url.searchParams.get("conversation");
      const conv = id ? opts.store.getConversation(id) : null;
      const root = conv?.projectRoot ?? opts.cwd;
      const r = spawnSync("git", ["diff"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      json(res, 200, { diff: r.status === 0 ? (r.stdout ?? "") : "" });
      return;
    }
    json(res, 404, { error: "not found" });
  }

  function streamEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const conversationId = url.searchParams.get("conversation") ?? "";
    const after = Number(url.searchParams.get("after") ?? "0") || 0;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // A 2KB padding comment forces buffering proxies (and some embedded browsers) to flush immediately,
    // so the client's EventSource `onopen` fires right away instead of waiting for the first data event.
    res.write(`:${" ".repeat(2048)}\n\n`);
    res.write(": connected\n\n");
    // Replay history after `after`, then go live. (A tiny race where an event lands between replay and
    // registration is avoided by registering FIRST, then replaying only strictly-greater seqs.)
    const client: SseClient = { conversationId, res };
    clients.add(client);
    for (const e of opts.store.readEvents(conversationId, after)) {
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    }
    const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25000);
    heartbeat.unref?.();
    req.on("close", () => { clearInterval(heartbeat); clients.delete(client); });
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      boundPort = addr && typeof addr === "object" ? addr.port : port;
      resolve({
        url: `http://${host}:${boundPort}/`,
        token,
        port: boundPort,
        close: () => new Promise<void>((r) => { for (const c of clients) { try { c.res.end(); } catch { /* */ } } server.close(() => r()); }),
      });
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    // A non-object JSON body (`null`, `42`, `[…]`) parses fine but is not a Record — callers destructure
    // it and would throw (surfacing a 500 instead of a clean 400). Treat it as an empty/invalid body.
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}
