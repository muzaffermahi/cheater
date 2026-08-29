// Model/runtime management primitives used by the native desktop onboarding flow.
// This module is deliberately UI-independent: it can discover existing endpoints, validate model
// files, and produce a safe launch plan without opening a terminal or mutating user configuration.

import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync, mkdirSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { planTuning, type TuningPlan } from "./autoTune.js";

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
  /**
   * The server ANSWERED but is still loading weights (llama.cpp replies 503 "Loading model" for the
   * whole time it reads a large GGUF). This is the difference between "starting" and "broken": a
   * 25 GB Q5_K_M can take minutes, and treating it as unreachable kills the model mid-load.
   */
  loading?: boolean;
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
  /** The model's own trained context length, when the header declares it. */
  contextLength?: number;
  /** Number of routed experts. Present ⇒ this is a mixture-of-experts model, and a split is possible. */
  expertCount?: number;
  /** Number of stored next-token prediction layers for native MTP speculation. */
  nextnPredictLayers?: number;
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
      ? [`${architecture}.block_count`, `${architecture}.attention.head_count`, `${architecture}.attention.head_count_kv`, `${architecture}.embedding_length`, `${architecture}.context_length`, `${architecture}.expert_count`, `${architecture}.nextn_predict_layers`]
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
        if (elemType === 8) {
          // Some exporters put general.tags before the architecture geometry. Skipping the
          // strings, rather than stopping at the first array, lets us reach block_count and
          // expert_count in Qwen3.6 GGUFs. Tokenizer arrays are still bounded by the 4 MiB read.
          for (let j = 0; j < count; j++) if (readString() === null) return finish();
          continue;
        }
        if (elemType === 9) {
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
      if (architecture && need().slice(0, 5).every((k) => wanted.has(k)) && wanted.has(`${architecture}.expert_count`)) return finish();
    }
    return finish();

    function finish(): GgufKvMeta | null {
      if (!architecture) return null;
      const keys = need();
      // context_length and expert_count are BONUSES: absent headers must still yield KV geometry.
      if (!keys.slice(0, 4).every((k) => Number(wanted.get(k)) > 0)) return null;
      const contextLength = Number(wanted.get(keys[4]));
      const expertCount = Number(wanted.get(keys[5]));
      const nextnPredictLayers = Number(wanted.get(keys[6]));
      return {
        architecture,
        blockCount: wanted.get(keys[0])!,
        headCount: wanted.get(keys[1])!,
        headCountKv: wanted.get(keys[2])!,
        embeddingLength: wanted.get(keys[3])!,
        ...(Number.isFinite(contextLength) && contextLength > 0 ? { contextLength } : {}),
        ...(Number.isFinite(expertCount) && expertCount > 0 ? { expertCount } : {}),
        ...(Number.isFinite(nextnPredictLayers) && nextnPredictLayers > 0 ? { nextnPredictLayers } : {}),
      };
    }
  } catch { return null; }
}

/**
 * Whether these weights are a mixture-of-experts model — the only kind an expert split applies to.
 * The header's expert count is the fact; the architecture name is the fallback for headers that
 * predate the key.
 */
export function isMixtureOfExperts(meta: GgufKvMeta | null | undefined): boolean {
  if (!meta) return true; // unknown: assume a split may be needed, which is the safe direction
  if (meta.expertCount !== undefined) return meta.expertCount > 1;
  return /moe|mixtral|deepseek|qwen\d*moe/i.test(meta.architecture);
}

/** Bytes of KV cache per context token. K and V each store headDim·kvHeads per layer; q8_0 carries a
 *  1/16 scale overhead over its 1 byte/element. */
export function kvBytesPerToken(meta: GgufKvMeta, cacheType: "q8_0" | "f16" = "q8_0"): number {
  const headDim = meta.embeddingLength / meta.headCount;
  const perElement = cacheType === "q8_0" ? 1.0625 : 2;
  return 2 * meta.blockCount * headDim * meta.headCountKv * perElement;
}

/**
 * The FEWEST leading layers whose expert tensors must live on the CPU for everything else to fit in
 * VRAM — llama.cpp's `--n-cpu-moe N`, and the difference between a usable MoE and a slow one.
 *
 * The blanket `--cpu-moe` sends EVERY expert to system RAM, which on this class of hardware measured
 * 7 tok/s against 30 for a hand-tuned partial offload: once the experts are the bottleneck, each
 * layer left on the GPU is decode speed you keep. So compute the minimum instead of dumping them all.
 *
 * Returns null when the answer would be "all of them" or when an input is unknown — the caller then
 * falls back to the blanket flag, which is slow but always fits.
 */
export function autoCpuMoeLayers(input: { modelBytes: number; vramBytes: number; blockCount: number; kvCacheBytes?: number; reserveBytes?: number; expertShare?: number }): number | null {
  const { modelBytes, vramBytes, blockCount } = input;
  if (!(modelBytes > 0) || !(vramBytes > 0) || !(blockCount > 0)) return null;
  // Experts dominate a large MoE's weights; the dense path (attention, embeddings, norms) is the
  // rest. 0.85 is deliberately conservative — over-estimating the expert share moves FEWER layers to
  // the CPU, and the cost of guessing wrong in that direction is an OOM, so err the other way.
  const expertShare = input.expertShare ?? 0.85;
  const perLayerExperts = (modelBytes * expertShare) / blockCount;
  if (!(perLayerExperts > 0)) return null;
  const budget = vramBytes - (input.reserveBytes ?? 1.2e9) - (input.kvCacheBytes ?? 0);
  if (budget <= 0) return null;
  const overflow = modelBytes - budget;
  if (overflow <= 0) return 0;
  // One extra layer of headroom: the estimate is an estimate, and a launch that OOMs costs the user
  // minutes of weight loading to find out.
  const layers = Math.ceil(overflow / perLayerExperts) + 1;
  return layers >= blockCount ? null : Math.max(1, layers);
}

/**
 * Pick the largest ladder rung whose KV cache fits the VRAM the weights leave free. Every input is
 * optional — each missing fact degrades to a conservative documented guess, and the reason string
 * always says which path was taken (it lands in the launch plan warnings).
 */
export function autoSizeContextTokens(input: { modelPath?: string; modelBytes?: number; vramBytes?: number; reserveBytes?: number; cacheType?: "q8_0" | "f16"; meta?: GgufKvMeta | null }): { contextTokens: number; reason: string } {
  const { modelBytes, vramBytes } = input;
  if (!vramBytes || vramBytes <= 0) {
    return { contextTokens: 16384, reason: "ctx auto-sized to 16384: no VRAM reading (conservative default)" };
  }
  // The caller may already have parsed the header (buildLaunchPlan needs it for the MoE split too);
  // re-reading 4 MB of GGUF twice per launch is pointless.
  const meta = input.meta !== undefined ? input.meta : input.modelPath ? readGgufKvMeta(input.modelPath) : null;
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
  // Never ask for more context than the model was TRAINED for: llama.cpp will either refuse or
  // silently rope-extend into gibberish, and either way it wastes the KV memory we just budgeted.
  let trainedNote = "";
  if (meta?.contextLength && contextTokens > meta.contextLength) {
    contextTokens = Math.max(CTX_LADDER[0], Math.min(contextTokens, meta.contextLength));
    trainedNote = `, clamped to the model's trained ${meta.contextLength}`;
  }
  const source = meta ? `GGUF geometry (${meta.architecture}: ${Math.round(perToken / 1024)} KiB/token)` : `heuristic ${Math.round(perToken / 1024)} KiB/token (GGUF header unreadable)`;
  return {
    contextTokens,
    reason: `ctx auto-sized to ${contextTokens}: ${source}, ${(Math.max(0, free) / 1e9).toFixed(1)} GB free after weights+reserve${trainedNote}`,
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

/**
 * Where a llama-server binary plausibly lives on this machine, best-first: one sitting beside the app
 * (`runtimes/llama.cpp`), then the backends LM Studio has already downloaded, then PATH, then the
 * usual manual-install spots.
 *
 * PATH alone was not enough, and it was the wrong place to look first. A binary shipped beside the
 * app is on nobody's PATH, and neither are LM Studio's — so "find the runtime" found nothing on a
 * machine with eight copies of llama-server on it, and the user had to browse for one by hand.
 */
/**
 * The accelerator names a machine's GPUs imply, best-first — the vocabulary LM Studio uses in its
 * backend directory names. Takes an already-measured profile rather than probing: discovery is a
 * filesystem lookup that must not open a shell, and the callers that care already know the hardware.
 */
export function preferredBackendTags(hardware?: HardwareProfile): string[] {
  const tags: string[] = [];
  for (const gpu of hardware?.gpus ?? []) {
    if (gpu.vendor === "NVIDIA") tags.push("cuda");
    else if (gpu.vendor === "AMD") tags.push("rocm", "vulkan");
    else if (gpu.vendor === "Intel") tags.push("vulkan", "sycl");
  }
  return [...new Set(tags)];
}

/** Higher is better: a build matching this machine's accelerator beats a generic CPU one. */
function backendRank(name: string, preferred: readonly string[]): number {
  const lower = name.toLowerCase();
  for (let i = 0; i < preferred.length; i++) if (lower.includes(preferred[i])) return 100 - i;
  // An accelerated build for the WRONG vendor is worse than a plain CPU build: it will not load.
  return /cuda|rocm|sycl|metal/.test(lower) ? 0 : 1;
}

function runtimeSearchDirectories(preferred: readonly string[]): string[] {
  const dirs: string[] = [];
  const add = (dir: string | undefined): void => {
    if (!dir) return;
    const normalized = dir.replace(/[\\/]+$/, "");
    if (normalized && !dirs.includes(normalized)) dirs.push(normalized);
  };
  // Beside the app / the engine's own tree: an installed Kitten, and a repo checkout.
  const roots = [process.env.KITTEN_RUNTIME_DIR, dirname(process.execPath), process.cwd()];
  for (const root of roots) {
    if (!root) continue;
    add(root);
    add(join(root, "runtimes", "llama.cpp"));
    add(join(root, "..", "runtimes", "llama.cpp"));
    add(join(root, "..", "..", "runtimes", "llama.cpp"));
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (home) {
    // LM Studio downloads llama.cpp backends into its own extensions tree; those are real, current
    // binaries the user already has. It keeps SEVERAL — a plain CPU build beside a CUDA one, across
    // versions — and they sort alphabetically with "avx2" ahead of "nvidia-cuda", so taking the first
    // entry would hand a CUDA machine a CPU-only server. Rank them against this machine instead.
    for (const backendRoot of [join(home, ".lmstudio", "extensions", "backends"), join(home, ".cache", "lm-studio", "extensions", "backends")]) {
      add(backendRoot);
      try {
        const entries = readdirSync(backendRoot).sort((a, b) => backendRank(b, preferred) - backendRank(a, preferred) || b.localeCompare(a, "en"));
        for (const entry of entries) add(join(backendRoot, entry));
      } catch { /* not installed */ }
    }
    add(join(home, "llama.cpp"));
  }
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) add(dir.trim() || undefined);
  if (process.platform === "win32") {
    add("C:\\Program Files\\llama.cpp");
    add("C:\\llama.cpp");
  } else {
    add("/usr/local/bin");
    add("/opt/llama.cpp");
  }
  return dirs;
}

/**
 * The llama-server binary a configured path refers to. A path can point at the FOLDER the server
 * lives in rather than the executable itself — a folder passes an `existsSync` check and then fails
 * at spawn with an OS error nobody can read — so a directory is resolved to the binary inside it.
 * Returns null when there is no server there.
 */
export function resolveServerBinary(pathOrDirectory: string | undefined): string | null {
  const candidate = (pathOrDirectory ?? "").trim();
  if (!candidate) return null;
  try {
    const stat = statSync(candidate);
    if (stat.isFile()) return candidate;
    if (!stat.isDirectory()) return null;
  } catch { return null; }
  for (const name of process.platform === "win32" ? ["llama-server.exe", "llama-server"] : ["llama-server"]) {
    const inside = join(candidate, name);
    try { if (statSync(inside).isFile()) return inside; } catch { /* try the next name */ }
  }
  return null;
}

/**
 * True when a saved "extra flags" string is really a whole generated command line.
 *
 * An earlier runtime panel wrote its editable command straight back into extraArgs, and extraArgs is
 * appended LAST — so `--model <the model's id>` overrode the real `--model <path to the weights>`,
 * and llama.cpp went looking for a file named after the model. Every launch failed, the duplication
 * compounded on each save, and the setting that broke it looked like something the user had typed.
 */
export function looksLikeGeneratedCommand(extraArgs: string | undefined): boolean {
  const raw = (extraArgs ?? "").trim();
  if (!raw) return false;
  return raw.includes("--model") && (raw.includes("--ctx-size") || raw.includes("--cont-batching") || raw.includes("--jinja"));
}

/**
 * Find already-installed llama.cpp servers without opening a shell or asking the user to type a
 * command. Pass a measured hardware profile to rank LM Studio's several backends against this
 * machine's accelerator; without one they are ranked by version alone.
 */
export function discoverRuntimeExecutables(extraDirs: readonly string[] = [], hardware?: HardwareProfile): string[] {
  const names = process.platform === "win32" ? ["llama-server.exe", "llama-server"] : ["llama-server"];
  const directories = [...extraDirs.map((dir) => dir.replace(/[\\/]+$/, "")), ...runtimeSearchDirectories(preferredBackendTags(hardware))].filter(Boolean);
  const found: string[] = [];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      try { if (existsSync(candidate) && statSync(candidate).isFile() && !found.includes(candidate)) found.push(candidate); } catch { /* unreadable entry */ }
    }
    if (found.length >= 8) return found.slice(0, 8);
  }
  return found.slice(0, 8);
}

export async function probeEndpoint(baseUrl: string, timeoutMs = 2500): Promise<EndpointProbe> {
  const started = Date.now();
  const root = baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${root}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      // 503 (and some builds' 500 "Loading model") means the process is ALIVE and reading weights.
      // Reporting that as unreachable is what used to make Kitten shoot a perfectly healthy 35B in
      // the head five seconds into a two-minute load.
      let detail = "";
      try { detail = (await response.text()).slice(0, 400); } catch { /* body optional */ }
      const loading = response.status === 503 || /loading|not (?:yet )?ready|warming/i.test(detail);
      return { baseUrl, kind: classifyEndpoint(baseUrl), reachable: false, loading, models: [], latencyMs: Date.now() - started, error: `HTTP ${response.status}${loading ? " (loading model)" : ""}` };
    }
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return { baseUrl, kind: classifyEndpoint(baseUrl), reachable: true, models: (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean), latencyMs: Date.now() - started };
  } catch (e) {
    return { baseUrl, kind: classifyEndpoint(baseUrl), reachable: false, models: [], latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── llama-server flag compatibility ─────────────────────────────────────────────────────────────
// llama.cpp renames and deprecates flags constantly (`--no-mmap` → `--load-mode`, `--flash-attn`
// gaining an on/off value, `--spec-type` not existing in older builds). Emitting a flag the user's
// build does not know is how a launch dies with a wall of deprecation noise. So ask the binary what
// it supports, once, and only ever emit flags it actually has.

const flagCache = new Map<string, { mtimeMs: number; flags: Set<string>; helpText: string }>();

/** Every `--flag` the executable advertises in `--help`. Empty set ⇒ unknown (emit everything). */
export function detectServerFlags(executable: string): { flags: Set<string>; helpText: string } {
  try {
    const stat = statSync(executable);
    const cached = flagCache.get(executable);
    if (cached && cached.mtimeMs === stat.mtimeMs) return { flags: cached.flags, helpText: cached.helpText };
    const result = execFileSync(executable, ["--help"], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
    const helpText = String(result ?? "");
    const flags = new Set<string>();
    for (const match of helpText.matchAll(/(--[a-z0-9][a-z0-9-]*)/gi)) flags.add(match[1].toLowerCase());
    flagCache.set(executable, { mtimeMs: stat.mtimeMs, flags, helpText });
    return { flags, helpText };
  } catch {
    // Some builds exit non-zero on --help, or write it to stderr; both land here. An empty set means
    // "unknown", and the plan then emits its normal flags rather than crippling itself.
    return { flags: new Set<string>(), helpText: "" };
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
  /** --n-gpu-layers: "auto" offloads everything that fits; a number is verbatim (0 = pure CPU). */
  gpuLayers?: number | "auto";
  /** Whether the MoE experts run on the CPU at all. "auto" = only when the weights dwarf VRAM. */
  cpuMoe?: "auto" | "on" | "off";
  /**
   * How MANY leading layers keep their experts on the CPU (`--n-cpu-moe N`). "all" is the blanket
   * `--cpu-moe`; a number is the partial split that keeps the remaining experts on the GPU. "auto"
   * (the default) computes the minimum that fits — see autoCpuMoeLayers.
   */
  cpuMoeLayers?: number | "all" | "auto";
  flashAttn?: "auto" | "on" | "off";
  kvCacheType?: "auto" | "q8_0" | "f16" | "q4_0";
  /** --no-kv-offload when "off": keeps the KV cache in system RAM instead of VRAM. */
  kvOffload?: "auto" | "on" | "off";
  /** --threads: generation thread count. "auto" leaves llama.cpp's own default (-1 = all cores). */
  threads?: number | "auto";
  /** --batch-size / --ubatch-size: prompt-processing batch geometry. */
  batchSize?: number | "auto";
  ubatchSize?: number | "auto";
  /** --load-mode: "auto" lets Kitten choose (it disables mmap under a CPU-MoE split, as llama.cpp
   *  itself advises); the rest are passed through verbatim. */
  loadMode?: "auto" | "none" | "mmap" | "mlock" | "mmap+mlock";
  /** --main-gpu: which device holds the model when it is not split. */
  mainGpu?: number | "auto";
  /** --tensor-split: comma-separated per-GPU fractions, e.g. "24,8". */
  tensorSplit?: string;
  /** Raw extra flags appended verbatim at the end of the command (last wins). */
  extraArgs?: string;
  /**
   * A COMPLETE llama-server command line that replaces the generated plan outright. This is what the
   * runtime panel's editable command box writes: appending a hand-edited full command as "extra
   * flags" duplicated every argument and silently pinned a stale command over every other setting.
   */
  argsOverride?: string;
  /** Foreground llama-server slots. "auto" preserves server defaults; 1 is preferred for Kitten's serialized endpoint. */
  parallelSlots?: number | "auto";
  /** Speculative decoder selected by model capability. */
  speculation?: "auto" | "ngram" | "mtp" | "off";
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
  speculation?: "auto" | "ngram" | "mtp" | "off";
  /** Flags the target binary advertises in --help. Empty/absent ⇒ unknown, emit everything. */
  supportedFlags?: Set<string>;
  /** The raw --help text, used to tell a valued flag from a bare boolean across llama.cpp versions. */
  supportedFlagsHelp?: string;
  /** The id this model should be served under (`--alias`), so /v1/models advertises exactly the name
   *  Kitten is configured to request instead of whatever the file happens to be called. */
  modelAlias?: string;
  /** Overrides for tests; production measures the real file and the real device. */
  modelBytes?: number;
  vramBytes?: number;
  /** The model's layer count, when the caller already knows it (tests, cached GGUF inspection). */
  layerCount?: number;
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
  // One header read serves both the context sizing and the MoE split below.
  const ggufMeta = readGgufKvMeta(input.mainModel);
  const blockCount = input.layerCount ?? ggufMeta?.blockCount;

  // Context, expert split and batch geometry are ONE decision, not three. Choosing them in sequence
  // is what produced a 131072-token window whose KV cache ate the card and pushed every expert onto
  // the CPU — measured at 10.9 tok/s where the joint plan reaches 14.7. See autoTune.ts for the sweep.
  const contextSource: RuntimeLaunchPlan["contextSource"] = input.contextTokens === undefined ? "auto" : "explicit";
  const tuned: TuningPlan = planTuning({
    modelBytes: modelBytes ?? 0,
    vramBytes: backend === "cpu" ? 0 : vramBytes,
    ramBytes: hardware?.ramBytes,
    meta: ggufMeta ?? (blockCount ? { architecture: "unknown", blockCount, headCount: 1, headCountKv: 1, embeddingLength: 1 } : null),
    kvBytesPerToken: ggufMeta ? kvBytesPerToken(ggufMeta, kvCacheType === "f16" ? "f16" : "q8_0") : undefined,
    contextTokens: contextSource === "explicit" ? Math.max(2048, Math.min(262144, Math.floor(input.contextTokens!))) : undefined,
    mixtureOfExperts: isMixtureOfExperts(ggufMeta),
  });
  const contextTokens = tuned.contextTokens;
  for (const reason of tuned.reasons) warnings.push(reason);

  if (backend === "unknown") warnings.push("GPU backend was not identified; the runtime will use its safe fallback.");
  if (sidecarMode === "contended") warnings.push("The sidecar shares the main device and will yield during user-blocking generation.");
  if (runtime !== "managed-llama-cpp") return { kind: runtime, backend, mainModel: input.mainModel, sidecarModel: input.sidecarModel, contextTokens, contextSource, parallelSlots: 1, sidecarMode, args: [], warnings };

  // A pinned command line replaces the plan entirely. This is the honest form of "what you see is
  // what runs": the old behaviour appended a hand-edited command as EXTRA flags, so every argument
  // appeared twice, the edit compounded on each save, and no tuning field could ever win against it.
  const override = splitExtraArgs(tuning.argsOverride);
  if (override.length) {
    const pinnedCtxIndex = Math.max(override.indexOf("--ctx-size"), override.indexOf("-c"));
    const pinnedCtx = pinnedCtxIndex >= 0 ? Number(override[pinnedCtxIndex + 1]) : NaN;
    warnings.push("Launch arguments are pinned to a custom command; the tuning fields do not apply until you reset it.");
    return {
      kind: runtime, backend, mainModel: input.mainModel, sidecarModel: input.sidecarModel,
      contextTokens: Number.isFinite(pinnedCtx) && pinnedCtx > 0 ? pinnedCtx : contextTokens,
      contextSource: "explicit", parallelSlots: 1, sidecarMode, args: override, warnings,
    };
  }

  // Only emit flags this binary actually advertises. llama.cpp renames and deprecates constantly, and
  // a flag the build does not know turns a good launch into a wall of deprecation noise.
  const known = input.supportedFlags && input.supportedFlags.size > 0 ? input.supportedFlags : null;
  const supports = (flag: string): boolean => !known || known.has(flag);
  const args: string[] = [];
  const push = (flag: string, ...values: string[]): void => {
    if (!supports(flag)) { warnings.push(`skipped ${flag}: this llama-server build does not advertise it`); return; }
    args.push(flag, ...values);
  };
  args.push("--model", input.mainModel, "--ctx-size", String(contextTokens));
  const parallelSlots = input.tuning?.parallelSlots;
  const resolvedParallelSlots = typeof parallelSlots === "number" && Number.isFinite(parallelSlots) && parallelSlots > 0 ? Math.min(2, Math.floor(parallelSlots)) : 1;
  // Serve the model under the id Kitten is configured to ask for. Without this the server advertises
  // the file's own name, so /v1/models never matches the configured model and every health check has
  // to be lenient about it.
  if (input.modelAlias && input.modelAlias.trim()) push("--alias", input.modelAlias.trim());
  push("--jinja");
  push("--cont-batching");
  push("--metrics");
  // Kitten serializes calls to one endpoint, so four implicit server slots only fragment cache
  // affinity. Auto therefore means one foreground slot; users can opt into two for experiments.
  push("--parallel", String(resolvedParallelSlots));

  // GPU offload: "auto" offloads everything that fits (llama.cpp clamps 999 to the real layer
  // count); an explicit number is the user's call — including 0 for a pure-CPU load.
  const gpuLayers = tuning.gpuLayers !== undefined && tuning.gpuLayers !== "auto" ? Math.max(0, Math.floor(tuning.gpuLayers)) : null;
  if (gpuLayers !== null) {
    push("--n-gpu-layers", String(gpuLayers));
  } else if (backend !== "cpu") {
    // "all that fit" for anything that fits; a real count for a dense model that does not.
    push("--n-gpu-layers", tuned.gpuLayers === "all" ? "999" : String(tuned.gpuLayers));
  }
  // Multi-GPU placement. Both are pure pass-throughs: Kitten has no basis to guess a split.
  if (typeof tuning.mainGpu === "number" && Number.isFinite(tuning.mainGpu) && tuning.mainGpu >= 0) push("--main-gpu", String(Math.floor(tuning.mainGpu)));
  if (tuning.tensorSplit && /^[\d.,\s]+$/.test(tuning.tensorSplit.trim())) push("--tensor-split", tuning.tensorSplit.trim().replace(/\s+/g, ""));
  // Attention on GPU is where flash-attention pays; auto = on for any GPU backend. Newer builds take
  // an on/off/auto VALUE, older ones are a bare boolean — emit whichever this build documents.
  const flashOn = tuning.flashAttn === "on" || (tuning.flashAttn !== "off" && backend !== "cpu" && gpuLayers !== 0);
  if (flashOn) {
    // Newer builds document `--flash-attn [on|off|auto]`; older ones are a bare boolean. Emitting a
    // value the build does not expect is a launch failure, so read its own help text.
    const valued = /--flash-attn[ =]+(?:\[?on\|off|\{?on,)/i.test(input.supportedFlagsHelp ?? "") || (input.supportedFlagsHelp ?? "").includes("--flash-attn on");
    if (valued || !input.supportedFlagsHelp) push("--flash-attn", "on");
    else push("--flash-attn");
  }

  // KV quantization is a CAPACITY lever here, not a quality one: q8_0 is the safe default and roughly
  // halves the cache, which is the difference between a usable context and an OOM on 8 GB. The user
  // can pin f16 (quality/default) or q4_0 (capacity) — q4 is never chosen automatically.
  push("--cache-type-k", kvCacheType);
  push("--cache-type-v", kvCacheType);
  // LM Studio calls this "Offload KV cache to GPU". Off keeps the cache in system RAM, which buys
  // VRAM for weights at the cost of attention speed.
  if (tuning.kvOffload === "off") push("--no-kv-offload");

  // The expert tensors are the bulk of a MoE and the part that does not fit. Pushing them to CPU keeps
  // attention and the dense path resident instead of letting the driver thrash. This is also the
  // heuristic a hand-tuner most often wants to OVERRIDE (measured on the dev box: blanket cpu-moe gave
  // 7 tok/s where the user's own launch gave 30) — so "off" is a first-class choice, not a hack, and
  // "how many layers" is a first-class number rather than an all-or-nothing switch.
  const pinnedLayers = typeof tuning.cpuMoeLayers === "number" && Number.isFinite(tuning.cpuMoeLayers) && tuning.cpuMoeLayers > 0
    ? Math.floor(tuning.cpuMoeLayers) : null;
  const forcedBlanket = tuning.cpuMoe === "on" && tuning.cpuMoeLayers === "all";
  // "off" means off. Otherwise a pinned count wins, then the measured plan.
  // A split is "in play" only when experts actually move. A plan of 0 layers means the model fits,
  // and a model that fits must not inherit any of the settings that exist to rescue one that does not.
  const planWantsSplit = (tuned.cpuMoeLayers !== null && tuned.cpuMoeLayers > 0) || tuned.blanketCpuMoe;
  const wantCpuMoe = tuning.cpuMoe !== "off"
    && backend !== "cpu"
    && (tuning.cpuMoe === "on" || planWantsSplit);
  const usedLoadMode = false;
  if (wantCpuMoe) {
    const layers = pinnedLayers ?? (forcedBlanket ? null : tuned.cpuMoeLayers);
    if (layers !== null && layers > 0 && supports("--n-cpu-moe")) {
      push("--n-cpu-moe", String(layers));
    } else {
      push("--cpu-moe");
      if (tuning.cpuMoe !== "on") warnings.push(`${((modelBytes ?? 0) / 1e9).toFixed(1)} GB of weights against ${((vramBytes ?? 0) / 1e9).toFixed(1)} GB of VRAM: every expert runs on the CPU, so decode is bound by system memory bandwidth.`);
    }
  }
  // An explicit load mode is the user's. Otherwise the plan decides, and it never DISABLES mmap:
  // llama.cpp advises that under CPU tensor overrides, and on the reference machine that advice cost
  // 24s of load against 8s for no decode gain. What it does do is PIN the weights when RAM allows,
  // because with experts on the CPU their residency is what decode speed is made of.
  if (tuning.loadMode && tuning.loadMode !== "auto" && !usedLoadMode) push("--load-mode", tuning.loadMode);
  else if ((!tuning.loadMode || tuning.loadMode === "auto") && !usedLoadMode && wantCpuMoe && tuned.loadMode) push("--load-mode", tuned.loadMode);

  // CPU-side geometry. Every one of these is "leave it alone" by default: llama.cpp's own defaults
  // are tuned for the machine, and a wrong thread count is a silent throughput loss.
  if (typeof tuning.threads === "number" && Number.isFinite(tuning.threads) && tuning.threads > 0) push("--threads", String(Math.floor(tuning.threads)));
  // Batch geometry is llama.cpp's unless the user says otherwise. Forcing a large one looked right and
  // measured 2.3x SLOWER on the reference machine: the bigger compute buffer is VRAM taken from the
  // resident experts, which is where the speed actually lives. See autoTune.ts.
  const splitInPlay = wantCpuMoe && planWantsSplit;
  const batchSize = typeof tuning.batchSize === "number" && tuning.batchSize > 0 ? Math.floor(tuning.batchSize) : splitInPlay ? tuned.batchSize : 0;
  const ubatchSize = typeof tuning.ubatchSize === "number" && tuning.ubatchSize > 0 ? Math.floor(tuning.ubatchSize) : splitInPlay ? tuned.ubatchSize : 0;
  if (batchSize > 0) push("--batch-size", String(batchSize));
  if (ubatchSize > 0) push("--ubatch-size", String(ubatchSize));

  // Prefix reuse is the largest latency lever on this hardware, and none of it is on by default:
  // a similarity threshold so a near-identical prompt lands on the warm slot, a prompt-cache pool, and
  // a disk path so a reopened conversation can restore instead of re-paying a 16k prefill.
  push("--slot-prompt-similarity", "0.25");
  if (input.slotSavePath && supports("--slot-save-path")) {
    // The server will not start if this directory does not exist, and because the managed spawn
    // discards stderr the only symptom was "the runtime never became reachable" — a silent failure
    // with no reason anywhere. Create it here so the flag is always safe to pass.
    try { mkdirSync(input.slotSavePath, { recursive: true }); args.push("--slot-save-path", input.slotSavePath); }
    catch { warnings.push(`KV slots cannot be persisted: ${input.slotSavePath} is not writable. Resume will re-prefill instead of restoring.`); }
  }
  if (input.promptCacheMiB && input.promptCacheMiB > 0) push("--cache-ram", String(Math.floor(input.promptCacheMiB)));

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
  const speculation = input.speculation ?? tuning.speculation ?? "auto";
  if (speculation === "mtp" && (ggufMeta?.nextnPredictLayers ?? 0) > 0) {
    push("--spec-type", "draft-mtp");
    push("--spec-draft-n-max", "1");
  } else if (speculation === "mtp") {
    warnings.push("MTP requested but the GGUF has no nextn prediction layer; speculation disabled.");
  } else if (speculation === "ngram" || (speculation === "auto" && !ggufMeta?.nextnPredictLayers)) {
    push("--spec-type", "ngram-mod");
  }

  if (input.sidecarModel && sidecarMode === "co-resident") push("--model-draft", input.sidecarModel);

  // User extra flags go LAST so they win over every heuristic above (llama.cpp takes the final value
  // of a repeated flag). This is the escape hatch for anything the structured fields don't cover.
  const extra = splitExtraArgs(tuning.extraArgs);
  if (extra.length) args.push(...extra);

  return { kind: runtime, backend, mainModel: input.mainModel, sidecarModel: input.sidecarModel, contextTokens, contextSource, parallelSlots: sidecarMode === "separate-device" || sidecarMode === "co-resident" ? 2 : resolvedParallelSlots, sidecarMode, args, warnings };
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

// ── Picking weights is the only decision the user has to make ───────────────────────────────────
// Everything else about a local launch — which binary, what the model is called, how the experts are
// split — is derivable from the file and the machine. These helpers derive it.

/**
 * The id a model file should be served and requested under. llama.cpp advertises whatever the file is
 * called, quantisation suffix and all; strip that so the configured id reads like a model name
 * ("ornith-1.0-35b") rather than a download artefact ("ornith-1.0-35b-Q5_K_M.gguf").
 */
export function suggestModelId(path: string): string {
  const base = basename(path).replace(/\.gguf$/i, "");
  return base
    // Multi-part downloads and quantisation tags are file facts, not model identity.
    .replace(/[-._]?(?:0000\d|\d{5})-of-\d{5}$/i, "")
    .replace(/[-._](?:i?q\d(?:_[a-z0-9]+)*|f16|bf16|f32|mxfp4(?:_moe)?)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase() || basename(path);
}

export interface WeightsInspection {
  path: string;
  name: string;
  bytes: number;
  exists: boolean;
  /** Architecture and layer count from the GGUF header; absent when the header is unreadable. */
  architecture?: string;
  layerCount?: number;
  trainedContextTokens?: number;
  suggestedModelId: string;
  /** What the machine says this file needs: how many layers of experts must sit on the CPU, and the
   *  context that then fits. Advisory — the settings panel shows it, the user decides. */
  suggested: { cpuMoeLayers: number | "all" | null; contextTokens: number; reason: string };
  vramBytes?: number;
  ramBytes: number;
}

/** Everything the settings panel needs to configure a launch from one picked .gguf. */
export function inspectWeights(path: string, hardware: HardwareProfile = detectHardware()): WeightsInspection {
  const exists = existsSync(path);
  let bytes = 0;
  try { bytes = exists ? statSync(path).size : 0; } catch { bytes = 0; }
  const meta = exists ? readGgufKvMeta(path) : null;
  const vramBytes = hardware.gpus.find((gpu) => gpu.backend !== "unknown" && gpu.vramBytes)?.vramBytes;
  const sized = autoSizeContextTokens({ modelPath: path, modelBytes: bytes || undefined, vramBytes, meta });
  // Only propose a CPU-expert split when the weights genuinely do not fit; a model that fits should
  // stay entirely on the GPU.
  let cpuMoeLayers: number | "all" | null = null;
  if (bytes > 0 && vramBytes && bytes > vramBytes * 0.8) {
    const computed = meta
      ? autoCpuMoeLayers({ modelBytes: bytes, vramBytes, blockCount: meta.blockCount, kvCacheBytes: sized.contextTokens * kvBytesPerToken(meta) })
      : null;
    cpuMoeLayers = computed ?? "all";
  }
  return {
    path,
    name: basename(path),
    bytes,
    exists,
    ...(meta ? { architecture: meta.architecture, layerCount: meta.blockCount } : {}),
    ...(meta?.contextLength ? { trainedContextTokens: meta.contextLength } : {}),
    suggestedModelId: suggestModelId(path),
    suggested: {
      cpuMoeLayers,
      contextTokens: sized.contextTokens,
      reason: sized.reason,
    },
    ...(vramBytes ? { vramBytes } : {}),
    ramBytes: hardware.ramBytes,
  };
}

/**
 * Turn raw llama-server stderr into something a human can read: strip ANSI colour, unescape the
 * literal `\n`/`` sequences that survive a JSON round-trip, drop the timestamp/verbosity
 * prefixes, and collapse blank runs. The unprocessed form is what turned a failure card into a wall
 * of `[34m0.00.080` noise.
 */
export function cleanRuntimeLog(raw: string, maxLines = 40): string {
  if (!raw) return "";
  const unescaped = raw
    .replace(/\\u001b|\\x1b/g, "")
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, "\"");
  const lines = unescaped
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+\.\d{2}\.\d{3}\s*/, "").trimEnd())
    .filter((line) => line.trim().length > 0);
  const deduped: string[] = [];
  for (const line of lines) if (deduped[deduped.length - 1] !== line) deduped.push(line);
  return deduped.slice(-maxLines).join("\n");
}

/**
 * The one line of a runtime log that explains a failure, in the server's own words. Prefers explicit
 * error/failure lines over the banner noise that precedes them.
 */
export function runtimeFailureReason(raw: string): string {
  const cleaned = cleanRuntimeLog(raw, 200);
  if (!cleaned) return "";
  const lines = cleaned.split("\n");
  const salient = [...lines].reverse().find((line) =>
    /error|failed|cannot|unable|unknown argument|invalid|out of memory|no such file|not found|unrecognized/i.test(line)
    && !/^\s*(?:W|warn|DEPRECATED)/i.test(line));
  return (salient ?? lines[lines.length - 1] ?? "").slice(0, 300);
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
