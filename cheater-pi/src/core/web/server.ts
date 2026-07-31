// Kitten — the local web server. NO Pi.

import { randomBytes } from "node:crypto";
import { createKittenServer, type KittenServer } from "../serve.js";
import { renderPage } from "./page.js";
import { catCells, type MascotState } from "../mascot.js";
import { VERSION } from "../../config.js";
import type { KittenApp } from "../app.js";
import type { ConversationStore } from "../store/conversationStore.js";

const MASCOT_STATES: MascotState[] = ["ready", "thinking", "working", "sampling", "verifying", "success", "blocked", "sleeping"];

export interface WebServerOptions {
  app: KittenApp;
  store: ConversationStore;
  cwd: string;
  host?: string;
  port?: number;
  model?: string;
}

export type WebServer = KittenServer;

export function startWebServer(opts: WebServerOptions): Promise<KittenServer> {
  const mascot: Record<string, string[][]> = {};
  for (const s of MASCOT_STATES) mascot[s] = catCells(s);
  const token = randomBytes(24).toString("hex");
  const pageHtml = renderPage({ token, mascot, cwd: opts.cwd, version: VERSION, model: opts.model });
  return createKittenServer({
    app: opts.app, store: opts.store, cwd: opts.cwd, host: opts.host, port: opts.port,
    token, servePage: true, pageHtml, model: opts.model,
  });
}
