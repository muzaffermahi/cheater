// Kitten Core — model discovery and validation. NO Pi.
//
// Reusable capability: discover which models an endpoint serves, validate a user-requested model
// against the discovery result, and fall back gracefully when discovery is unavailable.

import type { KittenLLM } from "./llm.js";

export type EngineKind = "llamacpp" | "openai-proxy" | "unknown";

export interface ModelInfo {
  id: string;
  provider: string;
  verified: boolean;
}

export interface DiscoveryResult {
  ok: boolean;
  models: ModelInfo[];
  engine: EngineKind;
  error?: string;
}

export type ModelRole = "main" | "sidecar";

export interface ModelHealthRow {
  id: string;
  advertised: boolean;
  reachable: boolean;
  /** A timeout usually means a large local model is still loading, not that it is invalid. */
  state: "responding" | "slow/loading" | "unavailable";
  latencyMs: number;
  /** Best-effort parameter estimate parsed from the model id (for tier guidance only). */
  estimatedB?: number;
  tierFit: "preferred" | "acceptable" | "unknown" | "mismatch";
  error?: string;
}

export interface ModelHealthResult {
  endpoint: string;
  role: ModelRole;
  configured: string;
  endpointReachable: boolean;
  rows: ModelHealthRow[];
  recommendations: Array<{ model: string; reason: string }>;
  warning?: string;
}

/** GET /models with 4s timeout. Returns null on any failure (never throws). */
async function listModels(llm: KittenLLM): Promise<string[] | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${llm.models.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${llm.models.apiKey ?? "lm-studio"}` },
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

export interface ModelProbe {
  /** The model produced a completion. */
  alive: boolean;
  /** The probe deadline elapsed. On a local runtime this usually means "still loading", not "broken". */
  timedOut: boolean;
  elapsedMs: number;
  /** It answered, but spent the whole budget thinking. Proof of life, not proof of usefulness. */
  reasonedOnly: boolean;
  error?: string;
}

/**
 * A local runtime JIT-loads weights on the first request, and a 35B takes tens of seconds to become
 * ready — so the deadline here is generous and a timeout is reported as its own state rather than as
 * a dead model. The token budget also has to clear the reasoning tax: a reasoning model counts its
 * `reasoning_content` against `max_tokens`, so a 16-token probe returns empty content by construction
 * (llm.ts documents this hazard) and must not be read as failure.
 */
export async function probeModel(llm: KittenLLM, model: string, timeoutMs = 45_000): Promise<ModelProbe> {
  const started = Date.now();
  const result = await llm.chat({ model, messages: [{ role: "user", content: "Reply: OK" }], maxTokens: 64, timeoutMs });
  const elapsedMs = Date.now() - started;
  const timedOut = !result.ok && /^timeout$/i.test(result.error ?? "");
  return {
    alive: result.ok,
    timedOut,
    elapsedMs,
    reasonedOnly: result.ok && !result.content.trim() && result.reasoning.trim().length > 0,
    ...(result.ok ? {} : { error: result.error ?? "no completion" }),
  };
}

/** Probe model with a minimal chat. Returns true if the model responds. */
export async function pingModel(llm: KittenLLM, model: string, timeoutMs = 45_000): Promise<boolean> {
  return (await probeModel(llm, model, timeoutMs)).alive;
}

/** Validate a requested model name against discovery results from a provider. */
export async function validateModel(
  llm: KittenLLM,
  model: string,
  provider: string,
  discoveredModels?: ModelInfo[],
  options: { probeAdvertised?: boolean; timeoutMs?: number } = {},
): Promise<{ valid: boolean; verified: boolean; error?: string; suggestion?: string; loading?: boolean }> {
  if (!model) return { valid: false, verified: false, error: "model name is empty" };

  const list = discoveredModels?.map((m) => m.id) ?? (await listModels(llm));

  if (list && list.length > 0) {
    if (list.includes(model)) {
      if (!options.probeAdvertised) return { valid: true, verified: true };
      const probe = await probeModel(llm, model, options.timeoutMs ?? 45_000);
      if (probe.alive) return { valid: true, verified: true };
      // The endpoint advertises it, so the name is right. A deadline that elapsed on a local runtime
      // means the weights are still loading — a real state to report, not a reason to reject the model.
      if (probe.timedOut) {
        return { valid: true, verified: false, loading: true, error: `model '${model}' is loading — it did not answer within ${Math.round(probe.elapsedMs / 1000)}s. Large local models often need a minute on first use.` };
      }
      return { valid: true, verified: false, error: `model '${model}' is advertised but did not respond (${probe.error ?? "unknown error"})` };
    }
    // Check cross-provider
    if (discoveredModels) {
      const otherProvider = discoveredModels.find((m) => m.id === model && m.provider !== provider);
      if (otherProvider) {
        return { valid: false, verified: false, error: `model '${model}' is served by provider '${otherProvider.provider}', not '${provider}'`, suggestion: otherProvider.provider };
      }
    }
    // Try ping
    const responds = await pingModel(llm, model);
    if (responds) {
      return { valid: true, verified: true };
    }
    return {
      valid: false, verified: false,
      error: `model '${model}' not served by '${provider}'. Available: ${list.slice(0, 5).map((m) => m.split(/[\\/]/).pop()).join(", ") || "none"}`,
    };
  }

  // Discovery unavailable — fall back to ping
  const responds = await pingModel(llm, model);
  if (responds) {
    return { valid: true, verified: false };
  }
  return { valid: false, verified: false, error: `endpoint unreachable / model '${model}' not responding` };
}

/** Probe the endpoint and return discovered models + engine. */
export async function discoverModels(llm: KittenLLM, provider: string): Promise<DiscoveryResult> {
  try {
    const list = await listModels(llm);
    const engine = await llm.detectEngine().catch(() => "unknown" as EngineKind);
    return {
      ok: list !== null,
      models: list ? list.map((id) => ({ id, provider, verified: true })) : [],
      engine,
    };
  } catch (e) {
    return { ok: false, models: [], engine: "unknown", error: (e as Error).message };
  }
}

/**
 * Bounded, read-only health scan used by the native onboarding/recovery surface.  It never changes
 * settings and never probes more than the first 12 advertised models.  A model id is only a hint for
 * tiering: unknown names remain unknown rather than being silently treated as a small or large model.
 */
export async function inspectModelHealth(
  llm: KittenLLM,
  role: ModelRole,
  configured: string,
  options: { timeoutMs?: number; maxCandidates?: number } = {},
): Promise<ModelHealthResult> {
  const endpoint = llm.models.baseUrl;
  const timeoutMs = Math.max(500, Math.min(10_000, options.timeoutMs ?? 2500));
  const maxCandidates = Math.max(1, Math.min(12, Math.floor(options.maxCandidates ?? 8)));
  const started = Date.now();
  const advertised = await listModels(llm);
  const endpointReachable = advertised !== null;
  const ids = Array.from(new Set([configured, ...(advertised ?? [])].filter((id): id is string => Boolean(id && id.trim())))).slice(0, maxCandidates + 1);
  const rows = await Promise.all(ids.map(async (id): Promise<ModelHealthRow> => {
    const rowStarted = Date.now();
    const estimatedB = estimateModelB(id);
    const tierFit = tierFitFor(role, estimatedB);
    const result = await llm.chat({ model: id, messages: [{ role: "user", content: "Reply with OK only." }], maxTokens: 8, temperature: 0, timeoutMs });
    const state: ModelHealthRow["state"] = result.ok
      ? "responding"
      : result.error === "timeout"
        ? "slow/loading"
        : "unavailable";
    return {
      id,
      advertised: advertised?.includes(id) ?? false,
      reachable: result.ok,
      state,
      latencyMs: Date.now() - rowStarted,
      ...(estimatedB === undefined ? {} : { estimatedB }),
      tierFit,
      ...(result.ok ? {} : { error: result.error ?? "model did not respond" }),
    };
  }));
  const reachable = rows.filter((row) => row.reachable);
  const preferred = reachable.filter((row) => row.tierFit === "preferred");
  const acceptable = reachable.filter((row) => row.tierFit === "acceptable");
  const recommendations: Array<{ model: string; reason: string }> = [];
  if (reachable.some((row) => row.id === configured)) {
    recommendations.push({ model: configured, reason: "configured model responds" });
  }
  for (const row of (role === "main" ? preferred : acceptable.length ? acceptable : preferred)) {
    if (recommendations.some((item) => item.model === row.id)) continue;
    recommendations.push({ model: row.id, reason: row.tierFit === "preferred" ? "reachable model matches the configured tier" : "reachable fallback; confirm before using" });
    if (recommendations.length >= 3) break;
  }
  return {
    endpoint,
    role,
    configured,
    endpointReachable,
    rows,
    recommendations,
    ...(endpointReachable ? {} : { warning: `endpoint did not return /models (${Date.now() - started}ms); candidates were pinged directly` }),
  };
}

export function estimateModelB(id: string): number | undefined {
  const match = id.match(/(?:^|[^0-9])([0-9]{1,4}(?:\.[0-9]+)?)\s*b(?:[^a-z0-9]|$)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function tierFitFor(role: ModelRole, estimatedB: number | undefined): ModelHealthRow["tierFit"] {
  if (estimatedB === undefined) return "unknown";
  if (role === "main") return estimatedB >= 35 && estimatedB <= 200 ? "preferred" : "mismatch";
  return estimatedB >= 2 && estimatedB <= 9 ? "preferred" : "mismatch";
}
