import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { CheaterConfig } from "../types.js";
import { redactSecrets } from "../reliability/redact.js";
import { piIdleTimeoutMs } from "../blueprint/worker.js";
import type { SidecarClient, SidecarCompletion, SidecarCompletionParams, SidecarLatchState } from "./types.js";

type ExtensionContext = any;

export const SIDECAR_DEFAULT_TIMEOUT_MS = 8000;
export const SIDECAR_DEFAULT_MAX_OUTPUT = 512;
/** A CPU-hosted sidecar on a separate endpoint is slower than a GPU model; give it more headroom. */
export const SIDECAR_CPU_TIMEOUT_MS = 20000;
/** After a TRANSIENT failure (session/endpoint), available() re-opens after this cooldown so the
 *  next call re-probes - one bad first call (e.g. a CPU server still loading) must not black the
 *  sidecar out for the whole session. A PERMANENT failure (no resolvable model) never re-probes. */
export const SIDECAR_REPROBE_COOLDOWN_MS = 30000;

/** The deterministic-only floor: a client that is always unavailable. Used in tests and whenever
 *  the sidecar is disabled or no small model resolves. Every job degrades to this cleanly. */
export const nullSidecarClient: SidecarClient = {
  available: () => false,
  async complete(): Promise<SidecarCompletion> {
    return { ok: false, error: "sidecar disabled", elapsedMs: 0 };
  },
  state: () => ({ latch: "unavailable", failKind: "permanent", lastError: "sidecar disabled" })
};

export interface ResolvedSidecarConfig {
  enabled: boolean;
  provider?: string;
  modelId?: string;
  baseUrl?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  parallelism: "off" | "gap" | "concurrent";
  allowMainModelFallback: boolean;
}

export function sidecarConfig(config: CheaterConfig): ResolvedSidecarConfig {
  // Auto-enable: setting a sidecarModel turns the sidecar on (the user "just points it at a 2-4B"),
  // unless sidecarEnabled is explicitly false. sidecarEnabled:true also works with the main-model
  // fallback when no separate model is configured.
  const enabled = config.sidecarEnabled === true || (config.sidecarEnabled !== false && Boolean(config.sidecarModel));
  // A configured separate endpoint (a CPU-hosted small model on its own port) does NOT compete for
  // the GPU, so it can run truly in parallel and warrants more time per call than a GPU model.
  const separateEndpoint = Boolean(config.sidecarBaseUrl);
  return {
    enabled,
    provider: config.sidecarProvider ?? config.provider,
    modelId: config.sidecarModel,
    baseUrl: config.sidecarBaseUrl,
    timeoutMs: config.sidecarTimeoutMs ?? (separateEndpoint ? SIDECAR_CPU_TIMEOUT_MS : SIDECAR_DEFAULT_TIMEOUT_MS),
    maxOutputTokens: config.sidecarMaxOutputTokens ?? SIDECAR_DEFAULT_MAX_OUTPUT,
    // How background sidecar jobs overlap the main model. Default "gap": only in main-model idle
    // windows (safe on a single serialized GPU). BUT a separate CPU endpoint runs truly in parallel
    // with the GPU, so default it to "concurrent" - the clerk prepares context while the GPU model
    // writes, "no brakes". Explicit sidecarParallelism always wins. See SidecarScheduler.
    parallelism: config.sidecarParallelism ?? (separateEndpoint ? "concurrent" : "gap"),
    // When enabled but no separate small model is configured, run the sidecar job on the parent
    // model in bounded no-tool mode. Still cheaper than a full agent turn (no tool loop, tiny
    // output), and keeps the feature functional on single-model setups. Set false to require a
    // genuinely separate small model or else stay deterministic.
    allowMainModelFallback: config.sidecarAllowMainModel !== false
  };
}

/** Resolve a genuinely separate small model from the local registry, or undefined. Never throws. */
function resolveSeparateModel(provider: string | undefined, modelId: string | undefined, baseUrl?: string): unknown {
  if (!modelId) return undefined;
  try {
    const registry = ModelRegistry.create(AuthStorage.create());
    // PREFER a model Pi already knows (in ~/.pi/agent/models.json): it carries WORKING auth. This is
    // the ONLY reliable path, because createAgentSession resolves the API key from disk by PROVIDER
    // NAME - a dynamically-registered synthetic provider has no on-disk key, so its calls fail with
    // "No API key found" and the sidecar silently falls back to the main model. So: add the small
    // model to your LM Studio provider in models.json and point sidecarProvider/sidecarModel at it.
    if (provider) {
      const known = registry.find(provider, modelId);
      if (known && registry.hasConfiguredAuth(known)) return known;
    }
    // Fallback: a truly separate endpoint Pi does not know. Register it best-effort. LM Studio needs
    // no real key but the registry still REQUIRES apiKey + a per-model `api` protocol (both were
    // missing originally, so registration threw and resolution fell back to the main model). This
    // path only works if the endpoint needs no real auth; otherwise it fails at call time and the
    // sidecar cleanly degrades to deterministic.
    if (baseUrl) {
      const syntheticProvider = "cheater-sidecar";
      try {
        registry.registerProvider(syntheticProvider, {
          baseUrl,
          apiKey: "lm-studio",
          models: [{ id: modelId, name: modelId, api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
        });
      } catch { /* provider registration is best-effort */ }
      const separate = registry.find(syntheticProvider, modelId);
      if (separate) return separate;
    }
  } catch {
    // A missing registry/auth just means "no separate sidecar model" - fall back, never crash.
  }
  return undefined;
}

type CreateFn = (options: Record<string, unknown>) => Promise<{ session: any }>;

/**
 * SDK-backed sidecar client: one bounded, no-tool completion per call on a small model.
 * Mirrors the fresh-worker backend's honest-degradation contract - it self-latches to
 * unavailable on the first structural failure (no model/auth), so a broken sidecar is paid for
 * at most once and every subsequent `available()` is a cheap false. createFn is injectable so
 * tests never touch the real SDK.
 */
export function sdkSidecarClient(opts: { cwd: string; model?: unknown; timeoutMs: number; maxOutputTokens: number; createFn?: CreateFn; now?: () => number }): SidecarClient {
  let latch: "unknown" | "available" | "unavailable" = "unknown";
  let failKind: "permanent" | "transient" | undefined;
  let lastError: string | undefined;
  let lastElapsedMs: number | undefined;
  let lastFailAt = 0;
  const now = opts.now ?? (() => Date.now());
  const createFn = opts.createFn ?? (createAgentSession as unknown as CreateFn);
  // A PERMANENT failure (no resolvable model) is a config error a re-probe cannot fix; a TRANSIENT
  // one (session/endpoint) may recover (a CPU server still loading), so available() re-opens after
  // a cooldown to let the next call re-probe instead of blacking out for the whole session.
  const markFailure = (kind: "permanent" | "transient", error: string): void => {
    latch = "unavailable";
    failKind = kind;
    lastError = error;
    lastFailAt = now();
  };
  return {
    available: () => {
      if (latch !== "unavailable") return true;
      // Self-heal: a transient failure re-opens the gate after the cooldown so the NEXT complete()
      // re-probes; a permanent failure stays closed until the config changes (a new client).
      return failKind === "transient" && now() - lastFailAt >= SIDECAR_REPROBE_COOLDOWN_MS;
    },
    state: (): SidecarLatchState => ({ latch, failKind, lastError, lastElapsedMs }),
    async complete(params: SidecarCompletionParams): Promise<SidecarCompletion> {
      const started = now();
      let session: any;
      try {
        const settingsManager = SettingsManager.inMemory({ httpIdleTimeoutMs: piIdleTimeoutMs() }, { projectTrusted: true });
        const sessionManager = SessionManager.create(opts.cwd, undefined, { id: `cheater-sidecar-${started.toString(36)}` });
        ({ session } = await createFn({
          cwd: opts.cwd,
          sessionManager,
          settingsManager,
          noTools: "all",
          ...(opts.model ? { model: opts.model } : {})
        }));
      } catch (err) {
        // Transient: the endpoint may be momentarily down or still warming up. available() re-opens
        // after the cooldown, so a CPU model that finishes loading recovers on its own.
        lastElapsedMs = now() - started;
        markFailure("transient", `sidecar session failed: ${(err as Error).message}`);
        return { ok: false, error: lastError!, elapsedMs: lastElapsedMs };
      }
      if (!session?.model?.id) {
        try { session?.dispose?.(); } catch { /* best-effort */ }
        lastElapsedMs = now() - started;
        markFailure("permanent", "sidecar has no resolvable model");
        return { ok: false, error: lastError!, elapsedMs: lastElapsedMs };
      }
      latch = "available";
      failKind = undefined;
      lastError = undefined;
      const timeoutMs = Math.max(1000, params.timeoutMs ?? opts.timeoutMs);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { session.abort?.(); } catch { /* best-effort */ } }, timeoutMs);
      try {
        const budget = params.maxOutputTokens ?? opts.maxOutputTokens;
        // Redact secrets before they reach the (separate) sidecar model - it must never SEE keys.
        const system = redactSecrets(params.system ?? "");
        const framing = `${system ? system + "\n\n" : ""}Answer compactly (aim for under ~${budget} tokens). Output ONLY what is asked for, no preamble.`;
        await session.prompt(`${framing}\n\n${redactSecrets(params.prompt)}`, { source: "extension" });
        lastElapsedMs = now() - started;
        if (timedOut) { lastError = `sidecar timed out after ${timeoutMs}ms`; return { ok: false, error: lastError, elapsedMs: lastElapsedMs }; }
        lastError = undefined;
        return { ok: true, text: session.getLastAssistantText() ?? "", modelId: session.model?.id, elapsedMs: lastElapsedMs };
      } catch (err) {
        // A prompt-level failure does NOT blacklist the client: the session was created, so the
        // endpoint is reachable - it was just this one call. available() stays true so the next job
        // retries; we only record the error for /sidecar status and /sidecar doctor.
        lastElapsedMs = now() - started;
        lastError = timedOut ? `sidecar timed out after ${timeoutMs}ms` : `sidecar prompt failed: ${(err as Error).message}`;
        return { ok: false, error: lastError, elapsedMs: lastElapsedMs };
      } finally {
        clearTimeout(timer);
        try { session.dispose?.(); } catch { /* best-effort */ }
      }
    }
  };
}

/**
 * Resolve the sidecar client for the current session. Returns the null (unavailable) client
 * whenever the sidecar is disabled or no model can back it, so callers can always
 * unconditionally `resolveSidecarClient(config, ctx)` and rely on `available()` to gate work.
 */
export function resolveSidecarClient(config: CheaterConfig, ctx: ExtensionContext): SidecarClient {
  const cfg = sidecarConfig(config);
  if (!cfg.enabled) return nullSidecarClient;
  const separate = resolveSeparateModel(cfg.provider, cfg.modelId, cfg.baseUrl);
  const model = separate ?? (cfg.allowMainModelFallback ? ctx?.model : undefined);
  if (!model) return nullSidecarClient;
  return sdkSidecarClient({ cwd: ctx?.cwd ?? process.cwd(), model, timeoutMs: cfg.timeoutMs, maxOutputTokens: cfg.maxOutputTokens });
}
