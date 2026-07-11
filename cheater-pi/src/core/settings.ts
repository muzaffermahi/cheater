// Kitten Core — unified settings for all clients (TUI, web, headless). NO Pi.
//
// One documented precedence (Goal §7), low → high:
//   defaults  <  user file (~/.kitten/config.json or ~/.config/kitten/config.json)  <  project
//   (.kitten/config.json)  <  KITTEN_* environment  <  explicit CLI flags (applied by the caller).
// Secrets (apiKey) are resolved here but NEVER written into conversation events. Unknown keys are
// reported (a typo that would silently fall back to the wrong model is a bug, per §7).

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_MODELS, type KittenModels } from "./llm.js";

export type ApprovalPolicy = "ask" | "auto-allow" | "auto-deny";

export interface KittenSettings {
  models: KittenModels;
  approvalPolicy: ApprovalPolicy;
  contextWindowTokens: number;
  /** Config files that were merged (for `kitten doctor` transparency). */
  sources: string[];
  /** Non-fatal problems (unknown keys, unreadable files) to surface in doctor. */
  warnings: string[];
}

const KNOWN_KEYS = new Set([
  "baseUrl", "mainModel", "sidecarModel", "embedModel", "apiKey",
  "approvalPolicy", "contextWindowTokens",
]);

interface RawConfig {
  baseUrl?: string; mainModel?: string; sidecarModel?: string; embedModel?: string; apiKey?: string;
  approvalPolicy?: string; contextWindowTokens?: number;
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

  // env highest (below explicit CLI flags, which the caller applies).
  const env = {
    baseUrl: process.env.KITTEN_BASE_URL,
    mainModel: process.env.KITTEN_MAIN_MODEL,
    sidecarModel: process.env.KITTEN_SIDECAR_MODEL,
    embedModel: process.env.KITTEN_EMBED_MODEL,
    apiKey: process.env.KITTEN_API_KEY,
    approvalPolicy: process.env.KITTEN_APPROVAL_POLICY,
    contextWindowTokens: process.env.KITTEN_CONTEXT_TOKENS ? Number(process.env.KITTEN_CONTEXT_TOKENS) : undefined,
  };
  const pick = <K extends keyof RawConfig>(k: K): RawConfig[K] =>
    (env[k] as RawConfig[K]) ?? (project?.[k]) ?? (user?.[k]);

  const models: KittenModels = {
    baseUrl: pick("baseUrl") ?? DEFAULT_MODELS.baseUrl,
    main: pick("mainModel") ?? DEFAULT_MODELS.main,
    sidecar: pick("sidecarModel") ?? DEFAULT_MODELS.sidecar,
    embed: pick("embedModel") ?? DEFAULT_MODELS.embed,
    apiKey: pick("apiKey") ?? DEFAULT_MODELS.apiKey,
  };

  const rawPolicy = pick("approvalPolicy");
  const approvalPolicy: ApprovalPolicy = rawPolicy === "ask" || rawPolicy === "auto-allow" || rawPolicy === "auto-deny" ? rawPolicy : "ask";
  if (rawPolicy && rawPolicy !== approvalPolicy) warnings.push(`approvalPolicy "${rawPolicy}" is not one of ask|auto-allow|auto-deny — using "ask"`);

  const contextWindowTokens = Number(pick("contextWindowTokens")) > 0 ? Number(pick("contextWindowTokens")) : 16384;

  return { models, approvalPolicy, contextWindowTokens, sources, warnings };
}
