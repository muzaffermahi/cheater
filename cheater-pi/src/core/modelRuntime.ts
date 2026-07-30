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
      const vram = Number(row.AdapterRAM);
      return { name, vendor, backend, ...(Number.isFinite(vram) && vram > 0 ? { vramBytes: vram } : {}) };
    }).filter((gpu) => gpu.name !== "Unknown GPU");
  } catch { return []; }
}

export function buildLaunchPlan(input: {
  runtime?: RuntimeKind;
  backend?: ComputeBackend;
  mainModel: string;
  sidecarModel?: string;
  contextTokens?: number;
  sidecarMode?: RuntimeLaunchPlan["sidecarMode"];
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
