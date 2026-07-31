import { KittenLLM } from "./llm.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Capabilities {
  engine: "llamacpp" | "openai-proxy" | "unknown";
  thinking: boolean;
  grammar: boolean;
  logprobs: boolean;
  contextSize: number;
  cachePrompt: boolean;
  chatTemplate: string;
  probedAt: number;
  baseUrl: string;
  model: string;
}

const CACHE_FILE = join(homedir(), ".kitten", "capabilities.json");
const CACHE_TTL_MS = 3600_000;

interface CacheEntry {
  key: string;
  caps: Capabilities;
  savedAt: number;
}

function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

function loadCache(): CacheEntry[] {
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = readFileSync(CACHE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    /* corrupt cache, ignore */
  }
  return [];
}

function saveCache(entries: CacheEntry[]): void {
  try {
    const dir = join(homedir(), ".kitten");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2));
  } catch {
    /* best-effort cache write */
  }
}

export function readCachedCapabilities(baseUrl: string, model: string): Capabilities | null {
  const key = cacheKey(baseUrl, model);
  const entries = loadCache();
  const entry = entries.find((e) => e.key === key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > CACHE_TTL_MS) return null;
  return entry.caps;
}

export function writeCachedCapabilities(caps: Capabilities): void {
  const key = cacheKey(caps.baseUrl, caps.model);
  const entries = loadCache();
  const idx = entries.findIndex((e) => e.key === key);
  const entry: CacheEntry = { key, caps, savedAt: Date.now() };
  if (idx !== -1) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  saveCache(entries);
}

export async function probeCapabilities(llm: KittenLLM, model: string): Promise<Capabilities> {
  const baseUrl = llm.models.baseUrl;
  const cached = readCachedCapabilities(baseUrl, model);
  if (cached) return cached;

  const engine = await llm.detectEngine();
  let contextSize = 4096;
  let chatTemplate = "";
  let grammar = false;
  let logprobs = false;
  let cachePrompt = false;
  let thinking = false;

  if (engine === "llamacpp") {
    try {
      const rootUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
      const res = await fetch(rootUrl + "/props", {
        headers: { authorization: `Bearer ${llm.models.apiKey ?? "lm-studio"}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const props: any = await res.json();
        chatTemplate = String(props.chat_template ?? "");
        const dgs = props.default_generation_settings;
        if (dgs) {
          if (typeof dgs.n_ctx === "number") contextSize = dgs.n_ctx;
          else if (typeof props.n_ctx === "number") contextSize = props.n_ctx;
        }
      }
    } catch {
      /* props unavailable, use defaults */
    }

    try {
      const g = await llm.complete({
        prompt: "hi",
        maxTokens: 1,
        grammar: 'root ::= "a"',
        timeoutMs: 5000,
      });
      grammar = g.ok && g.content.length > 0;
    } catch {
      grammar = false;
    }

    try {
      const p = await llm.complete({
        prompt: "hi",
        maxTokens: 1,
        nProbs: 1,
        timeoutMs: 5000,
      });
      logprobs = p.ok && Array.isArray(p.logprobs) && p.logprobs.length > 0;
    } catch {
      logprobs = false;
    }

    try {
      const cp = await llm.complete({
        prompt: "hello world",
        maxTokens: 1,
        cachePrompt: true,
        timeoutMs: 5000,
      });
      cachePrompt = cp.ok && cp.content.length > 0;
    } catch {
      cachePrompt = false;
    }

    try {
      const t = await llm.chat({
        model,
        messages: [{ role: "user", content: "think step by step then answer: 1+1=" }],
        maxTokens: 64,
        timeoutMs: 10000,
      });
      thinking = t.ok && t.content.includes("2");
      if (t.reasoning && t.reasoning.length > 0) thinking = true;
    } catch {
      thinking = false;
    }
  }

  const caps: Capabilities = {
    engine,
    thinking,
    grammar,
    logprobs,
    contextSize,
    cachePrompt,
    chatTemplate,
    probedAt: Date.now(),
    baseUrl,
    model,
  };

  writeCachedCapabilities(caps);
  return caps;
}
