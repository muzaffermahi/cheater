import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type SearchTriggerKind =
  | "exact_error"
  | "unknown_package"
  | "version_sensitive"
  | "framework_uncertainty"
  | "external_test_failure"
  | "repeated_failed_verification"
  | "user_requested_search"
  | "insufficient_local_evidence";

export interface SearchTrigger {
  kind: SearchTriggerKind;
  reason: string;
  weight: number;
  evidence: string[];
}

export interface SearchTriggerInput {
  taskType?: string;
  userGoal: string;
  repoRoot?: string;
  knownLibraries?: string[];
  failedVerificationCount?: number;
  lastFailureSignals?: string[];
  manifestDependencies?: Array<{ name: string; version?: string }>;
}

const ERROR_PATTERNS: RegExp[] = [
  /\bTypeError\b/i,
  /\bValueError\b/i,
  /\bKeyError\b/i,
  /\bAttributeError\b/i,
  /\bImportError\b/i,
  /\bModuleNotFoundError\b/i,
  /\bSyntaxError\b/i,
  /\bReferenceError\b/i,
  /\bRuntimeError\b/i,
  /\bHTTPError\b/i,
  /\bECONN[A-Z_]+/,
  /\bENOENT\b/,
  /\bELIFECYCLE\b/,
  /\bTypeError[ :].{0,80}/,
  /TS\d{3,5}\b/,
  /error[ \t:]+[A-Z][\w ]{8,120}/i
];

const VERSION_SENSITIVE_PATTERNS: RegExp[] = [
  /\bv(er)?sion\b/i,
  /\bupgrade\b/i,
  /\bmigrate|migration\b/i,
  /\bdeprecated\b/i,
  /\bbreaking change\b/i,
  /\bcompatibility\b/i,
  /\bpeer dep(endency)?\b/i,
  /\bnode\s*\d+/i,
  /\bpython\s*\d+/i,
  /[<>]=?\s*\d+\.\d+/
];

const USER_SEARCH_REQUESTS: RegExp[] = [
  /\bsearch (?:the )?(?:web|internet|online)\b/i,
  /\blook (?:it|this) up\b/i,
  /\bwhat is the latest\b/i,
  /\bcheck (?:the )?docs\b/i,
  /\bofficial docs\b/i,
  /\blatest version\b/i,
  /\brelease notes\b/i,
  /\bchangelog\b/i,
  /\bmigration guide\b/i
];

const UNKNOWN_PACKAGE_HINT = /(?:unknown|unrecognized|unrecognised|doesn't have|does not have|module not found|cannot find|is not a function|no attribute)/i;
const FRAMEWORK_UNCERTAINTY_HINT = /\b(how to|best practice|recommended way|idiomatic|should I use|which one|comparison)\b/i;

const EXTERNAL_LIB_HINTS = [
  "react", "vue", "svelte", "angular", "next", "remix", "vite", "webpack",
  "express", "fastify", "koa", "django", "flask", "fastapi", "spring", "gin", "echo",
  "pytest", "jest", "vitest", "mocha", "playwright", "cypress", "rspec", "junit",
  "typescript", "node", "deno", "bun",
  "pydantic", "sqlalchemy", "prisma", "drizzle", "sequelize", "mongoose",
  "zod", "yup", "joi", "rxjs", "lodash", "tailwind",
  "docker", "kubernetes", "nginx", "postgres", "sqlite", "redis"
];

export function detectSearchTriggers(input: SearchTriggerInput): SearchTrigger[] {
  const triggers: SearchTrigger[] = [];
  const lower = input.userGoal.toLowerCase();
  const signals = (input.lastFailureSignals ?? []).map((s) => s.trim()).filter(Boolean);

  for (const pattern of ERROR_PATTERNS) {
    const matched = signals.find((signal) => pattern.test(signal)) ?? (pattern.test(lower) ? lower : undefined);
    if (matched) {
      triggers.push({
        kind: "exact_error",
        reason: `error pattern ${pattern} matched${signals.includes(matched) ? " in failure signal" : " in user goal"}`,
        weight: 4,
        evidence: [truncate(matched, 160)]
      });
      break;
    }
  }

  if (input.taskType && /bug_fix|test_failure|import_error|type_error|migration/.test(input.taskType)) {
    if (signals.length === 0) {
      triggers.push({
        kind: "external_test_failure",
        reason: `task type ${input.taskType} without a captured local failure signal; external evidence is appropriate`,
        weight: 2,
        evidence: [`task type: ${input.taskType}`]
      });
    }
  }

  if (UNKNOWN_PACKAGE_HINT.test(lower)) {
    triggers.push({
      kind: "unknown_package",
      reason: "user goal indicates an unrecognized symbol, import, or attribute",
      weight: 2,
      evidence: [truncate(lower, 160)]
    });
  }

  if (VERSION_SENSITIVE_PATTERNS.some((re) => re.test(lower))) {
    triggers.push({
      kind: "version_sensitive",
      reason: "goal mentions version, upgrade, migration, or deprecation",
      weight: 3,
      evidence: [matchSlice(lower, VERSION_SENSITIVE_PATTERNS)]
    });
  }

  if (FRAMEWORK_UNCERTAINTY_HINT.test(lower)) {
    triggers.push({
      kind: "framework_uncertainty",
      reason: "goal asks for guidance or best practice for a framework",
      weight: 2,
      evidence: [truncate(lower, 160)]
    });
  }

  if (signals.some((signal) => /(?:at\s+\S+\s+\([^)]*node_modules\/[^)]+\))/i.test(signal))) {
    triggers.push({
      kind: "external_test_failure",
      reason: "failure stack trace points into node_modules (external library)",
      weight: 3,
      evidence: signals.filter((s) => /node_modules/.test(s)).slice(0, 2)
    });
  }

  if ((input.failedVerificationCount ?? 0) >= 2) {
    triggers.push({
      kind: "repeated_failed_verification",
      reason: `verification failed ${input.failedVerificationCount} times; local repair loop is not converging`,
      weight: 4,
      evidence: [`failed verification count: ${input.failedVerificationCount}`]
    });
  }

  if (USER_SEARCH_REQUESTS.some((re) => re.test(lower))) {
    triggers.push({
      kind: "user_requested_search",
      reason: "user explicitly asked to look something up",
      weight: 3,
      evidence: [matchSlice(lower, USER_SEARCH_REQUESTS)]
    });
  }

  const known = new Set((input.knownLibraries ?? []).map((item) => item.toLowerCase()));
  const goalLibraryHit = detectExternalLibraryInText(lower);
  if (goalLibraryHit && !known.has(goalLibraryHit)) {
    triggers.push({
      kind: "unknown_package",
      reason: `library "${goalLibraryHit}" mentioned in goal is not declared in the repo`,
      weight: 3,
      evidence: [goalLibraryHit]
    });
  }

  const manifest = input.manifestDependencies ?? loadManifestDependencies(input.repoRoot);
  if (manifest.length && known.size <= 1 && lower.length > 0) {
    triggers.push({
      kind: "insufficient_local_evidence",
      reason: "repo evidence is sparse; targeted web evidence can confirm an API surface",
      weight: 1,
      evidence: [`manifest deps: ${manifest.length}`]
    });
  }

  return triggers;
}

export function shouldSearchWeb(triggers: SearchTrigger[]): boolean {
  return triggers.length > 0 && triggers.reduce((sum, trigger) => sum + trigger.weight, 0) >= 3;
}

export function primarySearchReason(triggers: SearchTrigger[]): string {
  if (!triggers.length) return "no triggers";
  return triggers.map((trigger) => `${trigger.kind}=${trigger.weight}`).join("; ");
}

function detectExternalLibraryInText(text: string): string | undefined {
  for (const lib of EXTERNAL_LIB_HINTS) {
    if (new RegExp(`\\b${lib}\\b`, "i").test(text)) return lib;
  }
  return undefined;
}

function loadManifestDependencies(repoRoot?: string): Array<{ name: string; version?: string }> {
  if (!repoRoot) return [];
  const result: Array<{ name: string; version?: string }> = [];
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
        for (const [name, range] of Object.entries(parsed[section] ?? {})) {
          result.push({ name, version: range });
        }
      }
    } catch {
    }
  }
  return result;
}

function matchSlice(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return truncate(match[0], 80);
  }
  return truncate(text, 80);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "..." : value;
}

export type SearchPurpose = "official" | "exact_error" | "issues" | "examples" | "changelog";

export interface SearchQuery {
  text: string;
  purpose: SearchPurpose;
  packageOrLibrary: string;
  version?: string;
  siteFilter?: string;
  reason: string;
}

export interface QueryGenerationInput {
  userGoal: string;
  taskType?: string;
  errorSignals?: string[];
  manifestDependencies?: Array<{ name: string; version?: string }>;
  repoRoot?: string;
  goalLibraryHint?: string;
  maxQueriesPerPurpose?: number;
}

export function generateSearchQueries(input: QueryGenerationInput): SearchQuery[] {
  const cap = input.maxQueriesPerPurpose ?? 2;
  const deps = input.manifestDependencies ?? loadManifestDependencies(input.repoRoot);
  const pkg = pickPrimaryPackage(input, deps);
  const version = pkg?.version?.replace(/^[~^>=<]+\s*/, "").split(/\s+-\s+|\s+\|\|\s+/)[0];
  const queries: SearchQuery[] = [];
  const errorText = (input.errorSignals ?? []).map((s) => s.trim()).filter(Boolean)[0] ?? extractFirstError(input.userGoal);

  if (pkg) {
    const officialDomain = (firstAllowedDomain(pkg.name) ?? "");
    queries.push(buildQuery({
      text: `${pkg.name} ${version ?? ""} ${input.userGoal}`.trim(),
      purpose: "official",
      packageOrLibrary: pkg.name,
      version,
      siteFilter: officialDomain || undefined,
      reason: `official docs for ${pkg.name}${version ? `@${version}` : ""}`
    }));
    queries.push(buildQuery({
      text: `${pkg.name} ${input.userGoal} examples site:github.com OR site:${officialDomain || pkg.name + ".com"}`.trim(),
      purpose: "examples",
      packageOrLibrary: pkg.name,
      version,
      siteFilter: officialDomain || undefined,
      reason: `runnable example for ${pkg.name}`
    }));
    queries.push(buildQuery({
      text: `${pkg.name} ${version ?? ""} changelog migration breaking`.trim(),
      purpose: "changelog",
      packageOrLibrary: pkg.name,
      version,
      siteFilter: officialDomain || undefined,
      reason: `changelog/migration for ${pkg.name}${version ? `@${version}` : ""}`
    }));
  }

  if (errorText) {
    const quoted = errorText.length > 140 ? errorText.slice(0, 140) : errorText;
    queries.push(buildQuery({
      text: `"${quoted}"`,
      purpose: "exact_error",
      packageOrLibrary: pkg?.name ?? "unknown",
      version: pkg?.version,
      reason: "exact error text"
    }));
    if (pkg) {
      queries.push(buildQuery({
        text: `${pkg.name} ${quoted} site:github.com`.trim(),
        purpose: "issues",
        packageOrLibrary: pkg.name,
        version: pkg.version,
        siteFilter: "github.com",
        reason: "GitHub issue matching error"
      }));
    }
  } else if (pkg) {
    queries.push(buildQuery({
      text: `${pkg.name} ${input.taskType ?? ""}`.trim(),
      purpose: "issues",
      packageOrLibrary: pkg.name,
      version: pkg.version,
      siteFilter: "github.com",
      reason: `GitHub issues for ${pkg.name}`
    }));
  }

  return capByPurpose(queries, cap);
}

function capByPurpose(queries: SearchQuery[], cap: number): SearchQuery[] {
  const seen = new Set<string>();
  const out: SearchQuery[] = [];
  for (const purpose of ["official", "exact_error", "issues", "examples", "changelog"] as SearchPurpose[]) {
    let n = 0;
    for (const q of queries) {
      if (q.purpose !== purpose) continue;
      const key = `${q.purpose}::${q.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
      n++;
      if (n >= cap) break;
    }
  }
  return out;
}

function buildQuery(params: Omit<SearchQuery, "text"> & { text: string }): SearchQuery {
  return { text: params.text.trim().replace(/\s+/g, " "), purpose: params.purpose, packageOrLibrary: params.packageOrLibrary, version: params.version, siteFilter: params.siteFilter, reason: params.reason };
}

function pickPrimaryPackage(input: QueryGenerationInput, deps: Array<{ name: string; version?: string }>): { name: string; version?: string } | undefined {
  const hint = input.goalLibraryHint?.toLowerCase();
  if (hint) {
    const direct = deps.find((dep) => dep.name.toLowerCase() === hint || dep.name.toLowerCase().includes(hint));
    if (direct) return direct;
  }
  const lower = input.userGoal.toLowerCase();
  const fromGoal = deps.find((dep) => lower.includes(dep.name.toLowerCase()) || lower.includes(dep.name.toLowerCase().split("/").pop() ?? ""));
  if (fromGoal) return fromGoal;
  return deps[0];
}

function extractFirstError(text: string): string | undefined {
  for (const pattern of ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function firstAllowedDomain(pkg: string): string | undefined {
  const lower = pkg.toLowerCase().replace(/^@[^/]+\//, "");
  const allow = OFFICIAL_DOMAIN_MAP[lower];
  return allow?.[0];
}

const OFFICIAL_DOMAIN_MAP: Record<string, string[]> = {
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

export type SourceTier = "official" | "repo" | "issues" | "changelog" | "qna" | "blog" | "other";

export interface SourceRank {
  tier: SourceTier;
  rank: number;
  reason: string;
}

export function rankSource(url: string, title: string, purpose: SearchPurpose): SourceRank {
  const host = (() => { try { return new URL(url).host.toLowerCase(); } catch { return ""; } })();
  const lowerTitle = title.toLowerCase();
  const isOfficial = isOfficialDomain(host);
  const isGithub = host === "github.com" || host.endsWith(".github.com");
  const isSso = /(?:stackoverflow|stackexchange|serverfault|superuser)\.com$/.test(host);
  const isBlog = /(?:medium|dev\.to|hashnode|freecodecamp|blog\.)/.test(host) || /\/blog\//.test(url);
  if (isOfficial) {
    return { tier: "official", rank: 1, reason: `host ${host} is an allowlisted official domain` };
  }
  if (isGithub && /(issues?|discussions?|pull|q&a)/.test(url) || /\[(open|closed)\]/.test(lowerTitle)) {
    return { tier: "issues", rank: purpose === "exact_error" ? 2 : 4, reason: `GitHub issues/discussions for ${host}` };
  }
  if (isGithub && /\/blob\/|\/tree\//.test(url)) {
    return { tier: "repo", rank: 3, reason: `GitHub source for ${host}` };
  }
  if (isGithub && /\/releases?\/|\/releases\/tag\//.test(url) || /changelog|release notes|migration/.test(lowerTitle)) {
    return { tier: "changelog", rank: 2, reason: `release/changelog for ${host}` };
  }
  if (isSso) {
    return { tier: "qna", rank: 5, reason: `Q&A site ${host}` };
  }
  if (isBlog) {
    return { tier: "blog", rank: 6, reason: `community blog ${host}` };
  }
  if (/changelog|release notes|migration|upgrade|breaking/.test(lowerTitle)) {
    return { tier: "changelog", rank: 3, reason: `title indicates changelog/migration` };
  }
  return { tier: "other", rank: 7, reason: "no source category matched" };
}

function isOfficialDomain(host: string): boolean {
  for (const domains of Object.values(OFFICIAL_DOMAIN_MAP)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  }
  return false;
}

export interface WebEvidenceCard {
  id: string;
  fact: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDomain: string;
  sourceTier: SourceTier;
  sourceRank: number;
  rankReason: string;
  packageOrLibrary: string;
  version?: string;
  appliesTo: { packetIds?: string[]; files?: string[]; symbols?: string[] };
  codeSnippet?: string;
  doNotDo?: string;
  verificationHint?: string;
  confidence: "high" | "medium" | "low";
  purpose: SearchPurpose;
  query: string;
}

export interface SearchResultLike {
  url: string;
  title: string;
  content?: string;
  codeBlock?: string;
  warning?: string;
  purpose: SearchPurpose;
  query: string;
  packageOrLibrary: string;
  version?: string;
}

const COMMON_BAD_FIX_HINTS = [
  /(?:don't|do not|never|avoid)\s+(?:use|call|do|wrap|catch)/i,
  /common mistake/i,
  /\bantipattern\b/i,
  /\bdeprecated\b/i,
  /\bgotcha\b/i,
  /\bdon't confuse\b/i
];

export function extractWebEvidence(params: {
  results: SearchResultLike[];
  appliesToFiles?: string[];
  appliesToSymbols?: string[];
  maxCards?: number;
}): WebEvidenceCard[] {
  const maxCards = params.maxCards ?? 8;
  const ranked = [...params.results]
    .map((result) => ({ result, rank: rankSource(result.url, result.title, result.purpose) }))
    .sort((a, b) => a.rank.rank - b.rank.rank || a.result.title.length - b.result.title.length);
  const cards: WebEvidenceCard[] = [];
  const seenFactKeys = new Set<string>();
  for (const { result, rank } of ranked) {
    const fact = (result.content ?? result.title).trim().slice(0, 360);
    if (!fact) continue;
    const key = `${rank.tier}::${fact.slice(0, 80).toLowerCase()}`;
    if (seenFactKeys.has(key)) continue;
    seenFactKeys.add(key);
    const doNotDo = (result.content ?? "").match(COMMON_BAD_FIX_HINTS[0])?.[0]
      ?? (result.content ?? "").match(COMMON_BAD_FIX_HINTS[1])?.[0]
      ?? (result.content ?? "").match(COMMON_BAD_FIX_HINTS[2])?.[0]
      ?? (result.content ?? "").match(COMMON_BAD_FIX_HINTS[3])?.[0]
      ?? (result.content ?? "").match(COMMON_BAD_FIX_HINTS[4])?.[0];
    const verificationHint = extractVerificationHint(result.content ?? "");
    const codeSnippet = result.codeBlock?.slice(0, 600) ?? extractCodeBlock(result.content ?? "");
    cards.push({
      id: `web-${cards.length + 1}`,
      fact,
      sourceUrl: result.url,
      sourceTitle: result.title,
      sourceDomain: (() => { try { return new URL(result.url).host.toLowerCase(); } catch { return ""; } })(),
      sourceTier: rank.tier,
      sourceRank: rank.rank,
      rankReason: rank.reason,
      packageOrLibrary: result.packageOrLibrary,
      version: result.version,
      appliesTo: { files: params.appliesToFiles, symbols: params.appliesToSymbols },
      codeSnippet,
      doNotDo,
      verificationHint,
      confidence: rank.tier === "official" ? "high" : rank.tier === "issues" || rank.tier === "qna" ? "medium" : "low",
      purpose: result.purpose,
      query: result.query
    });
    if (cards.length >= maxCards) break;
  }
  return cards;
}

function extractVerificationHint(text: string): string | undefined {
  const match = /(?:run|verify|check|test with|reproduce with)[:\s]+([\w `./:_-]{4,120})/i.exec(text);
  return match?.[1]?.trim();
}

function extractCodeBlock(text: string): string | undefined {
  const match = /```[\w]*\n([\s\S]{0,400}?)```/m.exec(text);
  if (match) return match[1].trim();
  const inline = /(?:^|\n)((?:[ \t]*(?:>>>|\$|>)\s*[\w./:_-]+.*\n?){1,3})/m.exec(text);
  return inline?.[1]?.trim();
}

export interface WebScoutOptions {
  cwd: string;
  userGoal: string;
  taskType?: string;
  errorSignals?: string[];
  manifestDependencies?: Array<{ name: string; version?: string }>;
  knownLibraries?: string[];
  failedVerificationCount?: number;
  appliesToFiles?: string[];
  appliesToSymbols?: string[];
  maxCards?: number;
  provider?: "mock" | "searxng";
  searxngBaseUrl?: string;
  fetchHtml?: (url: string) => Promise<string | undefined>;
}

export interface WebScoutOutcome {
  triggered: boolean;
  reason: string;
  triggers: SearchTrigger[];
  queries: SearchQuery[];
  cards: WebEvidenceCard[];
  errors: string[];
}

export async function runWebScout(options: WebScoutOptions): Promise<WebScoutOutcome> {
  const errors: string[] = [];
  const triggers = detectSearchTriggers({
    taskType: options.taskType,
    userGoal: options.userGoal,
    repoRoot: options.cwd,
    knownLibraries: options.knownLibraries,
    failedVerificationCount: options.failedVerificationCount,
    lastFailureSignals: options.errorSignals,
    manifestDependencies: options.manifestDependencies
  });
  if (!shouldSearchWeb(triggers)) {
    return { triggered: false, reason: primarySearchReason(triggers), triggers, queries: [], cards: [], errors };
  }
  const queries = generateSearchQueries({
    userGoal: options.userGoal,
    taskType: options.taskType,
    errorSignals: options.errorSignals,
    manifestDependencies: options.manifestDependencies,
    repoRoot: options.cwd
  });
  const cards: WebEvidenceCard[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (seen.has(query.text)) continue;
    seen.add(query.text);
    const key = webEvidenceCacheKey(query.text, query.packageOrLibrary, query.version, query.siteFilter);
    const cached = readWebEvidenceCache(options.cwd, key);
    if (cached.hit && cached.cards.length) {
      cards.push(...cached.cards);
      continue;
    }
    let results: SearchResultLike[] = [];
    try {
      if (options.provider === "searxng" && options.searxngBaseUrl) {
        results = await searxngSearch(query, options.searxngBaseUrl, options.fetchHtml);
      } else if (query.siteFilter && options.fetchHtml) {
        results = await officialAllowlistFetch(query, options.fetchHtml);
      } else {
        results = mockSearchForTest(query, options.cwd);
      }
    } catch (err) {
      errors.push(`query "${query.text}" failed: ${(err as Error).message}`);
      continue;
    }
    const extracted = extractWebEvidence({
      results,
      appliesToFiles: options.appliesToFiles,
      appliesToSymbols: options.appliesToSymbols,
      maxCards: options.maxCards ?? 4
    });
    if (extracted.length) {
      writeWebEvidenceCache(options.cwd, key, { query: query.text, packageOrLibrary: query.packageOrLibrary, packageVersion: query.version, domain: query.siteFilter, cards: extracted });
      cards.push(...extracted);
    }
  }
  const deduped: WebEvidenceCard[] = [];
  const seenFacts = new Set<string>();
  for (const card of cards) {
    const k = `${card.sourceTier}::${card.fact.slice(0, 80).toLowerCase()}`;
    if (seenFacts.has(k)) continue;
    seenFacts.add(k);
    deduped.push(card);
  }
  return { triggered: true, reason: primarySearchReason(triggers), triggers, queries, cards: deduped.slice(0, options.maxCards ?? 8), errors };
}

async function searxngSearch(query: SearchQuery, baseUrl: string, fetchHtml?: (url: string) => Promise<string | undefined>): Promise<SearchResultLike[]> {
  if (!baseUrl) return [];
  let url: URL;
  try { url = new URL(baseUrl); } catch { return []; }
  url.searchParams.set("q", `${query.text}${query.siteFilter ? ` site:${query.siteFilter}` : ""}`);
  url.searchParams.set("format", "json");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 4000);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) return [];
    const json = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (json.results ?? []).slice(0, 5).map((r) => ({
      url: r.url ?? "",
      title: r.title ?? r.url ?? "",
      content: r.content ?? "",
      purpose: query.purpose,
      query: query.text,
      packageOrLibrary: query.packageOrLibrary,
      version: query.version
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function officialAllowlistFetch(query: SearchQuery, fetchHtml: (url: string) => Promise<string | undefined>): Promise<SearchResultLike[]> {
  if (!query.siteFilter) return [];
  const url = `https://${query.siteFilter}`;
  const html = await fetchHtml(url);
  if (!html) return [];
  return [{ url, title: query.packageOrLibrary + " docs", content: html, purpose: query.purpose, query: query.text, packageOrLibrary: query.packageOrLibrary, version: query.version }];
}

function mockSearchForTest(query: SearchQuery, cwd: string): SearchResultLike[] {
  return [];
}

const WEB_EVIDENCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WEB_EVIDENCE_CACHE_VERSION = 1;

export interface WebEvidenceCacheEntry {
  schemaVersion: number;
  createdAt: string;
  query: string;
  packageOrLibrary: string;
  packageVersion?: string;
  domain?: string;
  cards: WebEvidenceCard[];
}

export function webEvidenceCacheDir(cwd: string): string {
  return join(cwd, ".cheater", "cache", "web-evidence");
}

export function webEvidenceCacheKey(query: string, pkg: string, version?: string, domain?: string): string {
  const normalized = `${pkg}::${version ?? ""}::${domain ?? ""}::${normalizeKeyText(query)}`;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function normalizeKeyText(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
}

export interface WebEvidenceCacheReadResult {
  hit: boolean;
  cards: WebEvidenceCard[];
  ageMs: number;
}

export function readWebEvidenceCache(cwd: string, key: string, ttlMs = WEB_EVIDENCE_CACHE_TTL_MS): WebEvidenceCacheReadResult {
  const path = join(webEvidenceCacheDir(cwd), `${key}.json`);
  if (!existsSync(path)) return { hit: false, cards: [], ageMs: Number.POSITIVE_INFINITY };
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as WebEvidenceCacheEntry;
    if (entry.schemaVersion !== WEB_EVIDENCE_CACHE_VERSION) return { hit: false, cards: [], ageMs: Number.POSITIVE_INFINITY };
    const ageMs = Date.now() - new Date(entry.createdAt).getTime();
    if (ageMs > ttlMs) return { hit: false, cards: [], ageMs };
    return { hit: true, cards: entry.cards ?? [], ageMs };
  } catch {
    return { hit: false, cards: [], ageMs: Number.POSITIVE_INFINITY };
  }
}

export function writeWebEvidenceCache(cwd: string, key: string, entry: Omit<WebEvidenceCacheEntry, "schemaVersion" | "createdAt">): void {
  try {
    const dir = webEvidenceCacheDir(cwd);
    mkdirSync(dir, { recursive: true });
    const full: WebEvidenceCacheEntry = { ...entry, schemaVersion: WEB_EVIDENCE_CACHE_VERSION, createdAt: new Date().toISOString() };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(full, null, 2), "utf8");
  } catch {
  }
}
