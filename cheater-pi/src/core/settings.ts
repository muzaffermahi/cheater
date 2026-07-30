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

export type ApprovalPolicy = "ask" | "auto-allow" | "auto-deny";

export interface ManagedRuntimeSettings {
  executable?: string;
  mainModelPath?: string;
  sidecarModelPath?: string;
}

export interface KittenSettings {
  models: KittenModels;
  managedRuntime: ManagedRuntimeSettings;
  approvalPolicy: ApprovalPolicy;
  contextWindowTokens: number;
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
  contextWindowTokens?: number;
  runtimeExecutable?: string;
  mainModelPath?: string;
  sidecarModelPath?: string;
}

const KNOWN_KEYS = new Set([
  "baseUrl", "sidecarBaseUrl", "mainModel", "sidecarModel", "embedModel", "apiKey",
  "approvalPolicy", "contextWindowTokens",
  "runtimeExecutable", "mainModelPath", "sidecarModelPath",
]);

interface RawConfig {
  baseUrl?: string; sidecarBaseUrl?: string; mainModel?: string; sidecarModel?: string; embedModel?: string; apiKey?: string;
  approvalPolicy?: string; contextWindowTokens?: number;
  runtimeExecutable?: string; mainModelPath?: string; sidecarModelPath?: string;
}

function readConfig(path: string, warnings: string[]): RawConfig | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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
  let envContextTokens: number | undefined;
  const rawCtx = process.env.KITTEN_CONTEXT_TOKENS;
  if (rawCtx !== undefined && rawCtx.trim()) {
    const n = Number(rawCtx);
    if (Number.isFinite(n) && n > 0) envContextTokens = n;
    else warnings.push(`KITTEN_CONTEXT_TOKENS "${rawCtx}" is not a positive number — ignored (using config/default)`);
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

  const contextWindowTokens = Number(pick("contextWindowTokens")) > 0 ? Number(pick("contextWindowTokens")) : 16384;

  return { models, managedRuntime, approvalPolicy, contextWindowTokens, sources, warnings };
}

/** Persist non-secret app settings atomically. API keys remain environment/config-file only. */
export function saveKittenSettings(update: SettingsUpdate, scope: "user" | "project" = "user", cwd = process.cwd()): string {
  const path = scope === "project" ? join(cwd, ".kitten", "config.json") : join(homedir(), ".kitten", "config.json");
  mkdirSync(join(path, ".."), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* overwrite malformed config with the explicit app update */ }
  }
  for (const [key, value] of Object.entries(update)) if (value !== undefined) current[key] = value;
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return path;
}
