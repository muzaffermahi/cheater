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
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore } from "./store/conversationStore.js";
import { storePath } from "./paths.js";
import { KittenLLM, DEFAULT_MODELS, tierSidecar } from "./llm.js";
import { loadKittenSettings } from "./settings.js";
import { runRepl } from "./repl.js";
import { runTui } from "./tui.js";
import { runWeb, runServe } from "./web.js";
import { VERSION } from "../config.js";
import { runAttach } from "./tui.js";
import { gatherSupportInfo } from "./support.js";
import { launchApp, installLauncher } from "./app-launch.js";
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
  kitten init                first-time setup (check Node, endpoint, model)
  kitten run "<task>"        run one task (persisted + resumable)
  kitten resume [id]         replay a stored conversation
  kitten conversations|ls    list stored conversations
  kitten undo [id]           roll back the last file-changing run (git-backed)
  kitten doctor              check the runtime + endpoint
  kitten web                 local web UI
  kitten serve               daemon mode (starts background server)
  kitten attach              connect TUI to a running daemon
  kitten support             diagnostic bundle (copy-paste for support)
  kitten export [id]         export a conversation as Markdown
  kitten completions <shell>  generate shell completions (bash|zsh|fish|powershell)
  kitten app [--cwd DIR]    native desktop app (no browser fallback)
  kitten help

run options:  --cwd DIR  --model M  --lane answer|direct|reliable|bon|ascent  --k N  --json  --dangerous
              -c, --conversation <id>   continue an existing conversation (headless multi-turn)
`;

function isLane(s: string | undefined): s is Lane {
  return s === "answer" || s === "direct" || s === "reliable" || s === "bon" || s === "ascent";
}

/** A concise human line for a streamed/replayed event. Returns null for events not worth showing. */
function renderEvent(e: KittenEvent): string | null {
  switch (e.type) {
    case "user.message": return bold("you› ") + e.text;
    case "route.selected": return dim(`  route → ${e.lane}${e.k > 1 ? ` (k=${e.k})` : ""}  ${e.reasons.join("; ")}`);
    case "assistant.delta": return null; // streamed live by the run subscriber; skipped in replay (choppy)
    case "reasoning.delta": return null; // reasoning is streamed live, not replayed
    case "assistant.final": return e.text.trim() ? e.text.trim() : null;
    case "tool.approval_required": return red(`  ⚠ approval needed: ${e.name} — ${e.reason}`);
    case "tool.completed": return dim(`  ${e.ok ? "·" : "✗"} ${e.name}${e.output ? " " + e.output.replace(/\n/g, " ").slice(0, 80) : ""}`);
    case "verification.failed": return dim(`  ⓘ ${e.detail.slice(0, 100)}`);
    case "verification.passed": return dim(`  ✓ ${e.detail.slice(0, 100)}`);
    case "file.changed": return dim(`  ✎ ${e.path}`);
    case "repair.started": return dim(`  ↻ repair round ${e.round}`);
    case "run.undone": return dim(`  ↩ undo: restored ${e.restored.length}, deleted ${e.deleted.length}${e.skipped.length ? `, skipped ${e.skipped.length}` : ""}`);
    case "run.completed": {
      // Honest completion grade (§4): verified ≠ merely finished. Never a green check for lifecycle-only.
      const badge = e.verified ? green("  ✓ verified ") : e.finished ? yellow("  ~ checked (not independently verified) ") : yellow("  • finished, unverified ");
      return badge + (e.summary || "") + dim(` · ${(e.wallMs / 1000).toFixed(1)}s`);
    }
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
  let continueId: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--cwd") cwd = resolve(rest[++i] ?? ".");
    else if (a === "--model") model = rest[++i];
    else if (a === "--lane") { const l = rest[++i]; if (isLane(l)) lane = l; }
    else if (a === "--k") k = Math.max(1, Number(rest[++i]) || 1);
    else if (a === "--json") json = true;
    else if (a === "--dangerous" || a === "--yes") dangerous = true;
    else if (a === "--conversation" || a === "-c") continueId = rest[++i];
    else words.push(a);
  }
  const task = words.join(" ").trim();
  if (!task) { process.stderr.write('kitten run: give a task, e.g. kitten run "fix the parser"\n'); return 2; }

  const store = ConversationStore.open(storePath());
  // Resolve endpoint/model from config (env > project .kitten > user config > defaults); --model wins.
  const settings = loadKittenSettings(cwd);
  const resolvedModel = model ?? settings.models.main;
  const llm = new KittenLLM(tierSidecar({ ...settings.models, main: resolvedModel }));
  // Unattended headless runs default to auto-deny for destructive commands; --dangerous opts in.
  const app = new KittenApp({ store, runner: defaultRunner(llm), projectRoot: cwd, model: resolvedModel, approvalPolicy: dangerous ? "auto-allow" : "auto-deny" });
  app.recover();
  if (!json) {
    // Stream assistant deltas inline; finalize on assistant.final without re-printing (no duplicate text).
    const streamed = new Set<string>();
    app.subscribe((e) => {
      if (e.type === "assistant.delta") { streamed.add(e.runId); process.stdout.write(dim(e.text)); return; }
      if (e.type === "assistant.final") { process.stdout.write(streamed.has(e.runId) ? "\n" : "\n" + e.text + "\n"); return; }
      const line = renderEvent(e); if (line) process.stdout.write(line + "\n");
    });
  }

  // Continue an existing conversation (headless multi-turn) or start a new one.
  let conv;
  if (continueId) {
    const existing = store.getConversation(continueId);
    if (!existing) { process.stderr.write(`kitten run: no conversation ${continueId}\n`); store.close(); return 1; }
    if (model && existing.model && model !== existing.model) {
      process.stderr.write(`kitten run: conversation ${continueId} already runs model ${existing.model}; resume uses the recorded model. Start a new conversation to use --model.\n`);
      store.close(); return 2;
    }
    conv = existing;
  } else {
    conv = app.createConversation({ title: task.slice(0, 72), projectRoot: cwd, model });
  }
  if (!json) process.stdout.write(bold("Kitten") + dim(` · ${conv.id}${continueId ? " (continued)" : ""} · ${cwd}`) + "\n");
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
    : last.status === "completed" ? (last.verified ? "verified" : last.finished ? "checked" : "unverified")
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

interface EndpointDiagnostics {
  reachable: boolean;
  models: string[];
  errorKind: "none" | "refused" | "timeout" | "not_found" | "auth" | "unknown";
  errorDetail: string;
  /** Headers that help identify the provider (via response _and_ via error body probe). */
  providerHint: string;
}

async function diagnoseEndpoint(models = DEFAULT_MODELS): Promise<EndpointDiagnostics> {
  const base = { reachable: false, models: [] as string[], errorKind: "unknown" as const, errorDetail: "", providerHint: "" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${models.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${models.apiKey ?? "lm-studio"}` }, signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const j = await res.json() as { data?: Array<{ id?: string }> };
      const list = (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
      const xLlamaCpp = res.headers.get("x-llama-cpp") ?? "";
      const provider = xLlamaCpp ? `llama.cpp ${xLlamaCpp}` : "";
      return { reachable: true, models: list, errorKind: "none", errorDetail: "", providerHint: provider };
    }
    if (res.status === 401 || res.status === 403) {
      return { ...base, reachable: true, errorKind: "auth", errorDetail: `HTTP ${res.status} (check KITTEN_API_KEY)` };
    }
    if (res.status === 404) {
      return { ...base, reachable: true, errorKind: "not_found", errorDetail: "endpoint responded but /models returned 404 (not fatal — some providers omit it)" };
    }
    return { ...base, reachable: true, errorKind: "unknown", errorDetail: `HTTP ${res.status} ${res.statusText}` };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes("ECONNREFUSED") || msg.includes("Connection refused")) {
      return { ...base, errorKind: "refused", errorDetail: "connection refused — is the server running on this port?" };
    }
    if (msg.includes("ETIMEDOUT") || msg.includes("timeout") || msg.includes("AbortError") || msg.includes("aborted")) {
      return { ...base, errorKind: "timeout", errorDetail: "timeout — server did not respond in 4s" };
    }
    if (msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN") || msg.includes("getaddrinfo")) {
      return { ...base, errorKind: "refused", errorDetail: "host not found — check KITTEN_BASE_URL" };
    }
    return { ...base, errorKind: "unknown", errorDetail: msg };
  }
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

  // Config transparency (§7): show which files were merged + any validation warnings.
  const settings = loadKittenSettings(process.cwd());
  if (settings.sources.length) process.stdout.write(`${green("✓")} config: ${settings.sources.join(", ")}\n`);
  else process.stdout.write(dim("○ config: defaults + env (no config file)\n"));
  for (const w of settings.warnings) { process.stdout.write(`${yellow("!")} ${w}\n`); }

  // Endpoint + model + engine.
  const models = tierSidecar(settings.models);
  const llm = new KittenLLM(models);
  const ep = await diagnoseEndpoint(models);
  if (!ep.reachable) {
    bad++;
    process.stdout.write(`${red("✗")} endpoint unreachable at ${models.baseUrl}\n`);
    process.stdout.write(dim(`    ${ep.errorDetail || "unknown error"}\n`));
    if (ep.errorKind === "refused") {
      process.stdout.write(dim("    → start LM Studio with a loaded model, or launch: llama-server -m MODEL.gguf --port 1234\n"));
      process.stdout.write(dim("    → then set: export KITTEN_BASE_URL=http://localhost:1234/v1\n"));
    } else if (ep.errorKind === "timeout") {
      process.stdout.write(dim("    → check the port and that no firewall is blocking localhost\n"));
    }
  } else {
    const providerLine = ep.providerHint ? `  (${ep.providerHint})` : "";
    if (ep.errorKind === "auth") {
      bad++;
      process.stdout.write(`${red("✗")} endpoint auth failed at ${models.baseUrl}\n`);
      process.stdout.write(dim(`    ${ep.errorDetail}\n`));
      process.stdout.write(dim("    → set KITTEN_API_KEY (LM Studio default is \"lm-studio\"; llama.cpp has no default key)\n"));
    } else if (ep.errorKind === "not_found") {
      process.stdout.write(`${yellow("○")} ${ep.errorDetail}${providerLine}\n`);
    } else if (!ep.reachable) {
      bad++;
      process.stdout.write(`${red("✗")} endpoint at ${models.baseUrl}: ${ep.errorDetail}\n`);
      process.stdout.write(dim("    → set KITTEN_BASE_URL to your local server, e.g. http://localhost:1234/v1\n"));
    } else {
      process.stdout.write(`${green("✓")} endpoint reachable at ${models.baseUrl}${providerLine}\n`);
    }
    // Ping is authoritative: a llama.cpp single-model server advertises the .gguf path in /v1/models but
    // accepts ANY model id and returns the loaded model — so an id-list mismatch is NOT "model missing".
    if (ep.reachable && ep.errorKind !== "auth") {
      const responds = await llm.ping(models.main);
      if (responds) {
        const engine = await llm.detectEngine();
        const advertised = ep.models.length === 0 || ep.models.includes(models.main);
        const note = advertised ? "" : "  (server advertises a different id but accepts this one)";
        process.stdout.write(`${green("✓")} model '${models.main}' responds${note}\n`);
        const engineLabel = engine === "llamacpp" ? "llama.cpp (native — grammar/min-p/logprobs/cache-prompt available)" : "OpenAI-compatible proxy";
        process.stdout.write(dim(`    engine: ${engineLabel}\n`));
        if (engine === "llamacpp") {
          process.stdout.write(dim("    → streaming, constraint bans, and prompt-cache reuse are available\n"));
        }
        if (!advertised && ep.models.length) {
          process.stdout.write(dim(`    (advertised: ${ep.models.slice(0, 4).map((m) => m.split(/[\\/]/).pop()).join(", ")})\n`));
        }
      } else if (ep.models.length && !ep.models.includes(models.main)) {
        bad++;
        process.stdout.write(`${red("✗")} model '${models.main}' not loaded and probe failed\n`);
        process.stdout.write(dim(`    available: ${ep.models.slice(0, 5).map((m) => m.split(/[\\/]/).pop()).join(", ") || "none"}\n`));
        process.stdout.write(dim(`    → set KITTEN_MAIN_MODEL to an available model name (e.g. export KITTEN_MAIN_MODEL="${ep.models[0]?.split(/[\\/]/).pop() ?? "ornith"}")\n`));
      } else {
        bad++;
        process.stdout.write(`${red("✗")} model '${models.main}' did not respond — verify the model is loaded\n`);
      }
    }
  }
  // Show the resolved model name if set, otherwise default.
  if (!settings.models.main || settings.models.main === DEFAULT_MODELS.main) {
    process.stdout.write(dim("○ no KITTEN_MAIN_MODEL set — using default (set it to your loaded model name)\n"));
  }

  // Git (affects /undo).
  const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: process.cwd(), encoding: "utf8" }).stdout?.trim() === "true";
  process.stdout.write(`${inGit ? green("✓") : yellow("○")} git repository${inGit ? "" : "  (not a git repo — allowed, but /undo needs git for rollback)"}\n`);

  process.stdout.write(bad ? red(`\n${bad} issue${bad === 1 ? "" : "s"} to resolve.\n`) : green("\nall good.\n"));
  return bad ? 1 : 0;
}

async function cmdInit(): Promise<number> {
  process.stdout.write(bold("Kitten") + dim(" — first-time setup") + "\n\n");
  process.stdout.write(dim("Checks Node, storage, endpoint, and model. ")
    + "On a clean machine, export two env vars first:\n\n"
    + dim("  export KITTEN_BASE_URL=http://localhost:1234/v1\n")
    + dim("  export KITTEN_MAIN_MODEL=ornith-1.0-35b\n\n"));
  const code = await cmdDoctor();
  process.stdout.write("\n" + dim("To run your first task:") + "\n");
  process.stdout.write(dim("  kitten run \"write a hello.py that prints a greeting\"") + "\n");
  process.stdout.write(dim("Or open the interactive session: kitten") + "\n");
  return code;
}

function cmdExport(rest: string[]): number {
  const id = rest.find((a) => !a.startsWith("--"));
  const store = ConversationStore.open(storePath());
  if (!id) {
    const convs = store.listConversations({ limit: 10 });
    if (!convs.length) { process.stdout.write("no conversations to export\n"); store.close(); return 0; }
    process.stdout.write("export one of:\n");
    for (const c of convs) process.stdout.write(`  ${c.id}  ${c.title}\n`);
    store.close();
    return 0;
  }
  const conv = store.getConversation(id);
  if (!conv) { process.stderr.write(`kitten export: no conversation ${id}\n`); store.close(); return 1; }
  const events = store.readEvents(id);
  const runs = store.listRuns(id);
  const lines: string[] = [`# ${conv.title}`, `_kitten conversation ${id} · model: ${conv.model}_\n`];
  for (const e of events) {
    if (e.type === "user.message") lines.push(`\n## You — ${new Date(e.ts).toLocaleTimeString()}\n${e.text}`);
    if (e.type === "assistant.final") lines.push(`\n## Kitten — ${new Date(e.ts).toLocaleTimeString()}\n${e.text}`);
  }
  const markdown = lines.join("\n");
  const slug = conv.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 32);
  const outPath = resolve(process.cwd(), `${slug}-${id.slice(-8)}.md`);
  writeFileSync(outPath, markdown, "utf8");
  process.stdout.write(`exported to ${outPath}\n`);
  store.close();
  return 0;
}

function cmdCompletions(rest: string[]): number {
  const shell = rest[0] || "bash";
  const allCommands = ["run", "resume", "conversations", "ls", "undo", "doctor", "init", "web", "serve", "attach", "help", "support", "export", "completions", "app", "repl"];
  const flags = ["--cwd", "--model", "--lane", "--k", "--json", "--dangerous", "--yes", "--conversation", "-c", "--port", "--no-open", "--replace", "--print-connection", "--url", "--token"];
  switch (shell) {
    case "bash":
      process.stdout.write(`# kitten bash completion\ncomplete -W "${allCommands.join(" ")}" kitten\n`);
      break;
    case "zsh":
      process.stdout.write(`#compdef kitten\n_arguments "1: :(${allCommands.join(" ")})" "*: :(${flags.join(" ")})"\n`);
      break;
    case "fish":
      process.stdout.write(`complete -c kitten -f -a "${allCommands.join(" ")}"\n`);
      for (const f of flags) process.stdout.write(`complete -c kitten -l "${f.replace(/^--/, "")}"\n`);
      break;
    case "powershell":
      process.stdout.write(`Register-ArgumentCompleter -Native -CommandName kitten -ScriptBlock {
  param(\$wordToComplete, \$commandAst, \$cursorPosition)
  ${allCommands.map((c) => `"${c}"`).join("; ")} | Where-Object { \$_ -like \$wordToComplete + '*' } | ForEach-Object { [System.Management.Automation.CompletionResult]::new(\$_) }
}\n`);
      break;
    default:
      process.stderr.write(`kitten completions: unknown shell '${shell}' (use bash|zsh|fish|powershell)\n`);
      return 1;
  }
  return 0;
}

async function cmdApp(rest: string[]): Promise<number> {
  const install = rest.includes("--install");
  const dryRun = rest.includes("--dry-run");
  const cwdFlag = rest.indexOf("--cwd");
  const cwd = cwdFlag >= 0 ? rest[cwdFlag + 1] : undefined;
  if (install) {
    await installLauncher({ install: true, dryRun });
    return 0;
  }
  await launchApp({ cwd });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run": return cmdRun(rest);
    case "resume": return cmdResume(rest);
    case "conversations": case "ls": return cmdConversations(rest);
    case "undo": return cmdUndo(rest);
    case "doctor": return await cmdDoctor();
    case "init": return await cmdInit();
    case "web": await runWeb(rest); return 0;
    case "serve": await runServe(rest); return 0;
    case "attach": await runAttach(rest); return 0;
    case "support": process.stdout.write((await gatherSupportInfo()) + "\n"); return 0;
    case "export": return cmdExport(rest);
    case "completions": return cmdCompletions(rest);
    case "app": return await cmdApp(rest);
    case "repl": await runRepl(rest); return 0; // the minimal readline REPL (compatibility)
    case "help": case "--help": case "-h": process.stdout.write(HELP); return 0;
    case "version": case "--version": case "-v": process.stdout.write(VERSION + "\n"); return 0;
    case undefined: await runTui([]); return 0; // bare `kitten` → the full TUI
    default:
      // Unknown leading token → treat the whole argv as a one-shot task (back-compat with `kitten "<task>"`).
      return cmdRun(argv);
  }
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`kitten fatal: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  process.exit(1);
});
main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`kitten fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
