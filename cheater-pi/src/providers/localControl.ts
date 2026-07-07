// Decoding control: own the call path where cheater already can.
//
// Cheater rides Pi's provider for main-session turns (no temperature, no logprobs, no grammar, no
// stream control) - and full Pi provider surgery is OUT of scope. But cheater already makes DIRECT
// completions for the levers it owns (in-session best-of-N resampling, check/plan synthesis). This
// module is an OpenAI-compatible HTTP client for exactly that owned lane, adding the three knobs that
// matter - per-call temperature, response_format json_schema (structured output), and logprobs - each
// behind a one-time capability probe (probe, record, never assume; LM Studio and llama.cpp differ).
//
// Every feature is optional and self-downgrading: a 400 that names a feature marks it unsupported and
// the call retries once without it, so a picky endpoint still works (just without that knob). When no
// base URL is configured cheater cannot know the main model's endpoint (Pi owns it), so the client is
// simply unavailable and callers keep their existing SDK path. Network is injectable; tests never hit
// a real server.

import type { CheaterConfig } from "../types.js";

export type FeatureLatch = "unknown" | "supported" | "unsupported";

export interface LocalControlCapability {
  baseUrl: string;
  model?: string;
  temperature: FeatureLatch;
  jsonSchema: FeatureLatch;
  logprobs: FeatureLatch;
  notes: string[];
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface LocalCompleteParams {
  model?: string;
  system?: string;
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  temperature?: number;
  jsonSchema?: JsonSchemaSpec;
  logprobs?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface LocalCompleteResult {
  ok: boolean;
  text?: string;
  logprobs?: unknown;
  error?: string;
  /** Which optional features were actually sent on the successful call. */
  usedFeatures: { temperature: boolean; jsonSchema: boolean; logprobs: boolean };
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown };
type FetchResponse = { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; body?: AsyncIterable<Uint8Array> | null };
type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

const defaultFetch: FetchLike = (url, init) => (globalThis as any).fetch(url, init);
const DEFAULT_TIMEOUT_MS = 600_000;

/** Per-call temperature schedule for best-of-N: attempt 1 keeps the default (undefined); later
 *  attempts warm up so the samples genuinely diverge (kept alongside the stance/thinking jitter). */
export function resampleTemperature(attempt: number): number | undefined {
  if (attempt <= 1) return undefined;
  return [undefined, 0.4, 0.8, 1.0][Math.min(attempt - 1, 3)];
}

function chatUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(root) ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
}

function buildMessages(params: LocalCompleteParams): Array<{ role: string; content: string }> {
  if (params.messages?.length) return params.messages;
  const messages: Array<{ role: string; content: string }> = [];
  if (params.system) messages.push({ role: "system", content: params.system });
  messages.push({ role: "user", content: params.prompt ?? "" });
  return messages;
}

/** Does an error body name a given feature (so we know to downgrade THAT feature, not blanket-fail)? */
function errorMentions(errorText: string, feature: "temperature" | "jsonSchema" | "logprobs"): boolean {
  const t = errorText.toLowerCase();
  if (feature === "temperature") return /temperature/.test(t);
  if (feature === "jsonSchema") return /response_format|json_schema|json schema|grammar|structured/.test(t);
  return /logprob/.test(t);
}

export interface LocalControlClient {
  available(): boolean;
  capability(): LocalControlCapability;
  complete(params: LocalCompleteParams): Promise<LocalCompleteResult>;
  /**
   * Stream a completion and abort early if a guard trips (a must-exist path that fails a check, or a
   * full-file rewrite when a diff was requested). Only ever used on THIS owned streaming lane - Pi's
   * main-session turns are below our abstraction and are never stream-gated.
   */
  completeStreamGated(
    params: LocalCompleteParams,
    guard: (accumulated: string) => string | null
  ): Promise<{ ok: boolean; text?: string; aborted?: boolean; reason?: string; error?: string }>;
}

/** Build a local-control client for a base URL. Returns null when no base URL is available. */
export function localControlClient(opts: { baseUrl?: string; model?: string; fetchImpl?: FetchLike }): LocalControlClient | null {
  if (!opts.baseUrl) return null;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const cap: LocalControlCapability = {
    baseUrl: opts.baseUrl,
    model: opts.model,
    temperature: "unknown",
    jsonSchema: "unknown",
    logprobs: "unknown",
    notes: []
  };

  const post = async (body: Record<string, unknown>, timeoutMs: number): Promise<FetchResponse | { networkError: string }> => {
    const AC = (globalThis as any).AbortController;
    const controller = AC ? new AC() : undefined;
    const timer = setTimeout(() => { try { controller?.abort(); } catch { /* best-effort */ } }, Math.max(1000, timeoutMs));
    try {
      return await fetchImpl(chatUrl(opts.baseUrl!), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer lm-studio" },
        body: JSON.stringify(body),
        signal: controller?.signal
      });
    } catch (err) {
      return { networkError: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  };

  const buildBody = (params: LocalCompleteParams, stream: boolean): { body: Record<string, unknown>; used: { temperature: boolean; jsonSchema: boolean; logprobs: boolean } } => {
    const body: Record<string, unknown> = {
      model: params.model ?? opts.model,
      messages: buildMessages(params),
      max_tokens: params.maxOutputTokens ?? 4096
    };
    if (stream) body.stream = true;
    const used = { temperature: false, jsonSchema: false, logprobs: false };
    // Include a feature only when it is not known-unsupported (try optimistically when unknown).
    if (params.temperature !== undefined && cap.temperature !== "unsupported") { body.temperature = params.temperature; used.temperature = true; }
    if (params.jsonSchema && cap.jsonSchema !== "unsupported") {
      body.response_format = { type: "json_schema", json_schema: { name: params.jsonSchema.name, schema: params.jsonSchema.schema, strict: true } };
      used.jsonSchema = true;
    }
    if (params.logprobs && cap.logprobs !== "unsupported") { body.logprobs = true; used.logprobs = true; }
    return { body, used };
  };

  const recordSuccess = (used: { temperature: boolean; jsonSchema: boolean; logprobs: boolean }): void => {
    if (used.temperature && cap.temperature === "unknown") cap.temperature = "supported";
    if (used.jsonSchema && cap.jsonSchema === "unknown") cap.jsonSchema = "supported";
    if (used.logprobs && cap.logprobs === "unknown") cap.logprobs = "supported";
  };

  /** On a 400 that names a feature we sent, mark it unsupported and report that a downgrade is worth a retry. */
  const downgradeFromError = (errorText: string, used: { temperature: boolean; jsonSchema: boolean; logprobs: boolean }): boolean => {
    let downgraded = false;
    if (used.temperature && errorMentions(errorText, "temperature")) { cap.temperature = "unsupported"; cap.notes.push("temperature unsupported; dropped"); downgraded = true; }
    if (used.jsonSchema && errorMentions(errorText, "jsonSchema")) { cap.jsonSchema = "unsupported"; cap.notes.push("json_schema unsupported; dropped"); downgraded = true; }
    if (used.logprobs && errorMentions(errorText, "logprobs")) { cap.logprobs = "unsupported"; cap.notes.push("logprobs unsupported; dropped"); downgraded = true; }
    return downgraded;
  };

  return {
    available: () => true,
    capability: () => ({ ...cap, notes: [...cap.notes] }),

    async complete(params: LocalCompleteParams): Promise<LocalCompleteResult> {
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { body, used } = buildBody(params, false);
        const res = await post(body, timeoutMs);
        if ("networkError" in res) return { ok: false, error: `network: ${res.networkError}`, usedFeatures: used };
        if (!res.ok) {
          let errText = "";
          try { errText = await res.text(); } catch { /* ignore */ }
          // A 400 naming a feature we sent -> mark it unsupported and retry once without it.
          if (res.status === 400 && attempt === 0 && downgradeFromError(errText, used)) continue;
          return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}`, usedFeatures: used };
        }
        let json: any;
        try { json = await res.json(); } catch { return { ok: false, error: "non-JSON response", usedFeatures: used }; }
        recordSuccess(used);
        const choice = json?.choices?.[0];
        return { ok: true, text: choice?.message?.content ?? "", logprobs: choice?.logprobs ?? undefined, usedFeatures: used };
      }
      return { ok: false, error: "exhausted downgrade retries", usedFeatures: { temperature: false, jsonSchema: false, logprobs: false } };
    },

    async completeStreamGated(params, guard) {
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { body } = buildBody(params, true);
      const res = await post(body, timeoutMs);
      if ("networkError" in res) return { ok: false, error: `network: ${res.networkError}` };
      if (!res.ok) {
        let errText = "";
        try { errText = await res.text(); } catch { /* ignore */ }
        return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
      }
      if (!res.body) {
        // No stream body: fall back to a single non-streamed read + one guard check.
        const full = await this.complete({ ...params });
        if (!full.ok) return { ok: false, error: full.error };
        const reason = guard(full.text ?? "");
        return reason ? { ok: true, aborted: true, reason, text: full.text } : { ok: true, text: full.text };
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return { ok: true, text: accumulated };
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string") accumulated += delta;
          } catch { /* skip malformed SSE line */ }
        }
        const reason = guard(accumulated);
        if (reason) return { ok: true, aborted: true, reason, text: accumulated };
      }
      return { ok: true, text: accumulated };
    }
  };
}

/** Resolve the base URL cheater may own for direct calls: the LM Studio endpoint the user configured. */
export function localControlBaseUrl(config: CheaterConfig): string | undefined {
  return config.lmStudioBaseUrl || config.sidecarBaseUrl || undefined;
}

/** Build a local-control client from config + the resolved model, or null when no endpoint is known. */
export function localControlFromConfig(config: CheaterConfig, model?: { id?: string }, fetchImpl?: FetchLike): LocalControlClient | null {
  return localControlClient({ baseUrl: localControlBaseUrl(config), model: model?.id ?? config.model, fetchImpl });
}

// Last capability observed this process, for the receipt (probe-record; shown, never assumed).
let lastCapability: LocalControlCapability | null = null;
export function noteLocalControlCapability(cap: LocalControlCapability): void { lastCapability = cap; }
export function lastLocalControlCapability(): LocalControlCapability | null { return lastCapability; }

/** Receipt lines for the decoding-control lane (only when it was actually used this run). */
export function localControlLines(cap: LocalControlCapability | null = lastCapability): string[] {
  if (!cap) return [];
  const feat = (name: string, latch: FeatureLatch) => `${name} ${latch}`;
  return [`decoding control (owned lane @ ${cap.baseUrl}): ${feat("temperature", cap.temperature)}, ${feat("json_schema", cap.jsonSchema)}, ${feat("logprobs", cap.logprobs)}`];
}
