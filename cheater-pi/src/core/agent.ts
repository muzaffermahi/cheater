// Kitten Core — the standalone agent loop. NO Pi.
//
// A direct OpenAI tool-calling loop against LM Studio: assemble messages + tools, get the model's
// tool calls, gate + execute them, feed results back, repeat until `finish` or a bound. This is the
// loop Pi used to own. Owning it lets Kitten put its deterministic gates (noun/path firewall,
// per-step budget, read-before-write) INSIDE the loop instead of racing Pi's tool chrome.
//
// The reliability harness (contract, grade-in-code, check-first, scout) layers on top of this in
// agent-run.ts; this file is the minimal, honest driver.

import { KittenLLM, assistantTurn, toolResultTurn, type ChatMessage, type ChatResult } from "./llm.js";
import { CORE_TOOLS, toolByName, type Tool, type ToolContext, type ToolResult } from "./tools.js";
import { nounGateVerdict, resetNounGate } from "../reliability/nounGate.js";

export interface AgentEvent {
  turn: number;
  kind: "assistant" | "tool" | "gate_block" | "error" | "finish" | "nudge";
  detail: string;
  data?: Record<string, unknown>;
}

export interface FinishGateState {
  cwd: string;
  filesWritten: string[];
  /** successful (exit 0) bash commands run this session — evidence of self-verification. */
  bashOk: string[];
  /** all bash commands run. */
  bashAll: string[];
  summary: string;
}

export interface AgentRunParams {
  task: string;
  cwd: string;
  llm: KittenLLM;
  tools?: Tool[];
  systemPrompt?: string;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  /** Owned-engine lever: cap ornith's reasoning depth per turn (it reasons ~130 tok even for a
   *  trivial tool call). "low" trims the reasoning tax for speed; omit for the model default. */
  reasoningEffort?: "low" | "medium" | "high";
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Reliability hook: after a tool runs, return extra feedback to append to the tool result the
   *  model sees (e.g. a type/syntax diagnostic that rejects a broken edit — Tier A2). May be async. */
  postToolHook?: (call: { name: string; args: Record<string, unknown> }, result: ToolResult, ctx: ToolContext) => string | undefined | Promise<string | undefined>;
  /** Reliability hook: when the model calls finish, decide if it may. Returning allowed:false injects
   *  the feedback and the loop continues (the "no done without receipts" finish gate). Called at most
   *  `maxFinishRejections` times, then finish is allowed to avoid an infinite loop. May be async
   *  (e.g. to ground the failure via the sidecar). */
  finishGate?: (state: FinishGateState) => { allowed: boolean; feedback?: string } | Promise<{ allowed: boolean; feedback?: string }>;
  maxFinishRejections?: number;
}

export interface AgentRunResult {
  finished: boolean;
  summary: string;
  turns: number;
  toolCalls: number;
  filesWritten: string[];
  events: AgentEvent[];
  usage: { prompt: number; completion: number; reasoning: number };
  wallMs: number;
  stopReason: "finish" | "max_turns" | "error" | "stalled" | "aborted";
}

const DEFAULT_SYSTEM = `You are Kitten, a precise coding agent working in a real project directory. You have tools: read, write, edit, bash, ls, grep, finish.

Rules:
- Work in small, verified steps. Inspect before you edit: read the exact code region first.
- To change an existing file, use edit (give enough surrounding original text to be unique) — not write. Use write only to create a new file.
- After changing code, RUN it or its tests with bash and read the real output. Do not assume it works.
- Keep going until the task is actually done and verified. Then call finish with a one-line summary.
- Be concise. Do not explain your plan at length between actions — act.`;

const DEFAULT_MAX_TURNS = 40;

export async function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const started = Date.now();
  const llm = params.llm;
  const tools = params.tools ?? CORE_TOOLS;
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent): void => { events.push(e); params.onEvent?.(e); };
  const ctx: ToolContext = { cwd: params.cwd, filesRead: new Set(), filesWritten: new Set() };
  resetNounGate();

  const messages: ChatMessage[] = [
    { role: "system", content: params.systemPrompt ?? DEFAULT_SYSTEM },
    { role: "user", content: params.task }
  ];
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const usage = { prompt: 0, completion: 0, reasoning: 0 };
  let toolCalls = 0;
  let finished = false;
  let summary = "";
  let stopReason: AgentRunResult["stopReason"] = "max_turns";
  let emptyStreak = 0;
  let finishRejections = 0;
  const maxFinishRejections = params.maxFinishRejections ?? 2;
  const bashOk: string[] = [];
  const bashAll: string[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (params.signal?.aborted) { stopReason = "aborted"; break; }
    const result: ChatResult = await llm.chat({
      model: params.model,
      messages,
      tools: tools.map((t) => t.schema),
      toolChoice: "auto",
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      reasoningEffort: params.reasoningEffort,
      signal: params.signal
    });
    usage.prompt += result.usage.prompt; usage.completion += result.usage.completion; usage.reasoning += result.usage.reasoning;

    if (!result.ok) {
      emit({ turn, kind: "error", detail: result.error ?? "llm error" });
      // One retry on a transient error, then stop.
      if (turn < maxTurns && /timeout|network/.test(result.error ?? "")) continue;
      stopReason = "error";
      break;
    }
    emit({ turn, kind: "assistant", detail: (result.content || "(tool call)").slice(0, 400), data: { reasoningChars: result.reasoning.length, toolCalls: result.toolCalls.map((t) => t.name) } });
    messages.push(assistantTurn(result));

    if (!result.toolCalls.length) {
      // Model produced text but took no action. Nudge it once to act or finish; if it keeps stalling,
      // stop (a small model can loop emitting prose).
      emptyStreak++;
      if (emptyStreak >= 2) { summary = result.content.slice(0, 300); stopReason = "stalled"; break; }
      emit({ turn, kind: "nudge", detail: "no tool call; nudging to act" });
      messages.push({ role: "user", content: "Take a concrete action with a tool now (read/edit/write/bash), or call finish if the task is truly done and verified." });
      continue;
    }
    emptyStreak = 0;

    for (const call of result.toolCalls) {
      toolCalls++;
      const tool = toolByName(call.name) ?? tools.find((t) => t.schema.name === call.name);
      if (!tool) {
        messages.push(toolResultTurn(call.id, call.name, `error: unknown tool '${call.name}'. Available: ${tools.map((t) => t.schema.name).join(", ")}`));
        emit({ turn, kind: "tool", detail: `unknown tool ${call.name}`, data: { error: true } });
        continue;
      }
      if (call.argError) {
        messages.push(toolResultTurn(call.id, call.name, `error: ${call.argError}. Re-emit the call with valid JSON arguments.`));
        emit({ turn, kind: "tool", detail: `bad args for ${call.name}`, data: { error: true } });
        continue;
      }
      // Pre-execution noun/path firewall (Phase 2): a phantom exec/edit path is corrected in one turn.
      const verdict = nounGateVerdict({ toolName: call.name, input: call.args, cwd: params.cwd });
      if (verdict.action === "block") {
        messages.push(toolResultTurn(call.id, call.name, `blocked: ${verdict.reason}`));
        emit({ turn, kind: "gate_block", detail: verdict.reason, data: { phantom: verdict.phantomPath } });
        continue;
      }
      if (call.name === "finish") {
        const proposed = String(call.args.summary ?? "");
        // Finish gate: "no done without receipts". A reliability hook may reject the claim (e.g. the
        // model never actually ran a verification) and send it back with guidance, up to a bound.
        if (params.finishGate && finishRejections < maxFinishRejections) {
          const gate = await params.finishGate({ cwd: params.cwd, filesWritten: [...ctx.filesWritten], bashOk, bashAll, summary: proposed });
          if (!gate.allowed) {
            finishRejections++;
            messages.push(toolResultTurn(call.id, call.name, `NOT DONE: ${gate.feedback ?? "the task is not verified yet."}`));
            emit({ turn, kind: "gate_block", detail: `finish rejected: ${gate.feedback ?? ""}`.slice(0, 200) });
            continue;
          }
        }
        finished = true;
        summary = proposed;
        messages.push(toolResultTurn(call.id, call.name, "ok"));
        emit({ turn, kind: "finish", detail: summary });
        break;
      }
      const res = tool.execute(call.args, ctx);
      if (call.name === "bash") { const c = String(call.args.command ?? ""); bashAll.push(c); if (!res.isError) bashOk.push(c); }
      let output = res.output;
      // Reliability hook: append a post-edit diagnostic (type/syntax gate — Tier A2) so a broken edit
      // is rejected and re-asked in the same turn, not three tool calls later.
      const extra = await params.postToolHook?.({ name: call.name, args: call.args }, res, ctx);
      if (extra) output += `\n${extra}`;
      messages.push(toolResultTurn(call.id, call.name, output));
      emit({ turn, kind: "tool", detail: `${call.name}(${briefArgs(call.args)}) -> ${res.isError ? "ERR" : "ok"}${extra ? " +diag" : ""}`, data: { error: res.isError, output: output.slice(0, 500) } });
    }
    if (finished) { stopReason = "finish"; break; }
  }

  return {
    finished,
    summary,
    turns: Math.min(events.filter((e) => e.kind === "assistant").length, maxTurns),
    toolCalls,
    filesWritten: [...ctx.filesWritten],
    events,
    usage,
    wallMs: Date.now() - started,
    stopReason
  };
}

function briefArgs(args: Record<string, unknown>): string {
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") return String(args.command).slice(0, 60);
  if (typeof args.pattern === "string") return `/${args.pattern}/`;
  return "";
}
