#!/usr/bin/env node
// Kitten — the canonical command. NO Pi.
//
//   kitten                       open the interactive session in the current directory
//   kitten run "<task>"          run one task here; it is PERSISTED and resumable
//   kitten resume [id]           replay a stored conversation (no id → list recent)
//   kitten conversations | ls    list stored conversations
//   kitten doctor                environment + endpoint checks (basic; full check lands in Phase E)
//   kitten web                   local web UI (coming in a later preview)
//   kitten help
//
// Every `run` goes through the ONE application service (app.ts): routed → executed → persisted →
// replayable. This is the entry that proves the Phase-A spine end to end from a real command.

import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore } from "./store/conversationStore.js";
import { storePath } from "./paths.js";
import { KittenLLM, DEFAULT_MODELS, tierSidecar } from "./llm.js";
import { runRepl } from "./repl.js";
import { runTui } from "./tui.js";
import { runWeb } from "./web.js";
import type { KittenEvent, Lane } from "./events.js";
import type { ConversationRow } from "./store/conversationStore.js";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;

const HELP = `${bold("Kitten")} — a reliable local-first coding agent

Usage:
  kitten                     open the interactive session
  kitten run "<task>"        run one task (persisted + resumable)
  kitten resume [id]         replay a stored conversation
  kitten conversations|ls    list stored conversations
  kitten undo [id]           roll back the last file-changing run (git-backed)
  kitten doctor              check the runtime + endpoint
  kitten web                 local web UI (later preview)
  kitten help

run options:  --cwd DIR  --model M  --lane answer|direct|reliable|bon|ascent  --k N  --json  --dangerous
`;

function isLane(s: string | undefined): s is Lane {
  return s === "answer" || s === "direct" || s === "reliable" || s === "bon" || s === "ascent";
}

/** A concise human line for a streamed/replayed event. Returns null for events not worth showing. */
function renderEvent(e: KittenEvent): string | null {
  switch (e.type) {
    case "user.message": return bold("you› ") + e.text;
    case "route.selected": return dim(`  route → ${e.lane}${e.k > 1 ? ` (k=${e.k})` : ""}  ${e.reasons.join("; ")}`);
    case "assistant.delta": return e.text.trim() ? dim("  · ") + e.text.trim() : null;
    case "assistant.final": return e.text.trim() ? e.text.trim() : null;
    case "tool.approval_required": return red(`  ⚠ approval needed: ${e.name} — ${e.reason}`);
    case "tool.completed": return dim(`  ${e.ok ? "·" : "✗"} ${e.name}${e.output ? " " + e.output.replace(/\n/g, " ").slice(0, 80) : ""}`);
    case "verification.failed": return dim(`  ⓘ ${e.detail.slice(0, 100)}`);
    case "verification.passed": return dim(`  ✓ ${e.detail.slice(0, 100)}`);
    case "file.changed": return dim(`  ✎ ${e.path}`);
    case "repair.started": return dim(`  ↻ repair round ${e.round}`);
    case "run.undone": return dim(`  ↩ undo: restored ${e.restored.length}, deleted ${e.deleted.length}${e.skipped.length ? `, skipped ${e.skipped.length}` : ""}`);
    case "run.completed": return (e.finished ? green("  ✓ ") : red("  ✗ ")) + (e.summary || (e.finished ? "done" : "unfinished")) + dim(` · ${(e.wallMs / 1000).toFixed(1)}s`);
    case "run.failed": return red(`  ✗ failed: ${e.error}`);
    case "run.cancelled": return red("  ✗ cancelled");
    case "run.interrupted": return red(`  ✗ interrupted (was ${e.fromStatus})`);
    case "receipt.finalized": return e.lines.length ? dim("  receipt: " + e.lines.join(" | ").slice(0, 200)) : null;
    default: return null;
  }
}

async function cmdRun(rest: string[]): Promise<number> {
  let cwd = process.cwd();
  let model: string | undefined;
  let lane: Lane | undefined;
  let k: number | undefined;
  let json = false;
  let dangerous = false;
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--cwd") cwd = resolve(rest[++i] ?? ".");
    else if (a === "--model") model = rest[++i];
    else if (a === "--lane") { const l = rest[++i]; if (isLane(l)) lane = l; }
    else if (a === "--k") k = Math.max(1, Number(rest[++i]) || 1);
    else if (a === "--json") json = true;
    else if (a === "--dangerous" || a === "--yes") dangerous = true;
    else words.push(a);
  }
  const task = words.join(" ").trim();
  if (!task) { process.stderr.write('kitten run: give a task, e.g. kitten run "fix the parser"\n'); return 2; }

  const store = ConversationStore.open(storePath());
  // Unattended headless runs default to auto-deny for destructive commands; --dangerous opts in.
  const app = new KittenApp({ store, runner: defaultRunner(), projectRoot: cwd, model, approvalPolicy: dangerous ? "auto-allow" : "auto-deny" });
  app.recover();
  if (!json) app.subscribe((e) => { const line = renderEvent(e); if (line) process.stdout.write(line + "\n"); });

  const conv = app.createConversation({ title: task.slice(0, 72), projectRoot: cwd, model });
  if (!json) process.stdout.write(bold("Kitten") + dim(` · ${conv.id} · ${cwd}`) + "\n");
  const run = await app.submitMessage(conv.id, task, { lane, k });

  if (json) {
    process.stdout.write(JSON.stringify({ conversationId: conv.id, run }) + "\n");
  } else {
    process.stdout.write(dim(`\nsaved · resume with: `) + cyan(`kitten resume ${conv.id}`) + "\n");
  }
  store.close();
  return run.finished ? 0 : 1;
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toISOString().replace("T", " ").slice(0, 16);
}

function convLine(c: ConversationRow, store: ConversationStore): string {
  const runs = store.listRuns(c.id);
  const last = runs[runs.length - 1];
  // Show the task outcome, not just the run lifecycle: a run can reach "completed" without solving.
  const state = !last ? "—"
    : last.status === "completed" ? (last.finished ? (last.verified ? "verified" : "done") : "unfinished")
    : last.status;
  return `${cyan(c.id.padEnd(16))} ${fmtWhen(c.updatedAt)}  ${dim(state.padEnd(11))} ${c.title}`;
}

function cmdConversations(rest: string[]): number {
  const search = rest.find((a) => !a.startsWith("--"));
  const store = ConversationStore.open(storePath());
  const rows = store.listConversations({ search, limit: 50 });
  if (!rows.length) { process.stdout.write(dim("no conversations yet — run one with: kitten run \"…\"\n")); store.close(); return 0; }
  process.stdout.write(bold("Conversations\n"));
  for (const c of rows) process.stdout.write(convLine(c, store) + "\n");
  store.close();
  return 0;
}

function cmdResume(rest: string[]): number {
  const id = rest.find((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const store = ConversationStore.open(storePath());
  if (!id) {
    const rows = store.listConversations({ limit: 20 });
    if (!rows.length) { process.stdout.write(dim("no conversations to resume\n")); store.close(); return 0; }
    process.stdout.write(dim("resume one of:\n"));
    for (const c of rows) process.stdout.write(convLine(c, store) + "\n");
    store.close();
    return 0;
  }
  const conv = store.getConversation(id);
  if (!conv) { process.stderr.write(`kitten resume: no conversation ${id}\n`); store.close(); return 1; }
  const events = store.readEvents(id);
  if (json) {
    process.stdout.write(JSON.stringify({ conversation: conv, events, runs: store.listRuns(id) }) + "\n");
    store.close();
    return 0;
  }
  process.stdout.write(bold(conv.title) + dim(` · ${conv.id} · ${conv.projectRoot} · ${fmtWhen(conv.updatedAt)}`) + "\n");
  for (const e of events) { const line = renderEvent(e); if (line) process.stdout.write(line + "\n"); }
  store.close();
  return 0;
}

function cmdUndo(rest: string[]): number {
  const id = rest.find((a) => !a.startsWith("--"));
  const store = ConversationStore.open(storePath());
  if (!id) {
    // Undo the most recently updated conversation's last file-changing run.
    const latest = store.listConversations({ limit: 1 })[0];
    if (!latest) { process.stdout.write(dim("nothing to undo\n")); store.close(); return 0; }
    return finishUndo(store, latest.id);
  }
  if (!store.getConversation(id)) { process.stderr.write(`kitten undo: no conversation ${id}\n`); store.close(); return 1; }
  return finishUndo(store, id);
}

function finishUndo(store: ConversationStore, conversationId: string): number {
  const app = new KittenApp({ store, runner: async () => ({ finished: false, summary: "", wallMs: 0, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false }) });
  const res = app.undoLast(conversationId);
  if (!res.ok) { process.stdout.write(red(`undo: ${res.reason ?? "nothing to undo"}\n`)); store.close(); return 1; }
  process.stdout.write(green(`↩ undone`) + dim(` · restored ${res.restored.length}, deleted ${res.deleted.length}${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}\n`));
  for (const f of res.restored) process.stdout.write(dim(`  restored ${f}\n`));
  for (const f of res.deleted) process.stdout.write(dim(`  deleted  ${f}\n`));
  store.close();
  return 0;
}

async function endpointModels(models = DEFAULT_MODELS): Promise<{ reachable: boolean; models: string[] }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${models.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${models.apiKey ?? "lm-studio"}` }, signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { reachable: true, models: [] };
    const j = await res.json() as { data?: Array<{ id?: string }> };
    return { reachable: true, models: (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean) };
  } catch { return { reachable: false, models: [] }; }
}

async function cmdDoctor(): Promise<number> {
  let bad = 0;
  const ok = (b: boolean): string => (b ? green("✓") : red("✗"));

  // Node.
  const node = process.versions.node;
  const okNode = Number(node.split(".")[0]) >= 22;
  if (!okNode) bad++;
  process.stdout.write(`${ok(okNode)} Node ${node}${okNode ? "" : "  (need >= 22.5 for the durable store)"}\n`);

  // Storage.
  try {
    const store = ConversationStore.open(storePath());
    const n = store.listConversations({ includeArchived: true, limit: 1000 }).length;
    store.close();
    process.stdout.write(`${green("✓")} store writable at ${storePath()} (${n} conversation${n === 1 ? "" : "s"})\n`);
  } catch (e) {
    bad++;
    process.stdout.write(`${red("✗")} store: ${(e as Error).message}\n`);
  }

  // Endpoint + model + engine.
  const models = tierSidecar(DEFAULT_MODELS);
  const llm = new KittenLLM(models);
  const ep = await endpointModels(models);
  if (!ep.reachable) {
    bad++;
    process.stdout.write(`${red("✗")} endpoint unreachable at ${models.baseUrl}  (start LM Studio / llama.cpp, or set KITTEN_BASE_URL)\n`);
  } else {
    process.stdout.write(`${green("✓")} endpoint reachable at ${models.baseUrl}\n`);
    const hasModel = ep.models.length === 0 || ep.models.includes(models.main);
    if (!hasModel) {
      bad++;
      process.stdout.write(`${red("✗")} model '${models.main}' not loaded  (available: ${ep.models.slice(0, 6).join(", ") || "none"}; set KITTEN_MAIN_MODEL)\n`);
    } else {
      const responds = await llm.ping(models.main);
      if (!responds) { bad++; process.stdout.write(`${red("✗")} model '${models.main}' did not respond to a probe\n`); }
      else {
        const engine = await llm.detectEngine();
        process.stdout.write(`${green("✓")} model '${models.main}' responds  (engine: ${engine}${engine === "llamacpp" ? " — grammar/min-p/logprobs available" : ""})\n`);
      }
    }
  }

  // Git (affects /undo).
  const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: process.cwd(), encoding: "utf8" }).stdout?.trim() === "true";
  process.stdout.write(`${inGit ? green("✓") : yellow("○")} git repository${inGit ? "" : "  (not a git repo — allowed, but /undo needs git for rollback)"}\n`);

  process.stdout.write(bad ? red(`\n${bad} issue${bad === 1 ? "" : "s"} to resolve.\n`) : green("\nall good.\n"));
  return bad ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run": return cmdRun(rest);
    case "resume": return cmdResume(rest);
    case "conversations": case "ls": return cmdConversations(rest);
    case "undo": return cmdUndo(rest);
    case "doctor": return await cmdDoctor();
    case "web": await runWeb(rest); return 0;
    case "repl": await runRepl(rest); return 0; // the minimal readline REPL (compatibility)
    case "help": case "--help": case "-h": process.stdout.write(HELP); return 0;
    case undefined: await runTui([]); return 0; // bare `kitten` → the full TUI
    default:
      // Unknown leading token → treat the whole argv as a one-shot task (back-compat with `kitten "<task>"`).
      return cmdRun(argv);
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`kitten fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
