// Kitten Core — the standalone LM Studio provider. NO Pi.
//
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
  main: string;
  sidecar: string;
  embed?: string;
  /** Bearer token. Defaults to "lm-studio" (LM Studio ignores it); a real key for a cloud endpoint. */
  apiKey?: string;
  /** Extra headers merged onto every request (e.g. a cloud provider's required header). */
  extraHeaders?: Record<string, string>;
}

export const DEFAULT_MODELS: KittenModels = {
  baseUrl: process.env.KITTEN_BASE_URL || "http://localhost:1234/v1",
  main: process.env.KITTEN_MAIN_MODEL || "ornith-1.0-35b",
  sidecar: process.env.KITTEN_SIDECAR_MODEL || "qwen3.5-2b",
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
    sidecar: opts.sidecar || opts.main || "qwen3.6-35b-a3b",
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
  const isCloud = /^https?:\/\//.test(models.baseUrl) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(models.baseUrl);
  if (isCloud && !process.env.KITTEN_SIDECAR_MODEL) {
    return { ...models, sidecar: process.env.KITTEN_CLOUD_SIDECAR_MODEL || "qwen3-8b" };
  }
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
}

export interface ChatParams {
  model?: string;
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
}

/** One generated token's probability + its top alternatives (parsed from an OpenAI-style logprobs payload). */
export interface TokenLogprob {
  token: string;
  logprob: number;
  top: Array<{ token: string; logprob: number }>;
}

// Reasoning models need headroom: the reasoning block is counted against max_tokens, so a small
// budget yields empty content (observed live: max_tokens=16 -> 16 reasoning tokens, no answer).
const DEFAULT_MAIN_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 600_000;

export class KittenLLM {
  constructor(public readonly models: KittenModels = DEFAULT_MODELS) {}

  private url(path: string): string {
    return `${this.models.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** Auth + content headers. Bearer defaults to "lm-studio" (ignored locally); a real key for cloud. */
  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.models.apiKey ?? "lm-studio"}`, ...(this.models.extraHeaders ?? {}) };
  }

  /** One chat completion. Never throws — a failure returns ok:false so the caller can degrade. */
  async chat(params: ChatParams): Promise<ChatResult> {
    const started = Date.now();
    const model = params.model ?? this.models.main;
    const body: Record<string, unknown> = {
      model,
      messages: params.messages.map(serializeMessage),
      max_tokens: params.maxTokens ?? DEFAULT_MAIN_MAX_TOKENS,
      stream: false
    };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      if (params.toolChoice) body.tool_choice = params.toolChoice;
    }
    if (params.jsonSchema) {
      body.response_format = { type: "json_schema", json_schema: { name: params.jsonSchema.name, strict: true, schema: params.jsonSchema.schema } };
    }
    if (params.logprobs) { body.logprobs = true; if (params.topLogprobs) body.top_logprobs = params.topLogprobs; }
    if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
    // Owned-inference decode controls — sent only when set; a picky engine's rejection is the caller's
    // capability-latch concern (it drops the offending field and retries).
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.topK !== undefined) body.top_k = params.topK;
    if (params.minP !== undefined) body.min_p = params.minP;
    if (params.dryMultiplier !== undefined) body.dry_multiplier = params.dryMultiplier;
    if (params.stop?.length) body.stop = params.stop;
    if (params.logitBias && Object.keys(params.logitBias).length) body.logit_bias = params.logitBias;
    if (params.grammar) body.grammar = params.grammar;
    if (params.cachePrompt) body.cache_prompt = params.cachePrompt;
    if (params.disableThinking) body.chat_template_kwargs = { ...(body.chat_template_kwargs as object ?? {}), enable_thinking: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = params.signal ?? controller.signal;
    try {
      const res = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
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
        logprobs: parseLogprobs(choice.logprobs)
      };
    } catch (err) {
      const e = err as Error;
      return failure(e.name === "AbortError" ? "timeout" : `network: ${e.message}`, started);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A sidecar call: the fast CPU model, defaulted to a tight budget and (optionally) json_schema.
   * Used everywhere Kitten needs a clerical/structured answer without spending the GPU model's turn.
   */
  async sidecar(params: Omit<ChatParams, "model"> & { model?: string }): Promise<ChatResult> {
    return this.chat({ ...params, model: params.model ?? this.models.sidecar, maxTokens: params.maxTokens ?? 512, timeoutMs: params.timeoutMs ?? 60_000 });
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
      const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const res = await fetch(this.rootUrl("/completion"), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: params.signal ?? controller.signal });
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
    const r = await this.chat({ model, messages: [{ role: "user", content: "Reply: OK" }], maxTokens: 64, timeoutMs: 20_000 });
    return r.ok;
  }
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
