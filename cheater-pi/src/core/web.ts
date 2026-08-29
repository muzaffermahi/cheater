#!/usr/bin/env node
// Kitten — `kitten web` entry. NO Pi.
//
// Starts the local web server over the shared app service + store, prints the URL, and (unless
// --no-open) opens the default browser. Interactive approvals are on ("ask"), so the browser can
// approve/deny risky actions.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore } from "./store/conversationStore.js";
import { storePath, kittenHome } from "./paths.js";
import { KittenLLM, DEFAULT_MODELS, tierSidecar } from "./llm.js";
import { loadKittenSettings } from "./settings.js";
import { startWebServer } from "./web/server.js";
import { createKittenServer, writeServeInfo, getServeJsonPath, checkDaemonRunning, readServeInfo, removeServeInfo } from "./serve.js";
import { renderPage } from "./web/page.js";
import { catCells, type MascotState } from "./mascot.js";
import { VERSION } from "../config.js";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

/** Open a URL in the default browser, best-effort, per platform. */
function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref(); } catch { /* best-effort */ }
}

export async function runWeb(argv: string[] = process.argv.slice(2)): Promise<void> {
  let cwd = process.cwd();
  let model = DEFAULT_MODELS.main;
  let modelFlagProvided = false;
  let port = 4025;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") cwd = resolve(argv[++i] ?? ".");
    else if (a === "--model") { model = argv[++i] ?? model; modelFlagProvided = true; }
    else if (a === "--port") port = Number(argv[++i]) || port;
    else if (a === "--no-open") open = false;
  }

  const store = ConversationStore.open(storePath());
  const settings = loadKittenSettings(cwd);
  const resolvedModel = modelFlagProvided ? model : settings.models.main;
  const llm = new KittenLLM(tierSidecar({ ...settings.models, main: resolvedModel }));
  const app = new KittenApp({ store, runner: defaultRunner(llm), projectRoot: cwd, model: resolvedModel, approvalPolicy: settings.approvalPolicy, taskCompiler: settings.taskCompiler });
  app.recover();

  const server = await startWebServer({ app, store, cwd, port, model: resolvedModel });
  process.stdout.write(bold("Kitten web") + dim(`  ·  ${cwd}`) + "\n");
  process.stdout.write("  " + cyan(server.url) + "\n");
  process.stdout.write(dim("  bound to 127.0.0.1 · conversations are local · Ctrl+C to stop\n"));
  if (open) openBrowser(server.url);

  await new Promise<void>((resolveExit) => {
    const stop = (): void => { server.close().finally(() => { store.close(); resolveExit(); }); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export async function runServe(argv: string[] = process.argv.slice(2)): Promise<void> {
  let cwd = process.cwd();
  let model = DEFAULT_MODELS.main;
  let modelFlagProvided = false;
  let port = 4025;
  let replace = false;
  let printConnection = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") cwd = resolve(argv[++i] ?? ".");
    else if (a === "--model") { model = argv[++i] ?? model; modelFlagProvided = true; }
    else if (a === "--port") port = Number(argv[++i]) || port;
    else if (a === "--replace") replace = true;
    else if (a === "--print-connection") printConnection = true;
  }

  // Check if already running
  const existing = await (async () => {
    try {
      const info = readServeInfo();
      if (!info) return null;
      const daemon = await checkDaemonRunning(info);
      if (daemon) return daemon;
    } catch { /* */ }
    return null;
  })();
  if (existing && !replace) {
    process.stdout.write(`kitten serve: already running (pid ${existing.pid}, port ${existing.port})\n`);
    process.exit(0);
  }

  const store = ConversationStore.open(storePath());
  const settings = loadKittenSettings(cwd);
  const resolvedModel = modelFlagProvided ? model : settings.models.main;
  const llm = new KittenLLM(tierSidecar({ ...settings.models, main: resolvedModel }));
  const app = new KittenApp({ store, runner: defaultRunner(llm), projectRoot: cwd, model: resolvedModel, approvalPolicy: settings.approvalPolicy, taskCompiler: settings.taskCompiler });
  app.recover();

  const MASCOT_STATES: MascotState[] = ["ready", "thinking", "working", "sampling", "verifying", "success", "blocked", "sleeping"];
  const mascot: Record<string, string[][]> = {};
  for (const s of MASCOT_STATES) mascot[s] = catCells(s);
  const serveToken = randomBytes(24).toString("hex");
  const pageHtml = renderPage({ token: serveToken, mascot, cwd, version: VERSION, model: resolvedModel });

  const server = await createKittenServer({
    app, store, cwd, port, token: serveToken, servePage: true, pageHtml, model: resolvedModel,
  });

  // Write connection info
  writeServeInfo({ port: server.port, token: server.token, pid: process.pid, startedAt: Date.now(), version: VERSION });

  if (printConnection) {
    process.stdout.write(JSON.stringify({ port: server.port, token: server.token, pid: process.pid, connectionFile: getServeJsonPath() }) + "\n");
  }
  process.stdout.write(bold("kitten serve") + dim(` listening on http://127.0.0.1:${server.port} (connection file: ${getServeJsonPath()})\n`));

  await new Promise<void>((resolveExit) => {
    const stop = (): void => {
      server.close().finally(() => {
        store.close();
        try { removeServeInfo(); } catch { /* */ }
        resolveExit();
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`kitten web fatal: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  process.exit(1);
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWeb().catch((e) => { process.stderr.write(`kitten web fatal: ${e?.stack ?? e}\n`); process.exit(1); });
}
