// Kitten Core — the standalone LM Studio provider. NO Pi.
//
import type { InferenceCapabilities } from "./inferenceProfiles.js";

// This is the "own the inference engine" layer: a direct OpenAI-compatible HTTP client for the
// local LM Studio server, talking to three models at once —
//   - MAIN (ornith-1.0-35b): a reasoning model on the GPU. Emits `reasoning_content` separately
//     from `content`, supports native tool-calling and `response_format`. Its reasoning eats the
//     token budget, so main calls get a large max_tokens by default.
//   - SIDECAR (qwen3.5-2b): a fast dense model on the CPU. No reasoning tax, clean JSON, ~1s/call.
//     This is the workhorse for clerical + structured jobs — we keep it BUSY.
//   - EMBED (nomic-embed-text): for semantic localization/retrieval.
//
// Owning the engine gives Kitten what Pi's provider cannot: per-call temperature, json_schema
// structured output, logprobs, streaming control, and parallel main+sidecar dispatch. Everything
// here is a thin, well-typed wrapper over fetch; no SDK, no framework.

export interface KittenModels {
  baseUrl: string;
  /** Optional separate OpenAI-compatible endpoint for the small sidecar runtime. */
  sidecarBaseUrl?: string;
  main: string;
  /** Legacy compatibility field. Kitten no longer provisions a second model; omitted by default. */
  sidecar?: string;
  embed?: string;
  /** Bearer token. Defaults to "lm-studio" (LM Studio ignores it); a real key for a cloud endpoint. */
  apiKey?: string;
  /** Extra headers merged onto every request (e.g. a cloud provider's required header). */
  extraHeaders?: Record<string, string>;
}

export const DEFAULT_MODELS: KittenModels = {
  baseUrl: process.env.KITTEN_BASE_URL || "http://localhost:1234/v1",
  main: process.env.KITTEN_MAIN_MODEL || "ornith-1.0-35b",
  // Sidecar is intentionally absent from the supported default runtime. Legacy callers may still
  // provide `models.sidecar`, but all built-in phases use the primary model and Runtime Director.
  sidecar: process.env.KITTEN_SIDECAR_MODEL || undefined,
  embed: process.env.KITTEN_EMBED_MODEL || "text-embedding-nomic-embed-text-v1.5",
  apiKey: process.env.KITTEN_API_KEY || undefined
};

/**
 * Build a KittenLLM pointed at the Alibaba cloud endpoint that serves the EXACT SAME WEIGHTS as the
 * local ornith (qwen3.6-35b-a3b). This is the cloud-burst substrate (Part C2): identical model,
 * parallelisable, so large-N coverage doesn't wait hours at 25 tok/s — and the capability claim stays
 * honest because it is not a bigger model. The sidecar stays local (a 2B on the cloud is wasteful);
 * when only the cloud endpoint is available, main doubles as sidecar.
 */
export function cloudModels(opts: { baseUrl: string; apiKey: string; main?: string; sidecar?: string }): KittenModels {
  return {
    baseUrl: opts.baseUrl,
    main: opts.main || "qwen3.6-35b-a3b",
    sidecar: opts.sidecar,
    apiKey: opts.apiKey
  };
}

/**
 * Model tiering (research: Aider's weak-model for commit/summary; Claude Code runs Explore/guide on
 * Haiku): the SIDECAR does mechanical work (task-family classify, probe-input generation, failure
 * cards) that does NOT need the full reasoning model — so on a cloud endpoint (where the local 2b isn't
 * served anyway) tier the sidecar to a cheap cloud model. No-op locally, or when the sidecar was set
 * explicitly (KITTEN_SIDECAR_MODEL). This keeps the expensive model spent only on the actual coding.
 */
export function tierSidecar(models: KittenModels): KittenModels {
  // Kept as a source-compatible no-op for old settings and plugins. No automatic model tiering is
  // allowed: it made runtime ownership ambiguous and silently routed calls to the wrong process.
  return models;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema for the arguments
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant turns that called tools */
  tool_calls?: RawToolCall[];
  /** tool result turns */
  tool_call_id?: string;
  name?: string;
}

interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  /** parsed arguments; {} when the model emitted invalid JSON (recorded in argError) */
  args: Record<string, unknown>;
  argError?: string;
  raw: string;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ParsedToolCall[];
  finishReason: string;
  usage: { prompt: number; completion: number; reasoning: number; total: number };
  ok: boolean;
  error?: string;
  elapsedMs: number;
  raw?: unknown;
  /** Per-token logprobs of the generated content, when requested (for self-certainty selection). */
  logprobs?: TokenLogprob[];
  /** Number of formatting-constraint fallbacks used for this request (normally 0/undefined). */
  formatRescues?: number;
  /** llama.cpp server timings, when the endpoint exposes them. */
  timings?: InferenceTimings;
}

export interface InferenceTimings {
  cacheTokens?: number;
  promptTokens?: number;
  promptMs?: number;
  promptTokensPerSecond?: number;
  predictedTokens?: number;
  predictedMs?: number;
  predictedTokensPerSecond?: number;
  totalMs?: number;
}

export interface ChatParams {
  model?: string;
  /** Internal endpoint override used by the sidecar; omitted for the main model. */
  endpointBaseUrl?: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  toolChoice?: "auto" | "none" | "required";
  maxTokens?: number;
  temperature?: number;
  /** { name, schema } for response_format json_schema (structured output). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  logprobs?: boolean;
  /** Request top-N alternatives per token (needed for self-certainty selection). */
  topLogprobs?: number;
  timeoutMs?: number;
  /** LM Studio / Qwen reasoning-effort hint (best-effort; ignored by models that lack it). */
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * Hard cap on thinking tokens for this call (llama.cpp `reasoning_budget`). Unlike the effort hint
   * this is a real bound: 0 disables reasoning outright. Set it from task hardness — thinking is worth
   * paying for on a hard task and is the dominant latency cost on an easy one.
   */
  reasoningBudget?: number;
  signal?: AbortSignal;

  // ── Owned-inference decode controls (Pi/opencode cannot send these). Each is optional and only
  //    applied when set; on an engine that rejects one, the caller's capability latch drops it. ──
  /** Nucleus sampling. Reachable on cloud + LM Studio + llama.cpp. */
  topP?: number;
  /** Top-k truncation. cloud/LM Studio/llama.cpp. */
  topK?: number;
  /** min-p confidence-scaled truncation. llama.cpp native only. */
  minP?: number;
  /** DRY (don't-repeat-yourself) multiplier. llama.cpp native only. */
  dryMultiplier?: number;
  /** Optional sampler controls; kept on auto until a provider advertises support. */
  repeatPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  /** Stop sequences. */
  stop?: string[];
  /** token-id → bias (OpenAI form `{id: -100}`). A hard ban is -100 (cloud/LM Studio) or `false` (native). */
  logitBias?: Record<number, number>;
  /** GBNF grammar string (constrain output). llama.cpp native only. */
  grammar?: string;
  /** Reuse the KV cache of the longest matching prefix across calls. llama.cpp native only. */
  cachePrompt?: boolean;
  /** Disable the model's chain-of-thought (qwen3/ornith `enable_thinking:false` via chat_template_kwargs).
   *  On a single-function task the model writes code directly ~2x faster; the harness supplies correctness.
   *  Needs a native `--jinja` server. */
  disableThinking?: boolean;
  /** Optional role for bounded inference telemetry. */
  role?: string;
}

/** An incremental piece of a streamed generation (content and/or reasoning that just arrived). */
export interface StreamDelta {
  content?: string;
  reasoning?: string;
}

/** One generated token's probability + its top alternatives (parsed from an OpenAI-style logprobs payload). */
export interface TokenLogprob {
  token: string;
  logprob: number;
  top: Array<{ token: string; logprob: number }>;
}

// Reasoning models need headroom: the reasoning block is counted against max_tokens, so a small
// budget yields empty content (observed live: max_tokens=16 -> 16 reasoning tokens, no answer).
//
// 4096 was far too small, and it failed in a way that looked like anything but a token cap. An agent
// writing a whole file puts the file body inside ONE tool-call argument, so the cap cuts the JSON
// string mid-value; llama.cpp then rejects its own model's output with
// `HTTP 500 ... parse error ... invalid string: missing closing quote`. Observed live: a
// single-file Pac-Man clone (~20 KB, comfortably past 4096 tokens) killed all four ascent candidates
// this way, each dying identically, with nothing in the error naming a length limit.
//
// Measured against the reference llama.cpp runtime (32k ctx): max_tokens of 16384, 24576, 32768 and
// even 65536 are all ACCEPTED and clamped server-side to the remaining context — there is no 4xx to
// avoid, so the only thing the old value bought was truncation. 16384 fits a ~50 KB file in one
// write while still bounding a runaway generation.
const DEFAULT_MAIN_MAX_TOKENS = 16384;
// No implicit generation timeout. A local model may spend longer than ten minutes in prefill or
// reasoning; only an explicit caller timeout or user cancellation may abort the request.

// Process-wide because project-local settings may construct separate KittenLLM instances while
// still targeting the same LM Studio/llama.cpp endpoint.
const GLOBAL_ENDPOINT_QUEUES = new Map<string, Promise<void>>();

function endpointKey(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function retryableRuntimeStatus(status: number): boolean {
  // Local runtimes commonly answer 503 while loading a large GGUF or swapping a model slot, and 500
  // for their own transient trouble (a failed slot, a GC pause). Retrying those here is cheap and
  // usually works. A 4xx configuration error must surface immediately.
  return status === 408 || status === 425 || status === 429
    || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * A 500 whose body says the server could not parse the model's OWN tool call.
 *
 * Retrying this at the transport layer is the wrong move, and measurably so: the request is
 * byte-identical, so the model regenerates the same oversized `write`, and llama.cpp's parser breaks
 * in the same place. On a local 35B that is ~2 minutes per wasted attempt. The bakeoff's mini_sql
 * spent 513 s on exactly this before giving up.
 *
 * The agent loop already handles the case properly one level up: it retries WITH guidance telling
 * the model to split the write across smaller calls (agent.ts, `truncatedToolCall`). Failing fast
 * here is what lets that guided retry happen instead of burning the budget on identical resends.
 */
function isToolCallParseFailure(status: number, body: string): boolean {
  if (status !== 500 || !body) return false;
  return /parse.{0,40}tool.?call|tool.?call.{0,40}parse/i.test(body)
    || (/parse_error|parse error/i.test(body) && /invalid string|missing closing|unterminated/i.test(body));
}

/**
 * "Loading model" is not a transient hiccup — it is a promise that the server will be ready shortly.
 *
 * llama.cpp answers 503 with this body for the entire time it reads a large GGUF, which on a 25 GB
 * Q5_K_M is tens of seconds to minutes. The generic transient-retry budget (three attempts, 250ms and
 * 750ms apart) expires inside one second, so every cold start failed the run outright with
 * `HTTP 503 {"message":"Loading model"}` — the model then finished loading a minute later and sat
 * there, ready, having already lost the turn.
 */
function isModelLoading(status: number, body: string | undefined): boolean {
  if (status !== 503) return false;
  return !body || /loading|not (?:yet )?ready|warming|starting/i.test(body);
}

function retryDelayMs(attempt: number, response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(2000, retryAfter * 1000);
  return [250, 750][Math.min(attempt, 1)] ?? 750;
}

/**
 * How long to keep waiting on a server that says it is still loading its weights, and how often to
 * ask. The backoff starts quick — a server that is nearly ready should not cost a full poll interval —
 * and settles at two seconds, which is a sensible cadence for something that takes a minute.
 */
const LOADING_WAIT_CEILING_MS = 300_000;
const LOADING_BACKOFF_MS = [200, 500, 1_000, 2_000] as const;
function loadingPollMs(waited: number): number {
  return LOADING_BACKOFF_MS[Math.min(waited, LOADING_BACKOFF_MS.length - 1)];
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(true); }, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(false); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class KittenLLM {
  constructor(public readonly models: KittenModels = DEFAULT_MODELS) {}

  /** Capability facts supplied to Runtime Director after a live engine probe. */
  inferenceCapabilities?: InferenceCapabilities;
  runtimeOwnership: "managed-native" | "external-compatible" = "external-compatible";
  private _runtimePrepared = false;

  /** Reconcile per-request controls with the actual endpoint once per client instance. */
  async prepareRuntime(): Promise<InferenceCapabilities> {
    if (this._runtimePrepared && this.inferenceCapabilities) return this.inferenceCapabilities;
    const engine = await this.detectEngine(2000);
    this.runtimeOwnership = engine === "llamacpp" ? "managed-native" : "external-compatible";
    this.inferenceCapabilities = engine === "llamacpp"
      ? { temperature: true, topP: true, topK: true, minP: true, dryMultiplier: true, repeatPenalty: true, presencePenalty: true, seed: true, reasoningBudget: true, maxTokens: true, structuredOutput: true, logprobs: true, cachePrompt: true }
      : { temperature: true, topP: true, topK: true, minP: false, dryMultiplier: false, repeatPenalty: true, presencePenalty: true, seed: true, reasoningBudget: true, maxTokens: true, logprobs: false, cachePrompt: false };
    this._runtimePrepared = true;
    return this.inferenceCapabilities;
  }

  // A single LM Studio/llama.cpp endpoint is commonly shared by the main and sidecar
  // models. Serialize requests per endpoint so a clerical JSON call cannot collide with
  // a foreground generation or trigger an avoidable context/model swap. Separate
  // sidecarBaseUrl endpoints retain independent concurrency.
  private async acquireEndpointLock(endpoint: string, signal: AbortSignal): Promise<(() => void) | null> {
    const previous = GLOBAL_ENDPOINT_QUEUES.get(endpoint) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    GLOBAL_ENDPOINT_QUEUES.set(endpoint, current);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<boolean>((resolve) => {
      abortListener = () => resolve(true);
      if (signal.aborted) resolve(true);
      else signal.addEventListener("abort", abortListener, { once: true });
    });
    const winner = await Promise.race([previous.then(() => false), aborted]);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (winner) {
      release();
      if (GLOBAL_ENDPOINT_QUEUES.get(endpoint) === current) GLOBAL_ENDPOINT_QUEUES.delete(endpoint);
      return null;
    }
    return () => {
      release();
      if (GLOBAL_ENDPOINT_QUEUES.get(endpoint) === current) GLOBAL_ENDPOINT_QUEUES.delete(endpoint);
    };
  }

  private url(path: string, baseUrl = this.models.baseUrl): string {
    return `${baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** Auth + content headers. Bearer defaults to "lm-studio" (ignored locally); a real key for cloud. */
  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.models.apiKey ?? "lm-studio"}`, ...(this.models.extraHeaders ?? {}) };
  }

  /** Build the OpenAI-compatible request body shared by chat() and chatStream(). */
  private buildBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model ?? this.models.main,
      messages: params.messages.map(serializeMessage),
      max_tokens: params.maxTokens ?? DEFAULT_MAIN_MAX_TOKENS,
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      if (params.toolChoice) body.tool_choice = params.toolChoice;
    }
    if (params.jsonSchema) {
      body.response_format = { type: "json_schema", json_schema: { name: params.jsonSchema.name, strict: true, schema: params.jsonSchema.schema } };
    }
    if (params.logprobs) { body.logprobs = true; if (params.topLogprobs) body.top_logprobs = params.topLogprobs; }
    // `reasoning_effort` is sent for endpoints that honour it, but it is NOT a reliable control: on
    // llama.cpp only "none" dependably disables reasoning, and the graded values may do nothing at all.
    // So the effort hint never stands alone — `reasoningBudget` below is the mechanism that actually
    // bounds the thinking tax, and callers that care about latency must set it.
    if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
    if (params.reasoningBudget !== undefined && params.reasoningBudget >= 0) {
      body.reasoning_budget = Math.floor(params.reasoningBudget);
      if (params.reasoningBudget === 0) body.reasoning_effort = "none";
    }
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.topK !== undefined) body.top_k = params.topK;
    if (params.minP !== undefined) body.min_p = params.minP;
    if (params.dryMultiplier !== undefined) body.dry_multiplier = params.dryMultiplier;
    if (params.repeatPenalty !== undefined) body.repeat_penalty = params.repeatPenalty;
    if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
    if (params.seed !== undefined) body.seed = params.seed;
    if (params.stop?.length) body.stop = params.stop;
    if (params.logitBias && Object.keys(params.logitBias).length) body.logit_bias = params.logitBias;
    if (params.grammar) body.grammar = params.grammar;
    if (params.cachePrompt) body.cache_prompt = params.cachePrompt;
    if (params.disableThinking) {
      // Qwen3.5's official non-thinking path is the template kwarg. Force a zero budget too so
      // runtimes that ignore one half of the contract cannot silently spend a full reasoning turn.
      body.reasoning_budget = 0;
      body.reasoning_effort = "none";
      body.chat_template_kwargs = { ...(body.chat_template_kwargs as object ?? {}), enable_thinking: false };
    }
    return body;
  }

  /** A few OpenAI-compatible local servers reject optional structured-output fields with HTTP 400
   * while accepting the same prompt/tools normally. Retry once without only those constraints; never
   * weaken a safety/tool request or retry arbitrary configuration errors. */
  private formattingFallbackBody(body: Record<string, unknown>, params: ChatParams): Record<string, unknown> | null {
    if (!params.grammar && !params.jsonSchema) return null;
    const fallback = { ...body };
    let changed = false;
    if (params.grammar && Object.prototype.hasOwnProperty.call(fallback, "grammar")) { delete fallback.grammar; changed = true; }
    if (params.jsonSchema && Object.prototype.hasOwnProperty.call(fallback, "response_format")) { delete fallback.response_format; changed = true; }
    return changed ? fallback : null;
  }

  /** One chat completion. Never throws — a failure returns ok:false so the caller can degrade. */
  async chat(params: ChatParams): Promise<ChatResult> {
    const started = Date.now();
    const body = this.buildBody(params, false);
    const controller = new AbortController();
    const timer = params.timeoutMs && params.timeoutMs > 0 ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined;
    const signal = effectiveSignal(params.signal, controller.signal);
    const release = await this.acquireEndpointLock(endpointKey(params.endpointBaseUrl ?? this.models.baseUrl), signal);
    if (!release) { clearTimeout(timer); return failure(params.signal?.aborted ? "cancelled" : "timeout", started); }
    try {
      let res: Response | undefined;
      let bodyText: string | undefined;   // consumed while deciding whether to retry
      let loadingWaits = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(this.url("/chat/completions", params.endpointBaseUrl), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
        bodyText = undefined;
        if (res.ok) break;
        bodyText = await res.text().catch(() => "");
        // A loading model is worth waiting for; a transient error is worth three quick tries.
        if (isModelLoading(res.status, bodyText)) {
          if (Date.now() - started > LOADING_WAIT_CEILING_MS) break;
          if (!await waitForRetry(loadingPollMs(loadingWaits++), signal)) return failure(params.signal?.aborted ? "cancelled" : "timeout", started);
          attempt = -1; // bounded by the ceiling above and by the caller's own timeout, not by attempts
          continue;
        }
        if (!retryableRuntimeStatus(res.status) || attempt === 2) break;
        // An identical resend cannot fix the server failing to parse the model's own tool call —
        // only the agent loop's guided retry can. Surface it now rather than spending two more full
        // generations reproducing it.
        if (isToolCallParseFailure(res.status, bodyText ?? "")) break;
        if (!await waitForRetry(retryDelayMs(attempt, res), signal)) return failure(params.signal?.aborted ? "cancelled" : "timeout", started);
      }
      if (!res) return failure("network: no response", started);
      let formatRescues = 0;
      if (!res.ok && res.status === 400) {
        const fallbackBody = this.formattingFallbackBody(body, params);
        if (fallbackBody) {
          await res.text().catch(() => "");
          res = await fetch(this.url("/chat/completions", params.endpointBaseUrl), { method: "POST", headers: this.headers(), body: JSON.stringify(fallbackBody), signal });
          if (res.ok) formatRescues = 1;
        }
      }
      if (!res.ok) {
        const text = bodyText ?? await res.text().catch(() => "");
        return failure(`HTTP ${res.status}: ${text.slice(0, 300)}`, started);
      }
      const json: any = await res.json();
      const choice = json?.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      const usage = json?.usage ?? {};
      return {
        content: typeof msg.content === "string" ? msg.content : "",
        reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : (typeof msg.reasoning === "string" ? msg.reasoning : ""),
        toolCalls: parseToolCalls(msg.tool_calls),
        finishReason: choice.finish_reason ?? "stop",
        usage: {
          prompt: usage.prompt_tokens ?? 0,
          completion: usage.completion_tokens ?? 0,
          reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
          total: usage.total_tokens ?? 0
        },
        ok: true,
        elapsedMs: Date.now() - started,
        raw: json,
        logprobs: parseLogprobs(choice.logprobs),
        timings: parseInferenceTimings(json?.timings, usage),
        ...(formatRescues ? { formatRescues } : {})
      };
    } catch (err) {
      const e = err as Error;
      // Distinguish a caller cancellation from a timeout (Goal §3/§6: a cancelled read is not a failure).
      const reason = e.name === "AbortError" ? (params.signal?.aborted ? "cancelled" : "timeout") : `network: ${e.message}`;
      return failure(reason, started);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  /**
   * Streaming chat completion. Parses OpenAI/llama.cpp SSE chunks, calling `onDelta` with incremental
   * content/reasoning as they arrive, and returns the SAME reconstructed ChatResult as chat() (full
   * content + exactly-reconstructed tool calls — partial tool arguments are NEVER surfaced to callers).
   * Never throws; a cancelled read returns ok:false error "cancelled" (not a generic network failure).
   */
  async chatStream(params: ChatParams, onDelta: (d: StreamDelta) => void): Promise<ChatResult> {
    const started = Date.now();
    const body = this.buildBody(params, true);
    const controller = new AbortController();
    const timer = params.timeoutMs && params.timeoutMs > 0 ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined;
    const signal = effectiveSignal(params.signal, controller.signal);
    const release = await this.acquireEndpointLock(endpointKey(params.endpointBaseUrl ?? this.models.baseUrl), signal);
    if (!release) { clearTimeout(timer); return failure(params.signal?.aborted ? "cancelled" : "timeout", started); }
    const acc = new StreamAccumulator();
    try {
      let res: Response | undefined;
      let bodyText: string | undefined;   // consumed while deciding whether to retry
      let loadingWaits = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(this.url("/chat/completions", params.endpointBaseUrl), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
        bodyText = undefined;
        if (res.ok) break;
        bodyText = await res.text().catch(() => "");
        // A loading model is worth waiting for; a transient error is worth three quick tries.
        if (isModelLoading(res.status, bodyText)) {
          if (Date.now() - started > LOADING_WAIT_CEILING_MS) break;
          if (!await waitForRetry(loadingPollMs(loadingWaits++), signal)) return failure(params.signal?.aborted ? "cancelled" : "timeout", started);
          attempt = -1; // bounded by the ceiling above and by the caller's own timeout, not by attempts
          continue;
        }
        if (!retryableRuntimeStatus(res.status) || attempt === 2) break;
        // An identical resend cannot fix the server failing to parse the model's own tool call —
        // only the agent loop's guided retry can. Surface it now rather than spending two more full
        // generations reproducing it.
        if (isToolCallParseFailure(res.status, bodyText ?? "")) break;
        if (!await waitForRetry(retryDelayMs(attempt, res), signal)) return failure(params.signal?.aborted ? "cancelled" : "timeout", started);
      }
      if (!res) return failure("network: no response", started);
      let formatRescues = 0;
      if (!res.ok && res.status === 400) {
        const fallbackBody = this.formattingFallbackBody(body, params);
        if (fallbackBody) {
          await res.text().catch(() => "");
          res = await fetch(this.url("/chat/completions", params.endpointBaseUrl), { method: "POST", headers: this.headers(), body: JSON.stringify(fallbackBody), signal });
          if (res.ok) formatRescues = 1;
        }
      }
      if (!res.ok) {
        const text = bodyText ?? await res.text().catch(() => "");
        return failure(`HTTP ${res.status}: ${text.slice(0, 300)}`, started);
      }
      if (!res.body) return failure("no response body for stream", started);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // SSE events are separated by a blank line in ANY newline form (LF `\n\n`, CRLF `\r\n\r\n`, or
      // CR `\r\r`). Matching only `\n\n` meant a CRLF-framed stream (some gateways reframe it) never
      // split — the whole response buffered and was dropped as a silent empty ok:true. Match all three,
      // split each frame's lines the same way, and flush a final frame that lacks a trailing blank line.
      const FRAME = /\r\n\r\n|\n\n|\r\r/;
      let sawDone = false;
      const processFrame = (frame: string): void => {
        for (const line of frame.split(/\r\n|\n|\r/)) {
          const m = line.match(/^data:\s?(.*)$/);
          if (!m) continue;
          const payload = m[1];
          if (payload === "[DONE]") { sawDone = true; acc.markDone(); continue; }
          let json: any;
          try { json = JSON.parse(payload); } catch { continue; } // skip a malformed/partial chunk
          const d = acc.consume(json);
          if (d.content || d.reasoning) { try { onDelta(d); } catch { /* a bad listener never breaks the stream */ } }
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let m2: RegExpExecArray | null;
        while ((m2 = FRAME.exec(buf))) {
          const frame = buf.slice(0, m2.index);
          buf = buf.slice(m2.index + m2[0].length);
          processFrame(frame);
        }
      }
      if (buf.length) processFrame(buf); // a final frame can arrive without a trailing blank line before EOF
      const finalized = acc.finalize(started, sawDone);
      return formatRescues ? { ...finalized, formatRescues } : finalized;
    } catch (err) {
      const e = err as Error;
      const reason = e.name === "AbortError" ? (params.signal?.aborted ? "cancelled" : "timeout") : `network: ${e.message}`;
      return failure(reason, started);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  /** Whether streaming works on this endpoint/model — probed once and cached. */
  async supportsStreaming(): Promise<boolean> {
    if (this._streamCap !== undefined) return this._streamCap;
    let sawDelta = false;
    const r = await this.chatStream(
      { messages: [{ role: "user", content: "Reply: OK" }], maxTokens: 8, timeoutMs: 20000 },
      () => { sawDelta = true; },
    );
    this._streamCap = r.ok && (sawDelta || r.content.length > 0 || r.reasoning.length > 0);
    return this._streamCap;
  }
  private _streamCap?: boolean;

  /**
   * A sidecar call: the fast CPU model, defaulted to a tight budget and (optionally) json_schema.
   * Used everywhere Kitten needs a clerical/structured answer without spending the GPU model's turn.
   */
  async sidecar(params: Omit<ChatParams, "model"> & { model?: string }): Promise<ChatResult> {
    // Sidecar work is MECHANICAL (JSON test-inputs, family label, failure card) — it must NOT reason.
    // A reasoning model (ornith) with thinking ON burns the whole token budget in reasoning_content and
    // returns EMPTY content, which silently killed consensus/classification on the local native engine.
    // Default thinking OFF; if a picky endpoint rejects chat_template_kwargs, retry once with it on.
    const p = { ...params, model: params.model ?? this.models.sidecar ?? this.models.main, endpointBaseUrl: params.endpointBaseUrl ?? (this.models.sidecarBaseUrl?.trim() || undefined), maxTokens: params.maxTokens ?? 512, timeoutMs: params.timeoutMs ?? 60_000, disableThinking: params.disableThinking ?? true };
    const r = await this.chat(p);
    // Only retry when the endpoint explicitly rejected the thinking-control field. Retrying
    // timeouts/network failures doubles latency and made a down 2B endpoint hold an entire
    // benchmark battery open for minutes with no new information.
    const retryWithoutThinking = !r.ok && p.disableThinking && !!r.error && /^HTTP 4(?:00|22)\b/i.test(r.error);
    if (retryWithoutThinking) return this.chat({ ...p, disableThinking: false });
    return r;
  }

  /** Embed texts with the local embedding model. Returns [] on any failure. */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.models.embed || !texts.length) return [];
    try {
      const res = await fetch(this.url("/embeddings"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model: this.models.embed, input: texts })
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      return (json?.data ?? []).map((d: any) => d.embedding as number[]);
    } catch {
      return [];
    }
  }

  // ── Owned-engine detection + native endpoints (the leverage Pi/opencode structurally lack) ──────────
  // The base URL replaces "/v1"; native llama.cpp serves /props, /completion, /tokenize at the ROOT.
  private rootUrl(path: string): string {
    return `${this.models.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}${path}`;
  }

  /**
   * Probe the engine ONCE and cache it. `GET /props` succeeding ⇒ a native llama.cpp server (unlocks
   * grammar, n_probs, cache_prompt, min_p/DRY, /completion, /infill, /tokenize). Anything else ⇒ an
   * OpenAI proxy (LM Studio / cloud) where only the standard subset is reachable. Never throws.
   */
  async detectEngine(timeoutMs = 4000): Promise<"llamacpp" | "openai-proxy"> {
    if (this._engine) return this._engine;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(this.rootUrl("/props"), { headers: this.headers(), signal: controller.signal });
      clearTimeout(t);
      const json: any = res.ok ? await res.json().catch(() => null) : null;
      this._engine = json && (json.default_generation_settings || json.chat_template !== undefined || json.model_path) ? "llamacpp" : "openai-proxy";
    } catch {
      this._engine = "openai-proxy";
    }
    return this._engine;
  }
  private _engine?: "llamacpp" | "openai-proxy";

  /**
   * Native raw completion (`POST /completion`) — the endpoint that carries the controls the chat
   * endpoint can't (assistant-prefill via a hand-built prompt, `cache_prompt` KV reuse, `n_probs`,
   * `grammar`). Returns ok:false when unavailable so callers degrade to chat(). Never throws.
   */
  async complete(params: { prompt: string; model?: string; maxTokens?: number; temperature?: number; stop?: string[]; grammar?: string; cachePrompt?: boolean; nProbs?: number; minP?: number; topK?: number; topP?: number; logitBias?: Array<[number, number | false]>; timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: boolean; content: string; logprobs?: TokenLogprob[]; error?: string }> {
    const body: Record<string, unknown> = { prompt: params.prompt, n_predict: params.maxTokens ?? DEFAULT_MAIN_MAX_TOKENS, cache_prompt: params.cachePrompt ?? true, stream: false };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.stop?.length) body.stop = params.stop;
    if (params.grammar) body.grammar = params.grammar;
    if (params.nProbs) body.n_probs = params.nProbs;
    if (params.minP !== undefined) body.min_p = params.minP;
    if (params.topK !== undefined) body.top_k = params.topK;
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.logitBias?.length) body.logit_bias = params.logitBias;
    try {
      const controller = new AbortController();
      const timer = params.timeoutMs && params.timeoutMs > 0 ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined;
      const res = await fetch(this.rootUrl("/completion"), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: effectiveSignal(params.signal, controller.signal) });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, content: "", error: `HTTP ${res.status}` };
      const json: any = await res.json();
      // llama.cpp /completion returns { content, completion_probabilities? }
      const probs = Array.isArray(json?.completion_probabilities)
        ? json.completion_probabilities.map((p: any) => ({ token: String(p?.content ?? p?.token ?? ""), logprob: typeof p?.logprob === "number" ? p.logprob : Math.log(Math.max(1e-9, p?.prob ?? 0)), top: Array.isArray(p?.probs) ? p.probs.map((x: any) => ({ token: String(x?.tok_str ?? x?.token ?? ""), logprob: typeof x?.logprob === "number" ? x.logprob : Math.log(Math.max(1e-9, x?.prob ?? 0)) })) : [] }))
        : undefined;
      return { ok: true, content: typeof json?.content === "string" ? json.content : "", logprobs: probs };
    } catch (err) {
      return { ok: false, content: "", error: (err as Error).message };
    }
  }

  /** Native `POST /tokenize` → token ids (for precise logit_bias). Returns [] when unavailable. */
  async tokenize(text: string, timeoutMs = 10000): Promise<number[]> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(this.rootUrl("/tokenize"), { method: "POST", headers: this.headers(), body: JSON.stringify({ content: text, add_special: false }), signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return [];
      const json: any = await res.json();
      const toks = json?.tokens;
      return Array.isArray(toks) ? toks.map((x: any) => (typeof x === "number" ? x : x?.id)).filter((n: any) => typeof n === "number") : [];
    } catch {
      return [];
    }
  }

  /** Cheap capability + liveness probe: is the given model answering? */
  async ping(model: string): Promise<boolean> {
    return (await this.pingDetailed(model)).ok;
  }

  /**
   * Proof of life with the reason attached. A local runtime JIT-loads weights on first use and a 35B
   * needs tens of seconds, so a timeout here means "loading", not "missing" — the caller has to be able
   * to say which, instead of telling the user to load a model that is already loading.
   */
  async pingDetailed(model: string, timeoutMs = 45_000): Promise<{ ok: boolean; loading: boolean; elapsedMs: number; error?: string }> {
    const started = Date.now();
    const r = await this.chat({ model, messages: [{ role: "user", content: "Reply: OK" }], maxTokens: 64, timeoutMs });
    return { ok: r.ok, loading: !r.ok && r.error === "timeout", elapsedMs: Date.now() - started, ...(r.ok ? {} : { error: r.error ?? "no completion" }) };
  }

  /** List models from the endpoint. Returns null on any failure (never throws). */
  async listModels(): Promise<string[] | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${this.models.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { authorization: `Bearer ${this.models.apiKey ?? "lm-studio"}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const j = await res.json() as { data?: Array<{ id?: string }> };
      const list = (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
      return list.length ? list : null;
    } catch {
      return null;
    }
  }
}

/** Accumulates OpenAI/llama.cpp streaming chunks into a full ChatResult, exposing per-chunk deltas. */
class StreamAccumulator {
  private content = "";
  private reasoning = "";
  private finishReason = "stop";
  private sawTerminal = false;
  private usage = { prompt: 0, completion: 0, reasoning: 0, total: 0 };
  private readonly toolAcc = new Map<number, { id: string; name: string; args: string }>();
  private lastRaw: unknown = null;
  private timings: InferenceTimings | undefined;

  markDone(): void { this.sawTerminal = true; }

  /** Fold one parsed SSE chunk in; return the content/reasoning that just arrived (for the UI). */
  consume(json: any): StreamDelta {
    this.lastRaw = json;
    const parsedTimings = parseInferenceTimings(json?.timings, json?.usage);
    if (parsedTimings) this.timings = { ...(this.timings ?? {}), ...parsedTimings };
    if (json?.usage) {
      const u = json.usage;
      this.usage = {
        prompt: u.prompt_tokens ?? this.usage.prompt,
        completion: u.completion_tokens ?? this.usage.completion,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? this.usage.reasoning,
        total: u.total_tokens ?? this.usage.total,
      };
    }
    const choice = json?.choices?.[0];
    if (!choice) return {};
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.finishReason = String(choice.finish_reason);
      this.sawTerminal = true;
    }
    const delta = choice.delta ?? {};
    const out: StreamDelta = {};
    if (typeof delta.content === "string" && delta.content) { this.content += delta.content; out.content = delta.content; }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) { this.reasoning += delta.reasoning_content; out.reasoning = delta.reasoning_content; }
    else if (typeof delta.reasoning === "string" && delta.reasoning) { this.reasoning += delta.reasoning; out.reasoning = delta.reasoning; }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : this.toolAcc.size;
        const cur = this.toolAcc.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
        this.toolAcc.set(idx, cur);
      }
    }
    return out;
  }

  /** Reconstruct the final ChatResult — tool calls parsed EXACTLY from the assembled fragments. */
  finalize(started: number, sawDone = false): ChatResult {
    // A dropped socket is not a valid completion. Previously the accumulator defaulted to
    // finishReason="stop", so a disconnect became an apparently successful tool-free turn and the
    // agent eventually stopped as "stalled". Let the agent's bounded transient retry recover it.
    if (!this.sawTerminal && !sawDone) return failure("stream ended before completion", started);
    const raw = [...this.toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, t], i) => ({
      id: t.id || `call-${i}`, type: "function" as const, function: { name: t.name, arguments: t.args },
    }));
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls: parseToolCalls(raw),
      finishReason: this.finishReason,
      usage: this.usage,
      ok: true,
      elapsedMs: Date.now() - started,
      raw: this.lastRaw,
      ...(this.timings ? { timings: this.timings } : {}),
    };
  }
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalize llama.cpp/LM Studio timing payloads while tolerating older OpenAI-compatible servers. */
export function parseInferenceTimings(raw: any, usage?: any): InferenceTimings | undefined {
  const t = raw && typeof raw === "object" ? raw : {};
  const cached = finiteNumber(t.cache_n ?? usage?.prompt_tokens_details?.cached_tokens);
  const rawOut: InferenceTimings = {
    cacheTokens: cached,
    promptTokens: finiteNumber(t.prompt_n ?? usage?.prompt_tokens),
    promptMs: finiteNumber(t.prompt_ms),
    promptTokensPerSecond: finiteNumber(t.prompt_per_second ?? t.prompt_per_second_tokens),
    predictedTokens: finiteNumber(t.predicted_n ?? usage?.completion_tokens),
    predictedMs: finiteNumber(t.predicted_ms),
    predictedTokensPerSecond: finiteNumber(t.predicted_per_second ?? t.predicted_per_second_tokens),
    totalMs: finiteNumber(t.total_ms)
  };
  const out = Object.fromEntries(Object.entries(rawOut).filter(([, value]) => value !== undefined)) as InferenceTimings;
  return Object.keys(out).length ? out : undefined;
}

function serializeMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

function parseToolCalls(raw: unknown): ParsedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedToolCall[] = [];
  for (const tc of raw) {
    const fn = tc?.function ?? {};
    const argStr = typeof fn.arguments === "string" ? fn.arguments : "";
    let args: Record<string, unknown> = {};
    let argError: string | undefined;
    try {
      args = argStr.trim() ? JSON.parse(argStr) : {};
    } catch (e) {
      argError = `invalid JSON args: ${(e as Error).message}`;
    }
    out.push({ id: tc.id ?? `call-${out.length}`, name: fn.name ?? "", args, argError, raw: argStr });
  }
  return out;
}

/** Parse an OpenAI-style `choice.logprobs` payload into a compact per-token form. Returns undefined
 *  when absent. Handles both the chat shape (`content[]`) and the legacy completion shape (`tokens[]`). */
function parseLogprobs(lp: any): TokenLogprob[] | undefined {
  const content = lp?.content;
  if (Array.isArray(content) && content.length) {
    return content.map((c: any) => ({
      token: String(c?.token ?? ""),
      logprob: typeof c?.logprob === "number" ? c.logprob : 0,
      top: Array.isArray(c?.top_logprobs) ? c.top_logprobs.map((t: any) => ({ token: String(t?.token ?? ""), logprob: typeof t?.logprob === "number" ? t.logprob : 0 })) : []
    }));
  }
  return undefined;
}

/**
 * Combine a caller's optional AbortSignal with the internal timeout controller so BOTH can abort the
 * fetch: the timer always bounds a stalled endpoint, and the caller's signal still cancels first. Using
 * only `params.signal ?? controller.signal` silently disabled the timeout whenever a caller passed a
 * signal (the normal agent/stream path) — a stalled local model could then hang indefinitely.
 */
function effectiveSignal(caller: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function failure(error: string, started: number): ChatResult {
  return { content: "", reasoning: "", toolCalls: [], finishReason: "error", usage: { prompt: 0, completion: 0, reasoning: 0, total: 0 }, ok: false, error, elapsedMs: Date.now() - started };
}

/** Reconstruct the assistant message to append to history after a tool-calling turn. */
export function assistantTurn(result: ChatResult): ChatMessage {
  return {
    role: "assistant",
    content: result.content,
    tool_calls: result.toolCalls.length
      ? result.toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.raw } }))
      : undefined
  };
}

/** A tool-result message for the conversation. */
export function toolResultTurn(callId: string, name: string, output: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, name, content: output };
}
