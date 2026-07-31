import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoSizeContextTokens, buildLaunchPlan, classifyEndpoint, cleanRuntimeLog, CTX_LADDER, detectHardware, discoverLocalEndpoints, discoverRuntimeExecutables, kvBytesPerToken, listModelFiles, probeEndpoint, readGgufKvMeta, runtimeFailureReason, splitExtraArgs } from "../src/core/modelRuntime.js";

test("runtime classification recognizes common local endpoints", () => {
  assert.equal(classifyEndpoint("http://127.0.0.1:11434"), "ollama");
  assert.equal(classifyEndpoint("http://localhost:1234/v1"), "lm-studio");
  assert.equal(classifyEndpoint("http://localhost:8080/v1"), "openai-compatible");
});

test("managed launch plan keeps sidecar residency explicit", () => {
  const plan = buildLaunchPlan({ mainModel: "main.gguf", sidecarModel: "small.gguf", backend: "cuda", sidecarMode: "co-resident", contextTokens: 16384 });
  assert.deepEqual(plan.args.slice(0, 6), ["--model", "main.gguf", "--ctx-size", "16384", "--jinja", "--cont-batching"]);
  assert.equal(plan.contextSource, "explicit");
  assert.ok(plan.args.includes("--model-draft"));
  assert.equal(plan.parallelSlots, 2);
});

// ── context auto-sizing (E7) ────────────────────────────────────────────────────────────────────

/** A minimal valid GGUF v3 header carrying exactly the KV-geometry metadata the reader wants. */
function writeSyntheticGguf(path: string, arch = "llama", blocks = 48, heads = 40, kvHeads = 8, embed = 5120): void {
  const parts: Buffer[] = [];
  const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s: string): Buffer => Buffer.concat([u64(s.length), Buffer.from(s, "utf8")]);
  const kvString = (key: string, value: string): Buffer => Buffer.concat([str(key), u32(8), str(value)]);
  const kvU32 = (key: string, value: number): Buffer => Buffer.concat([str(key), u32(4), u32(value)]);
  parts.push(Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(5));
  parts.push(kvString("general.architecture", arch));
  parts.push(kvU32(`${arch}.block_count`, blocks));
  parts.push(kvU32(`${arch}.attention.head_count`, heads));
  parts.push(kvU32(`${arch}.attention.head_count_kv`, kvHeads));
  parts.push(kvU32(`${arch}.embedding_length`, embed));
  writeFileSync(path, Buffer.concat(parts));
}

test("readGgufKvMeta parses a real header and kvBytesPerToken prices q8_0 correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-gguf-"));
  const path = join(dir, "m.gguf");
  writeSyntheticGguf(path);
  const meta = readGgufKvMeta(path);
  assert.ok(meta, "header parsed");
  assert.equal(meta!.architecture, "llama");
  assert.equal(meta!.blockCount, 48);
  assert.equal(meta!.headCountKv, 8);
  // headDim = 5120/40 = 128; 2 · 48 · 128 · 8 · 1.0625 = 104448 bytes/token
  assert.equal(Math.round(kvBytesPerToken(meta!)), 104448);
  // Garbage in → null out, never a throw.
  const bad = join(dir, "bad.gguf");
  writeFileSync(bad, Buffer.from("not a gguf at all"));
  assert.equal(readGgufKvMeta(bad), null);
  assert.equal(readGgufKvMeta(join(dir, "missing.gguf")), null);
});

test("autoSizeContextTokens picks the largest ladder rung the free VRAM affords", () => {
  // The measured box: 8 GB card, 24.7 GB MoE → cpu-moe residency, heuristic pricing (no gguf file).
  const moe = autoSizeContextTokens({ modelBytes: 24.7e9, vramBytes: 8e9 });
  assert.equal(moe.contextTokens, 16384, moe.reason);
  // Same box but with the real GGUF geometry (cheaper per token) → one rung higher.
  const dir = mkdtempSync(join(tmpdir(), "kitten-gguf-size-"));
  const path = join(dir, "m.gguf");
  writeSyntheticGguf(path);
  const withMeta = autoSizeContextTokens({ modelPath: path, modelBytes: 24.7e9, vramBytes: 8e9 });
  assert.equal(withMeta.contextTokens, 24576, withMeta.reason);
  assert.match(withMeta.reason, /GGUF geometry/);
  // A 24 GB card with a fully-resident 20 GB model: little free → floor rung, never below.
  const tight = autoSizeContextTokens({ modelBytes: 20e9, vramBytes: 24e9 });
  assert.ok((CTX_LADDER as readonly number[]).includes(tight.contextTokens));
  // No VRAM reading at all → the conservative default, honestly labeled.
  const blind = autoSizeContextTokens({ modelBytes: 24.7e9 });
  assert.equal(blind.contextTokens, 16384);
  assert.match(blind.reason, /no VRAM/);
});

test("buildLaunchPlan auto-sizes when no context is pinned, and says so", () => {
  const auto = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9 });
  assert.equal(auto.contextSource, "auto");
  assert.equal(auto.contextTokens, 16384);
  assert.ok(auto.warnings.some((w) => /ctx auto-sized/.test(w)), "the sizing reason is in the warnings");
  const i = auto.args.indexOf("--ctx-size");
  assert.equal(auto.args[i + 1], "16384");
  const pinned = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 8192 });
  assert.equal(pinned.contextSource, "explicit");
  assert.equal(pinned.contextTokens, 8192);
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

// ── user runtime tuning ─────────────────────────────────────────────────────────────────────────

test("tuning overrides beat every heuristic: cpuMoe off, explicit gpu layers, f16 cache, extra args last", () => {
  // The 7-vs-30 tok/s case: same oversized MoE, but the user says NO cpu-moe and pins their layers.
  const tuned = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 32768,
    tuning: { cpuMoe: "off", gpuLayers: 28, kvCacheType: "f16", extraArgs: "--threads 12 --override-tensor \"exps=CPU\"" },
  });
  assert.ok(!tuned.args.includes("--cpu-moe"), "cpuMoe off wins over the VRAM heuristic");
  assert.ok(!tuned.args.includes("--no-mmap"));
  const ngl = tuned.args.indexOf("--n-gpu-layers");
  assert.equal(tuned.args[ngl + 1], "28", "explicit layer count passed verbatim");
  const kv = tuned.args.indexOf("--cache-type-k");
  assert.equal(tuned.args[kv + 1], "f16");
  assert.deepEqual(tuned.args.slice(-4), ["--threads", "12", "--override-tensor", "exps=CPU"], "extra args land at the end (last wins), quoted tokens whole");
  // Forcing cpuMoe on works even when the heuristic would not fire.
  const forced = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 48e9, modelBytes: 8e9, contextTokens: 16384, tuning: { cpuMoe: "on" } });
  assert.ok(forced.args.includes("--cpu-moe"));
  // gpuLayers 0 = CPU load: no flash-attn either (auto follows the device).
  const cpuLoad = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 2e9, contextTokens: 8192, tuning: { gpuLayers: 0 } });
  assert.equal(cpuLoad.args[cpuLoad.args.indexOf("--n-gpu-layers") + 1], "0");
  assert.ok(!cpuLoad.args.includes("--flash-attn"), "auto flash-attn stays off for a 0-layer load");
});

test("the plan only emits flags the target build advertises, and prefers --load-mode over deprecated --no-mmap", () => {
  // A modern build: has both spellings. The deprecated one must NOT be used (that is the wall of
  // "DEPRECATED: --mmap and --no-mmap" noise a real launch drowned in).
  const modern = new Set(["--model", "--ctx-size", "--jinja", "--cont-batching", "--n-gpu-layers", "--flash-attn", "--cache-type-k", "--cache-type-v", "--cpu-moe", "--no-mmap", "--load-mode", "--slot-prompt-similarity", "--spec-type"]);
  const plan = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 32768,
    supportedFlags: modern, supportedFlagsHelp: "-fa, --flash-attn [on|off|auto] set Flash Attention use",
  });
  assert.ok(plan.args.includes("--cpu-moe"));
  assert.ok(!plan.args.includes("--no-mmap"), "the deprecated spelling is avoided when --load-mode exists");
  // `none` is llama.cpp's documented "no special loading mode" — the modern spelling of --no-mmap.
  // A wrong value here makes llama-server print usage and exit, which a live launch proved.
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--load-mode"), plan.args.indexOf("--load-mode") + 2), ["--load-mode", "none"]);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--flash-attn"), plan.args.indexOf("--flash-attn") + 2), ["--flash-attn", "on"], "valued form for a build documenting [on|off|auto]");

  // An older/minimal build: unknown flags are skipped with an explicit warning rather than emitted.
  const minimal = new Set(["--model", "--ctx-size", "--n-gpu-layers", "--no-mmap", "--cpu-moe"]);
  const lean = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 8192, supportedFlags: minimal });
  assert.ok(!lean.args.includes("--spec-type"), "a flag this build lacks is never passed");
  assert.ok(!lean.args.includes("--cache-type-k"));
  assert.ok(!lean.args.includes("--jinja"));
  assert.ok(lean.args.includes("--no-mmap"), "the old spelling is still used where it is the only one");
  assert.ok(lean.warnings.some((w) => /skipped --spec-type/.test(w)), "skips are reported, not silent");

  // Unknown capability (probe failed) ⇒ behave exactly as before.
  const blind = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 8192 });
  assert.ok(blind.args.includes("--spec-type"));
  assert.ok(blind.args.includes("--jinja"));
});

test("cleanRuntimeLog unescapes and strips ANSI; runtimeFailureReason finds the real error", () => {
  // Exactly the shape that filled the failure panel with garbage.
  const raw = "\\u001b[34m0.00.080.619\\u001b[0m \\u001b[35mW DEPRECATED: --mmap and --no-mmap are deprecated\\n\\u001b[0m\\u001b[32ml \\u001b[0msrv    load_model: loading model 'ornith.gguf'\\nerror: failed to allocate buffer";
  const cleaned = cleanRuntimeLog(raw);
  assert.ok(!cleaned.includes("\\u001b"), "escape sequences gone");
  assert.ok(!cleaned.includes("[34m"), "ANSI codes gone");
  assert.ok(cleaned.includes("load_model: loading model"), "the real content survives");
  assert.ok(cleaned.includes("\n"), "literal \\n became a real newline");
  // The deprecation WARNING must not be mistaken for the failure; the allocation error is the reason.
  assert.match(runtimeFailureReason(raw), /failed to allocate buffer/);
  assert.equal(cleanRuntimeLog(""), "");
});

test("splitExtraArgs tokenizes with quotes and bounds", () => {
  assert.deepEqual(splitExtraArgs('--threads 12 --override-tensor "exps=CPU" --lora \'my file.gguf\''), ["--threads", "12", "--override-tensor", "exps=CPU", "--lora", "my file.gguf"]);
  assert.deepEqual(splitExtraArgs("   "), []);
  assert.deepEqual(splitExtraArgs(undefined), []);
});

test("listModelFiles finds ggufs beside the configured weights and in extra dirs, deduped", () => {
  const root = mkdtempSync(join(tmpdir(), "kitten-models-"));
  writeFileSync(join(root, "ornith-35b-q4.gguf"), Buffer.alloc(2048));
  writeFileSync(join(root, "qwen-2b-q8.gguf"), Buffer.alloc(1024));
  writeFileSync(join(root, "readme.txt"), "not a model");
  const nested = mkdtempSync(join(tmpdir(), "kitten-models-lm-"));
  writeFileSync(join(nested, "other-7b.gguf"), Buffer.alloc(512));
  const files = listModelFiles([join(root, "ornith-35b-q4.gguf"), join(root, "ornith-35b-q4.gguf")], [nested]);
  const names = files.map((f) => f.name);
  assert.ok(names.includes("ornith-35b-q4.gguf"));
  assert.ok(names.includes("qwen-2b-q8.gguf"), "siblings of the configured weight are offered");
  assert.ok(names.includes("other-7b.gguf"), "extra dirs are scanned");
  assert.ok(!names.includes("readme.txt"));
  assert.equal(names.filter((n) => n === "ornith-35b-q4.gguf").length, 1, "deduped");
  // Largest-first within a directory: the quant someone downloaded on purpose leads.
  const inRoot = files.filter((f) => f.dir === root);
  assert.equal(inRoot[0].name, "ornith-35b-q4.gguf");
});

test("a 503 'loading model' is reported as LOADING, not as an unreachable endpoint", async () => {
  // The live failure: llama.cpp answers 503 for the whole time it reads a 25GB GGUF. Treating that
  // as unreachable is what made Kitten kill a healthy model five seconds into a two-minute load.
  let phase: "loading" | "ready" = "loading";
  const server = createServer((req, res) => {
    if (phase === "loading") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 503, message: "Loading model" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "ornith-1.0-35b" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/v1`;
    const loading = await probeEndpoint(url, 1500);
    assert.equal(loading.reachable, false, "not servable yet");
    assert.equal(loading.loading, true, "but recognisably ALIVE and loading");
    assert.match(loading.error ?? "", /loading model/i);
    phase = "ready";
    const ready = await probeEndpoint(url, 1500);
    assert.equal(ready.reachable, true);
    assert.equal(ready.loading, undefined);
    assert.deepEqual(ready.models, ["ornith-1.0-35b"]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("a genuinely dead endpoint is still reported as unreachable and NOT loading", async () => {
  const dead = await probeEndpoint("http://127.0.0.1:1/v1", 400);
  assert.equal(dead.reachable, false);
  assert.ok(!dead.loading, "a refused connection must never look like a loading model");
});

test("the launch plan enables prompt-lookup speculation, and can turn it off", () => {
  // ngram-mod needs no draft model, so it costs no VRAM — the reason it is preferred on a card with
  // nothing spare. Speculative decoding is output-lossless, so the only risk is throughput.
  const on = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9 });
  const i = on.args.indexOf("--spec-type");
  assert.ok(i >= 0, "speculation is on by default");
  assert.equal(on.args[i + 1], "ngram-mod");
  assert.ok(!on.args.includes("--model-draft"), "no draft model is loaded — that would cost VRAM");

  const off = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, speculation: "off" });
  assert.ok(!off.args.includes("--spec-type"), "it is switchable");
});
