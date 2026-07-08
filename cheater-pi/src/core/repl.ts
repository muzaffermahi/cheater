#!/usr/bin/env node
// Kitten Core — the interactive REPL + headless entry. NO Pi, NO Pi TUI, NO Pi formatting.
//
// This is the last piece of "get rid of pi": a self-contained runtime over agent.ts + reliable.ts +
// bestofn.ts. This file is the global `kitten` bin:
//   kitten                     → open the REPL in the current directory
//   kitten "<task>"            → run one task here and exit (reliable mode)
//   kitten run "<task>" [flags] → same, explicit
// Flags: --cwd DIR  --raw|--reliable|--bon  --model M. In the REPL, files on disk are the session
// state, so a follow-up task builds on the previous one without threading a transcript.

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { runAgent, type AgentEvent } from "./agent.js";
import { runReliableAgent } from "./reliable.js";
import { runBestOfN } from "./bestofn.js";
import { KittenLLM, DEFAULT_MODELS } from "./llm.js";

type Mode = "raw" | "reliable" | "bon";

// Minimal ANSI so the terminal is ours, not Pi's — dim for tool chatter, no banners or boxes.
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

interface ReplState { cwd: string; mode: Mode; model: string; bon: number; }

/** Parse flags into state and collect any leftover words as a one-shot task (for `kitten "<task>"`). */
function parseArgs(argv: string[]): { st: ReplState; task: string } {
  const st: ReplState = { cwd: process.cwd(), mode: "reliable", model: DEFAULT_MODELS.main, bon: 2 };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") st.cwd = resolve(argv[++i] ?? ".");
    else if (a === "--model") st.model = argv[++i] ?? st.model;
    else if (a === "--mode") { const m = argv[++i]; if (m === "raw" || m === "reliable" || m === "bon") st.mode = m; }
    else if (a === "--raw") st.mode = "raw";
    else if (a === "--reliable") st.mode = "reliable";
    else if (a === "--bon") st.mode = "bon";
    else if (a === "run") { /* explicit subcommand — ignore, the rest is the task */ }
    else words.push(a);
  }
  return { st, task: words.join(" ").trim() };
}

const HELP = [
  "Commands:",
  "  /raw | /reliable | /bon   switch run mode (bon = best-of-N with consensus)",
  "  /cwd [dir]                show or change the working directory",
  "  /model [name]             show or change the main model",
  "  /help                     this help",
  "  /exit                     quit",
  "Anything else is a task, run in the current directory."
].join("\n");

async function runOnce(llm: KittenLLM, st: ReplState, task: string): Promise<void> {
  const started = Date.now();
  const onEvent = (e: AgentEvent): void => {
    if (e.kind === "tool") process.stdout.write(dim(`  · ${e.detail}`) + "\n");
    else if (e.kind === "gate_block") process.stdout.write(dim(`  ⓘ ${e.detail.slice(0, 120)}`) + "\n");
    else if (e.kind === "finish") process.stdout.write(green(`  ✓ ${e.detail}`) + "\n");
  };
  const common = { task, cwd: st.cwd, llm, model: st.model, onEvent };
  try {
    const result = st.mode === "bon"
      ? await runBestOfN({ ...common }, st.bon)
      : st.mode === "reliable"
        ? await runReliableAgent({ ...common })
        : await runAgent({ ...common });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!result.finished) process.stdout.write(red(`  ✗ stopped: ${result.stopReason}`) + "\n");
    process.stdout.write(dim(`  ${result.turns} turns · ${secs}s · ${result.usage.completion} tok`) + "\n");
  } catch (e) {
    process.stdout.write(red(`  ✗ error: ${(e as Error).message}`) + "\n");
  }
}

async function main(): Promise<void> {
  const { st, task } = parseArgs(process.argv.slice(2));
  const llm = new KittenLLM(DEFAULT_MODELS);

  // Headless one-shot: `kitten "<task>"` or `kitten run "<task>"` — run it here and exit.
  if (task) {
    process.stdout.write(bold("Kitten") + dim(` · ${st.mode} · ${st.cwd}`) + "\n");
    await runOnce(llm, st, task);
    return;
  }

  process.stdout.write(bold("Kitten") + dim(` — pi-free coding agent · ${st.model} · ${st.cwd}`) + "\n");
  process.stdout.write(dim(`mode: ${st.mode}   (/help for commands)`) + "\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: bold("kitten› ") });
  // Track close so a prompt() after the input stream ends (piped EOF while a task is still running)
  // does not throw ERR_USE_AFTER_CLOSE. prompt() is a no-op once closed.
  let closed = false;
  rl.on("close", () => { closed = true; });
  const prompt = (): void => { if (!closed) rl.prompt(); };
  prompt();
  for await (const lineRaw of rl) {
    const line = lineRaw.trim();
    if (!line) { prompt(); continue; }
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "exit" || cmd === "quit") break;
      else if (cmd === "help") process.stdout.write(HELP + "\n");
      else if (cmd === "raw" || cmd === "reliable" || cmd === "bon") { st.mode = cmd; process.stdout.write(dim(`mode: ${st.mode}`) + "\n"); }
      else if (cmd === "cwd") { if (arg) st.cwd = resolve(arg); process.stdout.write(dim(`cwd: ${st.cwd}`) + "\n"); }
      else if (cmd === "model") { if (arg) st.model = arg; process.stdout.write(dim(`model: ${st.model}`) + "\n"); }
      else process.stdout.write(red(`unknown command /${cmd} (/help)`) + "\n");
      prompt();
      continue;
    }
    await runOnce(llm, st, line);
    prompt();
  }
  if (!closed) rl.close();
  process.stdout.write(dim("bye") + "\n");
}

main().catch((e) => { process.stderr.write(`kitten repl fatal: ${e?.stack ?? e}\n`); process.exit(1); });
