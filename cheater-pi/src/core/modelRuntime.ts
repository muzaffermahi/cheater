// Model/runtime management primitives used by the native desktop onboarding flow.
// This module is deliberately UI-independent: it can discover existing endpoints, validate model
// files, and produce a safe launch plan without opening a terminal or mutating user configuration.

import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync, mkdirSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";

export type RuntimeKind = "managed-llama-cpp" | "lm-studio" | "ollama" | "openai-compatible";
export type ComputeBackend = "cpu" | "cuda" | "vulkan" | "unknown";

export interface ModelArtifact {
  path: string;
  name: string;
  bytes: number;
  format: "gguf" | "safetensors" | "unknown";
  sha256?: string;
  verified: boolean;
}

export interface EndpointProbe {
  baseUrl: string;
  kind: RuntimeKind;
  reachable: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

export interface HardwareProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpuCores: number;
  ramBytes: number;
  gpus: Array<{ name: string; vendor: string; vramBytes?: number; backend: ComputeBackend }>;
}

export interface RuntimeLaunchPlan {
  kind: RuntimeKind;
  backend: ComputeBackend;
  mainModel: string;
  sidecarModel?: string;
  contextTokens: number;
  /** Whether the caller pinned the context size or the plan sized it from the machine. */
  contextSource: "explicit" | "auto";
  parallelSlots: number;
  sidecarMode: "separate-device" | "co-resident" | "cpu" | "contended" | "disabled";
  args: string[];
  warnings: string[];
}

// ── Context auto-sizing ─────────────────────────────────────────────────────────────────────────
// The old behavior was `contextTokens ?? 16384` — a constant wish with no relationship to the
// machine. These helpers size n_ctx from what is actually true: the model's KV geometry (read from
// its own GGUF header) and the VRAM the weights leave free.

/** The KV geometry needed to price one token of context, from the model's own GGUF header. */
export interface GgufKvMeta {
  architecture: string;
  blockCount: number;
  headCount: number;
  headCountKv: number;
  embeddingLength: number;
}

/** Discrete n_ctx choices, smallest first. A ladder (not a continuum) keeps sizes predictable and
 *  cache-friendly across launches. */
export const CTX_LADDER = [8192, 16384, 24576, 32768, 49152, 65536, 98304, 131072] as const;

const GGUF_TYPE_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/**
 * Read the KV-relevant metadata from a GGUF v2/v3 header. Bounded: parses only what fits in the
 * first 4 MB (llama.cpp writers put general.* and the architecture params ahead of the tokenizer
 * arrays, so the needed keys are found long before the bound). Returns null on ANY anomaly —
 * callers fall back to a documented heuristic, never to a crash.
 */
export function readGgufKvMeta(path: string): GgufKvMeta | null {
  let buf: Buffer;
  try {
    const fd = openSync(path, "r");
    try {
      buf = Buffer.alloc(4 * 1024 * 1024);
      const read = readSync(fd, buf, 0, buf.length, 0);
      buf = buf.subarray(0, read);
    } finally { closeSync(fd); }
  } catch { return null; }
  try {
    if (buf.length < 24 || buf.readUInt32LE(0) !== 0x46554747) return null; // "GGUF"
    const version = buf.readUInt32LE(4);
    if (version < 2 || version > 3) return null;
    const kvCount = Number(buf.readBigUInt64LE(16));
    let off = 24;
    const wanted = new Map<string, number>();
    let architecture = "";
    const need = (): string[] => architecture
      ? [`${architecture}.block_count`, `${architecture}.attention.head_count`, `${architecture}.attention.head_count_kv`, `${architecture}.embedding_length`]
      : [];
    const readString = (): string | null => {
      if (off + 8 > buf.length) return null;
      const len = Number(buf.readBigUInt64LE(off)); off += 8;
      if (len < 0 || off + len > buf.length) return null;
      const s = buf.toString("utf8", off, off + len); off += len;
      return s;
    };
    for (let i = 0; i < kvCount; i++) {
      const key = readString();
      if (key === null || off + 4 > buf.length) return finish();
      const type = buf.readUInt32LE(off); off += 4;
      if (type === 8) { // string
        const v = readString();
        if (v === null) return finish();
        if (key === "general.architecture") architecture = v;
      } else if (type === 9) { // array: elem type + count, then elements
        if (off + 12 > buf.length) return finish();
        const elemType = buf.readUInt32LE(off); off += 4;
        const count = Number(buf.readBigUInt64LE(off)); off += 8;
        if (elemType === 8 || elemType === 9) {
          // A string/nested array (the tokenizer) — walking it element-by-element inside the bound
          // is pointless; everything we need appears before it. Stop here with what we have.
          return finish();
        }
        const size = GGUF_TYPE_SIZES[elemType];
        if (!size) return finish();
        off += size * count;
        if (off > buf.length) return finish();
      } else {
        const size = GGUF_TYPE_SIZES[type];
        if (!size || off + size > buf.length) return finish();
        let value = 0;
        if (type === 4) value = buf.readUInt32LE(off);
        else if (type === 5) value = buf.readInt32LE(off);
        else if (type === 10) value = Number(buf.readBigUInt64LE(off));
        else if (type === 11) value = Number(buf.readBigInt64LE(off));
        else if (type === 0) value = buf.readUInt8(off);
        else if (type === 2) value = buf.readUInt16LE(off);
        off += size;
        if (need().includes(key)) wanted.set(key, value);
      }
      if (architecture && need().every((k) => wanted.has(k))) return finish();
    }
    return finish();

    function finish(): GgufKvMeta | null {
      if (!architecture) return null;
      const keys = need();
      if (!keys.every((k) => Number(wanted.get(k)) > 0)) return null;
      return {
        architecture,
        blockCount: wanted.get(keys[0])!,
        headCount: wanted.get(keys[1])!,
        headCountKv: wanted.get(keys[2])!,
        embeddingLength: wanted.get(keys[3])!,
      };
    }
  } catch { return null; }
}

/** Bytes of KV cache per context token. K and V each store headDim·kvHeads per layer; q8_0 carries a
 *  1/16 scale overhead over its 1 byte/element. */
export function kvBytesPerToken(meta: GgufKvMeta, cacheType: "q8_0" | "f16" = "q8_0"): number {
  const headDim = meta.embeddingLength / meta.headCount;
  const perElement = cacheType === "q8_0" ? 1.0625 : 2;
  return 2 * meta.blockCount * headDim * meta.headCountKv * perElement;
}

/**
 * Pick the largest ladder rung whose KV cache fits the VRAM the weights leave free. Every input is
 * optional — each missing fact degrades to a conservative documented guess, and the reason string
 * always says which path was taken (it lands in the launch plan warnings).
 */
export function autoSizeContextTokens(input: { modelPath?: string; modelBytes?: number; vramBytes?: number; reserveBytes?: number; cacheType?: "q8_0" | "f16" }): { contextTokens: number; reason: string } {
  const { modelBytes, vramBytes } = input;
  if (!vramBytes || vramBytes <= 0) {
    return { contextTokens: 16384, reason: "ctx auto-sized to 16384: no VRAM reading (conservative default)" };
  }
  const meta = input.modelPath ? readGgufKvMeta(input.modelPath) : null;
  const cacheType = input.cacheType ?? "q8_0";
  // Heuristic fallback when the header is unreadable: a large MoE ~35B lands near 160 KiB/token at
  // q8_0; a mid-size dense model nearer 96 KiB. A guess, and labeled as one.
  const heuristic = (modelBytes && modelBytes > 20e9 ? 160 * 1024 : 96 * 1024) * (cacheType === "f16" ? 2 : 1);
  const perToken = meta ? kvBytesPerToken(meta, cacheType) : heuristic;
  const residentWeights = modelBytes === undefined ? vramBytes * 0.5
    : modelBytes > vramBytes * 0.8 ? vramBytes * 0.45 // cpu-moe: only attention + dense stay resident (mirrors the launch-plan branch)
    : modelBytes;
  const reserve = input.reserveBytes ?? 1.5e9;
  const free = vramBytes - residentWeights - reserve;
  let contextTokens: number = CTX_LADDER[0];
  for (const rung of CTX_LADDER) if (rung * perToken <= free) contextTokens = rung;
  const source = meta ? `GGUF geometry (${meta.architecture}: ${Math.round(perToken / 1024)} KiB/token)` : `heuristic ${Math.round(perToken / 1024)} KiB/token (GGUF header unreadable)`;
  return {
    contextTokens,
    reason: `ctx auto-sized to ${contextTokens}: ${source}, ${(Math.max(0, free) / 1e9).toFixed(1)} GB free after weights+reserve`,
  };
}

export function inspectModel(path: string, expectedSha256?: string): ModelArtifact {
  if (!existsSync(path)) throw new Error(`model does not exist: ${path}`);
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`model path is not a file: ${path}`);
  const format = extname(path).toLowerCase() === ".gguf" ? "gguf" : extname(path).toLowerCase() === ".safetensors" ? "safetensors" : "unknown";
  const sha256 = expectedSha256 ? hashFile(path) : undefined;
  return { path, name: basename(path), bytes: st.size, format, sha256, verified: !expectedSha256 || sha256 === expectedSha256.toLowerCase() };
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Find already-installed llama.cpp servers without opening a shell or asking the user to type a command. */
export function discoverRuntimeExecutables(): string[] {
  const names = process.platform === "win32" ? ["llama-server.exe", "llama-server"] : ["llama-server"];
  const directories = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const found: string[] = [];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = `${directory.replace(/[\\/]$/, "")}/${name}`;
      try { if (existsSync(candidate) && statSync(candidate).isFile() && !found.includes(candidate)) found.push(candidate); } catch {}
    }
  }
  return found.slice(0, 8);
}

export async function probeEndpoint(baseUrl: string, timeoutMs = 2500): Promise<EndpointProbe> {
  const started = Date.now();
  const root = baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${root}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { baseUrl, kind: classifyEndpoint(baseUrl), reachable: false, models: [], latencyMs: Date.now() - started, error: `HTTP ${response.status}` };
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return { baseUrl, kind: classifyEndpoint(baseUrl), reachable: true, models: (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean), latencyMs: Date.now() - started };
  } catch (e) {
    return { baseUrl, kind: classifyEndpoint(baseUrl), reachable: false, models: [], latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Probe the common loopback ports used by local model apps in parallel. This is intentionally
 * opt-in and read-only: it never changes settings or starts a process. Callers can provide a
 * candidate list for tests or a provider-specific setup flow. */
export async function discoverLocalEndpoints(candidateUrls: readonly string[] = [
  "http://127.0.0.1:1234/v1", // LM Studio
  "http://127.0.0.1:8080/v1", // llama.cpp
  "http://127.0.0.1:8000/v1", // vLLM / OpenAI-compatible
  "http://127.0.0.1:11434/v1", // Ollama OpenAI compatibility
], timeoutMs = 900): Promise<EndpointProbe[]> {
  const unique = [...new Set(candidateUrls.map((value) => value.trim()).filter(Boolean))].slice(0, 12);
  const probes = await Promise.all(unique.map((url) => probeEndpoint(url, timeoutMs)));
  return probes.filter((probe) => probe.reachable).sort((a, b) => a.latencyMs - b.latencyMs);
}

export function classifyEndpoint(baseUrl: string): RuntimeKind {
  if (/11434/.test(baseUrl) || /ollama/i.test(baseUrl)) return "ollama";
  if (/1234/.test(baseUrl) || /lm[-_ ]?studio/i.test(baseUrl)) return "lm-studio";
  return "openai-compatible";
}

export function detectHardware(): HardwareProfile {
  const gpus = process.platform === "win32" ? detectWindowsGpus() : [];
  return {
    platform: process.platform,
    arch: process.arch,
    cpuCores: Number(cpus().length),
    ramBytes: totalmem(),
    gpus,
  };
}

function detectWindowsGpus(): HardwareProfile["gpus"] {
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,VideoProcessor | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output) as Record<string, unknown> | Array<Record<string, unknown>>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => {
      const name = String(row.Name ?? row.VideoProcessor ?? "Unknown GPU");
      const lower = name.toLowerCase();
      const vendor = lower.includes("nvidia") ? "NVIDIA" : lower.includes("amd") || lower.includes("radeon") ? "AMD" : lower.includes("intel") ? "Intel" : "Unknown";
      const backend: ComputeBackend = vendor === "NVIDIA" ? "cuda" : vendor === "AMD" || vendor === "Intel" ? "vulkan" : "unknown";
      // Win32_VideoController.AdapterRAM is a 32-bit field and saturates at ~4 GB, so an 8 GB card
      // reports 4.3 GB. Ask the driver instead when it can answer; otherwise report nothing rather
      // than a number we know is wrong — this value is shown to the user and sizes the offload advice.
      const reported = Number(row.AdapterRAM);
      const vram = vendor === "NVIDIA" ? nvidiaVramBytes(name) ?? plausibleVram(reported) : plausibleVram(reported);
      return { name, vendor, backend, ...(vram !== undefined ? { vramBytes: vram } : {}) };
    }).filter((gpu) => gpu.name !== "Unknown GPU");
  } catch { return []; }
}

/** A saturated 32-bit AdapterRAM reading is not a VRAM size; treat it as unknown. */
function plausibleVram(bytes: number): number | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  return bytes >= 4_290_000_000 && bytes <= 4_300_000_000 ? undefined : bytes;
}

/** nvidia-smi knows the real number. Absent driver or non-NVIDIA card → undefined, never a guess. */
function nvidiaVramBytes(name: string): number | undefined {
  try {
    const output = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split(/\r?\n/)) {
      const [gpuName, mib] = line.split(",").map((part) => part.trim());
      if (!gpuName || !mib) continue;
      const megabytes = Number(mib);
      if (!Number.isFinite(megabytes) || megabytes <= 0) continue;
      if (name.toLowerCase().includes(gpuName.toLowerCase()) || gpuName.toLowerCase().includes(name.toLowerCase())) return megabytes * 1024 * 1024;
    }
  } catch { /* no driver tool: report nothing rather than a wrong number */ }
  return undefined;
}

/** User launch tuning (settings.runtimeTuning). Every "auto" falls through to the heuristics. */
export interface RuntimeTuning {
  gpuLayers?: number | "auto";
  cpuMoe?: "auto" | "on" | "off";
  flashAttn?: "auto" | "on" | "off";
  kvCacheType?: "auto" | "q8_0" | "f16" | "q4_0";
  extraArgs?: string;
}

/** Split a raw extra-flags string into argv tokens (quoted segments stay whole). */
export function splitExtraArgs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out.slice(0, 64);
}

export function buildLaunchPlan(input: {
  runtime?: RuntimeKind;
  backend?: ComputeBackend;
  mainModel: string;
  sidecarModel?: string;
  contextTokens?: number;
  sidecarMode?: RuntimeLaunchPlan["sidecarMode"];
  /** User overrides for the heuristics below; "auto"/absent keeps the measured-machine defaults. */
  tuning?: RuntimeTuning;
  /** Where llama.cpp may persist KV slots, so a reopened conversation restores instead of re-prefilling. */
  slotSavePath?: string;
  /** MiB of host RAM llama.cpp may use as a prompt-cache pool across requests. */
  promptCacheMiB?: number;
  /** Prompt-lookup speculation. `"ngram"` (default) drafts from the context; `"off"` disables it. */
  speculation?: "ngram" | "off";
  /** Overrides for tests; production measures the real file and the real device. */
  modelBytes?: number;
  vramBytes?: number;
}): RuntimeLaunchPlan {
  const runtime = input.runtime ?? "managed-llama-cpp";
  const hardware = input.backend && input.vramBytes !== undefined ? null : detectHardware();
  const backend = input.backend ?? hardware?.gpus.find((gpu) => gpu.backend !== "unknown")?.backend ?? "cpu";
  const sidecarMode = input.sidecarModel ? (input.sidecarMode ?? "cpu") : "disabled";
  const warnings: string[] = [];

  // The machine facts drive both the context size and the offload strategy, so measure them first.
  const vramBytes = input.vramBytes ?? hardware?.gpus.find((gpu) => gpu.backend === backend)?.vramBytes;
  const modelBytes = input.modelBytes ?? (existsSync(input.mainModel) ? statSync(input.mainModel).size : undefined);

  const tuning = input.tuning ?? {};
  const kvCacheType = tuning.kvCacheType && tuning.kvCacheType !== "auto" ? tuning.kvCacheType : "q8_0";

  // No pinned context ⇒ size it from the machine instead of wishing for 16384. An explicit number
  // (settings pin, per-run request) is honored exactly as before.
  const contextSource: RuntimeLaunchPlan["contextSource"] = input.contextTokens === undefined ? "auto" : "explicit";
  let contextTokens: number;
  if (contextSource === "auto") {
    const sized = autoSizeContextTokens({ modelPath: input.mainModel, modelBytes, vramBytes, cacheType: kvCacheType === "f16" ? "f16" : "q8_0" });
    contextTokens = sized.contextTokens;
    warnings.push(sized.reason);
  } else {
    contextTokens = Math.max(2048, Math.min(262144, Math.floor(input.contextTokens!)));
  }

  if (backend === "unknown") warnings.push("GPU backend was not identified; the runtime will use its safe fallback.");
  if (sidecarMode === "contended") warnings.push("The sidecar shares the main device and will yield during user-blocking generation.");
  if (runtime !== "managed-llama-cpp") return { kind: runtime, backend, mainModel: input.mainModel, sidecarModel: input.sidecarModel, contextTokens, contextSource, parallelSlots: 1, sidecarMode, args: [], warnings };
  const args = ["--model", input.mainModel, "--ctx-size", String(contextTokens), "--jinja", "--cont-batching"];

  // GPU offload: "auto" offloads everything that fits (llama.cpp clamps 999 to the real layer
  // count); an explicit number is the user's call — including 0 for a pure-CPU load.
  const gpuLayers = tuning.gpuLayers !== undefined && tuning.gpuLayers !== "auto" ? Math.max(0, Math.floor(tuning.gpuLayers)) : null;
  if (gpuLayers !== null) {
    args.push("--n-gpu-layers", String(gpuLayers));
  } else if (backend !== "cpu") {
    args.push("--n-gpu-layers", "999");
  }
  // Attention on GPU is where flash-attention pays; auto = on for any GPU backend.
  const flashOn = tuning.flashAttn === "on" || (tuning.flashAttn !== "off" && backend !== "cpu" && gpuLayers !== 0);
  if (flashOn) args.push("--flash-attn", "on");

  // KV quantization is a CAPACITY lever here, not a quality one: q8_0 is the safe default and roughly
  // halves the cache, which is the difference between a usable context and an OOM on 8 GB. The user
  // can pin f16 (quality/default) or q4_0 (capacity) — q4 is never chosen automatically.
  args.push("--cache-type-k", kvCacheType, "--cache-type-v", kvCacheType);

  // The expert tensors are the bulk of a MoE and the part that does not fit. Pushing them to CPU keeps
  // attention and the dense path resident instead of letting the driver thrash. This is also the
  // heuristic a hand-tuner most often wants to OVERRIDE (measured on the dev box: auto cpu-moe gave
  // 7 tok/s where the user's own launch gave 30) — so "off" is a first-class choice, not a hack.
  const wantCpuMoe = tuning.cpuMoe === "on"
    || (tuning.cpuMoe !== "off" && backend !== "cpu" && modelBytes !== undefined && vramBytes !== undefined && modelBytes > vramBytes * 0.8);
  if (wantCpuMoe && backend !== "cpu") {
    // llama.cpp itself warns that CPU tensor overrides with mmap enabled are slower, so take its advice.
    args.push("--cpu-moe", "--no-mmap");
    if (tuning.cpuMoe !== "on") warnings.push(`The model is ${((modelBytes ?? 0) / 1e9).toFixed(1)} GB against ${((vramBytes ?? 0) / 1e9).toFixed(1)} GB of VRAM, so its experts run on the CPU. Decode speed will be bound by system memory bandwidth. Override with cpuMoe:"off" if your own tuning beats this.`);
  }

  // Prefix reuse is the largest latency lever on this hardware, and none of it is on by default:
  // a similarity threshold so a near-identical prompt lands on the warm slot, a prompt-cache pool, and
  // a disk path so a reopened conversation can restore instead of re-paying a 16k prefill.
  args.push("--slot-prompt-similarity", "0.25");
  if (input.slotSavePath) {
    // The server will not start if this directory does not exist, and because the managed spawn
    // discards stderr the only symptom was "the runtime never became reachable" — a silent failure
    // with no reason anywhere. Create it here so the flag is always safe to pass.
    try { mkdirSync(input.slotSavePath, { recursive: true }); args.push("--slot-save-path", input.slotSavePath); }
    catch { warnings.push(`KV slots cannot be persisted: ${input.slotSavePath} is not writable. Resume will re-prefill instead of restoring.`); }
  }
  if (input.promptCacheMiB && input.promptCacheMiB > 0) args.push("--cache-ram", String(Math.floor(input.promptCacheMiB)));

  // Prompt-lookup (n-gram) speculation. Decode here is memory-bandwidth-bound, not compute-bound —
  // 24.7 GB of weights stream past an 8 GB card for every token — so verifying several drafted tokens
  // in one pass is close to free when the drafts hit. Coding agents are the ideal workload for it:
  // the model constantly re-emits text already present in the context (the file it is editing, an
  // error string, a repeated signature), which is exactly what an n-gram draft predicts.
  //
  // `ngram-mod` needs NO draft model, so it costs no VRAM — which is why it is preferred here over
  // pairing a small model as a drafter on a card that has nothing spare.
  //
  // SAFETY: speculative decoding is output-LOSSLESS. Drafted tokens are accepted only if they match
  // what the target model would have produced, so the sampled distribution is unchanged. The only
  // risk is a throughput regression when drafts miss, never a quality regression — which is why this
  // defaults on where the schema constraint (which DID change content) defaults off.
  //
  // UNMEASURED ON THIS BOX: A/B-ing it needs a second server instance, and with the 35B resident
  // there was 1.9 GB of 31.7 GB free — no headroom to run both. To measure, stop the live server and
  // compare tokens/s with and without `--spec-type ngram-mod` on a realistic edit prompt.
  if (input.speculation !== "off") {
    args.push("--spec-type", "ngram-mod");
  }

  if (input.sidecarModel && sidecarMode === "co-resident") args.push("--model-draft", input.sidecarModel);

  // User extra flags go LAST so they win over every heuristic above (llama.cpp takes the final value
  // of a repeated flag). This is the escape hatch for anything the structured fields don't cover.
  const extra = splitExtraArgs(tuning.extraArgs);
  if (extra.length) args.push(...extra);

  return { kind: runtime, backend, mainModel: input.mainModel, sidecarModel: input.sidecarModel, contextTokens, contextSource, parallelSlots: sidecarMode === "separate-device" || sidecarMode === "co-resident" ? 2 : 1, sidecarMode, args, warnings };
}

// ── Model file discovery ────────────────────────────────────────────────────────────────────────
// The picker must show what is ALREADY on the machine: the folders the configured weights live in,
// plus the standard LM Studio trees, so a model installed via LM Studio or a manual llama.cpp
// download is one click away instead of a filesystem safari.

export interface LocalModelFile {
  path: string;
  name: string;
  bytes: number;
  dir: string;
}

/** Recursively collect *.gguf files under `root` (bounded depth + count; never throws). */
function collectGguf(root: string, depth: number, out: LocalModelFile[], cap: number): void {
  if (out.length >= cap || depth < 0) return;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }
  for (const entry of entries) {
    if (out.length >= cap) return;
    const full = `${root.replace(/[\\/]+$/, "")}${process.platform === "win32" ? "\\" : "/"}${entry}`;
    try {
      const st = statSync(full);
      if (st.isDirectory()) collectGguf(full, depth - 1, out, cap);
      else if (st.isFile() && entry.toLowerCase().endsWith(".gguf")) out.push({ path: full, name: entry, bytes: st.size, dir: root });
    } catch { /* unreadable entry */ }
  }
}

/**
 * All local model files a user could plausibly want to load: the directories of the currently
 * configured weights first, then the LM Studio model trees. De-duplicated, largest-first within a
 * directory (the quant someone actually uses is usually the big one they downloaded on purpose).
 */
export function listModelFiles(seedPaths: ReadonlyArray<string | undefined> = [], extraDirs: ReadonlyArray<string> = []): LocalModelFile[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const roots = new Set<string>();
  for (const seed of seedPaths) {
    if (!seed || !seed.trim()) continue;
    try { const dir = seed.replace(/[\\/][^\\/]+$/, ""); if (dir && existsSync(dir)) roots.add(dir); } catch { /* skip */ }
  }
  for (const dir of extraDirs) if (dir && existsSync(dir)) roots.add(dir);
  if (home) {
    for (const candidate of [
      `${home}\\.lmstudio\\models`,
      `${home}\\.cache\\lm-studio\\models`,
      `${home}/.lmstudio/models`,
      `${home}/.cache/lm-studio/models`,
    ]) {
      if (existsSync(candidate)) roots.add(candidate);
    }
  }
  const out: LocalModelFile[] = [];
  for (const root of roots) collectGguf(root, 3, out, 200);
  const seen = new Set<string>();
  return out
    .filter((f) => { const key = f.path.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.dir.localeCompare(b.dir) || b.bytes - a.bytes);
}

/** Spawn a managed runtime without inheriting a console window or arbitrary environment secrets. */
export function spawnManagedRuntime(executable: string, args: string[], cwd: string): { process: ReturnType<typeof spawn>; stop: () => void; stderr: () => string } {
  // The native app has no console surface. Ignoring output also prevents a verbose server from
  // filling an undrained pipe and stalling inference after a long session.
  // stderr is captured, not discarded. Throwing it away meant a runtime that refused to start — a
  // missing slot directory, a bad flag, an out-of-memory — surfaced only as "did not become
  // reachable", with the actual reason printed into nowhere. The buffer stays bounded so a chatty
  // server can never fill an undrained pipe and stall inference.
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", env: { PATH: process.env.PATH ?? "" } });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-8000); });
  child.stderr?.on("error", () => { /* the runtime is what matters, not our reader */ });
  const stop = (): void => { if (child.pid && process.platform === "win32") { try { spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {} } else child.kill("SIGTERM"); };
  return { process: child, stop, stderr: () => stderr };
}
