// Kitten Core — the standalone agent loop. NO Pi.
//
// A direct OpenAI tool-calling loop against LM Studio: assemble messages + tools, get the model's
// tool calls, gate + execute them, feed results back, repeat until `finish` or a bound. This is the
// loop Pi used to own. Owning it lets Kitten put its deterministic gates (noun/path firewall,
// per-step budget, read-before-write) INSIDE the loop instead of racing Pi's tool chrome.
//
// The reliability harness (contract, grade-in-code, check-first, scout) layers on top of this in
// agent-run.ts; this file is the minimal, honest driver.

import { KittenLLM, assistantTurn, toolResultTurn, type ChatMessage, type ChatResult, type TokenLogprob, type StreamDelta, type InferenceTimings } from "./llm.js";
import { CORE_TOOLS, toolByName, type Tool, type ToolContext, type ToolResult } from "./tools.js";
import { nounGateVerdict, resetNounGate } from "../reliability/nounGate.js";
import { assessCommandSafety, type SafetyResult } from "../reliability/commandSafety.js";
import { AttemptLedger } from "./attemptLedger.js";
import { maskOldObservations } from "./observationMask.js";
import { aggregateSelfCertainty } from "./selfCertainty.js";
import { parseTextToolCalls, stripTextToolCalls } from "./textToolCalls.js";
import { isQwen35Family, profileChatParams, resolveInferenceProfile, type InferenceCapabilities, type InferenceOverrides, type InferenceRole, type InferenceProfile } from "./inferenceProfiles.js";
import { contractForPhase, receiptFor, type BootProfile, type InferencePhase, type RuntimeReceipt } from "./runtimeDirector.js";
import type { EffortLevel } from "./effort.js";

export interface AgentEvent {
  turn: number;
  kind: "assistant" | "assistant_delta" | "reasoning_delta" | "tool_start" | "tool_output" | "tool" | "gate_block" | "error" | "finish" | "nudge" | "inference.completed";
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
  /** The engine's context window, in tokens. When set, old tool OUTPUT is elided as the transcript
   *  approaches it instead of the run dying on "Context size has been exceeded" — the failure that
   *  once reported a 13/13 build as a model error. Omit to disable (no masking, unbounded growth). */
  contextWindowTokens?: number;
  temperature?: number;
  model?: string;
  /** Owned-engine lever: cap ornith's reasoning depth per turn (it reasons ~130 tok even for a
   *  trivial tool call). "low" trims the reasoning tax for speed; omit for the model default. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Hard cap on thinking tokens per turn (llama.cpp `reasoning_budget`); 0 disables reasoning. Set
   *  from task hardness by the caller — see runReliableAgent. */
  reasoningBudget?: number;
  /** Role-aware inference defaults. Explicit legacy fields below still win over the profile. */
  inferenceRole?: InferenceRole;
  /** Phase-level Runtime Director input. When present it is the source of truth for controls. */
  inferencePhase?: InferencePhase;
  inferenceOverrides?: InferenceOverrides;
  inferenceCapabilities?: InferenceCapabilities;
  bootProfile?: BootProfile;
  effort?: EffortLevel;
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
  /** Optional harness-owned completion after a mutation. This keeps deterministic checks out of the model loop. */
  autoFinish?: (state: FinishGateState) => { allowed: boolean; summary?: string; feedback?: string } | Promise<{ allowed: boolean; summary?: string; feedback?: string }>;
  autoFinishAfterMutation?: boolean;
  maxFinishRejections?: number;
  /** Safety/approval hook: called before a shell command with a non-"allow" safety assessment. Returning
   *  allowed:false injects the feedback as the tool result and the loop continues (denial → feedback, no
   *  retry loop — Goal §8). When omitted, catastrophic/RCE/exfil ("block") commands are still hard-blocked
   *  as a safety floor; merely-destructive ("warn") commands run (preserving the permissive default). */
  commandGate?: (command: string, assessment: SafetyResult) => Promise<{ allowed: boolean; feedback?: string }>;
  /** P1: request per-token logprobs and aggregate self-certainty across the trajectory (owned-engine
   *  selection signal). Opt-in — adds response size, so only the ascent best-of-N path enables it. */
  captureConfidence?: boolean;
  /** How many candidates this run competes against. Self-certainty is only captured above 1. */
  candidateCount?: number;
  /** Owned-inference per-sample decode controls (P2 ban, P5 sampler diversity) applied to every turn. */
  decode?: { logitBias?: Record<number, number>; topP?: number; topK?: number; minP?: number; dryMultiplier?: number; repeatPenalty?: number; presencePenalty?: number; seed?: number; grammar?: string };
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
  /** Files deterministically preloaded by a compiled path; counts as read-before-edit evidence. */
  preReadFiles?: readonly string[];
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
  /** Effective role profile and any capability-dropped fields for local diagnostics. */
  inferenceProfile?: InferenceProfile;
  runtimeReceipt?: RuntimeReceipt;
  inferenceTimings?: InferenceTimings & { modelCalls: number };
}

const DEFAULT_SYSTEM = `You are Kitten, a precise coding agent working in a real project directory. You have tools: read, write, edit, bash, ls, grep, finish.

Rules:
- Inspect before you edit: read the exact code region first.
- The current working directory is already the project root. On Windows, do not probe it with repeated variants such as pwd, echo %cd%, set, cd, dir, cmd /c dir, or shell listings. Use ls or glob once when discovery is needed; if the workspace is empty, start the requested deliverable immediately with write.
- To change an existing file, use edit (give enough surrounding original text to be unique) — not write. Use write only to create a new file.
- After changing code, run it ONCE with bash to confirm it works (don't assume). If that check passes, call finish — do NOT keep re-running checks that already passed or write throwaway test files; one confirming run is enough.
- Be concise and decisive: act, confirm once, finish. Do not narrate your plan.`;

const DEFAULT_MAX_TURNS = 40;

/** Recoverable model errors (transport 5xx / truncated tool calls) get this many in-run retries. */
const MAX_MODEL_ERROR_RETRIES = 3;
// A cut-off generation is retried with "write it in pieces" guidance. Bounded, because a model that
// cannot stay under the cap will not learn to on the fourth try, and each attempt is a full generation.
const MAX_LENGTH_RETRIES = 2;

// A bash command that actually exercises code (not a bare read/ls) — used only to count how many times
// the model has re-verified after editing, so the loop can nudge it to stop re-checking what passes.
const RUN_CHECK_RE = /\b(pytest|unittest|python3?\s+\S|node\s+\S|npm\s+(run\s+)?test|go\s+test|cargo\s+test|bash\s+\S+\.sh|\.\/\S)/i;

export async function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const started = Date.now();
  const llm = params.llm;
  const tools = params.tools ?? CORE_TOOLS;
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent): void => { events.push(e); params.onEvent?.(e); };
  // Live tool identity: `tool_start`/`tool_output`/`tool` events for one execution all carry the same
  // `call` number so a renderer can pair a spinner with its completion. Set right before execute.
  let currentCall = 0;
  let currentTurn = 0;
  const ctx: ToolContext = {
    cwd: params.cwd, filesRead: new Set(params.preReadFiles ?? []), filesWritten: new Set(), signal: params.signal, spawnTask: params.spawnTask, allowedFiles: params.allowedFiles, forbiddenFiles: params.forbiddenFiles,
    onOutput: (chunk) => emit({ turn: currentTurn, kind: "tool_output", detail: chunk, data: { call: currentCall } }),
  };
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
  const inferenceTimings: InferenceTimings & { modelCalls: number } = { modelCalls: 0 };
  let toolCalls = 0;
  let formatRescues = 0;
  let finished = false;
  let summary = "";
  let stopReason: AgentRunResult["stopReason"] = "max_turns";
  let emptyStreak = 0;
  let finishRejections = 0;
  let forcedFinish = false;
  let modelErrorRetries = 0;
  let lengthRetries = 0;
  const maxFinishRejections = params.maxFinishRejections ?? 2;
  // Verification-spiral cap: after the model has edited code and then run several PASSING checks, one
  // gentle nudge toward finish. Fires only after thorough verification (never on the ~3-turn median),
  // and it's a nudge not a block — a model still repairing a genuinely failing check can keep going.
  let hasEdited = false;
  let mutationSinceAutoCheck = false;
  let passingChecks = 0;
  let nudgedToFinish = false;
  const bashOk: string[] = [];
  const bashAll: string[] = [];
  // What has already been tried and failed, per run. Owned here so a candidate in an isolated
  // workspace can never inherit another candidate's history.
  const ledger = new AttemptLedger();
  const logprobChunks: (TokenLogprob[] | undefined)[] = [];
  // Self-certainty is a tiebreaker between candidates, so it is only worth its cost when there is
  // something to tie with. `candidateCount` is 1 for every ordinary run.
  const captureLogprobs = Boolean(params.captureConfidence) && (params.candidateCount ?? 1) > 1;
  const phase = params.inferencePhase ?? (params.inferenceRole === "repair" ? "repair" : params.inferenceRole === "judge" ? "judge" : params.inferenceRole === "planner" ? "plan" : "act");
  const phaseContract = contractForPhase(phase, params.effort ?? "balanced", {
    ...params.inferenceOverrides,
    temperature: params.temperature ?? params.inferenceOverrides?.temperature,
    // The effort profile supplies a per-turn budget for legacy models. Qwen3.5 instruct mode has a
    // separate hard switch and must not inherit that budget as if it were thinking mode.
    reasoningBudget: params.inferenceOverrides?.reasoningBudget ?? (isQwen35Family(params.model) ? undefined : params.reasoningBudget),
    maxTokens: params.maxTokens ?? params.inferenceOverrides?.maxTokens,
    topP: params.decode?.topP ?? params.inferenceOverrides?.topP,
    topK: params.decode?.topK ?? params.inferenceOverrides?.topK,
    minP: params.decode?.minP ?? params.inferenceOverrides?.minP,
    dryMultiplier: params.decode?.dryMultiplier ?? params.inferenceOverrides?.dryMultiplier,
    repeatPenalty: params.decode?.repeatPenalty ?? params.inferenceOverrides?.repeatPenalty,
    presencePenalty: params.decode?.presencePenalty ?? params.inferenceOverrides?.presencePenalty,
    seed: params.decode?.seed ?? params.inferenceOverrides?.seed,
  }, params.inferenceCapabilities ?? llm.inferenceCapabilities ?? {}, params.model);
  const profile = params.inferenceRole && params.inferenceRole !== phaseContract.role
    ? resolveInferenceProfile(params.inferenceRole, params.effort ?? "balanced", params.inferenceOverrides ?? {}, params.inferenceCapabilities ?? llm.inferenceCapabilities ?? {}, params.model)
    : phaseContract.profile;
  const profileTransport = profileChatParams(profile);
  const runtimeReceipt = receiptFor({ ...phaseContract, profile, transport: profileChatParams(profile) }, params.bootProfile ?? { ownership: llm.runtimeOwnership, model: params.model ?? "unknown" });

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (params.signal?.aborted) { stopReason = "aborted"; break; }
    // Shed weight BEFORE the call that would have overflowed. Old tool OUTPUT is stubbed; the system
    // message, the task, the conversation's shape and the recent turns are all untouched. See
    // observationMask.ts for why this is masking and not summarization.
    if (params.contextWindowTokens) {
      const shed = maskOldObservations(messages, { contextWindowTokens: params.contextWindowTokens });
      if (shed.masked) {
        emit({ turn, kind: "nudge", detail: `context: elided ${shed.masked} old tool output${shed.masked === 1 ? "" : "s"} (${Math.round(shed.charsFreed / 1000)}k chars) to stay inside the window` });
      }
    }
    const chatParams = {
      model: params.model,
      messages,
      tools: tools.map((t) => t.schema),
      toolChoice: "auto" as const,
      maxTokens: params.maxTokens ?? profileTransport.maxTokens,
      temperature: params.temperature ?? profileTransport.temperature,
      reasoningEffort: params.reasoningEffort,
      // The harness decides how long the model may think, because the model consistently over-spends
      // it. `reasoning_effort` alone is not a reliable control (only "none" dependably bites), so the
      // budget travels with it and is the thing that actually bounds the tax.
      reasoningBudget: params.reasoningBudget ?? profileTransport.reasoningBudget,
      // Per-token probabilities are NOT free: llama.cpp reports roughly a 3x generation slowdown with
      // n_probs > 0, and self-certainty is only ever consulted to break a tie between candidates. So
      // capture them only when more than one candidate will exist — a single-candidate run has nothing
      // to compare against and was paying the tax for a number nobody read.
      logprobs: captureLogprobs || (profile.logprobs && Boolean(params.captureConfidence)),
      topLogprobs: (captureLogprobs || (profile.logprobs && Boolean(params.captureConfidence))) ? 5 : undefined,
      logitBias: params.decode?.logitBias,
      topP: params.decode?.topP ?? profileTransport.topP,
      topK: params.decode?.topK ?? profileTransport.topK,
      minP: params.decode?.minP ?? profileTransport.minP,
      dryMultiplier: params.decode?.dryMultiplier ?? profileTransport.dryMultiplier,
      repeatPenalty: params.decode?.repeatPenalty ?? profileTransport.repeatPenalty,
      presencePenalty: params.decode?.presencePenalty ?? profileTransport.presencePenalty,
      seed: params.decode?.seed ?? profileTransport.seed,
      grammar: params.decode?.grammar,
      // Iter-1: no-think for the fast forward pass, but the moment the finish gate has bounced a "done"
      // the model is repairing a real failure — give it its reasoning back for every turn after that.
      disableThinking: (params.disableThinking ?? profile.samplingMode === "instruct") && finishRejections === 0,
      // P3a — KV-cache reuse: harmless on cloud/LM Studio (ignored); on native llama.cpp it reuses the
      // KV of the shared system+task prefix across the k best-of-N samples (they share everything up to
      // the per-sample directive). Automatic prefix caching does most of this; the flag makes it explicit.
      cachePrompt: profileTransport.cachePrompt,
      role: params.inferenceRole,
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
    inferenceTimings.modelCalls++;
    if (result.timings) {
      for (const key of ["cacheTokens", "promptTokens", "promptMs", "promptTokensPerSecond", "predictedTokens", "predictedMs", "predictedTokensPerSecond", "totalMs"] as const) {
        const value = result.timings[key];
        if (value === undefined) continue;
        const current = inferenceTimings[key];
        inferenceTimings[key] = key.endsWith("PerSecond") ? (current === undefined ? value : current) : ((current ?? 0) + value);
      }
    }
    emit({ turn, kind: "inference.completed", detail: "model call completed", data: {
      role: params.inferenceRole ?? "executor",
      cacheTokens: result.timings?.cacheTokens ?? 0,
      promptTokens: result.timings?.promptTokens ?? result.usage.prompt,
      promptMs: result.timings?.promptMs ?? 0,
      predictedTokens: result.timings?.predictedTokens ?? result.usage.completion,
      predictedMs: result.timings?.predictedMs ?? 0,
      decodeTokensPerSecond: result.timings?.predictedTokensPerSecond ?? 0,
      runtimeReceipt,
    } });
    formatRescues += result.formatRescues ?? 0;
    if (params.captureConfidence && result.logprobs?.length) logprobChunks.push(result.logprobs);

    if (!result.ok) {
      // A caller cancellation DURING the in-flight LLM call is a clean stop, not an error — the
      // top-of-loop abort check only catches a cancel BETWEEN turns, not one mid-generation.
      if (params.signal?.aborted || result.error === "cancelled") { stopReason = "aborted"; break; }
      emit({ turn, kind: "error", detail: result.error ?? "llm error" });
      const err = result.error ?? "";
      // "The model randomly stops" must not be a thing. Two recoverable classes, both retried with
      // backoff instead of killing the run:
      //   • transient transport/server trouble (timeouts, resets, 5xx while the server GC's/paging);
      //   • a MALFORMED/TRUNCATED TOOL CALL — llama.cpp 500s with a JSON parse error when the model's
      //     tool-call arguments blow past the generation budget mid-string (observed live: a whole
      //     HTML file inside one `write` call). Retrying alone would reproduce it, so the retry also
      //     tells the model to work in smaller steps.
      const transient = /timeout|network|ECONNRESET|ECONNREFUSED|EPIPE|socket|fetch failed|stream error|stream ended before completion|HTTP 5\d\d/i.test(err);
      const truncatedToolCall = /parse|unterminated|missing closing|invalid string|json/i.test(err);
      if (turn < maxTurns && (transient || truncatedToolCall) && modelErrorRetries < MAX_MODEL_ERROR_RETRIES) {
        modelErrorRetries++;
        if (truncatedToolCall) {
          messages.push({
            role: "user",
            content: "Your previous reply failed: a tool call was malformed or too large and was cut off before it finished. Re-do that step in SMALLER pieces — use edit with a bounded snippet, or write the file in parts across several calls. Never emit one huge tool call.",
          });
        }
        emit({ turn, kind: "nudge", detail: `model error — retrying (${modelErrorRetries}/${MAX_MODEL_ERROR_RETRIES}): ${err.slice(0, 120)}` });
        await new Promise((resolveWait) => setTimeout(resolveWait, 750 * modelErrorRetries));
        continue;
      }
      stopReason = "error";
      // Carry the reason out with the run. The summary is what every client shows, and it fell back to
      // the bare word "error" — a dead run with no diagnosis anywhere the user can see it.
      summary = `model call failed: ${result.error ?? "unknown error"}`;
      break;
    }
    // The generation hit the output cap. Say so HERE, where the length is actually known, rather than
    // letting a half-written tool call travel on to be rejected by the server's JSON parser as a
    // generic 500 — a diagnosis that names neither the cap nor the file. A turn cut off mid-argument
    // has no usable tool call anyway, so retry it with guidance instead of recording the fragment.
    if (result.finishReason === "length" && !result.toolCalls.length && lengthRetries < MAX_LENGTH_RETRIES) {
      lengthRetries++;
      emit({ turn, kind: "nudge", detail: `output hit the length cap — retrying in smaller pieces (${lengthRetries}/${MAX_LENGTH_RETRIES})` });
      messages.push(assistantTurn(result));
      messages.push({
        role: "user",
        content: "Your last reply was cut off at the output limit before it finished, so nothing was applied. Do NOT repeat it in full. Write the file in SEVERAL smaller calls: create it with the first section, then append each following section with a separate edit call. Keep every single tool call well under the limit.",
      });
      continue;
    }
    // Recover a prose tool call BEFORE the turn is recorded, so the transcript shows the action and
    // not the markup, and so the message history carries a real call the model can be held to.
    if (!result.toolCalls.length) {
      const recovered = parseTextToolCalls(result.content);
      if (recovered.length) {
        emit({ turn, kind: "nudge", detail: `recovered ${recovered.length} tool call${recovered.length === 1 ? "" : "s"} the model wrote as text` });
        result.toolCalls = recovered;
        result.content = stripTextToolCalls(result.content);
      }
    }
    emit({ turn, kind: "assistant", detail: (result.content || "(tool call)").slice(0, 400), data: { reasoningChars: result.reasoning.length, toolCalls: result.toolCalls.map((t) => t.name) } });
    messages.push(assistantTurn(result));

    if (!result.toolCalls.length) {
      // Model produced text but took no action. Nudge it once to act or finish; if it keeps stalling,
      // stop (a small model can loop emitting prose).
      emptyStreak++;
      // Three, not two. A model that has just been told its arguments were malformed often spends a
      // turn narrating the fix before making it, and ending the run there strands work that was one
      // turn from succeeding.
      if (emptyStreak >= 3) { summary = result.content.slice(0, 300); stopReason = "stalled"; break; }
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
        // A giant single-call payload is the usual cause: a whole source file inlined into the
        // arguments string, its quotes and newlines escaped, is exactly what breaks a tool-call
        // parser mid-string. Saying "re-emit with valid JSON" to a model that just produced 12 KB of
        // valid-looking JSON is useless advice; telling it to split the write is actionable.
        const rawSize = call.raw?.length ?? 0;
        const oversized = rawSize >= 4000;
        const advice = oversized
          ? ` The arguments were ${Math.round(rawSize / 1024)} KB, which is large enough that the parser can fail mid-string. Write the file in smaller pieces instead: create it with the first section, then append the rest with follow-up edits.`
          : " Re-emit the call with valid JSON arguments.";
        messages.push(toolResultTurn(call.id, call.name, `error: ${call.argError}.${advice}`));
        // The UI used to receive exactly "bad args for write" — no argument, no reason. Neither the
        // model nor the person watching could act on that.
        emit({
          turn, kind: "tool",
          detail: `bad args for ${call.name}: ${call.argError.slice(0, 200)}${oversized ? ` (${Math.round(rawSize / 1024)} KB payload)` : ""}`,
          data: { error: true, argError: call.argError, argBytes: rawSize },
        });
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
      // Have we already tried exactly this, and failed, with nothing changed since? Past ~30 turns a
      // model starts re-proposing actions whose failure is still in the transcript. The ledger answers
      // with what happened last time instead of paying for the same failure again.
      const priorAttempt = ledger.consider(call.name, call.args);
      if (priorAttempt.blocked) {
        messages.push(toolResultTurn(call.id, call.name, priorAttempt.feedback!));
        emit({ turn, kind: "gate_block", detail: `repeat of a failed attempt: ${priorAttempt.feedback!.slice(0, 200)}` });
        continue;
      }
      // Every gate has passed — this call WILL execute. Announce it so a UI can show live activity
      // ("running: bash npm test") instead of a card that materializes only after the fact.
      currentCall = toolCalls;
      currentTurn = turn;
      emit({ turn, kind: "tool_start", detail: `${call.name}(${briefArgs(call.args)})`, data: { call: toolCalls, name: call.name, target: briefArgs(call.args) } });
      const toolStartedAt = Date.now();
      const res = await tool.execute(call.args, ctx);
      const toolDurationMs = Date.now() - toolStartedAt;
      if (call.name === "edit" || call.name === "write") {
        if (!res.isError) {
          hasEdited = true; mutationSinceAutoCheck = true;
          // The world changed: every earlier failure is worth re-attempting, so the ledger forgets.
          ledger.noteMutation();
        }
      }
      if (call.name === "bash") {
        const c = String(call.args.command ?? ""); bashAll.push(c);
        if (!res.isError) { bashOk.push(c); if (hasEdited && RUN_CHECK_RE.test(c)) passingChecks++; }
      }
      if (res.isError) ledger.recordFailure(call.name, call.args, res.output);
      let output = res.output;
      // A first repeat is a warning, not a wall: the call ran, and the earlier failure rides along
      // with its result so the model can see the pattern itself.
      if (priorAttempt.feedback) output += `\n${priorAttempt.feedback}`;
      // Reliability hook: append a post-edit diagnostic (type/syntax gate — Tier A2) so a broken edit
      // is rejected and re-asked in the same turn, not three tool calls later.
      const extra = await params.postToolHook?.({ name: call.name, args: call.args }, res, ctx);
      if (extra) output += `\n${extra}`;
      messages.push(toolResultTurn(call.id, call.name, output));
      emit({ turn, kind: "tool", detail: `${call.name}(${briefArgs(call.args)}) -> ${res.isError ? "ERR" : "ok"}${extra ? " +diag" : ""}`, data: { error: res.isError, output: output.slice(0, 500), call: toolCalls, durationMs: toolDurationMs } });
    }
    if (!finished && params.autoFinishAfterMutation && params.autoFinish && mutationSinceAutoCheck) {
      const auto = await params.autoFinish({ cwd: params.cwd, filesWritten: [...ctx.filesWritten], bashOk, bashAll, summary: "" });
      mutationSinceAutoCheck = false;
      if (auto.allowed) {
        finished = true;
        summary = auto.summary ?? "Completed and verified by the harness.";
        emit({ turn, kind: "finish", detail: summary });
      } else if (auto.feedback) {
        messages.push({ role: "user", content: `Harness verification failed: ${auto.feedback}` });
        emit({ turn, kind: "nudge", detail: `harness verification failed: ${auto.feedback.slice(0, 240)}` });
      }
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
    confidence: params.captureConfidence ? aggregateSelfCertainty(logprobChunks) : undefined,
    inferenceProfile: profile,
    runtimeReceipt,
    inferenceTimings,
  };
}

/** Coalesce streamed deltas so we emit a handful of events per turn, not one per token (Goal §3):
 *  content flushes at ~48 chars, reasoning at ~300 chars (bounded), plus a final flush at turn end. */
function makeDeltaCoalescer(turn: number, emit: (e: AgentEvent) => void): { push: (d: StreamDelta) => void; flush: () => void } {
  let content = "", reasoning = "";
  let reasoningEvents = 0;
  // Reasoning no longer costs a durable row, so the cap exists only to stop a runaway model from
  // flooding the socket. At ~4 characters a token this is tens of thousands of tokens of thinking.
  const MAX_REASONING_EVENTS = 4000;
  const flushContent = (): void => { if (content) { emit({ turn, kind: "assistant_delta", detail: content }); content = ""; } };
  const flushReasoning = (): void => {
    if (reasoning && reasoningEvents < MAX_REASONING_EVENTS) { emit({ turn, kind: "reasoning_delta", detail: reasoning }); reasoningEvents++; }
    reasoning = "";
  };
  return {
    push: (d: StreamDelta): void => {
      // Roughly every two or three tokens. Coarser than this reads as lurching rather than typing —
      // the previous 300-character reasoning threshold meant one update per ~75 tokens, which on a
      // 15 tok/s local model is one flicker every five seconds.
      if (d.content) { content += d.content; if (content.length >= 10) flushContent(); }
      if (d.reasoning) { reasoning += d.reasoning; if (reasoning.length >= 12) flushReasoning(); }
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
