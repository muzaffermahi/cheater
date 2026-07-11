#!/usr/bin/env node
// Kitten — `kitten web` entry. NO Pi.
//
// Starts the local web server over the shared app service + store, prints the URL, and (unless
// --no-open) opens the default browser. Interactive approvals are on ("ask"), so the browser can
// approve/deny risky actions.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore } from "./store/conversationStore.js";
import { storePath } from "./paths.js";
import { KittenLLM, DEFAULT_MODELS, tierSidecar } from "./llm.js";
import { loadKittenSettings } from "./settings.js";
import { startWebServer } from "./web/server.js";

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
  let port = 4025;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") cwd = resolve(argv[++i] ?? ".");
    else if (a === "--model") model = argv[++i] ?? model;
    else if (a === "--port") port = Number(argv[++i]) || port;
    else if (a === "--no-open") open = false;
  }

  const store = ConversationStore.open(storePath());
  const settings = loadKittenSettings(cwd);
  const resolvedModel = model !== DEFAULT_MODELS.main ? model : settings.models.main;
  const llm = new KittenLLM(tierSidecar({ ...settings.models, main: resolvedModel }));
  const app = new KittenApp({ store, runner: defaultRunner(llm), projectRoot: cwd, model: resolvedModel, approvalPolicy: settings.approvalPolicy });
  app.recover();

  const server = await startWebServer({ app, store, cwd, port });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWeb().catch((e) => { process.stderr.write(`kitten web fatal: ${e?.stack ?? e}\n`); process.exit(1); });
}
