#!/usr/bin/env node
/**
 * Small streaming OpenAI-compatible proxy for benchmark containers.
 *
 * The secret exists only in this process. Incoming Authorization/x-api-key headers are discarded,
 * request and response bodies are piped without buffering, and diagnostics never include headers.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { pathToFileURL } from "node:url";

function joinPath(basePath, requestPath) {
  const base = basePath.replace(/\/$/, "");
  const req = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  if (base && (req === base || req.startsWith(`${base}/`))) return req;
  // OpenAI clients send /v1/... even when the upstream compatible endpoint is nested under a
  // deployment prefix such as /compatible-mode/v1. Preserve that prefix without duplicating /v1.
  if (base.endsWith("/v1") && (req === "/v1" || req.startsWith("/v1/"))) return `${base}${req.slice(3)}`;
  return `${base}${req}` || "/";
}

export function createCredentialProxy({ upstream, apiKey, listenHost = "127.0.0.1", listenPort = 0, server = http } = {}) {
  if (!upstream) throw new Error("MODEL_UPSTREAM is required");
  if (!apiKey) throw new Error("MODEL_API_KEY is required");
  const target = new URL(upstream);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("MODEL_UPSTREAM must use http or https");
  const transport = target.protocol === "https:" ? https : http;
  const proxy = server.createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers["x-api-key"];
    delete headers.host;
    headers.authorization = `Bearer ${apiKey}`;
    headers.host = target.host;
    const request = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path: joinPath(target.pathname, req.url || "/"), headers }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    request.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      if (!res.writableEnded) res.end('{"error":"upstream unavailable"}');
    });
    req.on("aborted", () => request.destroy());
    req.pipe(request);
  });
  return {
    server: proxy,
    listen: () => new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(listenPort, listenHost, () => {
        proxy.off("error", reject);
        const address = proxy.address();
        resolve({ host: listenHost, port: typeof address === "object" && address ? address.port : listenPort });
      });
    }),
    close: () => new Promise((resolve) => proxy.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = createCredentialProxy({
    upstream: process.env.MODEL_UPSTREAM,
    apiKey: process.env.MODEL_API_KEY,
    listenHost: process.env.MODEL_LISTEN_HOST || "127.0.0.1",
    listenPort: Number(process.env.MODEL_LISTEN_PORT || 11435),
  });
  const address = await proxy.listen();
  process.stdout.write(`credential proxy listening on ${address.host}:${address.port}\n`);
  const stop = async () => { await proxy.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
