// Kitten Core — web_search / web_fetch as REAL tools the model can call. NO Pi.
//
// The webAugment module looks things up FOR the model (harness-driven repair seeds); these tools let
// the model decide to look something up itself — "search the web if it doesn't know something". Three
// access modes, switchable in settings (`webAccess`):
//   "open"      — any http(s) host (the product default, per the user's explicit choice), behind a
//                 NON-NEGOTIABLE SSRF floor: no loopback/private/link-local/ULA addresses, no
//                 localhost/.internal names, checked again on EVERY redirect hop.
//   "allowlist" — only the reference-doc hosts webAugment trusts (ALLOW_DOMAINS).
//   "off"       — the tools are not offered at all.
// The eval-leakage guard is kept regardless of mode: a search query near-identical to a known eval
// task's text is refused (reference knowledge is fine; looking up the answer sheet is not).
//
// Availability is triple-gated in the runner: settings.webAccess ≠ off AND the effort profile enables
// web AND the agent's permission.web ≠ deny (subagents default deny).

import type { Tool, ToolResult } from "./tools.js";
import { ALLOW_DOMAINS, domainAllowed, htmlToText, defaultSearchImpl, type SearchImpl, type SearchResult } from "./webAugment.js";
import { defaultRegistry, type EvalRegistry } from "./disjointness.js";

export type WebAccessMode = "allowlist" | "open" | "off";

const FETCH_DEFAULT_CHARS = 4000;
const FETCH_MAX_CHARS = 8000;
const SEARCH_MAX_CHARS = 2000;
const MAX_REDIRECT_HOPS = 4;

/**
 * The SSRF floor. Never relaxes, in any mode: http(s) only, and no address that could reach the
 * user's own machine or network (loopback, RFC1918, link-local/metadata, IPv6 ULA/link-local,
 * localhost and *.internal names). Literal-address level — a public DNS name is allowed on the open
 * web by design; this floor is about the model never being able to point a fetch INWARD.
 */
export function hostAllowedOpenMode(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  // IPv6 literals.
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return false;
    if (/^(fc|fd)/i.test(host)) return false;      // ULA fc00::/7
    if (/^fe[89ab]/i.test(host)) return false;      // link-local fe80::/10
    // v4-mapped (::ffff:a.b.c.d — which Node may normalize to hex, e.g. ::ffff:7f00:1): the mapped
    // address could be anything private, and no legitimate public site is reached this way. Block all.
    if (/^::ffff:/i.test(host)) return false;
    return true;
  }
  // IPv4 literals.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;       // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;                     // multicast/reserved
  }
  return true;
}

function urlAllowed(url: string, mode: WebAccessMode): { ok: boolean; reason?: string } {
  if (!hostAllowedOpenMode(url)) return { ok: false, reason: "blocked: the address is local/private (SSRF floor)" };
  if (mode === "allowlist" && !domainAllowed(url)) return { ok: false, reason: `blocked: host not on the reference-docs allow-list (${ALLOW_DOMAINS.slice(0, 4).join(", ")}, …)` };
  return { ok: true };
}

export interface WebToolsOpts {
  mode: WebAccessMode;
  /** Anti-leakage registry; defaults to the standard one. */
  registry?: EvalRegistry;
  /** Injectable transports so tests never hit the network. */
  searchImpl?: SearchImpl;
  fetchImpl?: (url: string, init: { redirect: "manual"; headers: Record<string, string> }) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;
}

/** Build the web tools for a mode. `[]` when the mode is "off". */
export function makeWebTools(opts: WebToolsOpts): Tool[] {
  if (opts.mode === "off") return [];
  const mode = opts.mode;
  const registry = opts.registry ?? safeDefaultRegistry();
  const search = opts.searchImpl ?? defaultSearchImpl;
  const doFetch = opts.fetchImpl ?? ((url: string, init: { redirect: "manual"; headers: Record<string, string> }) => fetch(url, init));

  const webSearch: Tool = {
    schema: {
      name: "web_search",
      description: "Search the web. Use when you need current documentation, an unfamiliar API, or an error message you cannot resolve from the repository alone. Returns result titles and URLs; follow up with web_fetch to read a page.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, max_results: { type: "integer", description: "optional, 1-8, default 5" } },
        required: ["query"],
      },
    },
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? "").trim();
      if (!query) return { output: "web_search: empty query", isError: true };
      // Anti-leakage: reference knowledge is fine; an eval task's own text is not something we look up.
      const near = registry?.nearestEval(query);
      if (near && near.score >= 0.6) {
        return { output: "web_search: refused — this query is near-identical to a known evaluation task; solve it from the repository instead.", isError: true, meta: { refused: true } };
      }
      const wanted = Math.max(1, Math.min(8, Number(args.max_results ?? 5) || 5));
      let results: SearchResult[];
      try { results = await search(query); } catch { results = []; }
      const eligible = results.filter((r) => urlAllowed(r.url, mode).ok);
      const filtered = results.length - eligible.length;
      if (!eligible.length) return { output: `web_search: no results${filtered ? ` (${filtered} filtered by access policy)` : ""}. Try a different query.`, isError: false, meta: { query, filtered } };
      const lines = eligible.slice(0, wanted).map((r, i) => `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 160)}` : ""}`);
      const body = `Results for "${query}"${filtered ? ` (${filtered} filtered by access policy)` : ""}:\n${lines.join("\n")}`;
      return { output: body.slice(0, SEARCH_MAX_CHARS), isError: false, meta: { query, results: eligible.length, filtered } };
    },
  };

  const webFetch: Tool = {
    schema: {
      name: "web_fetch",
      description: "Fetch a web page as readable text (bounded). Use after web_search, or directly for a known documentation URL. Do not copy fetched content verbatim into the project.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, max_chars: { type: "integer", description: `optional, up to ${FETCH_MAX_CHARS}, default ${FETCH_DEFAULT_CHARS}` } },
        required: ["url"],
      },
    },
    async execute(args): Promise<ToolResult> {
      const url = String(args.url ?? "").trim();
      const maxChars = Math.max(400, Math.min(FETCH_MAX_CHARS, Number(args.max_chars ?? FETCH_DEFAULT_CHARS) || FETCH_DEFAULT_CHARS));
      let current = url;
      // Manual redirect walk with the policy re-checked on EVERY hop — a 3xx must never smuggle the
      // fetch to a private address or (in allowlist mode) off the list.
      for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
        const gate = urlAllowed(current, mode);
        if (!gate.ok) return { output: `web_fetch: ${gate.reason} (${current})`, isError: true, meta: { url: current, blocked: true } };
        let res;
        try {
          res = await doFetch(current, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (kitten web tool)" } });
        } catch (e) {
          return { output: `web_fetch: request failed (${e instanceof Error ? e.message : String(e)})`, isError: true, meta: { url: current } };
        }
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) return { output: "web_fetch: redirect without a location", isError: true, meta: { url: current } };
          try { current = new URL(loc, current).toString(); } catch { return { output: "web_fetch: unparseable redirect target", isError: true, meta: { url: current } }; }
          continue;
        }
        if (!res.ok) return { output: `web_fetch: HTTP ${res.status} for ${current}`, isError: true, meta: { url: current, status: res.status } };
        let text = "";
        try { text = htmlToText(await res.text(), maxChars); } catch { /* body unreadable */ }
        if (!text) return { output: `web_fetch: the page at ${current} had no readable text`, isError: true, meta: { url: current } };
        return {
          output: `[${safeHost(current)}] ${text}\n(Reference material — apply it yourself; do NOT copy verbatim.)`,
          isError: false,
          meta: { url: current, bytes: text.length, hops: hop },
        };
      }
      return { output: "web_fetch: too many redirects", isError: true, meta: { url } };
    },
  };

  return [webSearch, webFetch];
}

export const WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const;

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}

function safeDefaultRegistry(): EvalRegistry | undefined {
  try { return defaultRegistry(process.env.KITTEN_SWE_MANIFEST); } catch { return undefined; }
}
