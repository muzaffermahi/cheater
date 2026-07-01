import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintConfig } from "./config.js";
import type { OfficialDocsFact } from "./types.js";
import { docsCacheKey, readDocsCache, writeDocsCache } from "./docsCache.js";

const OFFICIAL_DOMAINS: Record<string, string[]> = {
  pi: ["pi.dev", "github.com/earendil-works/pi"],
  flask: ["flask.palletsprojects.com"],
  fastapi: ["fastapi.tiangolo.com"],
  pydantic: ["docs.pydantic.dev"],
  pytest: ["docs.pytest.org"],
  sqlalchemy: ["docs.sqlalchemy.org"],
  django: ["docs.djangoproject.com"],
  react: ["react.dev"],
  next: ["nextjs.org"],
  vite: ["vite.dev"],
  vitest: ["vitest.dev"],
  playwright: ["playwright.dev"],
  typescript: ["typescriptlang.org"],
  node: ["nodejs.org"],
  express: ["expressjs.com"],
  zod: ["zod.dev"],
  prisma: ["prisma.io"],
  tailwind: ["tailwindcss.com"],
  vue: ["vuejs.org"],
  svelte: ["svelte.dev"],
  sqlite: ["sqlite.org"],
  textual: ["textual.textualize.io"]
};

export function officialDomainsFor(packageOrLibrary: string): string[] {
  return OFFICIAL_DOMAINS[packageOrLibrary.toLowerCase()] ?? [];
}

export function isOfficialAllowed(url: string, packageOrLibrary: string): boolean {
  const domains = officialDomainsFor(packageOrLibrary);
  if (domains.length === 0) return false;
  try {
    const host = new URL(url).host.toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function localDocsFacts(cwd: string, query: string, maxFacts = 5): OfficialDocsFact[] {
  const candidates = ["README.md", "docs/cheater_pi.md", "docs/ARCHITECTURE.md", "docs/STATE_OF_REPO.md"];
  const q = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3).slice(0, 8);
  const facts: OfficialDocsFact[] = [];
  for (const rel of candidates) {
    const path = join(cwd, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const line = text.split(/\r?\n/).find((item) => q.some((term) => item.toLowerCase().includes(term)));
    if (!line) continue;
    facts.push({
      query,
      packageOrLibrary: "local",
      sourceTitle: rel,
      sourceUrl: rel,
      sourceDomain: "local",
      claim: line.trim().slice(0, 240),
      confidence: "medium"
    });
    if (facts.length >= maxFacts) break;
  }
  return facts;
}

export async function scoutOfficialDocs(params: {
  cwd: string;
  query: string;
  packageOrLibrary?: string;
  config: BlueprintConfig;
}): Promise<OfficialDocsFact[]> {
  const local = localDocsFacts(params.cwd, params.query, params.config.blueprintMaxDocsFacts);
  if (!params.config.blueprintOfficialDocsSearchEnabled) return local;
  const library = params.packageOrLibrary ?? inferLibrary(params.query, params.cwd);
  if (params.config.blueprintDocsProvider === "local") return local;
  const provider = params.config.blueprintDocsProvider;
  const cacheKey = docsCacheKey(params.query, library, provider);
  const cached = readDocsCache(params.cwd, cacheKey);
  if (cached.hit && cached.facts.length) return [...local, ...cached.facts].slice(0, params.config.blueprintMaxDocsFacts);
  let remote: OfficialDocsFact[] = [];
  if (provider === "official_allowlist") {
    remote = params.config.blueprintFetchDocsPages
      ? await fetchOfficialDocsPages(params.query, library)
      : officialAllowlistFacts(params.query, library);
  } else if (params.config.searxngBaseUrl) {
    remote = await searxngOfficialFacts(params.query, library, params.config.searxngBaseUrl);
  }
  writeDocsCache(params.cwd, cacheKey, { query: params.query, library, provider, facts: remote });
  return [...local, ...remote].slice(0, params.config.blueprintMaxDocsFacts);
}

export { docsCacheKey, readDocsCache, writeDocsCache } from "./docsCache.js";

export async function fetchOfficialDocsPages(query: string, packageOrLibrary: string): Promise<OfficialDocsFact[]> {
  const domains = officialDomainsFor(packageOrLibrary);
  if (!domains.length) return [];
  const facts: OfficialDocsFact[] = [];
  for (const domain of domains.slice(0, 3)) {
    const url = `https://${domain}`;
    if (!isOfficialAllowed(url, packageOrLibrary)) continue;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 3500);
    try {
      const response = await fetch(url, { signal: abort.signal, headers: { "user-agent": "CheaterBlueprint/0.7" } });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "";
      if (!/html|text/i.test(contentType)) continue;
      const html = (await response.text()).slice(0, 120000);
      const claim = extractDocsClaim(html, query) || `Official ${packageOrLibrary} documentation is reachable at ${url}; verify API details against this source.`;
      facts.push({
        query,
        packageOrLibrary,
        sourceTitle: extractTitle(html) || `${packageOrLibrary} official docs`,
        sourceUrl: url,
        sourceDomain: domain,
        claim,
        confidence: "high"
      });
    } catch {
      facts.push({
        query,
        packageOrLibrary,
        sourceTitle: `${packageOrLibrary} official docs`,
        sourceUrl: url,
        sourceDomain: domain,
        claim: `Official ${packageOrLibrary} documentation source allowlisted but unavailable during blueprint creation; retry with SearXNG or local docs if API details matter.`,
        confidence: "low"
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return facts;
}

export function officialAllowlistFacts(query: string, packageOrLibrary: string): OfficialDocsFact[] {
  return officialDomainsFor(packageOrLibrary).map((domain) => ({
    query,
    packageOrLibrary,
    sourceTitle: `${packageOrLibrary} official docs`,
    sourceUrl: `https://${domain}`,
    sourceDomain: domain,
    claim: `Use only official ${packageOrLibrary} documentation from ${domain}; verify details against local source before editing.`,
    confidence: "medium" as const
  }));
}

export async function searxngOfficialFacts(query: string, packageOrLibrary: string, baseUrl: string): Promise<OfficialDocsFact[]> {
  const domains = officialDomainsFor(packageOrLibrary);
  if (!domains.length) return [];
  const siteFilter = domains.map((domain) => `site:${domain}`).join(" OR ");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return [];
  }
  url.searchParams.set("q", `${query} ${siteFilter}`);
  url.searchParams.set("format", "json");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) return [];
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return [];
    const json = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (json.results ?? [])
      .filter((result) => result.url && isOfficialAllowed(result.url, packageOrLibrary))
      .slice(0, 5)
      .map((result) => ({
        query,
        packageOrLibrary,
        sourceTitle: result.title ?? result.url ?? "official result",
        sourceUrl: result.url ?? "",
        sourceDomain: new URL(result.url ?? "https://example.com").host,
        claim: (result.content ?? result.title ?? "").slice(0, 240),
        confidence: "medium" as const
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export function inferLibrary(query: string, cwd?: string): string {
  const lower = query.toLowerCase();
  for (const library of Object.keys(OFFICIAL_DOMAINS)) {
    if (lower.includes(library)) return library;
  }
  if (cwd) {
    const manifestLibraries = inferLibrariesFromRepo(cwd);
    const mentioned = manifestLibraries.find((library) => lower.includes(library));
    if (mentioned) return mentioned;
    if (manifestLibraries.length === 1 && /\b(docs?|official|framework|library|api|unknown|how to)\b/.test(lower)) {
      return manifestLibraries[0];
    }
  }
  return "pi";
}

export function inferLibrariesFromRepo(cwd: string): string[] {
  const libraries = new Set<string>();
  for (const dep of packageJsonDependencies(cwd)) {
    const mapped = normalizePackageName(dep);
    if (mapped && officialDomainsFor(mapped).length) libraries.add(mapped);
  }
  for (const dep of pyprojectDependencies(cwd)) {
    const mapped = normalizePackageName(dep);
    if (mapped && officialDomainsFor(mapped).length) libraries.add(mapped);
  }
  return [...libraries].sort();
}

function packageJsonDependencies(cwd: string): string[] {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string> | undefined>;
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {})
    ];
  } catch {
    return [];
  }
}

function pyprojectDependencies(cwd: string): string[] {
  const path = join(cwd, "pyproject.toml");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/["']([A-Za-z0-9_.-]+)(?:[<>=!~ ].*)?["']/g)].map((match) => match[1]);
}

function normalizePackageName(name: string): string | undefined {
  const original = name.toLowerCase();
  if (original === "@types/node") return "node";
  if (original === "@playwright/test") return "playwright";
  if (original === "@prisma/client") return "prisma";
  if (original.startsWith("@tailwindcss/")) return "tailwind";
  const lower = original.replace(/^@[^/]+\//, "");
  if (lower === "react-dom") return "react";
  if (lower === "next") return "next";
  if (lower === "typescript") return "typescript";
  if (lower === "node") return "node";
  if (lower === "tailwindcss") return "tailwind";
  if (lower === "vue") return "vue";
  if (lower === "svelte") return "svelte";
  if (lower === "vitest") return "vitest";
  if (lower === "playwright") return "playwright";
  if (lower === "express") return "express";
  if (lower === "zod") return "zod";
  if (lower === "prisma") return "prisma";
  if (lower === "fastapi") return "fastapi";
  if (lower === "pydantic") return "pydantic";
  if (lower === "pytest") return "pytest";
  if (lower === "sqlalchemy") return "sqlalchemy";
  if (lower === "django") return "django";
  if (lower === "flask") return "flask";
  if (lower === "textual") return "textual";
  return officialDomainsFor(lower).length ? lower : undefined;
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return decodeHtml(stripTags(match?.[1] ?? "")).slice(0, 120);
}

function extractDocsClaim(html: string, query: string): string {
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3).slice(0, 8);
  const text = decodeHtml(stripTags(html)).replace(/\s+/g, " ").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  const index = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, index - 120);
  return text.slice(start, start + 360).trim();
}

function stripTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
