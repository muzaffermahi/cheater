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
}

export const DEFAULT_MODELS: KittenModels = {
  baseUrl: process.env.KITTEN_BASE_URL || "http://localhost:1234/v1",
  main: process.env.KITTEN_MAIN_MODEL || "ornith-1.0-35b",
  sidecar: process.env.KITTEN_SIDECAR_MODEL || "qwen3.5-2b",
  embed: process.env.KITTEN_EMBED_MODEL || "text-embedding-nomic-embed-text-v1.5"
};

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
  timeoutMs?: number;
  /** LM Studio / Qwen reasoning-effort hint (best-effort; ignored by models that lack it). */
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
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
    if (params.logprobs) body.logprobs = true;
    if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = params.signal ?? controller.signal;
    try {
      const res = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer lm-studio" },
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
        raw: json
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
        headers: { "content-type": "application/json", authorization: "Bearer lm-studio" },
        body: JSON.stringify({ model: this.models.embed, input: texts })
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      return (json?.data ?? []).map((d: any) => d.embedding as number[]);
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
