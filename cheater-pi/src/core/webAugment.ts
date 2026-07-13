// Kitten Ascent A2 — "screw it, look it up". The kitten that googles the error is the kitten that
// fixes it: on an unknown error or unfamiliar API, a real dev's first move is to search. This is the
// most real-world-reflective coverage lever, and the user explicitly greenlit web access — so we use
// it, but disciplined by three hard rules so it stays on the RIGHT side of the benchmaxx line:
//
//   1. Triggers only (never speculative browsing):
//        (a) an unresolved ERROR signature AFTER ≥1 repair round → search the exact error text.
//        (b) a SYMBOL/API the noun/import gate couldn't resolve and the model is guessing at → fetch
//            the library's real doc/signature.
//        (c) a from-scratch task naming an external API/PROTOCOL → fetch the spec, before implementing.
//   2. Reference knowledge only: docs, error explanations, API signatures — injected as a bounded
//        brief. NEVER fetch or paste a solution to the benchmark task itself. Domain allow-list; and
//        the disjointness firewall refuses any query that is (near-)identical to an eval task's text.
//   3. Every fetch is logged into receipts, so any benchmark run is auditable for what it looked at.
//
// Search + fetch are injected (fetchImpl / searchImpl), so tests never hit the network and the whole
// module degrades to null offline. Nothing here ever throws into a run.

import { EvalRegistry } from "./disjointness.js";

export type WebTriggerKind = "unresolved-error" | "unresolved-symbol" | "external-spec";

export interface WebTrigger {
  kind: WebTriggerKind;
  /** The exact text to search/fetch for — an error signature, a symbol, or an API name. */
  query: string;
  /** Optional library/language hint that lets us build a direct doc URL. */
  hint?: string;
}

export interface WebAugmentContext {
  /** 0 = first attempt (error-triggered augmentation is suppressed); ≥1 = a repair round. */
  repairRound: number;
  /** Exact error/exception text from the failing run, if any. */
  errorSignature?: string;
  /** Symbols the noun/import gate could not resolve (the model is guessing at their API). */
  unresolvedSymbols?: string[];
  /** Library hint for the unresolved symbol (e.g. "python", "numpy"). */
  symbolHint?: string;
  /** External API/protocol names a from-scratch task references. */
  externalApiHints?: string[];
  offline?: boolean;
}

/** Decide whether a trigger fires, and what to look up. Returns null when no trigger applies. */
export function decideTrigger(ctx: WebAugmentContext): WebTrigger | null {
  if (ctx.offline) return null;
  // (a) unresolved error, but only after we've actually tried and failed at least once.
  if (ctx.repairRound >= 1 && ctx.errorSignature && ctx.errorSignature.trim().length > 8) {
    return { kind: "unresolved-error", query: ctx.errorSignature.trim().slice(0, 200) };
  }
  // (b) a symbol/API the gates couldn't resolve.
  if (ctx.unresolvedSymbols?.length) {
    return { kind: "unresolved-symbol", query: ctx.unresolvedSymbols[0], hint: ctx.symbolHint };
  }
  // (c) a from-scratch task naming an external spec — fetch it up front (round 0 only).
  if (ctx.repairRound === 0 && ctx.externalApiHints?.length) {
    return { kind: "external-spec", query: ctx.externalApiHints[0] };
  }
  return null;
}

// Reference-knowledge domains only: language/library docs, Q&A, and issue trackers. A search-engine
// transport is used to FIND pages, but only results on this list are ever fetched.
export const ALLOW_DOMAINS = [
  "docs.python.org", "docs.pytest.org", "pypi.org", "readthedocs.io",
  "developer.mozilla.org", "nodejs.org", "npmjs.com",
  "doc.rust-lang.org", "docs.rs", "pkg.go.dev", "go.dev",
  "en.cppreference.com", "cplusplus.com", "docs.oracle.com",
  "stackoverflow.com", "stackexchange.com", "github.com", "raw.githubusercontent.com",
  "man7.org", "linux.die.net"
];

/** Host is on the allow-list (subdomain-safe: sub.readthedocs.io matches readthedocs.io). */
export function domainAllowed(url: string): boolean {
  let host: string;
  try { host = new URL(url).host.toLowerCase(); } catch { return false; }
  return ALLOW_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

export interface SearchResult { title: string; url: string; snippet?: string; }
export type SearchImpl = (query: string) => Promise<SearchResult[]>;
export type FetchTextImpl = (url: string) => Promise<string | null>;

export interface WebFetchReceipt { url: string; domain: string; ok: boolean; bytes: number; }
export interface WebBrief {
  trigger: WebTrigger;
  brief: string;
  fetches: WebFetchReceipt[];
  refusedReason?: string;
}

/** Strip HTML to a bounded plain-text brief. */
export function htmlToText(html: string, maxChars: number): string {
  const text = (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars) + " …";
}

export interface WebAugmentorOpts {
  searchImpl?: SearchImpl;
  fetchTextImpl?: FetchTextImpl;
  /** The eval registry — a query near-identical to an eval task's text is REFUSED (anti-leakage). */
  registry?: EvalRegistry;
  maxBriefChars?: number;
  maxFetches?: number;
}

/**
 * Runs a trigger: (optionally) search, filter results to the allow-list, fetch the top pages, and
 * assemble a bounded reference brief with full fetch receipts. Never throws; returns null when nothing
 * usable was found (offline, no allow-listed result, or refused by the disjointness guard).
 */
export class WebAugmentor {
  private search: SearchImpl | null;
  private fetchText: FetchTextImpl | null;
  private registry?: EvalRegistry;
  private maxBriefChars: number;
  private maxFetches: number;

  constructor(opts: WebAugmentorOpts = {}) {
    this.search = opts.searchImpl ?? null;
    this.fetchText = opts.fetchTextImpl ?? null;
    this.registry = opts.registry;
    this.maxBriefChars = opts.maxBriefChars ?? 1200;
    this.maxFetches = opts.maxFetches ?? 2;
  }

  available(): boolean {
    return !!(this.search || this.fetchText);
  }

  /** Direct documentation URL for a stdlib symbol when we can construct one without searching. */
  private directDocUrl(trigger: WebTrigger): string | null {
    const hint = (trigger.hint ?? "").toLowerCase();
    const sym = trigger.query;
    if ((hint === "python" || /^[a-z_][a-z0-9_.]*$/i.test(sym)) && trigger.kind !== "unresolved-error") {
      const mod = sym.split(".")[0];
      if (/^[a-z_][a-z0-9_]*$/.test(mod)) return `https://docs.python.org/3/library/${mod}.html`;
    }
    return null;
  }

  async augment(trigger: WebTrigger): Promise<WebBrief | null> {
    // Anti-leakage: refuse a query that is (near-)identical to an eval task's text. Reference knowledge
    // about a class of problem is fine; the eval task's own text is not something we look up.
    if (this.registry) {
      const near = this.registry.nearestEval(trigger.query);
      if (near && near.score >= 0.6) {
        return { trigger, brief: "", fetches: [], refusedReason: `query too close to eval task ${near.id} (${near.score.toFixed(2)}) — refused` };
      }
    }

    const fetches: WebFetchReceipt[] = [];
    const urls: string[] = [];
    const direct = this.directDocUrl(trigger);
    if (direct && domainAllowed(direct)) urls.push(direct);

    if (this.search && urls.length < this.maxFetches) {
      let results: SearchResult[] = [];
      try { results = await this.search(this.buildSearchQuery(trigger)); } catch { results = []; }
      for (const r of results) {
        if (urls.length >= this.maxFetches) break;
        if (domainAllowed(r.url) && !urls.includes(r.url)) urls.push(r.url);
      }
    }
    if (!urls.length || !this.fetchText) {
      return urls.length ? null : { trigger, brief: "", fetches, refusedReason: "no allow-listed result / offline" };
    }

    const chunks: string[] = [];
    for (const url of urls.slice(0, this.maxFetches)) {
      let html: string | null = null;
      try { html = await this.fetchText(url); } catch { html = null; }
      const domain = safeHost(url);
      if (!html) { fetches.push({ url, domain, ok: false, bytes: 0 }); continue; }
      fetches.push({ url, domain, ok: true, bytes: html.length });
      chunks.push(`[${domain}] ${htmlToText(html, Math.floor(this.maxBriefChars / this.maxFetches))}`);
    }
    if (!chunks.length) return { trigger, brief: "", fetches, refusedReason: "all fetches failed" };

    const label = trigger.kind === "unresolved-error" ? "Reference (error looked up)" :
      trigger.kind === "unresolved-symbol" ? "Reference (API doc)" : "Reference (external spec)";
    const brief = `${label} — general knowledge, apply it yourself; do NOT copy verbatim:\n${chunks.join("\n").slice(0, this.maxBriefChars)}`;
    return { trigger, brief, fetches };
  }

  private buildSearchQuery(trigger: WebTrigger): string {
    if (trigger.kind === "unresolved-error") return trigger.query;
    if (trigger.kind === "unresolved-symbol") return `${trigger.hint ? trigger.hint + " " : ""}${trigger.query} documentation`;
    return `${trigger.query} specification reference`;
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}

// ── Real transport (opt-in; network, so never exercised in tests) ────────────────────────────────
// A keyless DuckDuckGo-lite search + a plain fetch, each fully defensive: any failure yields []/null so
// the augmentor degrades to offline. A user with a keyed search API can inject their own SearchImpl.

const DDG_LITE = "https://lite.duckduckgo.com/lite/?q=";

/** Keyless search over DuckDuckGo lite HTML. Returns [] on any failure (offline-safe). */
export const defaultSearchImpl: SearchImpl = async (query: string): Promise<SearchResult[]> => {
  try {
    const res = await (globalThis as any).fetch(DDG_LITE + encodeURIComponent(query), {
      headers: { "user-agent": "Mozilla/5.0 (kitten-ascent web-augment)" }
    });
    if (!res.ok) return [];
    const html: string = await res.text();
    const out: SearchResult[] = [];
    const re = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < 10) {
      let url = m[1];
      // DDG lite wraps external links in a redirect; pull the uddg= target when present.
      const wrapped = url.match(/[?&]uddg=([^&]+)/);
      if (wrapped) { try { url = decodeURIComponent(wrapped[1]); } catch { /* keep raw */ } }
      if (/^https?:\/\//.test(url)) out.push({ title: htmlToText(m[2], 120), url });
    }
    return out;
  } catch {
    return [];
  }
};

/** Plain page fetch, allow-list enforced at the call site AND on every redirect hop. Returns null on any
 *  failure. Redirects are followed MANUALLY so a 3xx to an off-allow-list host (or an internal address
 *  like 169.254.169.254) can't be followed and its body injected into the model brief (SSRF-lite). */
export const defaultFetchTextImpl: FetchTextImpl = async (url: string): Promise<string | null> => {
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!domainAllowed(current)) return null; // re-check every hop, not just the initial call site
      const res = await (globalThis as any).fetch(current, { headers: { "user-agent": "Mozilla/5.0 (kitten-ascent web-augment)" }, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current).toString(); // resolve a relative Location against the current URL
        continue;
      }
      if (!res.ok) return null;
      return await res.text();
    }
    return null; // too many redirects
  } catch {
    return null;
  }
};

/** A ready-to-use augmentor with the real transport + the disjointness registry. */
export function defaultWebAugmentor(registry?: EvalRegistry): WebAugmentor {
  return new WebAugmentor({ searchImpl: defaultSearchImpl, fetchTextImpl: defaultFetchTextImpl, registry });
}

/** Render web-augment receipts for the run log. */
export function webAugmentReceiptLines(brief: WebBrief | null): string[] {
  if (!brief) return [];
  if (brief.refusedReason) return [`web-augment: ${brief.trigger.kind} refused (${brief.refusedReason})`];
  const ok = brief.fetches.filter((f) => f.ok);
  return [`web-augment: ${brief.trigger.kind} "${brief.trigger.query.slice(0, 60)}" → ${ok.length} page(s): ${ok.map((f) => f.domain).join(", ")}`];
}
