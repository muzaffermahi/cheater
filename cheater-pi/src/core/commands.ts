// Kitten Core — the shared command registry. NO Pi.
//
// ONE registry used by TUI, web, and headless. Every command is a KittenCommand in the COMMANDS
// array. The TUI and web composer both call runCommand(); behavior cannot diverge.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { KittenApp } from "./app.js";
import type { KittenLLM } from "./llm.js";
import type { KittenSettings } from "./settings.js";
import type { Lane } from "./events.js";
import type { ConversationStore } from "./store/conversationStore.js";
import { listAgents } from "./agents.js";

export interface CommandFrame {
  type: "text" | "table" | "diff" | "error" | "success";
  text?: string;
  rows?: string[][];
  header?: string[];
  diff?: string;
}

export interface CommandIO {
  print(text: string, style?: "dim" | "ok" | "warn" | "error"): void;
  table(rows: string[][], header?: string[]): void;
  frame(frame: CommandFrame): void;
}

export interface SessionState {
  conversationId: string | null;
  model: string;
  provider: string | null;
  lane: Lane | null;
}

export interface CommandContext {
  app: KittenApp;
  store: ConversationStore;
  llm: KittenLLM;
  settings: KittenSettings;
  session: SessionState;
  cwd: string;
  io: CommandIO;
}

export interface KittenCommand {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
  run(ctx: CommandContext, arg: string): Promise<void>;
}

const dim = (s: string): string => s;
const green = (s: string): string => s;
const red = (s: string): string => s;
const yellow = (s: string): string => s;
const cyan = (s: string): string => s;
const bold = (s: string): string => s;

export const COMMANDS: KittenCommand[] = [
  {
    name: "help",
    usage: "/help",
    description: "Show this help",
    async run(ctx) {
      const lines = COMMANDS.map((c) => `  ${c.usage.padEnd(28)} ${c.description}`);
      ctx.io.print(bold("Commands:"), "ok");
      for (const l of lines) ctx.io.print(l, "dim");
    },
  },
  {
    name: "exit", aliases: ["quit"],
    usage: "/exit",
    description: "Exit the session",
    async run() { process.exit(0); },
  },
  {
    name: "new",
    usage: "/new",
    description: "Start a new conversation",
    async run(ctx) {
      const conv = ctx.app.createConversation({ projectRoot: ctx.cwd, model: ctx.session.model });
      ctx.session.conversationId = conv.id;
      ctx.io.print(`new conversation ${conv.id}`, "ok");
    },
  },
  {
    name: "conversations", aliases: ["ls"],
    usage: "/conversations",
    description: "List recent conversations",
    async run(ctx) {
      const rows = ctx.store.listConversations({ limit: 20 });
      if (!rows.length) { ctx.io.print("no conversations yet", "dim"); return; }
      const table = rows.map((c) => {
        const runs = ctx.store.listRuns(c.id);
        const last = runs[runs.length - 1];
        const state = !last ? "\u2014" : last.status;
        return [
          c.id.slice(0, 12),
          new Date(c.updatedAt).toISOString().slice(0, 16).replace("T", " "),
          state,
          c.title,
        ];
      });
      ctx.io.table(table, ["id", "updated", "status", "title"]);
    },
  },
  {
    name: "resume",
    usage: "/resume <id>",
    description: "Resume a stored conversation",
    async run(ctx, arg) {
      if (!arg) { ctx.io.print("resume which? (use /conversations to list)", "warn"); return; }
      const c = ctx.store.getConversation(arg);
      if (!c) { ctx.io.print(`no conversation ${arg}`, "error"); return; }
      ctx.session.conversationId = c.id;
      ctx.session.model = c.model;
      ctx.io.print(`\u2014 resuming ${c.title} (${c.id}) \u2014`, "ok");
    },
  },
  {
    name: "rename",
    usage: "/rename <title>",
    description: "Rename the current conversation",
    async run(ctx, arg) {
      if (!arg || !ctx.session.conversationId) { ctx.io.print("rename to what?", "warn"); return; }
      ctx.app.rename(ctx.session.conversationId, arg);
      ctx.io.print(`renamed \u2192 ${arg}`, "ok");
    },
  },
  {
    name: "model",
    usage: "/model [name]",
    description: "Show or change the session model",
    async run(ctx, arg) {
      if (arg) {
        ctx.session.model = arg;
        ctx.io.print(`model: ${arg} (new conversations)`, "ok");
      } else {
        ctx.io.print(`model: ${ctx.session.model}`, "dim");
      }
    },
  },
  {
    name: "mode",
    usage: "/mode [auto|answer|direct|reliable|bon|ascent]",
    description: "Lane override for this session",
    async run(ctx, arg) {
      const LANES: Lane[] = ["answer", "direct", "reliable", "bon", "ascent"];
      if (!arg || arg === "auto") {
        ctx.session.lane = null;
        ctx.io.print("mode: auto (adaptive routing)", "ok");
      } else if (LANES.includes(arg as Lane)) {
        ctx.session.lane = arg as Lane;
        ctx.io.print(`mode: ${arg} (override for this session)`, "ok");
      } else {
        ctx.io.print(`unknown mode '${arg}' \u2014 one of: auto ${LANES.join(" ")}`, "error");
      }
    },
  },
  {
    name: "diff",
    usage: "/diff",
    description: "Show the git diff of the working tree",
    async run(ctx) {
      const r = spawnSync("git", ["diff", "--stat"], { cwd: ctx.cwd, encoding: "utf8" });
      if (r.stdout?.trim()) {
        ctx.io.frame({ type: "diff", diff: r.stdout });
      } else {
        ctx.io.print("(no changes / not a git repo)", "dim");
      }
    },
  },
  {
    name: "undo",
    usage: "/undo",
    description: "Roll back the last file-changing run",
    async run(ctx) {
      if (!ctx.session.conversationId) { ctx.io.print("no active conversation", "warn"); return; }
      const res = ctx.app.undoLast(ctx.session.conversationId);
      if (res.ok) {
        ctx.io.print(`\u21a9 restored ${res.restored.length}, deleted ${res.deleted.length}`, "ok");
      } else {
        ctx.io.print(`undo: ${res.reason}`, "error");
      }
    },
  },
  {
    name: "doctor",
    usage: "/doctor",
    description: "Run environment checks",
    async run(ctx) {
      ctx.io.print(`node ${process.versions.node}`, "ok");
      ctx.io.print("store: local database", "dim");
      ctx.io.print("doctor: run \`kitten doctor\` for full diagnostics", "dim");
    },
  },
  {
    name: "web",
    usage: "/web",
    description: "Start the web UI (run \`kitten web\` in another terminal)",
    async run(ctx) {
      ctx.io.print("\`kitten web\` runs the browser UI \u2014 start it in another terminal.", "dim");
    },
  },
  {
    name: "search",
    usage: "/search <query>",
    description: "Search conversation titles",
    async run(ctx, arg) {
      if (!arg) { ctx.io.print("search for what?", "warn"); return; }
      const hits = ctx.store.listConversations({ search: arg, limit: 20 });
      if (!hits.length) {
        ctx.io.print(`no conversations matching "${arg}"`, "dim");
      } else {
        ctx.io.print(`${hits.length} match${hits.length > 1 ? "es" : ""}:`, "ok");
        for (const c of hits) ctx.io.print(`  ${c.id}  ${c.title}`, "dim");
      }
    },
  },
  {
    name: "archive",
    usage: "/archive <id>",
    description: "Archive / unarchive a conversation",
    async run(ctx, arg) {
      if (!arg) { ctx.io.print("archive which conversation id?", "warn"); return; }
      const c = ctx.store.getConversation(arg);
      if (!c) { ctx.io.print(`no conversation ${arg}`, "error"); return; }
      ctx.app.archive(arg, !c.archived);
      ctx.io.print(c.archived ? `unarchived ${arg}` : `archived ${arg}`, "ok");
    },
  },
  {
    name: "status",
    usage: "/status",
    description: "Show current conversation + model info",
    async run(ctx) {
      ctx.io.print(bold("Status"), "ok");
      ctx.io.print(`  conversation: ${ctx.session.conversationId || "(none)"}`, "dim");
      ctx.io.print(`  model:        ${ctx.session.model}`, "dim");
      ctx.io.print(`  lane:         ${ctx.session.lane || "auto"}`, "dim");
      if (ctx.session.conversationId) {
        const runs = ctx.app.getRuns(ctx.session.conversationId);
        ctx.io.print(`  runs:         ${runs.length}`, "dim");
      }
    },
  },
  {
    name: "redo",
    usage: "/redo",
    description: "Re-apply the last undone run",
    async run(ctx) {
      if (!ctx.session.conversationId) { ctx.io.print("no active conversation", "warn"); return; }
      const res = ctx.app.redoLast(ctx.session.conversationId);
      if (res.ok) {
        ctx.io.print(`↪ restored ${res.restored.length}, deleted ${res.deleted.length}`, "ok");
      } else {
        ctx.io.print(`redo: ${res.reason}`, "error");
      }
    },
  },
  {
    name: "export",
    usage: "/export",
    description: "Export the conversation as Markdown",
    async run(ctx) {
      if (!ctx.session.conversationId) { ctx.io.print("no active conversation", "warn"); return; }
      try {
        ctx.io.frame({ type: "text", text: ctx.app.exportConversationMarkdown(ctx.session.conversationId) });
      } catch (error) {
        ctx.io.print(`export: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  },
  {
    name: "delete",
    usage: "/delete",
    description: "Delete the current conversation (use /archive to keep)",
    async run(ctx) {
      if (!ctx.session.conversationId) { ctx.io.print("no active conversation", "warn"); return; }
      ctx.app.archive(ctx.session.conversationId, true);
      ctx.session.conversationId = null;
      ctx.io.print("conversation archived", "ok");
    },
  },
  {
    name: "usage",
    usage: "/usage",
    description: "Show token usage for this conversation",
    async run(ctx) {
      if (!ctx.session.conversationId) { ctx.io.print("no active conversation", "warn"); return; }
      const runs = ctx.app.getRuns(ctx.session.conversationId);
      let total = { prompt: 0, completion: 0, reasoning: 0 };
      for (const r of runs) {
        total.prompt += r.usage.prompt;
        total.completion += r.usage.completion;
        total.reasoning += r.usage.reasoning;
      }
      ctx.io.print(`usage: ${total.prompt}p / ${total.completion}c / ${total.reasoning}r tokens`, "dim");
    },
  },
  {
    name: "cat",
    usage: "/cat",
    description: "Show the mascot",
    async run(ctx) {
      ctx.io.print("(=^･^=)", "ok");
    },
  },
  {
    name: "retry",
    usage: "/retry",
    description: "Re-submit the last user message on a failed/cancelled run",
    async run(ctx) {
      if (!ctx.session.conversationId) { ctx.io.print("no active conversation", "warn"); return; }
      const events = ctx.app.getEvents(ctx.session.conversationId, 0);
      let lastUserMsg = "";
      for (const e of events) {
        if (e.type === "user.message") lastUserMsg = e.text;
      }
      if (!lastUserMsg) { ctx.io.print("no previous user message to retry", "warn"); return; }
      await ctx.app.submitMessage(ctx.session.conversationId, lastUserMsg, ctx.session.lane ? { lane: ctx.session.lane } : {});
      ctx.io.print("retrying last message...", "ok");
    },
  },
  {
    name: "provider",
    usage: "/provider [name]",
    description: "Show or change the session provider",
    async run(ctx, arg) {
      if (arg) {
        const provider = arg.trim().toLowerCase();
        const known = ["local", "lm-studio", "ollama", "openai-compatible"];
        if (!known.includes(provider)) {
          ctx.io.print(`unknown provider '${arg}' — one of: ${known.join(", ")}`, "error");
          return;
        }
        ctx.session.provider = provider;
        ctx.io.print(`provider: ${provider} (endpoint/model settings remain unchanged)`, "ok");
      } else {
        ctx.io.print(`provider: ${ctx.session.provider || "default"}`, "dim");
      }
    },
  },
  {
    name: "agents",
    usage: "/agents",
    description: "List available agents",
    async run(ctx) {
      const agents = listAgents(false, ctx.cwd);
      if (!agents.length) { ctx.io.print("no agents available", "dim"); return; }
      ctx.io.table(agents.map((agent) => [agent.name, agent.model, agent.mode, agent.description]), ["name", "model", "mode", "description"]);
    },
  },
];

export const COMMAND_MAP = new Map<string, KittenCommand>();
for (const cmd of COMMANDS) {
  COMMAND_MAP.set(cmd.name, cmd);
  for (const a of cmd.aliases ?? []) COMMAND_MAP.set(a, cmd);
}

export function suggestCommands(prefix: string): string[] {
  const hits = COMMANDS.filter((c) => c.name.startsWith(prefix) || (c.aliases ?? []).some((a) => a.startsWith(prefix)));
  return hits.map((c) => c.name);
}

export async function runCommand(ctx: CommandContext, input: string): Promise<boolean> {
  const trimmed = input.startsWith("/") ? input.slice(1).trim() : input.trim();
  if (!trimmed) return false;
  const [name, ...rest] = trimmed.split(/\s+/);
  const cmd = COMMAND_MAP.get(name);
  if (!cmd) return false;
  await cmd.run(ctx, rest.join(" "));
  return true;
}

export function getCommandsJson(): Array<{ name: string; usage: string; description: string }> {
  return COMMANDS.map((c) => ({ name: c.name, usage: c.usage, description: c.description }));
}
