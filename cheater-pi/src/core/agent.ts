// Kitten Core — the standalone agent loop. NO Pi.
//
// A direct OpenAI tool-calling loop against LM Studio: assemble messages + tools, get the model's
// tool calls, gate + execute them, feed results back, repeat until `finish` or a bound. This is the
// loop Pi used to own. Owning it lets Kitten put its deterministic gates (noun/path firewall,
// per-step budget, read-before-write) INSIDE the loop instead of racing Pi's tool chrome.
//
// The reliability harness (contract, grade-in-code, check-first, scout) layers on top of this in
// agent-run.ts; this file is the minimal, honest driver.

import { KittenLLM, assistantTurn, toolResultTurn, type ChatMessage, type ChatResult, type TokenLogprob, type StreamDelta } from "./llm.js";
import { CORE_TOOLS, toolByName, type Tool, type ToolContext, type ToolResult } from "./tools.js";
import { nounGateVerdict, resetNounGate } from "../reliability/nounGate.js";
import { assessCommandSafety, type SafetyResult } from "../reliability/commandSafety.js";
import { aggregateSelfCertainty } from "./selfCertainty.js";

export interface AgentEvent {
  turn: number;
  kind: "assistant" | "assistant_delta" | "reasoning_delta" | "tool" | "gate_block" | "error" | "finish" | "nudge";
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
  /** Safety/approval hook: called before a shell command with a non-"allow" safety assessment. Returning
   *  allowed:false injects the feedback as the tool result and the loop continues (denial → feedback, no
   *  retry loop — Goal §8). When omitted, catastrophic/RCE/exfil ("block") commands are still hard-blocked
   *  as a safety floor; merely-destructive ("warn") commands run (preserving the permissive default). */
  commandGate?: (command: string, assessment: SafetyResult) => Promise<{ allowed: boolean; feedback?: string }>;
  /** P1: request per-token logprobs and aggregate self-certainty across the trajectory (owned-engine
   *  selection signal). Opt-in — adds response size, so only the ascent best-of-N path enables it. */
  captureConfidence?: boolean;
  /** Owned-inference per-sample decode controls (P2 ban, P5 sampler diversity) applied to every turn. */
  decode?: { logitBias?: Record<number, number>; topP?: number; topK?: number; minP?: number; dryMultiplier?: number; grammar?: string };
  /** Model-facing conversation context (prior turns + current repo truth), injected as a system block
   *  after the stable rules and before the current task, so a resumed/multi-turn run informs the model. */
  contextPreamble?: string;
  /** Stream the model's generation (real token deltas) when the endpoint supports it, emitting coalesced
   *  assistant_delta/reasoning_delta events. The reconstructed final ChatResult is identical to chat().
   *  Off for measurement/tests (they use the non-streaming path). */
  streamDeltas?: boolean;
  /** Owned-engine thinking control (iter-1 speed lever): on a single-function task ornith writes the
   *  code directly ~2x faster when its chain-of-thought is off — the harness (worked-example gate,
   *  consensus, repair) supplies the correctness, not the model's CoT. Thinking is auto-RE-ENABLED once
   *  the finish gate rejects a "done" (repair genuinely needs reasoning). Native `--jinja` server only. */
  disableThinking?: boolean;
  /** Main-agent delegation hook; omitted for isolated/read-only workers. */
  spawnTask?: ToolContext["spawnTask"];
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
}

export interface AgentRunResult {
  finished: boolean;
  /** finished was FORCE-allowed after exhausting the finish-gate rejection budget (no receipt obtained).
   *  Callers must NOT treat a forced finish as verified. Absent ⇒ not forced. */
  forcedFinish?: boolean;
  summary: string;
  turns: number;
  toolCalls: number;
  filesWritten: string[];
  events: AgentEvent[];
  usage: { prompt: number; completion: number; reasoning: number };
  /** Number of times the endpoint rejected structured output and the client used a bounded fallback. */
  formatRescues?: number;
  wallMs: number;
  stopReason: "finish" | "max_turns" | "error" | "stalled" | "aborted";
  /** P1: self-certainty aggregated over the trajectory (0.5 if not captured). Verifier tiebreaker. */
  confidence?: { selfCertainty: number; tokens: number };
}

const DEFAULT_SYSTEM = `You are Kitten, a precise coding agent working in a real project directory. You have tools: read, write, edit, bash, ls, grep, finish.

Rules:
- Inspect before you edit: read the exact code region first.
- To change an existing file, use edit (give enough surrounding original text to be unique) — not write. Use write only to create a new file.
- After changing code, run it ONCE with bash to confirm it works (don't assume). If that check passes, call finish — do NOT keep re-running checks that already passed or write throwaway test files; one confirming run is enough.
- Be concise and decisive: act, confirm once, finish. Do not narrate your plan.`;

const DEFAULT_MAX_TURNS = 40;

// A bash command that actually exercises code (not a bare read/ls) — used only to count how many times
// the model has re-verified after editing, so the loop can nudge it to stop re-checking what passes.
const RUN_CHECK_RE = /\b(pytest|unittest|python3?\s+\S|node\s+\S|npm\s+(run\s+)?test|go\s+test|cargo\s+test|bash\s+\S+\.sh|\.\/\S)/i;

export async function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const started = Date.now();
  const llm = params.llm;
  const tools = params.tools ?? CORE_TOOLS;
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent): void => { events.push(e); params.onEvent?.(e); };
  const ctx: ToolContext = { cwd: params.cwd, filesRead: new Set(), filesWritten: new Set(), signal: params.signal, spawnTask: params.spawnTask, allowedFiles: params.allowedFiles, forbiddenFiles: params.forbiddenFiles };
  resetNounGate();

  // Ground the model in its real environment. Without this, a small model invents a cwd (observed
  // live: it tried `cd /home/user` and then burned 3 turns fumbling an `rm` at the wrong path) and
  // wastes turns tidying scratch files. Both tanked speed with zero benefit.
  const env = `\n\nEnvironment: your working directory is ${params.cwd}. Every tool (read/write/edit/bash) already runs from there, so use plain relative paths (e.g. \`python foo.py\`) and do NOT cd anywhere — never cd to a guess like /home/user or /app, and you don't need to cd to the working directory either. Scratch files you create while testing may be left in place; do not spend turns deleting them.`;
  // Conversation context (prior turns + repo truth) is MERGED into the single system message — many
  // chat templates (Ornith/Qwen included) reject a second system message with "System message must be
  // at the beginning". It goes after the stable rules + env, before the task.
  const ctxBlock = params.contextPreamble && params.contextPreamble.trim() ? `\n\n${params.contextPreamble}` : "";
  const messages: ChatMessage[] = [
    { role: "system", content: (params.systemPrompt ?? DEFAULT_SYSTEM) + env + ctxBlock },
    { role: "user", content: params.task }
  ];
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const usage = { prompt: 0, completion: 0, reasoning: 0 };
  let toolCalls = 0;
  let formatRescues = 0;
  let finished = false;
  let summary = "";
  let stopReason: AgentRunResult["stopReason"] = "max_turns";
  let emptyStreak = 0;
  let finishRejections = 0;
  let forcedFinish = false;
  const maxFinishRejections = params.maxFinishRejections ?? 2;
  // Verification-spiral cap: after the model has edited code and then run several PASSING checks, one
  // gentle nudge toward finish. Fires only after thorough verification (never on the ~3-turn median),
  // and it's a nudge not a block — a model still repairing a genuinely failing check can keep going.
  let hasEdited = false;
  let passingChecks = 0;
  let nudgedToFinish = false;
  const bashOk: string[] = [];
  const bashAll: string[] = [];
  const logprobChunks: (TokenLogprob[] | undefined)[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (params.signal?.aborted) { stopReason = "aborted"; break; }
    const chatParams = {
      model: params.model,
      messages,
      tools: tools.map((t) => t.schema),
      toolChoice: "auto" as const,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      reasoningEffort: params.reasoningEffort,
      logprobs: params.captureConfidence,
      topLogprobs: params.captureConfidence ? 5 : undefined,
      logitBias: params.decode?.logitBias,
      topP: params.decode?.topP,
      topK: params.decode?.topK,
      minP: params.decode?.minP,
      dryMultiplier: params.decode?.dryMultiplier,
      grammar: params.decode?.grammar,
      // Iter-1: no-think for the fast forward pass, but the moment the finish gate has bounced a "done"
      // the model is repairing a real failure — give it its reasoning back for every turn after that.
      disableThinking: params.disableThinking && finishRejections === 0,
      // P3a — KV-cache reuse: harmless on cloud/LM Studio (ignored); on native llama.cpp it reuses the
      // KV of the shared system+task prefix across the k best-of-N samples (they share everything up to
      // the per-sample directive). Automatic prefix caching does most of this; the flag makes it explicit.
      cachePrompt: true,
      signal: params.signal
    };
    // Real streaming when asked + supported: emit coalesced content/reasoning deltas as they arrive, so
    // a slow local model shows live progress instead of a frozen pause. The reconstructed result is
    // identical to the non-streaming path. Tests/measurement (streamDeltas off) take the plain chat path.
    let result: ChatResult;
    if (params.streamDeltas && typeof llm.chatStream === "function") {
      const co = makeDeltaCoalescer(turn, emit);
      result = await llm.chatStream(chatParams, (d) => co.push(d));
      co.flush();
    } else {
      result = await llm.chat(chatParams);
    }
    usage.prompt += result.usage.prompt; usage.completion += result.usage.completion; usage.reasoning += result.usage.reasoning;
    formatRescues += result.formatRescues ?? 0;
    if (params.captureConfidence && result.logprobs?.length) logprobChunks.push(result.logprobs);

    if (!result.ok) {
      // A caller cancellation DURING the in-flight LLM call is a clean stop, not an error — the
      // top-of-loop abort check only catches a cancel BETWEEN turns, not one mid-generation.
      if (params.signal?.aborted || result.error === "cancelled") { stopReason = "aborted"; break; }
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
        } else if (params.finishGate) {
          // A finish gate exists but the rejection budget is exhausted: finish is FORCE-allowed to avoid
          // an infinite loop — it was NOT gate-approved, so no execution receipt was obtained. Mark it so
          // the caller never records this as verified (§4: finished ≠ verified).
          forcedFinish = true;
        }
        finished = true;
        summary = proposed;
        messages.push(toolResultTurn(call.id, call.name, "ok"));
        emit({ turn, kind: "finish", detail: summary });
        break;
      }
      // Safety/approval gate for shell commands (runs before execution).
      if (call.name === "bash") {
        const command = String(call.args.command ?? "");
        const assessment = assessCommandSafety(command);
        if (assessment.verdict !== "allow") {
          if (params.commandGate) {
            const decision = await params.commandGate(command, assessment);
            if (!decision.allowed) {
              messages.push(toolResultTurn(call.id, call.name, `blocked: ${decision.feedback ?? assessment.message}. Do not retry this command; choose a safe alternative.`));
              emit({ turn, kind: "gate_block", detail: `command denied (${assessment.category}): ${assessment.message}` });
              continue;
            }
          } else if (assessment.verdict === "block") {
            // Safety floor: catastrophic / remote-code-execution / secret-exfiltration never run.
            messages.push(toolResultTurn(call.id, call.name, `blocked (safety): ${assessment.message}. Do not retry; this class of command is not permitted.`));
            emit({ turn, kind: "gate_block", detail: `safety block (${assessment.category}): ${assessment.message}` });
            continue;
          }
        }
      }
      const res = await tool.execute(call.args, ctx);
      if (call.name === "edit" || call.name === "write") { if (!res.isError) hasEdited = true; }
      if (call.name === "bash") {
        const c = String(call.args.command ?? ""); bashAll.push(c);
        if (!res.isError) { bashOk.push(c); if (hasEdited && RUN_CHECK_RE.test(c)) passingChecks++; }
      }
      let output = res.output;
      // Reliability hook: append a post-edit diagnostic (type/syntax gate — Tier A2) so a broken edit
      // is rejected and re-asked in the same turn, not three tool calls later.
      const extra = await params.postToolHook?.({ name: call.name, args: call.args }, res, ctx);
      if (extra) output += `\n${extra}`;
      messages.push(toolResultTurn(call.id, call.name, output));
      emit({ turn, kind: "tool", detail: `${call.name}(${briefArgs(call.args)}) -> ${res.isError ? "ERR" : "ok"}${extra ? " +diag" : ""}`, data: { error: res.isError, output: output.slice(0, 500) } });
    }
    if (finished) { stopReason = "finish"; break; }
    // Gentle one-time nudge once the model has run several passing checks post-edit — cap the spiral.
    if (!nudgedToFinish && passingChecks >= 3) {
      nudgedToFinish = true;
      messages.push({ role: "user", content: "Your checks are passing. If the task is complete, call finish now — don't keep re-running checks that already pass." });
      emit({ turn, kind: "nudge", detail: "verification spiral cap: nudging to finish" });
    }
  }

  return {
    finished,
    forcedFinish,
    summary,
    turns: Math.min(events.filter((e) => e.kind === "assistant").length, maxTurns),
    toolCalls,
    filesWritten: [...ctx.filesWritten],
    events,
    usage,
    ...(formatRescues ? { formatRescues } : {}),
    wallMs: Date.now() - started,
    stopReason,
    confidence: params.captureConfidence ? aggregateSelfCertainty(logprobChunks) : undefined
  };
}

/** Coalesce streamed deltas so we emit a handful of events per turn, not one per token (Goal §3):
 *  content flushes at ~48 chars, reasoning at ~300 chars (bounded), plus a final flush at turn end. */
function makeDeltaCoalescer(turn: number, emit: (e: AgentEvent) => void): { push: (d: StreamDelta) => void; flush: () => void } {
  let content = "", reasoning = "";
  let reasoningEvents = 0;
  const MAX_REASONING_EVENTS = 60;
  const flushContent = (): void => { if (content) { emit({ turn, kind: "assistant_delta", detail: content }); content = ""; } };
  const flushReasoning = (): void => {
    if (reasoning && reasoningEvents < MAX_REASONING_EVENTS) { emit({ turn, kind: "reasoning_delta", detail: reasoning }); reasoningEvents++; }
    reasoning = "";
  };
  return {
    push: (d: StreamDelta): void => {
      if (d.content) { content += d.content; if (content.length >= 48) flushContent(); }
      if (d.reasoning) { reasoning += d.reasoning; if (reasoning.length >= 300) flushReasoning(); }
    },
    flush: (): void => { flushContent(); flushReasoning(); },
  };
}

function briefArgs(args: Record<string, unknown>): string {
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") return String(args.command).slice(0, 60);
  if (typeof args.pattern === "string") return `/${args.pattern}/`;
  return "";
}
