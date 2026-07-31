// Kitten — the daemon server. NO Pi.
//
// A reusable HTTP + SSE server. Used by:
//   - `kitten serve`   → daemon mode (owns in-flight runs, writes ~/.kitten/serve.json)
//   - `kitten web`     → ephemeral per-launch server (opens browser, dies on exit)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { KittenApp } from "./app.js";
import type { ConversationStore } from "./store/conversationStore.js";
import { kittenHome } from "./paths.js";
import { getCommandsJson, runCommand, type CommandContext, type CommandIO, type CommandFrame } from "./commands.js";
import { KittenLLM } from "./llm.js";
import { discoverModels, type ModelInfo } from "./discovery.js";

export interface KittenServerOptions {
  app: KittenApp;
  store: ConversationStore;
  cwd: string;
  host?: string;
  port?: number;
  token?: string;
  servePage?: boolean;
  pageHtml?: string;
  model?: string;
}

export interface KittenServer {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
  setPageHtml(html: string): void;
}

interface SseClient { conversationId: string; res: ServerResponse; }

const SERVE_JSON_PATH = join(kittenHome(), "serve.json");

export interface ServeInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}

function isAllowedOrigin(origin: string, host: string, boundPort: number): boolean {
  return [`http://${host}:${boundPort}`, `http://localhost:${boundPort}`, `http://127.0.0.1:${boundPort}`].includes(origin);
}

function tokenOk(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'", "x-frame-options": "DENY" });
  res.end(s);
}

export function createKittenServer(opts: KittenServerOptions): Promise<KittenServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4025;
  const token = opts.token ?? randomBytes(24).toString("hex");
  const clients = new Set<SseClient>();
  let boundPort = port;
  let pageHtml = opts.pageHtml ?? "";

  opts.app.subscribe((e) => {
    const frame = `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) if (c.conversationId === e.conversationId) { try { c.res.write(frame); } catch { /* dropped */ } }
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);
    const path = url.pathname;

    if (opts.servePage && req.method === "GET" && (path === "/" || path === "/index.html") && pageHtml) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'", "x-frame-options": "DENY" });
      res.end(pageHtml);
      return;
    }

    if (!path.startsWith("/api/")) { json(res, 404, { error: "not found" }); return; }

    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, host, boundPort)) { json(res, 403, { error: "bad origin" }); return; }

    if (path === "/api/stream") {
      if (!tokenOk(url.searchParams.get("token") ?? undefined, token)) { json(res, 401, { error: "unauthorized" }); return; }
      streamEvents(req, res, url);
      return;
    }
    if (!tokenOk(header(req, "x-kitten-token"), token)) { json(res, 401, { error: "unauthorized" }); return; }

    if (req.method === "GET" && path === "/api/conversations") {
      const search = url.searchParams.get("search") ?? undefined;
      const includeArchived = url.searchParams.get("includeArchived") === "1";
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 100;
      json(res, 200, { conversations: opts.store.listConversations({ search, includeArchived, limit }) });
      return;
    }
    if (req.method === "POST" && path === "/api/conversations") {
      const body = await readJson(req);
      const conv = opts.app.createConversation({
        title: typeof body.title === "string" ? body.title : undefined,
        projectRoot: typeof body.projectRoot === "string" ? body.projectRoot : opts.cwd,
        model: typeof body.model === "string" ? body.model : undefined,
        mode: body.mode as any,
      });
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
      const conversation = opts.store.getConversation(conversationId);
      if (!conversation) { json(res, 404, { error: "unknown conversation" }); return; }
      const lane = typeof body.lane === "string" ? body.lane as any : undefined;
      const k = typeof body.k === "number" ? body.k : undefined;
      opts.app.submitMessage(conversationId, text, { lane, k }).catch(() => {});
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
      if (typeof conversationId === "string" && typeof title === "string") {
        const conv = opts.store.getConversation(conversationId);
        if (!conv) { json(res, 404, { error: "unknown conversation" }); return; }
        opts.app.rename(conversationId, title);
      }
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && path === "/api/archive") {
      const { conversationId, archived } = await readJson(req);
      if (typeof conversationId === "string") {
        const conv = opts.store.getConversation(conversationId);
        if (!conv) { json(res, 404, { error: "unknown conversation" }); return; }
        opts.app.archive(conversationId, !!archived);
      }
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && convMatch) {
      const id = convMatch[1];
      const conv = opts.store.getConversation(id);
      if (!conv) { json(res, 404, { error: "unknown conversation" }); return; }
      opts.app.archive(id, true);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && path === "/api/commands") {
      json(res, 200, { commands: getCommandsJson() });
      return;
    }
    if (req.method === "POST" && path === "/api/command") {
      const body = await readJson(req);
      const { conversationId, input } = body;
      if (typeof input !== "string") { json(res, 400, { error: "input required" }); return; }
      const frames: CommandFrame[] = [];
      const io: CommandIO = {
        print(text, style) { frames.push({ type: style === "error" ? "error" : style === "ok" ? "success" : "text", text }); },
        table(rows, header) { frames.push({ type: "table", rows, header }); },
        frame(f) { frames.push(f); },
      };
      const ctx: CommandContext = {
        app: opts.app, store: opts.store,
        llm: null as any, settings: null as any,
        session: { conversationId: conversationId as string || null, model: opts.model ?? "", provider: null, lane: null },
        cwd: opts.cwd, io,
      };
      const found = await runCommand(ctx, input);
      json(res, 200, { frames, found });
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
    if (req.method === "GET" && path === "/api/status") {
      let branch = "";
      let dirty = false;
      try {
        const br = spawnSync("git", ["branch", "--show-current"], { cwd: opts.cwd, encoding: "utf8", timeout: 3000 });
        branch = (br.stdout ?? "").trim();
        const st = spawnSync("git", ["status", "--porcelain"], { cwd: opts.cwd, encoding: "utf8", timeout: 3000 });
        dirty = (st.stdout ?? "").trim().length > 0;
      } catch { /* best-effort */ }
      let convCount = 0;
      let runCount = 0;
      try {
        const convs = opts.store.listConversations({ includeArchived: true, limit: 1000 });
        convCount = convs.length;
        for (const c of convs) runCount += opts.store.listRuns(c.id).length;
      } catch { /* best-effort */ }
      json(res, 200, { branch, dirty, convCount, runCount, model: opts.model ?? "" });
      return;
    }
    if (req.method === "GET" && path === "/api/models") {
      const llm = new KittenLLM({ baseUrl: "http://localhost:1234/v1", main: opts.model ?? "" });
      const result = await discoverModels(llm, "local");
      json(res, 200, { models: result.models, current: opts.model ?? "", unverified: !result.ok });
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
    res.write(`:${" ".repeat(2048)}\n\n`);
    res.write(": connected\n\n");
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
        setPageHtml: (html: string) => { pageHtml = html; },
      });
    });
  });
}

export function writeServeInfo(info: ServeInfo): void {
  writeFileSync(SERVE_JSON_PATH, JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function readServeInfo(): ServeInfo | null {
  try {
    if (!existsSync(SERVE_JSON_PATH)) return null;
    const data = readFileSync(SERVE_JSON_PATH, "utf8");
    return JSON.parse(data) as ServeInfo;
  } catch { return null; }
}

export function removeServeInfo(): void {
  try { unlinkSync(SERVE_JSON_PATH); } catch { /* ignore */ }
}

export function getServeJsonPath(): string {
  return SERVE_JSON_PATH;
}

export async function checkDaemonRunning(info: ServeInfo): Promise<{ running: boolean; port: number; pid: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/status`, {
      headers: { "x-kitten-token": info.token },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return { running: true, port: info.port, pid: info.pid };
  } catch { /* not running */ }
  return null;
}
