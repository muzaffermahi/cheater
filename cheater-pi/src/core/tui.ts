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
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore, type ConversationRow } from "./store/conversationStore.js";
import { storePath } from "./paths.js";
import { KittenLLM, DEFAULT_MODELS, tierSidecar } from "./llm.js";
import { catAnsi, mascotStateForRunEvent, type MascotState } from "./mascot.js";
import type { KittenEvent, Lane } from "./events.js";

const A = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// A compact face per mascot state for the status line (the full pixel cat lives behind /cat).
const FACE: Record<MascotState, string> = {
  ready: "(=^･^=)", thinking: "(=･ω･=)?", working: "(=｀ω´=)", sampling: "(=ΦωΦ=)",
  verifying: "(=・∅・=)", success: "(=^‥^=)♪", blocked: "(=；ェ；=)", sleeping: "(=_ _=)zzz",
};

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
  "  /help                   this help",
  "  /exit                   quit  (Ctrl+C once cancels a run; again to exit)",
  A.dim("Anything else is a task, run in the current directory."),
].join("\n");

interface TuiState {
  conversationId: string;
  mascot: MascotState;
  activeRun: string | null;
  model: string;
  /** Sticky lane override from /mode; undefined = automatic routing. */
  lane?: Lane;
}

const LANES: Lane[] = ["answer", "direct", "reliable", "bon", "ascent"];

function out(s: string): void { process.stdout.write(s + "\n"); }

/** Render one canonical event as a styled line (null = don't show). Shared vocabulary with the web UI. */
function renderEvent(e: KittenEvent): string | null {
  switch (e.type) {
    case "user.message": return A.bold("\nyou › ") + e.text;
    case "route.selected": return A.dim(`  ◆ ${e.lane}${e.k > 1 ? ` k=${e.k}` : ""} — ${e.reasons.join("; ")}`);
    case "assistant.delta": return null;   // streamed live inline by the subscriber
    case "reasoning.delta": return null;   // model thinking; the mascot + status show it, not the log
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

function statusLine(st: TuiState, health: string): string {
  return A.dim(`${FACE[st.mascot]}  ${st.mascot}  ·  ${st.model}  ·  ${health}`);
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

export async function runTui(argv: string[] = process.argv.slice(2)): Promise<void> {
  let cwd = process.cwd();
  let model = DEFAULT_MODELS.main;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") cwd = resolve(argv[++i] ?? ".");
    else if (argv[i] === "--model") model = argv[++i] ?? model;
  }
  const interactive = process.stdin.isTTY === true;

  const store = ConversationStore.open(storePath());
  const llm = new KittenLLM(tierSidecar({ ...DEFAULT_MODELS, main: model }));
  const app = new KittenApp({ store, runner: defaultRunner(llm), projectRoot: cwd, model, approvalPolicy: interactive ? "ask" : "auto-deny" });
  app.recover();

  const conv = app.createConversation({ projectRoot: cwd, model });
  const st: TuiState = { conversationId: conv.id, mascot: "ready", activeRun: null, model };

  // Header + mascot.
  out("");
  for (const row of catAnsi("ready")) out(row);
  out(A.bold("Kitten") + A.dim(`  ·  a reliable local-first coding agent  ·  ${cwd}`));
  const health = await checkHealth(llm, model);
  out(statusLine(st, health));
  out(A.dim(`conversation ${conv.id}  ·  /help for commands`));
  out("");

  // Stream events → render + drive the mascot.
  const streamedRuns = new Set<string>();
  app.subscribe((e) => {
    if (e.conversationId !== st.conversationId) return;
    const next = mascotStateForRunEvent(e.type);
    if (next) st.mascot = next;
    if (e.type === "run.started") st.activeRun = e.runId;
    if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") st.activeRun = null;
    // Live streaming: write content deltas inline (no per-chunk newline); finalize without re-printing.
    if (e.type === "assistant.delta") { streamedRuns.add(e.runId); process.stdout.write(e.text); return; }
    if (e.type === "assistant.final") { process.stdout.write(streamedRuns.has(e.runId) ? "\n" : (e.text.trim() ? "\n" + e.text.trim() + "\n" : "")); return; }
    const line = renderEvent(e);
    if (line) out(line);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (): void => { rl.setPrompt(A.bold("\nkitten › ")); rl.prompt(); };

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
    if (st.activeRun) { app.cancel(st.activeRun); return; }
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
    await app.submitMessage(st.conversationId, line, st.lane ? { lane: st.lane } : {});
  };

  const slash = async (body: string): Promise<void> => {
    const [cmd, ...rest] = body.split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "help": out(HELP); break;
      case "exit": case "quit": exiting = true; rl.close(); break;
      case "new": { const c = app.createConversation({ projectRoot: cwd, model: st.model }); st.conversationId = c.id; out(A.dim(`new conversation ${c.id}`)); break; }
      case "conversations": case "ls": {
        const rows = store.listConversations({ limit: 20 });
        if (!rows.length) out(A.dim("no conversations yet")); else for (const c of rows) out("  " + convLabel(c));
        break;
      }
      case "resume": {
        if (!arg) { const rows = store.listConversations({ limit: 20 }); out(A.dim("resume which?")); for (const c of rows) out("  " + convLabel(c)); break; }
        const c = store.getConversation(arg);
        if (!c) { out(A.red(`no conversation ${arg}`)); break; }
        st.conversationId = c.id;
        out(A.bold(`\n— resuming ${c.title} (${c.id}) —`));
        for (const e of store.readEvents(c.id)) { const l = renderEvent(e); if (l) out(l); }
        break;
      }
      case "rename": { if (arg) { app.rename(st.conversationId, arg); out(A.dim(`renamed → ${arg}`)); } break; }
      case "model": { if (arg) { st.model = arg; out(A.dim(`model: ${arg} (new conversations)`)); } else out(A.dim(`model: ${st.model}`)); break; }
      case "mode": {
        if (!arg || arg === "auto") { st.lane = undefined; out(A.dim("mode: auto (adaptive routing)")); }
        else if (LANES.includes(arg as Lane)) { st.lane = arg as Lane; out(A.dim(`mode: ${arg} (override for this session)`)); }
        else out(A.red(`unknown mode '${arg}' — one of: auto ${LANES.join(" ")}`));
        break;
      }
      case "diff": { const r = spawnSync("git", ["diff", "--stat"], { cwd, encoding: "utf8" }); out(r.stdout?.trim() ? r.stdout : A.dim("(no changes / not a git repo)")); break; }
      case "undo": { const res = app.undoLast(st.conversationId); out(res.ok ? A.green(`↩ restored ${res.restored.length}, deleted ${res.deleted.length}`) : A.red(`undo: ${res.reason}`)); break; }
      case "cat": { st.mascot = "ready"; for (const row of catAnsi(st.mascot)) out(row); break; }
      case "doctor": { out(`${A.green("✓")} node ${process.versions.node}`); out(await checkHealth(llm, st.model)); out(A.dim(`store: ${storePath()}`)); break; }
      case "web": out(A.dim("`kitten web` runs the browser UI — start it in another terminal.")); break;
      default: out(A.red(`unknown command /${cmd} — /help`));
    }
  };

  // Non-interactive (piped) input: run each line, then exit. Interactive: prompt loop.
  rl.on("line", (raw) => {
    rl.pause();
    handle(raw).catch((e) => out(A.red(`error: ${(e as Error).message}`))).finally(() => {
      if (!exiting) { rl.resume(); prompt(); }
    });
  });
  rl.on("close", () => { if (!exiting) { /* EOF on pipe */ } out(A.dim("\nbye")); store.close(); });

  prompt();
  // Keep the process alive until the readline closes.
  await new Promise<void>((r) => rl.on("close", () => r()));
}

// Auto-run only when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTui().catch((e) => { process.stderr.write(`kitten tui fatal: ${e?.stack ?? e}\n`); process.exit(1); });
}
