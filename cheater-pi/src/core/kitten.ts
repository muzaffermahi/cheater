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
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore } from "./store/conversationStore.js";
import { storePath } from "./paths.js";
import { runRepl } from "./repl.js";
import type { KittenEvent, Lane } from "./events.js";
import type { ConversationRow } from "./store/conversationStore.js";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

const HELP = `${bold("Kitten")} — a reliable local-first coding agent

Usage:
  kitten                     open the interactive session
  kitten run "<task>"        run one task (persisted + resumable)
  kitten resume [id]         replay a stored conversation
  kitten conversations|ls    list stored conversations
  kitten doctor              check the runtime + endpoint
  kitten web                 local web UI (later preview)
  kitten help

run options:  --cwd DIR  --model M  --lane answer|direct|reliable|bon|ascent  --k N  --json
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
    case "tool.completed": return dim(`  ${e.ok ? "·" : "✗"} ${e.name}${e.output ? " " + e.output.replace(/\n/g, " ").slice(0, 80) : ""}`);
    case "verification.failed": return dim(`  ⓘ ${e.detail.slice(0, 100)}`);
    case "verification.passed": return dim(`  ✓ ${e.detail.slice(0, 100)}`);
    case "file.changed": return dim(`  ✎ ${e.path}`);
    case "repair.started": return dim(`  ↻ repair round ${e.round}`);
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
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--cwd") cwd = resolve(rest[++i] ?? ".");
    else if (a === "--model") model = rest[++i];
    else if (a === "--lane") { const l = rest[++i]; if (isLane(l)) lane = l; }
    else if (a === "--k") k = Math.max(1, Number(rest[++i]) || 1);
    else if (a === "--json") json = true;
    else words.push(a);
  }
  const task = words.join(" ").trim();
  if (!task) { process.stderr.write('kitten run: give a task, e.g. kitten run "fix the parser"\n'); return 2; }

  const store = ConversationStore.open(storePath());
  const app = new KittenApp({ store, runner: defaultRunner(), projectRoot: cwd, model });
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

function cmdDoctor(): number {
  // Basic Phase-A checks; the full doctor (endpoint capabilities, storage, git, node) lands in Phase E.
  const node = process.versions.node;
  const okNode = Number(node.split(".")[0]) >= 22;
  process.stdout.write(`${okNode ? green("✓") : red("✗")} Node ${node} ${okNode ? "" : "(need >= 22.5 for the durable store)"}\n`);
  try {
    const store = ConversationStore.open(storePath());
    const n = store.listConversations({ includeArchived: true, limit: 1000 }).length;
    store.close();
    process.stdout.write(`${green("✓")} store at ${storePath()} (${n} conversation${n === 1 ? "" : "s"})\n`);
  } catch (e) {
    process.stdout.write(`${red("✗")} store: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(dim("endpoint + model checks arrive with the full `kitten doctor` in a later preview.\n"));
  return okNode ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run": return cmdRun(rest);
    case "resume": return cmdResume(rest);
    case "conversations": case "ls": return cmdConversations(rest);
    case "doctor": return cmdDoctor();
    case "web": process.stdout.write(dim("kitten web arrives in a later preview (Phase D).\n")); return 0;
    case "help": case "--help": case "-h": process.stdout.write(HELP); return 0;
    case undefined: await runRepl([]); return 0; // bare `kitten` → interactive session
    default:
      // Unknown leading token: treat the whole argv as REPL flags/one-shot (back-compat with `kitten "<task>"`).
      await runRepl(argv);
      return 0;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`kitten fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
