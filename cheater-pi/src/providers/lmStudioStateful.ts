// LM Studio native stateful/telemetry PROBE (Part B).
//
// Cheater talks to models through the Pi SDK, which uses the OpenAI-compatible /v1/chat/completions
// endpoint. Per LM Studio's own docs that path is STATELESS - every call resends the whole
// conversation, so a growing context re-prefills every turn (the TTFT bottleneck). LM Studio ALSO
// exposes a native /api/v1/chat that is STATEFUL (returns a `response_id`; a follow-up may pass
// `previous_response_id` so the client need not resend the history) and reports useful stats
// (input_tokens, time_to_first_token_seconds, tokens_per_second, model_load_time_seconds).
//
// This module PROBES that capability with a standalone fetch - it does NOT rewire Pi's provider.
// It reports what is measurably available and falls back safely when not. It NEVER assumes stateful
// chat implies KV-cache reuse; that is a separate, explicitly-measured benchmark that records only
// what it observed. All network access is injectable so tests never touch a real server.

import type { CheaterConfig } from "../types.js";

export interface ProviderStateCapability {
  provider: string;
  baseUrl?: string;
  /** /api/v1/chat answered and (ideally) returned a response_id we could follow up on. */
  statefulChatAvailable: boolean;
  /** Per-call stats (TTFT, tokens/s, input tokens) are exposed. */
  statsAvailable: boolean;
  /** The OpenAI-compat /v1/chat/completions path. FALSE unless someone proves otherwise. */
  chatCompletionsStateful: boolean;
  responseIdSupported?: boolean;
  /** Measured, never assumed. "unknown" until a fixed-prefix benchmark runs. */
  measuredPrefixReuseBenefit?: "unknown" | "none" | "small" | "large";
  ttftSeconds?: number;
  tokensPerSecond?: number;
  inputTokens?: number;
  modelLoadTimeSeconds?: number;
  notes: string[];
}

// A minimal fetch surface so this compiles/tests without DOM libs; the global fetch (Node >=18)
// satisfies it, and tests pass a mock.
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: any };
type FetchLike = (url: string, init?: FetchInit) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

const defaultFetch: FetchLike = (url, init) => (globalThis as any).fetch(url, init);

// A probe must be BOUNDED: a local reasoning model can emit hundreds of "thinking" tokens even for a
// trivial prompt, so every probe call caps output AND has a wall-clock timeout (abort) so it can
// never hang the caller. Found live: an uncapped probe against qwen3.5-2b never returned.
const PROBE_TIMEOUT_MS = 12000;
const PROBE_MAX_OUTPUT = 8;
async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: FetchInit, timeoutMs = PROBE_TIMEOUT_MS) {
  const AC = (globalThis as any).AbortController;
  const controller = AC ? new AC() : undefined;
  const timer = setTimeout(() => { try { controller?.abort(); } catch { /* best-effort */ } }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller?.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Strip a trailing /v1 (OpenAI-compat) to get the LM Studio server root for the native /api path. */
export function lmStudioRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

interface ChatStats { inputTokens?: number; ttftSeconds?: number; tokensPerSecond?: number; modelLoadTimeSeconds?: number }

/** Defensive extraction of LM Studio's stats regardless of whether they are top-level or nested. */
function extractStats(body: any): ChatStats {
  const s = body?.stats ?? body ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    inputTokens: num(s.input_tokens ?? s.prompt_tokens ?? body?.usage?.prompt_tokens),
    ttftSeconds: num(s.time_to_first_token_seconds ?? s.ttft_seconds),
    tokensPerSecond: num(s.tokens_per_second ?? s.tps),
    modelLoadTimeSeconds: num(s.model_load_time_seconds)
  };
}

function extractResponseId(body: any): string | undefined {
  const id = body?.response_id ?? body?.id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Probe a base URL for LM Studio native stateful chat + stats. Returns a capability record; never
 * throws (a dead/absent server yields statefulChatAvailable:false with a note).
 */
export async function probeLmStudioStateful(opts: { baseUrl: string; model?: string; fetchImpl?: FetchLike }): Promise<ProviderStateCapability> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const root = lmStudioRoot(opts.baseUrl);
  const url = `${root}/api/v1/chat`;
  const cap: ProviderStateCapability = {
    provider: "lmstudio",
    baseUrl: opts.baseUrl,
    statefulChatAvailable: false,
    statsAvailable: false,
    chatCompletionsStateful: false, // LM Studio docs: /v1/chat/completions is stateless. Never assume otherwise.
    measuredPrefixReuseBenefit: "unknown",
    notes: []
  };
  // LM Studio's native /api/v1/chat is a Responses-style endpoint: it takes `input` (a string), NOT
  // `messages`, and returns `response_id` + a `stats` object. Sending `messages` yields HTTP 400
  // "'input' is required" (the original probe bug, found by hitting a live server).
  const body1 = { model: opts.model, input: "Reply with exactly: OK", store: true, max_output_tokens: PROBE_MAX_OUTPUT };
  let first: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    first = await fetchWithTimeout(fetchImpl, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body1) });
  } catch (err) {
    cap.notes.push(`native /api/v1/chat unreachable at ${url}: ${(err as Error).message}. Treating provider as stateless (OpenAI-compat only).`);
    return cap;
  }
  if (!first.ok) {
    cap.notes.push(`/api/v1/chat returned HTTP ${first.status}; native stateful API not available here.`);
    return cap;
  }
  let json1: any;
  try { json1 = await first.json(); } catch { cap.notes.push("/api/v1/chat returned non-JSON."); return cap; }
  const responseId = extractResponseId(json1);
  const stats1 = extractStats(json1);
  cap.statefulChatAvailable = true;
  cap.responseIdSupported = Boolean(responseId);
  cap.statsAvailable = stats1.ttftSeconds !== undefined || stats1.inputTokens !== undefined || stats1.tokensPerSecond !== undefined;
  cap.ttftSeconds = stats1.ttftSeconds;
  cap.tokensPerSecond = stats1.tokensPerSecond;
  cap.inputTokens = stats1.inputTokens;
  cap.modelLoadTimeSeconds = stats1.modelLoadTimeSeconds;
  cap.notes.push(`native /api/v1/chat available${responseId ? " with response_id" : " (no response_id in reply)"}${cap.statsAvailable ? " and stats" : ""}.`);

  // Confirm the STATEFUL follow-up actually works: pass previous_response_id and expect a 200.
  if (responseId) {
    try {
      const body2 = { model: opts.model, previous_response_id: responseId, input: "Reply with exactly: OK2", store: true, max_output_tokens: PROBE_MAX_OUTPUT };
      const second = await fetchWithTimeout(fetchImpl, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body2) });
      if (second.ok) cap.notes.push("previous_response_id follow-up accepted (stateful chat confirmed).");
      else { cap.responseIdSupported = false; cap.notes.push(`previous_response_id follow-up rejected (HTTP ${second.status}).`); }
    } catch (err) {
      cap.notes.push(`previous_response_id follow-up failed: ${(err as Error).message}.`);
    }
  }
  return cap;
}

/**
 * Fixed-prefix reuse micro-benchmark: send the SAME long prefix twice (different suffix) and compare
 * TTFT / input-token behaviour. Records ONLY what it measured - a lower second-call TTFT is
 * consistent with prompt-cache reuse but is not proof of it, so we grade it conservatively and never
 * claim KV-cache. Mutates and returns the capability with measuredPrefixReuseBenefit set.
 */
export async function benchmarkPrefixReuse(cap: ProviderStateCapability, opts: { baseUrl: string; model?: string; fetchImpl?: FetchLike; prefix?: string }): Promise<ProviderStateCapability> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const url = `${lmStudioRoot(opts.baseUrl)}/api/v1/chat`;
  const prefix = opts.prefix ?? ("Fixed prefix for cache benchmark. ".repeat(24)); // a stable prefix to reuse
  const call = async (suffix: string) => {
    try {
      const r = await fetchWithTimeout(fetchImpl, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: opts.model, input: prefix + suffix, store: false, max_output_tokens: PROBE_MAX_OUTPUT }) });
      if (!r.ok) return undefined;
      return extractStats(await r.json());
    } catch { return undefined; }
  };
  const a = await call("Question A: reply OK.");
  const b = await call("Question B: reply OK.");
  if (!a || !b || a.ttftSeconds === undefined || b.ttftSeconds === undefined) {
    cap.measuredPrefixReuseBenefit = "unknown";
    cap.notes.push("prefix-reuse benchmark inconclusive (no TTFT stats).");
    return cap;
  }
  const ratio = b.ttftSeconds / Math.max(1e-6, a.ttftSeconds);
  cap.measuredPrefixReuseBenefit = ratio <= 0.5 ? "large" : ratio <= 0.8 ? "small" : "none";
  cap.notes.push(`prefix-reuse benchmark: 1st TTFT ${a.ttftSeconds.toFixed(3)}s, 2nd ${b.ttftSeconds.toFixed(3)}s (ratio ${ratio.toFixed(2)}) -> measured benefit "${cap.measuredPrefixReuseBenefit}" (observation only; not proof of KV-cache reuse).`);
  return cap;
}

// The last capability we measured this process, so the receipt/command can report it without
// re-probing every run. null until a probe runs.
let lastCapability: ProviderStateCapability | null = null;
export function lastProviderCapability(): ProviderStateCapability | null { return lastCapability; }

/** Resolve the base URL to probe (explicit lmStudioBaseUrl, else the sidecar's if it points at LM Studio). */
export function providerProbeBaseUrl(config: CheaterConfig): string | undefined {
  return config.lmStudioBaseUrl || config.sidecarBaseUrl || undefined;
}

/**
 * Run the probe for the configured base URL and cache the result. No-op (returns null) when no base
 * URL is configured - Cheater cannot know the main model's endpoint (Pi owns it), so the user must
 * point this at their LM Studio server for a real measurement.
 */
export async function runProviderProbe(config: CheaterConfig, opts: { fetchImpl?: FetchLike; benchmark?: boolean } = {}): Promise<ProviderStateCapability | null> {
  const baseUrl = providerProbeBaseUrl(config);
  if (!baseUrl) return null;
  // Probe with the small sidecar model when set (fast); it only measures endpoint capability.
  const probeModel = config.sidecarModel ?? config.model;
  let cap = await probeLmStudioStateful({ baseUrl, model: probeModel, fetchImpl: opts.fetchImpl });
  if ((opts.benchmark ?? config.providerProbeBenchmark) && cap.statefulChatAvailable) {
    cap = await benchmarkPrefixReuse(cap, { baseUrl, model: probeModel, fetchImpl: opts.fetchImpl });
  }
  lastCapability = cap;
  return cap;
}

/** Receipt lines for the provider/perf section, from a capability record (or the last probed one). */
export function providerCapabilityLines(cap: ProviderStateCapability | null = lastCapability): string[] {
  if (!cap) return [];
  const lines = [
    `provider/perf: stateful_chat ${cap.statefulChatAvailable ? "available" : "unavailable/unknown"}, response_id ${cap.responseIdSupported ? "used" : "no"}, /v1/chat/completions treated stateless`
  ];
  const stat: string[] = [];
  if (cap.ttftSeconds !== undefined) stat.push(`TTFT ${cap.ttftSeconds.toFixed(3)}s`);
  if (cap.inputTokens !== undefined) stat.push(`input ${cap.inputTokens} tok`);
  if (cap.tokensPerSecond !== undefined) stat.push(`${cap.tokensPerSecond.toFixed(1)} tok/s`);
  if (stat.length) lines.push(`  ${stat.join(", ")}`);
  lines.push(`  cache benefit measured: ${cap.measuredPrefixReuseBenefit ?? "unknown"}`);
  return lines;
}
