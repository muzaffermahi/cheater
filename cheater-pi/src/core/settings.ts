// Kitten Core — unified settings for all clients (TUI, web, headless). NO Pi.
//
// One documented precedence (Goal §7), low → high:
//   defaults  <  user file (~/.kitten/config.json or ~/.config/kitten/config.json)  <  project
//   (.kitten/config.json)  <  KITTEN_* environment  <  explicit CLI flags (applied by the caller).
// Secrets (apiKey) are resolved here but NEVER written into conversation events. Unknown keys are
// reported (a typo that would silently fall back to the wrong model is a bug, per §7).

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_MODELS, type KittenModels } from "./llm.js";
import { looksLikeGeneratedCommand, resolveServerBinary } from "./modelRuntime.js";

export type ApprovalPolicy = "ask" | "auto-allow" | "auto-deny";

export interface ManagedRuntimeSettings {
  executable?: string;
  mainModelPath?: string;
  sidecarModelPath?: string;
}

/**
 * User-tunable llama.cpp launch behavior. Every field defaults to "auto" (the measured-machine
 * heuristics), because the heuristics are a starting point, not a verdict: the user who hand-tunes
 * their own llama-server invocation must be able to reproduce it here — the observed gap on this
 * class of hardware was 7 tok/s under the auto cpu-moe plan vs 30 tok/s under a hand-tuned launch.
 */
export interface RuntimeTuningSettings {
  /** --n-gpu-layers: "auto" = offload everything that fits (999); a number is passed verbatim (0 = CPU). */
  gpuLayers?: number | "auto";
  /** --cpu-moe / --n-cpu-moe: "auto" = only when the weights dwarf VRAM; "on"/"off" force it. */
  cpuMoe?: "auto" | "on" | "off";
  /** How many leading layers keep their experts on the CPU. "auto" computes the minimum that fits,
   *  "all" is the blanket --cpu-moe, a number is --n-cpu-moe N. */
  cpuMoeLayers?: number | "all" | "auto";
  /** --flash-attn: "auto" = on for any GPU backend. */
  flashAttn?: "auto" | "on" | "off";
  /** --cache-type-k/v. "f16" is llama.cpp's default quality; "q8_0" halves KV memory (Kitten's auto). */
  kvCacheType?: "auto" | "q8_0" | "f16" | "q4_0";
  /** --no-kv-offload when "off": the KV cache stays in system RAM. */
  kvOffload?: "auto" | "on" | "off";
  /** --threads / --batch-size / --ubatch-size. "auto" leaves llama.cpp's own defaults alone. */
  threads?: number | "auto";
  batchSize?: number | "auto";
  ubatchSize?: number | "auto";
  /** --load-mode: mmap/mlock behaviour. "auto" lets the launch plan decide. */
  loadMode?: "auto" | "none" | "mmap" | "mlock" | "mmap+mlock";
  /** --main-gpu / --tensor-split for multi-GPU machines. */
  mainGpu?: number | "auto";
  tensorSplit?: string;
  /** Where the sidecar model lives: "cpu" (default — RAM, real parallelism with the GPU-bound main
   *  model) or "gpu" (contends with the main model's VRAM). */
  sidecarDevice?: "cpu" | "gpu";
  /** Raw extra flags appended verbatim at the end of the llama-server command (last wins). */
  extraArgs?: string;
  /** A complete command line that REPLACES the generated one. Empty means "use the plan". */
  argsOverride?: string;
  parallelSlots?: number | "auto";
  speculation?: "auto" | "ngram" | "mtp" | "off";
}

/** Task Compiler rollout switch. `off` restores pre-compiler behavior byte for byte, which is what
 *  makes this feature reversible without a code change. */
export type TaskCompilerFlag = "off" | "auto" | "force";

export interface KittenSettings {
  models: KittenModels;
  managedRuntime: ManagedRuntimeSettings;
  runtimeTuning: RuntimeTuningSettings;
  approvalPolicy: ApprovalPolicy;
  /** "auto" (the default) sizes the server context from the machine (VRAM + GGUF geometry) at
   *  launch; a number is an explicit pin that reaches the server verbatim. */
  contextWindowTokens: number | "auto";
  /** How the Task Compiler participates in the request path. Default "auto". */
  taskCompiler: TaskCompilerFlag;
  /** Web tool reach: "open" (any http(s) site behind the SSRF floor — the default), "allowlist"
   *  (reference-doc hosts only), or "off". */
  webAccess: "allowlist" | "open" | "off";
  fastPath: "auto" | "off";
  /** Config files that were merged (for `kitten doctor` transparency). */
  sources: string[];
  /** Non-fatal problems (unknown keys, unreadable files) to surface in doctor. */
  warnings: string[];
}

export interface SettingsUpdate {
  baseUrl?: string;
  sidecarBaseUrl?: string;
  mainModel?: string;
  sidecarModel?: string;
  embedModel?: string;
  approvalPolicy?: ApprovalPolicy;
  contextWindowTokens?: number | "auto";
  runtimeExecutable?: string;
  mainModelPath?: string;
  sidecarModelPath?: string;
  taskCompiler?: TaskCompilerFlag;
  webAccess?: "allowlist" | "open" | "off";
  fastPath?: "auto" | "off";
  gpuLayers?: number | "auto";
  cpuMoe?: "auto" | "on" | "off";
  cpuMoeLayers?: number | "all" | "auto";
  flashAttn?: "auto" | "on" | "off";
  kvCacheType?: "auto" | "q8_0" | "f16" | "q4_0";
  kvOffload?: "auto" | "on" | "off";
  threads?: number | "auto";
  batchSize?: number | "auto";
  ubatchSize?: number | "auto";
  loadMode?: "auto" | "none" | "mmap" | "mlock" | "mmap+mlock";
  mainGpu?: number | "auto";
  tensorSplit?: string;
  sidecarDevice?: "cpu" | "gpu";
  extraArgs?: string;
  argsOverride?: string;
  parallelSlots?: number | "auto";
  speculation?: "auto" | "ngram" | "mtp" | "off";
}

const KNOWN_KEYS = new Set([
  "baseUrl", "sidecarBaseUrl", "mainModel", "sidecarModel", "embedModel", "apiKey",
  "approvalPolicy", "contextWindowTokens",
  "runtimeExecutable", "mainModelPath", "sidecarModelPath",
  "taskCompiler", "webAccess", "fastPath",
  "gpuLayers", "cpuMoe", "cpuMoeLayers", "flashAttn", "kvCacheType", "kvOffload",
  "threads", "batchSize", "ubatchSize", "loadMode", "mainGpu", "tensorSplit",
  "sidecarDevice", "extraArgs", "argsOverride", "parallelSlots", "speculation",
]);

interface RawConfig {
  baseUrl?: string; sidecarBaseUrl?: string; mainModel?: string; sidecarModel?: string; embedModel?: string; apiKey?: string;
  approvalPolicy?: string; contextWindowTokens?: number | string;
  runtimeExecutable?: string; mainModelPath?: string; sidecarModelPath?: string;
  taskCompiler?: string; webAccess?: string; fastPath?: string;
  gpuLayers?: number | string; cpuMoe?: string; cpuMoeLayers?: number | string;
  flashAttn?: string; kvCacheType?: string; kvOffload?: string;
  threads?: number | string; batchSize?: number | string; ubatchSize?: number | string;
  loadMode?: string; mainGpu?: number | string; tensorSplit?: string;
  sidecarDevice?: string; extraArgs?: string; argsOverride?: string; parallelSlots?: number | string; speculation?: string;
}

function readConfig(path: string, warnings: string[]): RawConfig | null {
  if (!existsSync(path)) return null;
  try {
    // Strip a UTF-8 BOM before parsing. Every PowerShell way of writing a file — `Out-File`,
    // `Set-Content -Encoding utf8`, `>` — prepends one, so a config edited or generated from a
    // Windows shell parses as invalid JSON and the WHOLE file is discarded. The symptom is the worst
    // kind: settings that appear to save and then have no effect, endpoint, weights and llama.cpp
    // tuning alike, with the reason buried in a doctor warning nobody reads.
    const data = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
    for (const k of Object.keys(data)) {
      if (!KNOWN_KEYS.has(k)) warnings.push(`config ${path}: unknown key "${k}" (ignored)`);
    }
    return data as RawConfig;
  } catch (e) {
    warnings.push(`config ${path}: not valid JSON (${(e as Error).message}) — ignored`);
    return null;
  }
}

function userConfigPath(): string {
  // KITTEN_HOME is the documented Kitten home (paths.ts), so user settings live inside it too.
  // Honouring it here also makes the suite hermetic: without this, a developer's own ~/.kitten config
  // silently changes what tests observe — which is exactly how a green suite starts lying.
  const override = process.env.KITTEN_HOME?.trim();
  if (override) return join(override, "config.json");
  // Prefer ~/.kitten/config.json; fall back to the XDG-style ~/.config/kitten/config.json if present.
  const home = join(homedir(), ".kitten", "config.json");
  if (existsSync(home)) return home;
  const xdg = join(homedir(), ".config", "kitten", "config.json");
  return existsSync(xdg) ? xdg : home;
}

/** Resolve settings for `cwd`. CLI flags override the result afterward in the caller. */
export function loadKittenSettings(cwd = process.cwd()): KittenSettings {
  const warnings: string[] = [];
  const sources: string[] = [];

  const userPath = userConfigPath();
  const projectPath = join(cwd, ".kitten", "config.json");
  const user = readConfig(userPath, warnings);
  const project = readConfig(projectPath, warnings);
  if (user) sources.push(userPath);
  if (project) sources.push(projectPath);

  // env highest (below explicit CLI flags, which the caller applies). An env var that is SET but empty/
  // blank is treated as UNSET (a shell that expands an undefined variable yields "") so it falls through
  // to the file value instead of silently blanking it; a set-but-invalid value warns rather than
  // vanishing into a hardcoded default (§7: a typo that silently uses the wrong value is a bug).
  const envStr = (name: string): string | undefined => {
    const v = process.env[name];
    if (v === undefined) return undefined;
    if (!v.trim()) { warnings.push(`${name} is set but empty — ignored (using config/default)`); return undefined; }
    return v;
  };
  let envContextTokens: number | "auto" | undefined;
  const rawCtx = process.env.KITTEN_CONTEXT_TOKENS;
  if (rawCtx !== undefined && rawCtx.trim()) {
    if (rawCtx.trim().toLowerCase() === "auto") envContextTokens = "auto";
    else {
      const n = Number(rawCtx);
      if (Number.isFinite(n) && n > 0) envContextTokens = n;
      else warnings.push(`KITTEN_CONTEXT_TOKENS "${rawCtx}" is not a positive number or "auto" — ignored (using config/default)`);
    }
  }
  const env = {
    baseUrl: envStr("KITTEN_BASE_URL"),
    sidecarBaseUrl: envStr("KITTEN_SIDECAR_BASE_URL"),
    mainModel: envStr("KITTEN_MAIN_MODEL"),
    sidecarModel: envStr("KITTEN_SIDECAR_MODEL"),
    embedModel: envStr("KITTEN_EMBED_MODEL"),
    apiKey: envStr("KITTEN_API_KEY"),
    approvalPolicy: envStr("KITTEN_APPROVAL_POLICY"),
    contextWindowTokens: envContextTokens,
    runtimeExecutable: undefined,
    mainModelPath: undefined,
    sidecarModelPath: undefined,
    taskCompiler: envStr("KITTEN_TASK_COMPILER"),
    webAccess: envStr("KITTEN_WEB_ACCESS"),
    fastPath: envStr("KITTEN_FAST_PATH"),
    gpuLayers: envStr("KITTEN_GPU_LAYERS"),
    cpuMoe: envStr("KITTEN_CPU_MOE"),
    cpuMoeLayers: envStr("KITTEN_CPU_MOE_LAYERS"),
    flashAttn: envStr("KITTEN_FLASH_ATTN"),
    kvCacheType: envStr("KITTEN_KV_CACHE_TYPE"),
    kvOffload: envStr("KITTEN_KV_OFFLOAD"),
    threads: envStr("KITTEN_THREADS"),
    batchSize: envStr("KITTEN_BATCH_SIZE"),
    ubatchSize: envStr("KITTEN_UBATCH_SIZE"),
    loadMode: envStr("KITTEN_LOAD_MODE"),
    mainGpu: envStr("KITTEN_MAIN_GPU"),
    tensorSplit: envStr("KITTEN_TENSOR_SPLIT"),
    sidecarDevice: envStr("KITTEN_SIDECAR_DEVICE"),
    extraArgs: envStr("KITTEN_RUNTIME_EXTRA_ARGS"),
    argsOverride: envStr("KITTEN_RUNTIME_ARGS_OVERRIDE"),
    parallelSlots: envStr("KITTEN_PARALLEL_SLOTS"),
    speculation: envStr("KITTEN_SPECULATION"),
  };
  const pick = <K extends keyof RawConfig>(k: K): RawConfig[K] =>
    (env[k] as RawConfig[K]) ?? (project?.[k]) ?? (user?.[k]);

  const models: KittenModels = {
    baseUrl: pick("baseUrl") ?? DEFAULT_MODELS.baseUrl,
    sidecarBaseUrl: (pick("sidecarBaseUrl") ?? "").trim() || undefined,
    main: pick("mainModel") ?? DEFAULT_MODELS.main,
    sidecar: pick("sidecarModel") ?? DEFAULT_MODELS.sidecar,
    embed: pick("embedModel") ?? DEFAULT_MODELS.embed,
    apiKey: pick("apiKey") ?? DEFAULT_MODELS.apiKey,
  };

  const managedRuntime: ManagedRuntimeSettings = {
    executable: pick("runtimeExecutable"),
    mainModelPath: pick("mainModelPath"),
    sidecarModelPath: pick("sidecarModelPath"),
  };

  const rawPolicy = pick("approvalPolicy");
  const approvalPolicy: ApprovalPolicy = rawPolicy === "ask" || rawPolicy === "auto-allow" || rawPolicy === "auto-deny" ? rawPolicy : "ask";
  if (rawPolicy && rawPolicy !== approvalPolicy) warnings.push(`approvalPolicy "${rawPolicy}" is not one of ask|auto-allow|auto-deny — using "ask"`);

  // "auto" is the default: the launch plan sizes n_ctx from the machine, and the probed truth flows
  // back into the harness budget. A pinned number (the old behavior) still wins everywhere.
  const rawWindow = pick("contextWindowTokens");
  const contextWindowTokens: number | "auto" =
    rawWindow === "auto" || rawWindow === undefined ? "auto"
      : Number(rawWindow) > 0 ? Number(rawWindow)
      : (warnings.push(`contextWindowTokens "${String(rawWindow)}" is not a positive number or "auto" — using "auto"`), "auto");

  const rawCompiler = pick("taskCompiler");
  const taskCompiler: TaskCompilerFlag = rawCompiler === "off" || rawCompiler === "auto" || rawCompiler === "force" ? rawCompiler : "auto";
  if (rawCompiler && rawCompiler !== taskCompiler) warnings.push(`taskCompiler "${rawCompiler}" is not one of off|auto|force — using "auto"`);

  const rawWeb = pick("webAccess");
  const webAccess: KittenSettings["webAccess"] = rawWeb === "allowlist" || rawWeb === "open" || rawWeb === "off" ? rawWeb : "open";
  if (rawWeb && rawWeb !== webAccess) warnings.push(`webAccess "${rawWeb}" is not one of allowlist|open|off — using "open"`);

  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
  // A count reaches us as a number from a config file and as a string from the environment; both are
  // valid, and anything else falls back to "auto" rather than to a silently wrong number.
  const count = (value: unknown): number | "auto" =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value)
      : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : "auto";
  const rawCpuMoeLayers = pick("cpuMoeLayers");
  const runtimeTuning: RuntimeTuningSettings = {
    gpuLayers: count(pick("gpuLayers")),
    cpuMoe: oneOf(pick("cpuMoe"), ["auto", "on", "off"] as const, "auto"),
    cpuMoeLayers: rawCpuMoeLayers === "all" ? "all" : count(rawCpuMoeLayers),
    flashAttn: oneOf(pick("flashAttn"), ["auto", "on", "off"] as const, "auto"),
    kvCacheType: oneOf(pick("kvCacheType"), ["auto", "q8_0", "f16", "q4_0"] as const, "auto"),
    kvOffload: oneOf(pick("kvOffload"), ["auto", "on", "off"] as const, "auto"),
    threads: count(pick("threads")),
    batchSize: count(pick("batchSize")),
    ubatchSize: count(pick("ubatchSize")),
    loadMode: oneOf(pick("loadMode"), ["auto", "none", "mmap", "mlock", "mmap+mlock"] as const, "auto"),
    mainGpu: count(pick("mainGpu")),
    tensorSplit: typeof pick("tensorSplit") === "string" ? String(pick("tensorSplit")).trim() : "",
    sidecarDevice: oneOf(pick("sidecarDevice"), ["cpu", "gpu"] as const, "cpu"),
    extraArgs: typeof pick("extraArgs") === "string" ? String(pick("extraArgs")).trim() : "",
    argsOverride: typeof pick("argsOverride") === "string" ? String(pick("argsOverride")).trim() : "",
    parallelSlots: count(pick("parallelSlots")),
    speculation: oneOf(pick("speculation"), ["auto", "ngram", "mtp", "off"] as const, "auto"),
  };
  // Heal a config an older build corrupted. Its runtime panel saved the whole generated command into
  // extraArgs, which appends LAST — so `--model <model id>` beat the real `--model <weights path>`
  // and llama.cpp went looking for a file named after the model. Dropping it restores the launch;
  // saying so is the difference between a fix and a mystery.
  if (looksLikeGeneratedCommand(runtimeTuning.extraArgs)) {
    warnings.push("Extra llama-server flags contained a whole generated command (an earlier version saved one there, which broke every launch by overriding the weights path). It has been ignored — re-add just the flags you want under Settings, Advanced.");
    runtimeTuning.extraArgs = "";
  }
  // A runtime path may point at the FOLDER the server lives in. Resolve it to the binary rather than
  // failing at spawn with an OS error.
  const resolvedBinary = resolveServerBinary(managedRuntime.executable);
  if (managedRuntime.executable && resolvedBinary && resolvedBinary !== managedRuntime.executable) {
    managedRuntime.executable = resolvedBinary;
  }

  const rawFastPath = pick("fastPath");
  const fastPath: KittenSettings["fastPath"] = rawFastPath === "off" ? "off" : "auto";
  if (rawFastPath && rawFastPath !== fastPath) warnings.push(`fastPath "${rawFastPath}" is not one of auto|off — using "auto"`);
  return { models, managedRuntime, runtimeTuning, approvalPolicy, contextWindowTokens, taskCompiler, webAccess, fastPath, sources, warnings };
}

/** Persist non-secret app settings atomically. API keys remain environment/config-file only. */
export function saveKittenSettings(update: SettingsUpdate, scope: "user" | "project" = "user", cwd = process.cwd()): string {
  // Write where a read would look, or a saved setting becomes invisible to the next load.
  const path = scope === "project" ? join(cwd, ".kitten", "config.json") : userConfigPath();
  mkdirSync(join(path, ".."), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      // Same BOM tolerance as the read path — without it, saving ONE setting into a PowerShell-written
      // config threw the whole file away and rewrote it with just that setting.
      const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* overwrite malformed config with the explicit app update */ }
  }
  for (const [key, value] of Object.entries(update)) if (value !== undefined) current[key] = value;
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return path;
}
