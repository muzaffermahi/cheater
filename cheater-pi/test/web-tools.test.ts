// web_search / web_fetch: the SSRF floor that never relaxes, the allowlist mode, the eval-leakage
// guard, redirect re-checking, output bounds, and the triple availability gate in the runner.

import test from "node:test";
import assert from "node:assert/strict";
import { hostAllowedOpenMode, makeWebTools, WEB_TOOL_NAMES } from "../src/core/webTools.js";
import type { ToolContext } from "../src/core/tools.js";
import { EFFORT_PROFILES } from "../src/core/effort.js";

const ctx: ToolContext = { cwd: process.cwd(), filesRead: new Set(), filesWritten: new Set() };

function fakeFetch(routes: Record<string, { status: number; location?: string; body?: string }>) {
  return async (url: string) => {
    const route = routes[url] ?? { status: 404 };
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      headers: { get: (name: string) => (name.toLowerCase() === "location" ? route.location ?? null : null) },
      text: async () => route.body ?? "",
    };
  };
}

test("the SSRF floor blocks every inward address, in every form", () => {
  const blocked = [
    "http://localhost/x", "http://api.localhost/x", "http://vault.internal/x", "http://printer.local/x",
    "http://127.0.0.1/x", "http://127.8.9.1/x", "http://10.0.0.5/x", "http://172.16.0.1/x", "http://172.31.255.255/x",
    "http://192.168.1.1/x", "http://169.254.169.254/latest/meta-data", "http://0.0.0.0/x",
    "http://[::1]/x", "http://[fc00::1]/x", "http://[fd12::3]/x", "http://[fe80::1]/x", "http://[::ffff:127.0.0.1]/x",
    "ftp://example.com/x", "file:///etc/passwd", "not a url",
  ];
  for (const url of blocked) assert.equal(hostAllowedOpenMode(url), false, `${url} must be blocked`);
  const allowed = ["https://example.com/docs", "http://172.15.0.1/x", "http://172.32.0.1/x", "https://8.8.8.8/x", "https://docs.python.org/3/"];
  for (const url of allowed) assert.equal(hostAllowedOpenMode(url), true, `${url} must be allowed`);
});

test("web_fetch re-checks the policy on every redirect hop (a 3xx cannot point inward)", async () => {
  const [, webFetch] = makeWebTools({
    mode: "open",
    fetchImpl: fakeFetch({
      "https://example.com/a": { status: 302, location: "http://169.254.169.254/latest/meta-data" },
    }),
  });
  const r = await webFetch.execute({ url: "https://example.com/a" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /SSRF floor/);
});

test("allowlist mode fetches doc hosts and refuses everything else; open mode fetches the web", async () => {
  const routes = {
    "https://docs.python.org/3/library/json.html": { status: 200, body: "<html><body>json — JSON encoder and decoder</body></html>" },
    "https://random-blog.example.com/post": { status: 200, body: "<html><body>a blog post</body></html>" },
  };
  const [, allowFetch] = makeWebTools({ mode: "allowlist", fetchImpl: fakeFetch(routes) });
  const okDoc = await allowFetch.execute({ url: "https://docs.python.org/3/library/json.html" }, ctx);
  assert.equal(okDoc.isError, false);
  assert.match(okDoc.output, /JSON encoder/);
  const refused = await allowFetch.execute({ url: "https://random-blog.example.com/post" }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.output, /allow-list/);
  const [, openFetch] = makeWebTools({ mode: "open", fetchImpl: fakeFetch(routes) });
  const blog = await openFetch.execute({ url: "https://random-blog.example.com/post" }, ctx);
  assert.equal(blog.isError, false);
  assert.match(blog.output, /blog post/);
  assert.match(blog.output, /do NOT copy verbatim/i);
});

test("web_search filters results per mode, bounds output, and reports what it filtered", async () => {
  const searchImpl = async () => [
    { title: "Python json docs", url: "https://docs.python.org/3/library/json.html" },
    { title: "Some blog", url: "https://blog.example.com/json" },
    { title: "Metadata", url: "http://169.254.169.254/latest" },
  ];
  const [allowSearch] = makeWebTools({ mode: "allowlist", searchImpl });
  const filtered = await allowSearch.execute({ query: "python json usage" }, ctx);
  assert.equal(filtered.isError, false);
  assert.match(filtered.output, /docs\.python\.org/);
  assert.ok(!/blog\.example\.com/.test(filtered.output), "off-list result filtered in allowlist mode");
  assert.match(filtered.output, /2 filtered/);
  const [openSearch] = makeWebTools({ mode: "open", searchImpl });
  const open = await openSearch.execute({ query: "python json usage" }, ctx);
  assert.match(open.output, /blog\.example\.com/, "open mode keeps public results");
  assert.ok(!/169\.254/.test(open.output), "the SSRF floor filters even search results");
  assert.ok(open.output.length <= 2000, "bounded output");
});

test("the eval-leakage guard refuses a query near-identical to a known eval task", async () => {
  const registry = { nearestEval: (q: string) => (q.includes("exact eval wording") ? { id: "swe-123", score: 0.9 } : null) } as never;
  const [search] = makeWebTools({ mode: "open", registry, searchImpl: async () => [{ title: "x", url: "https://example.com" }] });
  const refused = await search.execute({ query: "the exact eval wording of task 123" }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.output, /refused/);
  const fine = await search.execute({ query: "how does python json.dumps sort keys" }, ctx);
  assert.equal(fine.isError, false);
});

test("mode off yields no tools; the profiles gate availability by effort", () => {
  assert.deepEqual(makeWebTools({ mode: "off" }), []);
  assert.deepEqual(WEB_TOOL_NAMES, ["web_search", "web_fetch"]);
  assert.equal(EFFORT_PROFILES.fast.webEnabled, false, "fast never offers web");
  assert.equal(EFFORT_PROFILES["think-hard"].webEnabled, true);
});
