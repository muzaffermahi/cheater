import test from "node:test";
import assert from "node:assert/strict";
import {
  decideTrigger, domainAllowed, htmlToText, WebAugmentor, webAugmentReceiptLines, defaultFetchTextImpl,
  type SearchResult
} from "../src/core/webAugment.js";
import { EvalRegistry } from "../src/core/disjointness.js";

test("decideTrigger: error trigger fires only AFTER a repair round, never on the first attempt", () => {
  assert.equal(decideTrigger({ repairRound: 0, errorSignature: "ModuleNotFoundError: no module named foo" }), null);
  const t = decideTrigger({ repairRound: 1, errorSignature: "ModuleNotFoundError: no module named foo" });
  assert.ok(t && t.kind === "unresolved-error");
});

test("decideTrigger: unresolved symbol and external spec triggers", () => {
  const sym = decideTrigger({ repairRound: 0, unresolvedSymbols: ["itertools.pairwise"], symbolHint: "python" });
  assert.ok(sym && sym.kind === "unresolved-symbol" && sym.query === "itertools.pairwise");
  const spec = decideTrigger({ repairRound: 0, externalApiHints: ["OpenWeatherMap API"] });
  assert.ok(spec && spec.kind === "external-spec");
});

test("decideTrigger: offline suppresses everything", () => {
  assert.equal(decideTrigger({ repairRound: 2, errorSignature: "boom boom boom", offline: true }), null);
});

test("defaultFetchTextImpl never follows a redirect to an off-allow-list host (SSRF guard)", async () => {
  // Regression: fetch defaulted to redirect:"follow", so an allow-listed URL that 3xx-redirected to an
  // off-list host (or 169.254.169.254) had that host's body fetched and injected into the model brief.
  const realFetch = (globalThis as { fetch?: unknown }).fetch;
  const fetchedHosts: string[] = [];
  (globalThis as any).fetch = async (u: string, init: { redirect?: string }) => {
    const host = new URL(u).host;
    fetchedHosts.push(host);
    if (host === "docs.python.org") {
      // Simulate a redirect to an internal metadata address.
      return { status: 302, ok: false, headers: { get: (h: string) => (h.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null) }, text: async () => "" };
    }
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => "SECRET-METADATA" };
  };
  try {
    const body = await defaultFetchTextImpl("https://docs.python.org/3/library/json.html");
    assert.equal(body, null, "the off-list redirect target's body must not be returned");
    assert.ok(!fetchedHosts.includes("169.254.169.254"), "the off-list host must never be fetched");
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("domainAllowed enforces the allow-list, subdomain-safe", () => {
  assert.equal(domainAllowed("https://docs.python.org/3/library/json.html"), true);
  assert.equal(domainAllowed("https://numpy.readthedocs.io/en/stable/x.html"), true, "subdomain of an allowed domain");
  assert.equal(domainAllowed("https://stackoverflow.com/questions/123"), true);
  assert.equal(domainAllowed("https://evil.example.com/leak"), false);
  assert.equal(domainAllowed("not a url"), false);
});

test("htmlToText strips tags/scripts and bounds length", () => {
  const html = "<html><script>bad()</script><body><h1>Title</h1><p>Hello &amp; world</p></body></html>";
  const text = htmlToText(html, 100);
  assert.match(text, /Title Hello & world/);
  assert.ok(!/script|bad\(\)/.test(text), "script content removed");
  assert.ok(htmlToText("x".repeat(500), 50).length <= 52 + 2);
});

test("augment: searches, filters to allow-listed results, fetches, and records receipts", async () => {
  const search = async (): Promise<SearchResult[]> => [
    { title: "evil", url: "https://evil.example.com/answer" },       // dropped (not allow-listed)
    { title: "SO", url: "https://stackoverflow.com/questions/42" },  // kept
    { title: "docs", url: "https://docs.python.org/3/library/json.html" } // kept
  ];
  const fetchText = async (url: string): Promise<string> =>
    url.includes("stackoverflow") ? "<p>Use json.loads to parse</p>" : "<p>json module reference</p>";
  const aug = new WebAugmentor({ searchImpl: search, fetchTextImpl: fetchText, maxFetches: 2 });
  const brief = await aug.augment({ kind: "unresolved-error", query: "json.decoder.JSONDecodeError expecting value" });
  assert.ok(brief && brief.brief.length > 0);
  assert.equal(brief!.fetches.length, 2, "only the two allow-listed results were fetched");
  assert.ok(brief!.fetches.every((f) => f.domain === "stackoverflow.com" || f.domain === "docs.python.org"));
  assert.match(brief!.brief, /json/);
  assert.ok(!/evil/.test(brief!.brief), "non-allow-listed content never enters the brief");
});

test("augment: REFUSES a query near-identical to an eval task's text (anti-leakage)", async () => {
  const reg = new EvalRegistry();
  const evalText = "implement a metacircular evaluator for a scheme-like language supporting lambda let and define";
  reg.register("tb2", ["schemelike-metacircular-eval"], { "schemelike-metacircular-eval": evalText });
  const search = async (): Promise<SearchResult[]> => [{ title: "x", url: "https://docs.python.org/x.html" }];
  const aug = new WebAugmentor({ searchImpl: search, fetchTextImpl: async () => "should not be reached", registry: reg });
  const brief = await aug.augment({ kind: "external-spec", query: evalText });
  assert.ok(brief && brief.refusedReason && /refused/.test(brief.refusedReason), "eval-task-text query is refused");
  assert.equal(brief!.fetches.length, 0, "nothing was fetched for a refused query");
});

test("augment: offline (no impls) degrades gracefully, never throws", async () => {
  const aug = new WebAugmentor({});
  assert.equal(aug.available(), false);
  const brief = await aug.augment({ kind: "unresolved-error", query: "some error" });
  // No search + no direct URL => nothing to fetch.
  assert.ok(brief === null || brief.brief === "");
});

test("webAugmentReceiptLines renders a compact audit line", () => {
  const lines = webAugmentReceiptLines({
    trigger: { kind: "unresolved-error", query: "TypeError x" },
    brief: "ref", fetches: [{ url: "https://stackoverflow.com/q", domain: "stackoverflow.com", ok: true, bytes: 40 }]
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /web-augment: unresolved-error.*stackoverflow\.com/);
});
