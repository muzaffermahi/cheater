// Kitten Core — the interactive REPL. NO Pi, NO Pi TUI, NO Pi formatting.
//
// This is the last piece of "get rid of pi": a self-contained readline chat loop over the pi-free
// runtime (agent.ts + reliable.ts + bestofn.ts). Each line you type is a task run in the current
// working directory; tool activity streams as clean, dim lines and the run ends with a one-line
// receipt. Slash commands switch mode / cwd. The files on disk ARE the session state, so a follow-up
// task builds on the previous one without threading a transcript.
//
//   node dist/src/core/repl.js [--cwd DIR] [--mode raw|reliable|bon] [--model M]

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

function parseArgs(argv: string[]): ReplState {
  const st: ReplState = { cwd: process.cwd(), mode: "reliable", model: DEFAULT_MODELS.main, bon: 2 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") st.cwd = resolve(argv[++i] ?? ".");
    else if (argv[i] === "--model") st.model = argv[++i] ?? st.model;
    else if (argv[i] === "--mode") { const m = argv[++i]; if (m === "raw" || m === "reliable" || m === "bon") st.mode = m; }
  }
  return st;
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
  const st = parseArgs(process.argv.slice(2));
  const llm = new KittenLLM(DEFAULT_MODELS);
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
