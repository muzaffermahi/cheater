#!/usr/bin/env node
// Kitten — the terminal UI. NO Pi.
//
// A streaming, event-driven terminal app over the ONE application service (app.ts). It renders the
// canonical event stream (the same one the web UI renders), carries the pixel-cat mascot as a status
// companion, and drives everything a daily driver needs: streamed output + status, slash commands, a
// conversation picker + resume with full history, interactive approvals, cancellation, and /undo.
//
// Design: linear streaming (we print to the terminal's native scrollback rather than managing a fragile
// custom scroll region) with a compact status line and a readline input. This is robust across
// platforms — notably Windows — and never corrupts scrollback. The full pixel cat shows on /cat and at
// idle milestones; during work the mascot rides in the one-line status so it never steals the screen.

import { createInterface, type Interface } from "node:readline";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore, type ConversationRow } from "./store/conversationStore.js";
import { kittenHome, storePath } from "./paths.js";
import { KittenLLM, DEFAULT_MODELS, tierSidecar } from "./llm.js";
import { loadKittenSettings } from "./settings.js";
import { catAnsi, mascotStateForRunEvent, type MascotState } from "./mascot.js";
import type { KittenEvent, Lane } from "./events.js";
import { runCommand, COMMANDS, COMMAND_MAP, type CommandContext, type CommandIO, type SessionState } from "./commands.js";
import { readServeInfo } from "./serve.js";
import { RemoteClient } from "./client.js";

const A = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  bg: (s: string) => `\x1b[48;5;236m${s}\x1b[0m`,
};

const FACE: Record<MascotState, string> = {
  ready: "(=^･^=)", thinking: "(=･ω･=)?", working: "(=｀ω´=)", sampling: "(=ΦωΦ=)",
  verifying: "(=・∅・=)", success: "(=^‥^=)♪", blocked: "(=；ェ；=)", sleeping: "(=_ _=)zzz",
};

const SPINNER = ["◌", "○", "◍", "◉", "◎", "◉", "◍", "○"];

const CMDS = ["help","exit","quit","new","conversations","ls","resume","rename","model","mode","diff","undo","cat","doctor","web","search","archive","status"];

const KNOWN_MODELS = ["ornith-1.0-35b", "qwen3.5-2b", "qwen3.6-35b-a3b", "text-embedding-nomic-embed-text-v1.5"];

const HELP = [
  A.bold("Commands:"),
  "  /new                    start a new conversation",
  "  /resume [id]            resume a stored conversation (no id → list)",
  "  /conversations, /ls     list recent conversations",
  "  /rename <title>         rename this conversation",
  "  /model [name]           show or change the model",
  "  /mode [auto|answer|reliable|ascent|bon|direct]   lane override for this conversation",
  "  /diff                   show the git diff of the working tree",
  "  /undo                   roll back the last file-changing run",
  "  /cat                    show the mascot",
  "  /doctor                 environment checks",
  "  /search <query>         search conversation titles",
  "  /status                 show current conversation + model info",
  "  /archive <id>           archive / unarchive a conversation",
  "  /help                   this help",
  "  /exit                   quit  (Ctrl+C once cancels a run; again to exit)",
  A.dim("Anything else is a task, run in the current directory."),
  A.dim("End a line with \\ to continue on the next line."),
].join("\n");

interface TuiState {
  conversationId: string;
  mascot: MascotState;
  activeRun: string | null;
  model: string;
  lane?: Lane;
  runStartTime: number;
  runTurn: number;
  runFiles: number;
  lastEventTime: number;
  lastDuration: number;
  lastFiles: number;
  lastVerified: boolean;
  lastFailed: boolean;
}

const LANES: Lane[] = ["answer", "direct", "reliable", "bon", "ascent"];

function out(s: string): void { process.stdout.write(s + "\n"); }

function renderEvent(e: KittenEvent): string | null {
  switch (e.type) {
    case "user.message": return A.bold("\nyou › ") + e.text;
    case "route.selected": return A.dim(`  ◆ ${e.lane}${e.k > 1 ? ` k=${e.k}` : ""} — ${e.reasons.join("; ")}`);
    case "assistant.delta": return null;
    case "reasoning.delta": return null;
    case "assistant.final": return e.text.trim() ? "\n" + e.text.trim() : null;
    case "tool.approval_required": return A.yellow(`  ⚠ approval needed: ${e.name} — ${e.reason}`);
    case "tool.completed": return A.dim(`  ${e.ok ? "▸" : "✗"} ${e.name}${e.output ? "  " + e.output.replace(/\s+/g, " ").slice(0, 76) : ""}`);
    case "verification.failed": return A.yellow(`  ⓘ ${e.detail.slice(0, 100)}`);
    case "verification.passed": return A.green(`  ✓ ${e.detail.slice(0, 100)}`);
    case "verification.evidence": return A.dim(`  ${e.passed ? "✓" : "✗"} ${e.check}${e.proves ? ` (${e.proves})` : ""}`);
    case "file.changed": return A.cyan(`  ✎ ${e.path}`);
    case "repair.started": return A.magenta(`  ↻ repair round ${e.round}`);
    case "run.undone": return A.dim(`  ↩ undo: restored ${e.restored.length}, deleted ${e.deleted.length}`);
    case "run.completed": {
      const badge = e.verified ? A.green("  ✓ verified ") : e.finished ? A.yellow("  ~ checked ") : A.yellow("  • unverified ");
      return badge + (e.summary || "") + A.dim(` · ${(e.wallMs / 1000).toFixed(1)}s`);
    }
    case "run.failed": return A.red(`  ✗ failed: ${e.error}`);
    case "run.cancelled": return A.red("  ✗ cancelled");
    case "receipt.finalized": return e.lines.length ? A.dim("  receipt: " + e.lines.join(" | ").slice(0, 160)) : null;
    default: return null;
  }
}

function buildStatus(st: TuiState): string {
  if (st.activeRun && st.runStartTime) {
    const elapsed = Math.floor((Date.now() - st.runStartTime) / 1000);
    const face = FACE[st.mascot] || FACE.working;
    const idle = Date.now() - st.lastEventTime > 1500;
    const frame = Math.floor((Date.now() - st.runStartTime) / 250) % SPINNER.length;
    const icon = idle ? SPINNER[frame] : face;
    let parts = `${icon} Working... [${elapsed}s]`;
    if (st.runTurn > 0) parts += `  |  turn ${st.runTurn}`;
    if (st.runFiles > 0) parts += `  |  ${A.cyan("✓")} ${st.runFiles} files changed`;
    return parts;
  }
  if (st.lastFailed) {
    return `${FACE.blocked} Failed [${st.lastDuration.toFixed(1)}s]  |  ${st.lastFiles} files changed`;
  }
  if (st.lastDuration > 0) {
    return `${FACE.success} Done in ${st.lastDuration.toFixed(1)}s  |  ${st.lastFiles} files changed  |  ${st.lastVerified ? A.green("verified ✓") : A.yellow("unverified")}`;
  }
  const convInfo = st.conversationId ? `  |  ${A.cyan(st.conversationId)}  |  ${st.model}` : `  ·  ${st.model}`;
  return `${FACE.ready} kitten${convInfo}`;
}

function printStatus(st: TuiState): void {
  out(A.bg(buildStatus(st)));
}

function convLabel(c: ConversationRow): string {
  return `${A.cyan(c.id)}  ${A.dim(new Date(c.updatedAt).toISOString().slice(0, 16).replace("T", " "))}  ${c.title}`;
}

async function checkHealth(llm: KittenLLM, model: string): Promise<string> {
  const okp = llm.ping(model);
  const to = new Promise<boolean>((r) => setTimeout(() => r(false), 2500));
  const ok = await Promise.race([okp, to]).catch(() => false);
  return ok ? A.green("endpoint ✓") : A.red("endpoint offline");
}

function buildCompleter(store: ConversationStore, currentModel: () => string): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    if (line.startsWith("/resume ")) {
      const rows = store.listConversations({ limit: 50 });
      const hits = rows.filter(c => c.id.startsWith(line.slice(8))).map(c => "/resume " + c.id);
      return [hits.length ? hits : rows.map(c => "/resume " + c.id), line];
    }
    if (line.startsWith("/model ")) {
      const prefix = line.slice(7);
      const models = [...new Set([currentModel(), ...KNOWN_MODELS])];
      const hits = models.filter(m => m.startsWith(prefix)).map(m => "/model " + m);
      return [hits.length ? hits : models.map(m => "/model " + m), line];
    }
    if (line.startsWith("/")) {
      const hits = CMDS.filter(c => ("/" + c).startsWith(line)).map(c => "/" + c);
      return [hits.length ? hits : CMDS.map(c => "/" + c), line];
    }
    return [[], line];
  };
}

export async function runTui(argv: string[] = process.argv.slice(2)): Promise<void> {
  let cwd = process.cwd();
  let model = DEFAULT_MODELS.main;
  let modelFlagProvided = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") cwd = resolve(argv[++i] ?? ".");
    else if (argv[i] === "--model") { model = argv[++i] ?? model; modelFlagProvided = true; }
  }
  const interactive = process.stdin.isTTY === true;

  const store = ConversationStore.open(storePath());
  const settings = loadKittenSettings(cwd);
  const resolvedModel = modelFlagProvided ? model : settings.models.main;
  const llm = new KittenLLM(tierSidecar({ ...settings.models, main: resolvedModel }));
  model = resolvedModel;
  const app = new KittenApp({ store, runner: defaultRunner(llm), projectRoot: cwd, model: resolvedModel, approvalPolicy: interactive ? settings.approvalPolicy : "auto-deny" });
  app.recover();

  const st: TuiState = {
    conversationId: "", mascot: "ready", activeRun: null, model,
    runStartTime: 0, runTurn: 0, runFiles: 0, lastEventTime: 0,
    lastDuration: 0, lastFiles: 0, lastVerified: false, lastFailed: false,
  };

  const historyFile = resolve(kittenHome(), "history.txt");
  let initHistory: string[] = [];
  try {
    initHistory = readFileSync(historyFile, "utf8").split(/\r?\n/).filter(Boolean);
  } catch { /* no history yet */ }

  // Header + mascot.
  out("");
  for (const row of catAnsi("ready")) out(row);
  out(A.bold("Kitten") + A.dim(`  ·  a reliable local-first coding agent  ·  ${cwd}`));
  out(A.dim(`model: ${st.model}`));
  const modelFromEnv = Boolean(process.env.KITTEN_MAIN_MODEL);
  if (!modelFromEnv && model === DEFAULT_MODELS.main) {
    out(A.dim("No KITTEN_MAIN_MODEL set — using default. Run `kitten init` to configure."));
  }
  const health = await checkHealth(llm, model);
  out(buildStatus(st));
  out(A.dim("type a task or /help for commands"));
  out("");

  // Stream events → render + drive the mascot.
  const streamedRuns = new Set<string>();
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  const onEvent = (e: KittenEvent): void => {
    if (e.conversationId !== st.conversationId) return;
    st.lastEventTime = Date.now();
    const next = mascotStateForRunEvent(e.type);
    if (next) st.mascot = next;
    if (e.type === "user.message") st.runTurn++;
    if (e.type === "run.started") {
      st.activeRun = e.runId;
      st.runStartTime = Date.now();
      st.runFiles = 0;
      st.runTurn = st.runTurn || 1;
      st.lastFailed = false;
      st.lastDuration = 0;
      statusTimer = setInterval(() => { if (st.activeRun) printStatus(st); }, 250);
      process.stdout.write("\x1b[?25l");
    }
    if (e.type === "run.completed") {
      st.activeRun = null;
      st.lastDuration = e.wallMs / 1000;
      st.lastFiles = st.runFiles;
      st.lastVerified = e.verified;
      st.lastFailed = false;
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      process.stdout.write("\x1b[?25h");
      printStatus(st);
    }
    if (e.type === "run.failed" || e.type === "run.cancelled") {
      st.activeRun = null;
      st.lastDuration = (e.type === "run.failed" ? ((e as KittenEvent & { wallMs?: number }).wallMs ?? 0) : 0) / 1000;
      st.lastFiles = st.runFiles;
      st.lastVerified = false;
      st.lastFailed = true;
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      process.stdout.write("\x1b[?25h");
      printStatus(st);
    }
    if (e.type === "file.changed") st.runFiles++;
    if (e.type === "assistant.delta") { streamedRuns.add(e.runId); process.stdout.write(e.text); return; }
    if (e.type === "assistant.final") { process.stdout.write(streamedRuns.has(e.runId) ? "\n" : (e.text.trim() ? "\n" + e.text.trim() + "\n" : "")); return; }
    const line = renderEvent(e);
    if (line) out(line);
  };

  app.subscribe(onEvent);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 1000,
    completer: buildCompleter(store, () => st.model),
  }) as Interface;

  // Seed history from persisted file
  try { for (const h of initHistory) (rl as unknown as { history: string[] }).history.push(h); } catch { /* best effort */ }

  const prompt = (): void => {
    process.stdout.write("\x1b[?25h");
    rl.setPrompt(A.bold("\nkitten › "));
    rl.prompt();
  };

  // Interactive approvals: when a run needs approval, ask y/n on the same input.
  const askApproval = (runId: string, callId: string, label: string): void => {
    rl.question(A.yellow(`approve ${label}? [y/N] `), (ans) => {
      app.resolveApproval(runId, callId, /^y(es)?$/i.test(ans.trim()));
    });
  };
  app.subscribe((e) => {
    if (interactive && e.type === "tool.approval_required" && e.conversationId === st.conversationId) {
      askApproval(e.runId, e.callId, `${e.name} — ${e.reason}`);
    }
  });

  let exiting = false;
  let lastSigint = 0;
  rl.on("SIGINT", () => {
    if (st.activeRun) {
      out(A.yellow("  Cancelling..."));
      app.cancel(st.activeRun);
      // Brief "Cancelled" will appear when run.cancelled event fires via onEvent
      return;
    }
    const now = process.hrtime.bigint();
    if (Number(now - BigInt(lastSigint)) < 1.5e9 && lastSigint) { exiting = true; rl.close(); return; }
    lastSigint = Number(now);
    out(A.dim("  (Ctrl+C again to exit, or /exit)"));
    prompt();
  });

  const handle = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("/")) { await slash(line.slice(1)); return; }
    if (!st.conversationId) {
      const conv = app.createConversation({ projectRoot: cwd, model });
      st.conversationId = conv.id;
      st.runTurn = 0;
      out(A.dim(`new conversation ${conv.id}`));
    }
    await app.submitMessage(st.conversationId, line, st.lane ? { lane: st.lane } : {});
  };

  const slash = async (body: string): Promise<void> => {
    const [cmd, ...rest] = body.split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "exit": case "quit": exiting = true; rl.close(); break;
      case "new": { const c = app.createConversation({ projectRoot: cwd, model: st.model }); st.conversationId = c.id; st.runTurn = 0; out(A.dim(`new conversation ${c.id}`)); break; }
      case "resume": {
        if (!arg) { const rows = store.listConversations({ limit: 20 }); out(A.dim("resume which?")); for (const c of rows) out("  " + convLabel(c)); break; }
        const c = store.getConversation(arg);
        if (!c) { out(A.red(`no conversation ${arg}`)); break; }
        st.conversationId = c.id;
        st.runTurn = 0;
        st.model = c.model;
        for (const e of store.readEvents(c.id)) { if (e.type === "user.message") st.runTurn++; }
        out(A.bold(`\n— resuming ${c.title} (${c.id}) —`));
        for (const e of store.readEvents(c.id)) { const l = renderEvent(e); if (l) out(l); }
        break;
      }
      case "cat": { st.mascot = "ready"; for (const row of catAnsi(st.mascot)) out(row); break; }
      default: {
        const sessionState: SessionState = {
          conversationId: st.conversationId || null,
          model: st.model,
          provider: null,
          lane: st.lane || null,
        };
        const io: CommandIO = {
          print(text, style) {
            switch (style) {
              case "dim": out(A.dim(text)); break;
              case "ok": out(A.green(text)); break;
              case "error": out(A.red(text)); break;
              case "warn": out(A.yellow(text)); break;
              default: out(text);
            }
          },
          table(rows, header) {
            const all = header ? [header, ...rows] : rows;
            if (!all.length) return;
            const colWidths = header
              ? header.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] || "").length)))
              : rows[0].map((_, i) => Math.max(...rows.map(r => (r[i] || "").length)));
            for (const row of all) {
              const line = row.map((cell, i) => cell + " ".repeat(colWidths[i] - (cell || "").length)).join("  ");
              out(line);
            }
          },
          frame(frame) {
            switch (frame.type) {
              case "text": out(frame.text ?? ""); break;
              case "table": io.table(frame.rows ?? [], frame.header); break;
              case "diff": out(frame.diff ?? ""); break;
              case "error": out(A.red(frame.text ?? "")); break;
              case "success": out(A.green(frame.text ?? "")); break;
            }
          },
        };
        const ctx: CommandContext = { app, store, llm, settings, session: sessionState, cwd, io };
        const ok = await runCommand(ctx, body);
        if (!ok) out(A.red(`unknown command /${cmd} — /help`));
        st.model = sessionState.model;
        st.conversationId = sessionState.conversationId ?? st.conversationId;
        st.lane = sessionState.lane ?? undefined;
      }
    }
  };

  // Multi-line support: \ at end of line continues on next line.
  let multilineBuffer = "";

  rl.on("line", (raw) => {
    if (!raw.startsWith("/") && raw.endsWith("\\")) {
      multilineBuffer += raw.slice(0, -1).trimEnd() + "\n";
      rl.setPrompt("... ");
      rl.prompt();
      return;
    }
    const full = multilineBuffer ? multilineBuffer + raw : raw;
    multilineBuffer = "";
    rl.pause();
    handle(full).catch((e) => out(A.red(`error: ${(e as Error).message}`))).finally(() => {
      if (!exiting) { rl.resume(); prompt(); }
    });
  });

  rl.on("close", () => {
    process.stdout.write("\x1b[?25h");
    try {
      const hist = (rl as unknown as { history: string[] }).history;
      writeFileSync(historyFile, hist.slice(-500).join("\n") + "\n", "utf8");
    } catch { /* best effort */ }
    if (statusTimer) clearInterval(statusTimer);
    if (!exiting) { /* EOF on pipe */ }
    out(A.dim("\nbye"));
    store.close();
  });

  prompt();
  // Keep the process alive until the readline closes.
  await new Promise<void>((r) => rl.on("close", () => r()));
}

/** Remote-mode TUI that connects to a running daemon. */
export async function runAttach(argv: string[] = process.argv.slice(2)): Promise<void> {
  let attachUrl = "";
  let attachToken = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") attachUrl = argv[++i] ?? "";
    else if (argv[i] === "--token") attachToken = argv[++i] ?? "";
  }

  if (!attachUrl || !attachToken) {
    const info = readServeInfo();
    if (info) {
      attachUrl = `http://127.0.0.1:${info.port}`;
      attachToken = info.token;
    }
  }

  if (!attachUrl || !attachToken) {
    process.stderr.write("kitten attach: no daemon found. Start one with `kitten serve`, or pass --url and --token.\n");
    process.exit(1);
  }

  const client = new RemoteClient({ url: attachUrl, token: attachToken });

  // Test connection
  try {
    const res = await fetch(`${attachUrl}/api/status`, { headers: { "x-kitten-token": attachToken } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    process.stderr.write(`kitten attach: cannot reach daemon at ${attachUrl}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const interactive = process.stdin.isTTY === true;
  if (!interactive) {
    process.stderr.write("kitten attach: need a TTY for the TUI\n");
    process.exit(1);
  }

  runRemoteTui(client, attachUrl, attachToken).catch((e) => {
    process.stderr.write(`kitten attach: ${(e as Error).message}\n`);
    process.exit(1);
  });

  await new Promise<void>(() => {});
}

async function runRemoteTui(client: RemoteClient, baseUrl: string, token: string): Promise<void> {
  const st: TuiState = {
    conversationId: "", mascot: "ready", activeRun: null, model: "",
    runStartTime: 0, runTurn: 0, runFiles: 0, lastEventTime: 0,
    lastDuration: 0, lastFiles: 0, lastVerified: false, lastFailed: false,
  };

  const historyFile = resolve(kittenHome(), "history.txt");
  let initHistory: string[] = [];
  try { initHistory = readFileSync(historyFile, "utf8").split(/\r?\n/).filter(Boolean); } catch { /* no history yet */ }

  // Check health
  let healthStatus = A.green("connected ✓");

  out("");
  for (const row of catAnsi("ready")) out(row);
  out(A.bold("Kitten attach") + A.dim(`  ·  daemon: ${baseUrl}`));
  out(buildStatus(st));

  const streamedRuns = new Set<string>();
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  const onEvent = (e: KittenEvent): void => {
    if (e.conversationId !== st.conversationId) return;
    st.lastEventTime = Date.now();
    const next = mascotStateForRunEvent(e.type);
    if (next) st.mascot = next;
    if (e.type === "user.message") st.runTurn++;
    if (e.type === "run.started") {
      st.activeRun = e.runId;
      st.runStartTime = Date.now();
      st.runFiles = 0;
      st.runTurn = st.runTurn || 1;
      st.lastFailed = false;
      st.lastDuration = 0;
      statusTimer = setInterval(() => { if (st.activeRun) printStatus(st); }, 250);
      process.stdout.write("\x1b[?25l");
    }
    if (e.type === "run.completed") {
      st.activeRun = null;
      st.lastDuration = e.wallMs / 1000;
      st.lastFiles = st.runFiles;
      st.lastVerified = e.verified;
      st.lastFailed = false;
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      process.stdout.write("\x1b[?25h");
      printStatus(st);
    }
    if (e.type === "run.failed" || e.type === "run.cancelled") {
      st.activeRun = null;
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      process.stdout.write("\x1b[?25h");
      printStatus(st);
    }
    if (e.type === "file.changed") st.runFiles++;
    if (e.type === "assistant.delta") { streamedRuns.add(e.runId); process.stdout.write(e.text); return; }
    if (e.type === "assistant.final") { process.stdout.write(streamedRuns.has(e.runId) ? "\n" : (e.text.trim() ? "\n" + e.text.trim() + "\n" : "")); return; }
    const line = renderEvent(e);
    if (line) out(line);
  };

  client.subscribe(onEvent);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 1000,
    completer: (line: string): [string[], string] => {
      if (line.startsWith("/")) {
        const hits = CMDS.filter(c => ("/" + c).startsWith(line)).map(c => "/" + c);
        return [hits.length ? hits : CMDS.map(c => "/" + c), line];
      }
      return [[], line];
    },
  }) as Interface;

  try { for (const h of initHistory) (rl as unknown as { history: string[] }).history.push(h); } catch { /* best effort */ }

  const prompt = (): void => {
    process.stdout.write("\x1b[?25h");
    rl.setPrompt(A.bold("\nkitten (remote) › "));
    rl.prompt();
  };

  const askApproval = (runId: string, callId: string, label: string): void => {
    rl.question(A.yellow(`approve ${label}? [y/N] `), (ans) => {
      client.resolveApproval(runId, callId, /^y(es)?$/i.test(ans.trim()));
    });
  };
  client.subscribe((e) => {
    if (e.type === "tool.approval_required" && e.conversationId === st.conversationId) {
      askApproval(e.runId, e.callId, `${e.name} — ${e.reason}`);
    }
  });

  let exiting = false;
  let lastSigint = 0;

  rl.on("SIGINT", () => {
    if (st.activeRun) {
      out(A.yellow("  Cancelling..."));
      client.cancel(st.activeRun);
      return;
    }
    const now = process.hrtime.bigint();
    if (Number(now - BigInt(lastSigint)) < 1.5e9 && lastSigint) { exiting = true; rl.close(); return; }
    lastSigint = Number(now);
    out(A.dim("  (Ctrl+C again to exit, or /exit)"));
    prompt();
  });

  const handle = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "help": out(HELP); break;
        case "exit": case "quit": exiting = true; rl.close(); break;
        case "new": {
          const convs = await client.listConversations({ limit: 1 });
          const c = await client.createConversation({});
          st.conversationId = c.id;
          st.runTurn = 0;
          out(A.dim(`new conversation ${c.id}`));
          client.streamConversation(c.id, 0);
          break;
        }
        case "conversations": case "ls": {
          const rows = await client.listConversations({ limit: 20 });
          if (!rows.length) out(A.dim("no conversations yet"));
          else for (const c of rows) out("  " + A.cyan(c.id) + A.dim(` ${c.title}`));
          break;
        }
        default: out(A.red(`unknown command /${cmd} — /help`));
      }
      return;
    }
    if (!st.conversationId) {
      const c = await client.createConversation({});
      st.conversationId = c.id;
      st.runTurn = 0;
      out(A.dim(`new conversation ${c.id}`));
      client.streamConversation(c.id, 0);
    }
    await client.submitMessage(st.conversationId, line);
  };

  rl.on("line", (raw) => {
    const full = raw.trim();
    if (!full) { if (!exiting) { rl.resume(); prompt(); } return; }
    rl.pause();
    handle(full).catch((e) => out(A.red(`error: ${(e as Error).message}`))).finally(() => {
      if (!exiting) { rl.resume(); prompt(); }
    });
  });

  rl.on("close", () => {
    process.stdout.write("\x1b[?25h");
    try {
      const hist = (rl as unknown as { history: string[] }).history;
      writeFileSync(historyFile, hist.slice(-500).join("\n") + "\n", "utf8");
    } catch { /* best effort */ }
    if (statusTimer) clearInterval(statusTimer);
    out(A.dim("\nbye"));
  });

  prompt();
  await new Promise<void>((r) => rl.on("close", () => r()));
}

// Auto-run only when invoked directly.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`kitten tui fatal: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  process.exit(1);
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTui().catch((e) => { process.stderr.write(`kitten tui fatal: ${e?.stack ?? e}\n`); process.exit(1); });
}
