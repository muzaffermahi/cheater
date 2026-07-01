import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OfficialDocsFact } from "../blueprint/types.js";

const DOCS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DOCS_CACHE_VERSION = 1;
const DOCS_CACHE_MAX_ENTRIES = 64;
const DOCS_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export interface DocsCacheEntry {
  version: number;
  createdAt: string;
  query: string;
  library: string;
  provider: string;
  facts: OfficialDocsFact[];
}

export function docsCacheDir(cwd: string): string {
  return join(cwd, ".cheater", "cache", "docs-scout");
}

export function docsCacheKey(query: string, library: string, provider: string): string {
  const normalized = `${provider}::${library}::${normalizeQuery(query)}`;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
}

export interface DocsCacheReadResult {
  hit: boolean;
  facts: OfficialDocsFact[];
  ageMs: number;
}

export function readDocsCache(cwd: string, key: string, ttlMs = DOCS_CACHE_TTL_MS): DocsCacheReadResult {
  const path = join(docsCacheDir(cwd), `${key}.json`);
  let ageMs = Number.POSITIVE_INFINITY;
  if (!existsSync(path)) return { hit: false, facts: [], ageMs };
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as DocsCacheEntry;
    if (entry.version !== DOCS_CACHE_VERSION) return { hit: false, facts: [], ageMs };
    ageMs = Date.now() - new Date(entry.createdAt).getTime();
    if (ageMs > ttlMs) return { hit: false, facts: [], ageMs };
    return { hit: true, facts: entry.facts ?? [], ageMs };
  } catch {
    return { hit: false, facts: [], ageMs };
  }
}

export function writeDocsCache(cwd: string, key: string, entry: Omit<DocsCacheEntry, "version" | "createdAt">): void {
  try {
    const dir = docsCacheDir(cwd);
    mkdirSync(dir, { recursive: true });
    const full: DocsCacheEntry = {
      ...entry,
      version: DOCS_CACHE_VERSION,
      createdAt: new Date().toISOString()
    };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(full, null, 2), "utf8");
    evictDocsCache(dir);
  } catch {
  }
}

export function evictDocsCache(dir: string): { evicted: number; remaining: number } {
  let entries: { name: string; mtimeMs: number; size: number }[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        entries.push({ name, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
      }
    }
  } catch {
    return { evicted: 0, remaining: 0 };
  }
  if (entries.length <= DOCS_CACHE_MAX_ENTRIES && entries.reduce((sum, e) => sum + e.size, 0) <= DOCS_CACHE_MAX_BYTES) {
    return { evicted: 0, remaining: entries.length };
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let evicted = 0;
  let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  for (const entry of entries) {
    if (entries.length - evicted <= DOCS_CACHE_MAX_ENTRIES && totalBytes <= DOCS_CACHE_MAX_BYTES) break;
    try {
      unlinkSync(join(dir, entry.name));
      evicted++;
      totalBytes -= entry.size;
    } catch {
    }
  }
  return { evicted, remaining: entries.length - evicted };
}

export function docsCacheStats(cwd: string): { entries: number; bytes: number } {
  const dir = docsCacheDir(cwd);
  let entries = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const stat = statSync(join(dir, name));
        entries++;
        bytes += stat.size;
      } catch {
      }
    }
  } catch {
  }
  return { entries, bytes };
}