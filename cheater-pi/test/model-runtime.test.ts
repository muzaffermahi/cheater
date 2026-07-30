import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildLaunchPlan, classifyEndpoint, detectHardware, discoverLocalEndpoints, discoverRuntimeExecutables } from "../src/core/modelRuntime.js";

test("runtime classification recognizes common local endpoints", () => {
  assert.equal(classifyEndpoint("http://127.0.0.1:11434"), "ollama");
  assert.equal(classifyEndpoint("http://localhost:1234/v1"), "lm-studio");
  assert.equal(classifyEndpoint("http://localhost:8080/v1"), "openai-compatible");
});

test("managed launch plan keeps sidecar residency explicit", () => {
  const plan = buildLaunchPlan({ mainModel: "main.gguf", sidecarModel: "small.gguf", backend: "cuda", sidecarMode: "co-resident" });
  assert.deepEqual(plan.args.slice(0, 6), ["--model", "main.gguf", "--ctx-size", "16384", "--jinja", "--cont-batching"]);
  assert.ok(plan.args.includes("--model-draft"));
  assert.equal(plan.parallelSlots, 2);
});

test("hardware discovery is bounded and returns honest backend metadata", () => {
  const profile = detectHardware();
  assert.ok(profile.cpuCores >= 1);
  assert.ok(profile.ramBytes > 0);
  for (const gpu of profile.gpus) assert.ok(["cpu", "cuda", "vulkan", "unknown"].includes(gpu.backend));
});

test("runtime discovery is a bounded, non-shell lookup", () => {
  const found = discoverRuntimeExecutables();
  assert.ok(Array.isArray(found));
  assert.ok(found.length <= 8);
});

test("local endpoint discovery probes candidates in parallel and returns only reachable servers", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "ornith-1.0-35b" }, { id: "qwen3.5-2b" }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const found = await discoverLocalEndpoints([
      `http://127.0.0.1:${address.port}/v1`,
      "http://127.0.0.1:1/v1",
    ], 500);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].models, ["ornith-1.0-35b", "qwen3.5-2b"]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
