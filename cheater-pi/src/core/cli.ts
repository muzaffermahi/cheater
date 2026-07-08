#!/usr/bin/env node
// Kitten Core CLI — headless standalone agent. NO Pi, NO TUI.
//
//   node dist/src/core/cli.js run "<task>" [--cwd DIR] [--model M] [--max-turns N] [--trace FILE] [--quiet]
//
// Prints a one-line human summary to stderr and a single JSON result line to stdout (so a harness can
// parse it). With --trace, writes the full event trace to a file for diagnosis. This is the entry the
// A/B harness drives; it exists precisely so Kitten can be measured without Pi's runtime in the way.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgent, type AgentEvent } from "./agent.js";
import { runReliableAgent } from "./reliable.js";
import { runBestOfN } from "./bestofn.js";
import { KittenLLM, DEFAULT_MODELS } from "./llm.js";

interface CliOpts { task: string; cwd: string; model?: string; maxTurns?: number; trace?: string; quiet: boolean; reliable: boolean; bon: number; reasoning?: "low" | "medium" | "high"; }

function parse(argv: string[]): CliOpts | null {
  if (argv[0] !== "run") return null;
  const opts: CliOpts = { task: "", cwd: process.cwd(), quiet: false, reliable: false, bon: 1 };
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") opts.cwd = resolve(argv[++i] ?? ".");
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--max-turns") opts.maxTurns = Number(argv[++i]);
    else if (a === "--trace") opts.trace = argv[++i];
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--reliable") opts.reliable = true;
    else if (a === "--bon") { opts.bon = Math.max(1, Number(argv[++i]) || 1); opts.reliable = true; }
    else if (a === "--reasoning") { const v = argv[++i]; if (v === "low" || v === "medium" || v === "high") opts.reasoning = v; }
    else rest.push(a);
  }
  opts.task = rest.join(" ").trim();
  return opts;
}

async function main(argv: string[]): Promise<number> {
  const opts = parse(argv);
  if (!opts || !opts.task) {
    process.stderr.write('usage: kitten-core run "<task>" [--cwd DIR] [--model M] [--max-turns N] [--trace FILE] [--quiet]\n');
    return 2;
  }
  const llm = new KittenLLM(DEFAULT_MODELS);
  const model = opts.model ?? DEFAULT_MODELS.main;
  if (!opts.quiet) process.stderr.write(`kitten-core${opts.reliable ? " (reliable)" : ""}: ${model} @ ${DEFAULT_MODELS.baseUrl}  cwd=${opts.cwd}\n`);

  const onEvent = opts.quiet ? undefined : (e: AgentEvent) => process.stderr.write(`  [${e.turn}] ${e.kind}: ${e.detail.replace(/\n/g, " ").slice(0, 160)}\n`);
  const result = opts.bon > 1
    ? await runBestOfN({ task: opts.task, cwd: opts.cwd, llm, model, maxTurns: opts.maxTurns, reasoningEffort: opts.reasoning, onEvent }, opts.bon)
    : opts.reliable
      ? await runReliableAgent({ task: opts.task, cwd: opts.cwd, llm, model, maxTurns: opts.maxTurns, reasoningEffort: opts.reasoning, onEvent })
      : await runAgent({ task: opts.task, cwd: opts.cwd, llm, model, maxTurns: opts.maxTurns, reasoningEffort: opts.reasoning, onEvent });

  if (opts.trace) {
    try { writeFileSync(opts.trace, JSON.stringify(result, null, 2)); } catch { /* best-effort */ }
  }
  const line = {
    finished: result.finished,
    stopReason: result.stopReason,
    turns: result.turns,
    toolCalls: result.toolCalls,
    filesWritten: result.filesWritten,
    summary: result.summary,
    wallMs: result.wallMs,
    usage: result.usage
  };
  process.stdout.write(JSON.stringify(line) + "\n");
  if (!opts.quiet) process.stderr.write(`kitten-core: ${result.stopReason} in ${result.turns} turns / ${(result.wallMs / 1000).toFixed(1)}s (${result.usage.completion} completion tok, ${result.usage.reasoning} reasoning)\n`);
  return result.finished ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { process.stderr.write(`kitten-core fatal: ${e?.stack ?? e}\n`); process.exit(1); });
