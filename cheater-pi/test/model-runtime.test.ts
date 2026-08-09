import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCpuMoeLayers, autoSizeContextTokens, buildLaunchPlan, classifyEndpoint, cleanRuntimeLog, CTX_LADDER, detectHardware, discoverLocalEndpoints, discoverRuntimeExecutables, inspectWeights, kvBytesPerToken, listModelFiles, looksLikeGeneratedCommand, preferredBackendTags, probeEndpoint, resolveServerBinary, readGgufKvMeta, runtimeFailureReason, splitExtraArgs, suggestModelId } from "../src/core/modelRuntime.js";

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

/** The Qwen3.6 exporter places a string array before the architecture geometry. */
function writeTaggedSyntheticGguf(path: string): void {
  const parts: Buffer[] = [];
  const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s: string): Buffer => Buffer.concat([u64(s.length), Buffer.from(s, "utf8")]);
  const kvString = (key: string, value: string): Buffer => Buffer.concat([str(key), u32(8), str(value)]);
  const kvU32 = (key: string, value: number): Buffer => Buffer.concat([str(key), u32(4), u32(value)]);
  const tags = Buffer.concat([str("general.tags"), u32(9), u32(8), u64(2), str("qwen"), str("moe")]);
  const arch = "qwen35moe";
  parts.push(Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(7));
  parts.push(kvString("general.architecture", arch), tags);
  parts.push(kvU32(`${arch}.block_count`, 40));
  parts.push(kvU32(`${arch}.attention.head_count`, 16));
  parts.push(kvU32(`${arch}.attention.head_count_kv`, 2));
  parts.push(kvU32(`${arch}.embedding_length`, 2048));
  parts.push(kvU32(`${arch}.expert_count`, 256));
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

test("readGgufKvMeta skips early string arrays used by Qwen3.6 GGUFs", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-gguf-tags-"));
  const path = join(dir, "qwen36.gguf");
  writeTaggedSyntheticGguf(path);
  const meta = readGgufKvMeta(path);
  assert.equal(meta?.architecture, "qwen35moe");
  assert.equal(meta?.blockCount, 40);
  assert.equal(meta?.expertCount, 256);
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

test("an unpinned context is sized for the work, not for the largest window that fits", () => {
  // This assertion changed on the strength of a measurement, and the old value is the bug it fixes.
  // Sizing the window to whatever the card would hold produced 131072 tokens on the reference
  // machine, a KV cache that filled the card, and every expert evicted to system RAM: 10.9 tok/s
  // decode against 14.7 for a working-sized window. Context is VRAM taken from the experts, and the
  // experts are what decode speed is made of.
  const auto = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9 });
  assert.equal(auto.contextSource, "auto");
  assert.equal(auto.contextTokens, 32768, "a window sized for agent work");
  assert.ok(auto.warnings.some((w) => /sized for the work|blanket split|trained for/.test(w)), "and it says why");
  const i = auto.args.indexOf("--ctx-size");
  assert.equal(auto.args[i + 1], "32768");
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

test("a machine's accelerator decides which of LM Studio's backends is preferred", () => {
  // LM Studio keeps several llama.cpp backends side by side and they sort alphabetically with "avx2"
  // ahead of "nvidia-cuda" — so taking the first entry handed a CUDA machine a CPU-only server.
  const nvidia = preferredBackendTags({ platform: "win32", arch: "x64", cpuCores: 8, ramBytes: 32e9, gpus: [{ name: "RTX 4060", vendor: "NVIDIA", backend: "cuda", vramBytes: 8e9 }] });
  assert.deepEqual(nvidia, ["cuda"]);
  const amd = preferredBackendTags({ platform: "win32", arch: "x64", cpuCores: 8, ramBytes: 32e9, gpus: [{ name: "RX 7900", vendor: "AMD", backend: "vulkan" }] });
  assert.deepEqual(amd, ["rocm", "vulkan"]);
  // No hardware reading ⇒ no preference, and discovery still never opens a shell for one.
  assert.deepEqual(preferredBackendTags(), []);
  assert.deepEqual(preferredBackendTags({ platform: "linux", arch: "x64", cpuCores: 4, ramBytes: 8e9, gpus: [] }), []);
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
  assert.ok(!plan.args.includes("--no-mmap"), "the deprecated spelling is never used");
  // Kitten used to emit `--load-mode none` here, following llama.cpp's advice that CPU tensor
  // overrides are slower with mmap enabled. Measured on the reference machine, that advice cost 24s
  // of load time against 8s, for 14.26 vs 14.35 tok/s decode — a difference inside the noise. The
  // measurement wins over the folklore, so no load mode is chosen automatically at all.
  assert.ok(!plan.args.includes("--load-mode"), "no load mode is imposed without being asked for");
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--flash-attn"), plan.args.indexOf("--flash-attn") + 2), ["--flash-attn", "on"], "valued form for a build documenting [on|off|auto]");

  // An older/minimal build: unknown flags are skipped with an explicit warning rather than emitted.
  const minimal = new Set(["--model", "--ctx-size", "--n-gpu-layers", "--no-mmap", "--cpu-moe"]);
  const lean = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 8192, supportedFlags: minimal });
  assert.ok(!lean.args.includes("--spec-type"), "a flag this build lacks is never passed");
  assert.ok(!lean.args.includes("--cache-type-k"));
  assert.ok(!lean.args.includes("--jinja"));
  assert.ok(!lean.args.includes("--no-mmap"), "and the deprecated spelling is not resurrected for older builds either");
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

// ── the MoE split, the pinned command, and picking weights ──────────────────────────────────────

test("a partial CPU-expert split is computed instead of dumping every expert on the CPU", () => {
  // 24.7 GB of weights against 8 GB of VRAM: the blanket --cpu-moe measured 7 tok/s here, a partial
  // split 30. The answer must be "the fewest layers that make the rest fit", not "all of them".
  const layers = autoCpuMoeLayers({ modelBytes: 24.7e9, vramBytes: 8e9, blockCount: 48, kvCacheBytes: 1e9 });
  assert.ok(layers !== null && layers > 0 && layers < 48, `expected a partial split, got ${layers}`);
  // A model that already fits needs nothing moved.
  assert.equal(autoCpuMoeLayers({ modelBytes: 6e9, vramBytes: 24e9, blockCount: 48 }), 0);
  // A model that cannot fit even with every expert evicted falls back to the blanket flag (null).
  assert.equal(autoCpuMoeLayers({ modelBytes: 400e9, vramBytes: 8e9, blockCount: 48 }), null);
  // Unknown machine ⇒ no guess.
  assert.equal(autoCpuMoeLayers({ modelBytes: 24.7e9, vramBytes: 0, blockCount: 48 }), null);
});

test("the launch plan emits --n-cpu-moe with a layer count, and honours a pinned one", () => {
  const known = new Set(["--model", "--ctx-size", "--n-gpu-layers", "--cpu-moe", "--n-cpu-moe", "--load-mode", "--alias", "--threads", "--batch-size", "--ubatch-size", "--no-kv-offload", "--main-gpu", "--tensor-split", "--cache-type-k", "--cache-type-v"]);
  const auto = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 16384,
    layerCount: 48, supportedFlags: known,
  });
  const i = auto.args.indexOf("--n-cpu-moe");
  assert.ok(i >= 0, "a known layer count buys the partial split");
  assert.ok(Number(auto.args[i + 1]) > 0 && Number(auto.args[i + 1]) < 48);
  assert.ok(!auto.args.includes("--cpu-moe"), "the blanket flag is not ALSO emitted");

  const pinned = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 16384,
    layerCount: 48, supportedFlags: known, tuning: { cpuMoe: "on", cpuMoeLayers: 30 },
  });
  assert.deepEqual(pinned.args.slice(pinned.args.indexOf("--n-cpu-moe"), pinned.args.indexOf("--n-cpu-moe") + 2), ["--n-cpu-moe", "30"]);

  // "all" is still available, and still means the blanket flag.
  const all = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 16384,
    layerCount: 48, supportedFlags: known, tuning: { cpuMoe: "on", cpuMoeLayers: "all" },
  });
  assert.ok(all.args.includes("--cpu-moe") && !all.args.includes("--n-cpu-moe"));

  // A build that never heard of --n-cpu-moe gets the flag it does have.
  const older = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 16384,
    layerCount: 48, supportedFlags: new Set(["--model", "--ctx-size", "--cpu-moe", "--no-mmap"]),
  });
  assert.ok(older.args.includes("--cpu-moe") && !older.args.includes("--n-cpu-moe"));
});

test("the LM Studio-parity knobs reach llama-server, and only when set", () => {
  // A model that fits its card needs no split, so nothing here is chosen for the user.
  const bare = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 24e9, modelBytes: 8e9, contextTokens: 8192 });
  for (const flag of ["--threads", "--batch-size", "--ubatch-size", "--no-kv-offload", "--main-gpu", "--tensor-split", "--alias"]) {
    assert.ok(!bare.args.includes(flag), `${flag} must stay off llama.cpp's own defaults until asked for`);
  }
  const tuned = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 24e9, modelBytes: 8e9, contextTokens: 8192,
    modelAlias: "ornith-1.0-35b",
    tuning: { threads: 12, batchSize: 2048, ubatchSize: 512, kvOffload: "off", mainGpu: 1, tensorSplit: "24, 8", loadMode: "mlock" },
  });
  const at = (flag: string): string => tuned.args[tuned.args.indexOf(flag) + 1];
  assert.equal(at("--alias"), "ornith-1.0-35b");
  assert.equal(at("--threads"), "12");
  assert.equal(at("--batch-size"), "2048");
  assert.equal(at("--ubatch-size"), "512");
  assert.equal(at("--main-gpu"), "1");
  assert.equal(at("--tensor-split"), "24,8", "whitespace is not part of a tensor split");
  assert.equal(at("--load-mode"), "mlock");
  assert.ok(tuned.args.includes("--no-kv-offload"));
  // An explicit load mode wins over the one the CPU-MoE branch would have chosen.
  const withMoe = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 8192,
    supportedFlags: new Set(["--model", "--ctx-size", "--cpu-moe", "--load-mode"]), tuning: { loadMode: "mmap" },
  });
  assert.equal(withMoe.args.filter((arg) => arg === "--load-mode").length, 1, "one load mode, not two");
  assert.equal(withMoe.args[withMoe.args.indexOf("--load-mode") + 1], "mmap");
});

test("a pinned command REPLACES the plan instead of being appended to it", () => {
  // The bug this encodes: the runtime panel saved its whole edited command as "extra flags", so every
  // argument appeared twice, the duplication compounded on each save, and no tuning field could ever
  // win against the stale copy pinned at the end.
  const pinned = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9,
    tuning: { gpuLayers: 12, cpuMoe: "on", argsOverride: "--model \"C:/w/ornith.gguf\" --ctx-size 24576 --n-cpu-moe 30" },
  });
  assert.deepEqual(pinned.args, ["--model", "C:/w/ornith.gguf", "--ctx-size", "24576", "--n-cpu-moe", "30"]);
  assert.equal(pinned.args.filter((arg) => arg === "--model").length, 1, "exactly one --model, never a duplicate");
  assert.ok(!pinned.args.includes("--n-gpu-layers"), "the tuning fields do not leak into a pinned command");
  assert.equal(pinned.contextTokens, 24576, "the pinned context is reported, not the one that was overridden");
  assert.ok(pinned.warnings.some((warning) => /pinned/i.test(warning)), "and the user is told the fields are inert");

  const empty = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 8192, tuning: { argsOverride: "   " } });
  assert.ok(empty.args.includes("--jinja"), "an empty pin is not a pin");
});

test("a model id is derived from the weights file, not from the user", () => {
  assert.equal(suggestModelId("C:/models/Ornith-1.0-35B-Q5_K_M.gguf"), "ornith-1.0-35b");
  assert.equal(suggestModelId("/m/qwen3.5-2b-f16.gguf"), "qwen3.5-2b");
  assert.equal(suggestModelId("/m/plain-model.gguf"), "plain-model");
});

test("inspectWeights answers the picker's questions without a runtime", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-weights-"));
  const path = join(dir, "Some-Model-35B-Q4_K_M.gguf");
  writeFileSync(path, "not really a gguf");
  const found = inspectWeights(path, { platform: "win32", arch: "x64", cpuCores: 8, ramBytes: 32e9, gpus: [{ name: "Test", vendor: "NVIDIA", backend: "cuda", vramBytes: 8e9 }] });
  assert.equal(found.exists, true);
  assert.equal(found.suggestedModelId, "some-model-35b");
  assert.ok(found.suggested.contextTokens >= CTX_LADDER[0]);
  assert.equal(found.vramBytes, 8e9);

  const missing = inspectWeights(join(dir, "absent.gguf"));
  assert.equal(missing.exists, false);
  assert.equal(missing.bytes, 0);
});

test("a runtime path may name the folder the server lives in, not the binary", () => {
  // A folder passes an existsSync check and then fails at spawn with an unreadable OS error — which
  // is exactly what a real config on this machine did: runtimeExecutable pointed at runtimes/llama.cpp.
  const dir = mkdtempSync(join(tmpdir(), "kitten-bin-"));
  const exe = join(dir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  writeFileSync(exe, "");
  assert.equal(resolveServerBinary(dir), exe, "a directory resolves to the server inside it");
  assert.equal(resolveServerBinary(exe), exe, "a file is itself");
  assert.equal(resolveServerBinary(join(dir, "nope")), null);
  assert.equal(resolveServerBinary(undefined), null);
  assert.equal(resolveServerBinary("   "), null);
  const empty = mkdtempSync(join(tmpdir(), "kitten-nobin-"));
  assert.equal(resolveServerBinary(empty), null, "an empty directory is not a server");
});

test("a whole generated command saved as 'extra flags' is recognised as corruption", () => {
  // Verbatim from a real project config an older build wrote. Appended last, its `--model <id>` beat
  // the real `--model <weights path>`, so llama.cpp looked for a file named after the model.
  assert.equal(looksLikeGeneratedCommand("--model ornith-1.0-35b --ctx-size 24576 --jinja --cont-batching --n-gpu-layers 40 --cpu-moe"), true);
  // Genuine extra flags are left alone.
  assert.equal(looksLikeGeneratedCommand("--threads 12"), false);
  assert.equal(looksLikeGeneratedCommand("--override-tensor exps=CPU --numa distribute"), false);
  assert.equal(looksLikeGeneratedCommand(""), false);
  assert.equal(looksLikeGeneratedCommand(undefined), false);
});

test("batch geometry is llama.cpp's own unless the user asks otherwise", () => {
  // This assertion was inverted by a measurement. Forcing 4096/4096 sounded right — an early sweep
  // even seemed to support it — but on the reference machine, same split and window measured back to
  // back in one warm session, it cost a factor of 2.3: 14.27 tok/s against 32.12 for the default,
  // with WORSE prefill too. A large batch's compute buffer is VRAM taken from the resident experts,
  // and the experts are where the speed lives.
  const split = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 32768,
    supportedFlags: new Set(["--model", "--ctx-size", "--n-gpu-layers", "--cpu-moe", "--batch-size", "--ubatch-size"]),
  });
  assert.ok(!split.args.includes("--batch-size"), "no batch size is imposed on a split");
  assert.ok(!split.args.includes("--ubatch-size"));

  // No split, no reason to override the defaults either.
  const resident = buildLaunchPlan({ mainModel: "m.gguf", backend: "cuda", vramBytes: 48e9, modelBytes: 8e9, contextTokens: 8192 });
  assert.ok(!resident.args.includes("--batch-size"));

  // And an explicit choice still beats the plan.
  const chosen = buildLaunchPlan({
    mainModel: "m.gguf", backend: "cuda", vramBytes: 8e9, modelBytes: 24.7e9, contextTokens: 32768,
    tuning: { batchSize: 512, ubatchSize: 128 },
  });
  assert.equal(chosen.args[chosen.args.indexOf("--batch-size") + 1], "512");
  assert.equal(chosen.args[chosen.args.indexOf("--ubatch-size") + 1], "128");
});
