// Model/runtime management primitives used by the native desktop onboarding flow.
// This module is deliberately UI-independent: it can discover existing endpoints, validate model
// files, and produce a safe launch plan without opening a terminal or mutating user configuration.

import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
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
  parallelSlots: number;
  sidecarMode: "separate-device" | "co-resident" | "cpu" | "contended" | "disabled";
  args: string[];
  warnings: string[];
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

export function buildLaunchPlan(input: {
  runtime?: RuntimeKind;
  backend?: ComputeBackend;
  mainModel: string;
  sidecarModel?: string;
  contextTokens?: number;
  sidecarMode?: RuntimeLaunchPlan["sidecarMode"];
  /** Where llama.cpp may persist KV slots, so a reopened conversation restores instead of re-prefilling. */
  slotSavePath?: string;
  /** MiB of host RAM llama.cpp may use as a prompt-cache pool across requests. */
  promptCacheMiB?: number;
  /** Overrides for tests; production measures the real file and the real device. */
  modelBytes?: number;
  vramBytes?: number;
}): RuntimeLaunchPlan {
  const runtime = input.runtime ?? "managed-llama-cpp";
  const backend = input.backend ?? detectHardware().gpus.find((gpu) => gpu.backend !== "unknown")?.backend ?? "cpu";
  const contextTokens = Math.max(2048, Math.min(262144, Math.floor(input.contextTokens ?? 16384)));
  const sidecarMode = input.sidecarModel ? (input.sidecarMode ?? "cpu") : "disabled";
  const warnings: string[] = [];
  if (backend === "unknown") warnings.push("GPU backend was not identified; the runtime will use its safe fallback.");
  if (sidecarMode === "contended") warnings.push("The sidecar shares the main device and will yield during user-blocking generation.");
  if (runtime !== "managed-llama-cpp") return { kind: runtime, backend, mainModel: input.mainModel, sidecarModel: input.sidecarModel, contextTokens, parallelSlots: 1, sidecarMode, args: [], warnings };
  const args = ["--model", input.mainModel, "--ctx-size", String(contextTokens), "--jinja", "--cont-batching"];

  // Four flags were not a launch plan. Everything below is a consequence of the machine actually in
  // front of us: a quantized MoE whose weights are several times the VRAM, so the experts stream from
  // system RAM and the scarce resource is VRAM for attention + KV, not compute.
  const vramBytes = input.vramBytes ?? detectHardware().gpus.find((gpu) => gpu.backend === backend)?.vramBytes;
  const modelBytes = input.modelBytes ?? (existsSync(input.mainModel) ? statSync(input.mainModel).size : undefined);

  if (backend !== "cpu") {
    // Offload every layer that fits; llama.cpp clamps a too-large count to the layers that exist.
    args.push("--n-gpu-layers", "999");
    // Attention on GPU is where flash-attention pays; it is off by default and costs nothing to ask for.
    args.push("--flash-attn", "on");
  }

  // KV quantization is a CAPACITY lever here, not a quality one: q8_0 is the safe default and roughly
  // halves the cache, which is the difference between a usable context and an OOM on 8 GB. q4 is NOT
  // enabled automatically — the evidence for it on multi-file code editing does not exist yet.
  args.push("--cache-type-k", "q8_0", "--cache-type-v", "q8_0");

  // The expert tensors are the bulk of a MoE and the part that does not fit. Pushing them to CPU keeps
  // attention and the dense path resident instead of letting the driver thrash.
  if (backend !== "cpu" && modelBytes !== undefined && vramBytes !== undefined && modelBytes > vramBytes * 0.8) {
    args.push("--cpu-moe");
    warnings.push(`The model is ${(modelBytes / 1e9).toFixed(1)} GB against ${(vramBytes / 1e9).toFixed(1)} GB of VRAM, so its experts run on the CPU. Decode speed will be bound by system memory bandwidth.`);
  }

  // Prefix reuse is the largest latency lever on this hardware, and none of it is on by default:
  // a similarity threshold so a near-identical prompt lands on the warm slot, a prompt-cache pool, and
  // a disk path so a reopened conversation can restore instead of re-paying a 16k prefill.
  args.push("--slot-prompt-similarity", "0.25");
  if (input.slotSavePath) args.push("--slot-save-path", input.slotSavePath);
  if (input.promptCacheMiB && input.promptCacheMiB > 0) args.push("--cache-ram", String(Math.floor(input.promptCacheMiB)));

  if (input.sidecarModel && sidecarMode === "co-resident") args.push("--model-draft", input.sidecarModel);
  return { kind: runtime, backend, mainModel: input.mainModel, sidecarModel: input.sidecarModel, contextTokens, parallelSlots: sidecarMode === "separate-device" || sidecarMode === "co-resident" ? 2 : 1, sidecarMode, args, warnings };
}

/** Spawn a managed runtime without inheriting a console window or arbitrary environment secrets. */
export function spawnManagedRuntime(executable: string, args: string[], cwd: string): { process: ReturnType<typeof spawn>; stop: () => void } {
  // The native app has no console surface. Ignoring output also prevents a verbose server from
  // filling an undrained pipe and stalling inference after a long session.
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "ignore"], detached: process.platform !== "win32", env: { PATH: process.env.PATH ?? "" } });
  const stop = (): void => { if (child.pid && process.platform === "win32") { try { spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {} } else child.kill("SIGTERM"); };
  return { process: child, stop };
}
