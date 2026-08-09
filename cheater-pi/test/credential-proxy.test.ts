import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("credential proxy strips caller secrets and preserves SSE chunks", async () => {
  let seen: { authorization?: string; key?: string } | undefined;
  const upstream = http.createServer((req, res) => {
    seen = { authorization: req.headers.authorization, key: req.headers["x-api-key"] as string | undefined };
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: one\n\n"); setTimeout(() => res.end("data: [DONE]\n\n"), 5); });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  // The proxy is an intentionally dependency-free benchmark script, kept outside the product API.
  const { createCredentialProxy } = await import(pathToFileURL(resolve(process.cwd(), "scripts/credential-proxy.mjs")).href);
  const proxy = createCredentialProxy({ upstream: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "super-secret", listenPort: 0 });
  const address = await proxy.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer caller-secret", "x-api-key": "caller-secret" }, body: "{}" });
    assert.equal(await response.text(), "data: one\n\ndata: [DONE]\n\n");
    assert.equal(seen?.authorization, "Bearer super-secret");
    assert.equal(seen?.key, undefined);
  } finally { await proxy.close(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
});
