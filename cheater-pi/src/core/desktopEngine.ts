// Hidden engine entrypoint for the native desktop app. It owns the existing KittenApp service and
// exposes only typed local IPC; no HTTP listener, browser, or terminal is needed by the user.

import { createConnection, createServer, type Socket } from "node:net";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { KittenApp } from "./app.js";
import { defaultRunner } from "./runner.js";
import { ConversationStore } from "./store/conversationStore.js";
import { kittenHome, storePath } from "./paths.js";
import { DEFAULT_MODELS, KittenLLM, tierSidecar, type KittenModels } from "./llm.js";
import { loadKittenSettings, saveKittenSettings, type KittenSettings, type SettingsUpdate } from "./settings.js";
import { DESKTOP_PROTOCOL_VERSION, encodeFrame, FrameDecoder, type DesktopCommand, type DesktopEvent, type DesktopResponse } from "./desktopProtocol.js";
import type { KittenEvent } from "./events.js";
import { WorkspaceIndex } from "./workspaceIndex.js";
import { inspectWorkspaceChanges } from "./workspaceChanges.js";
import { buildLaunchPlan, cleanRuntimeLog, detectHardware, detectServerFlags, probeEndpoint, inspectModel, inspectWeights, resolveServerBinary, runtimeFailureReason, spawnManagedRuntime, discoverRuntimeExecutables, discoverLocalEndpoints, listModelFiles, suggestModelId, CTX_LADDER, type RuntimeTuning } from "./modelRuntime.js";
import { workspaceFingerprint } from "./planArtifact.js";
import { calibrateRuntime, readCalibration } from "./calibrate.js";
import { calibrationFingerprint } from "./autoTune.js";
import { SidecarControlPlane } from "./sidecarControlPlane.js";
import { runCatalogJob, SIDECAR_JOB_TYPES, SIDECAR_WORKFLOWS, isSidecarJobType, sidecarWorkflow, type SidecarJobType } from "./sidecarJobs.js";
import { downloadModel, parseModelCatalog, type ModelCatalogEntry } from "./modelCatalog.js";
import { listAgents } from "./agents.js";
import type { Runner } from "./app.js";
import { discoverModels, estimateModelB, inspectModelHealth, validateModel } from "./discovery.js";
import { benchmarkCodingBattery, benchmarkModel, benchmarkModelBattery, benchmarkModelBakeoff, benchmarkProjectBattery, latestModelBakeoffSummary, listModelBakeoffs, saveCodingBenchmarkBattery, saveModelBakeoff, saveModelBenchmarkBattery, saveProjectBenchmarkBattery } from "./modelBenchmark.js";
import { profileSummary, recommendModelProfiles } from "./modelProfiles.js";
import { runWorkspaceVerification } from "./workspaceVerification.js";
import { probeCapabilities, probeContextSize, readCachedCapabilities } from "./capabilities.js";
import { gatherSupportInfo } from "./support.js";
import { AgentRuntime, CacheScoutPolicy } from "./agentRuntime.js";
import { SidecarAssist } from "./sidecarAssist.js";

export interface DesktopEngineOptions {
  endpoint?: string;
  store?: string;
  socketPath?: string;
  projectRoot?: string;
  /** Injectable runner for fixture/diagnostic hosts; production uses the local-model runner. */
  runner?: Runner;
  /** Optional model overrides for an installer or a test fixture. */
  models?: Partial<KittenModels>;
  /** Injectable client for deterministic native-engine tests; production constructs the local HTTP client. */
  llm?: KittenLLM;
  /** Opt into the pre-Director sidecar surface for compatibility fixtures only. */
  enableLegacySidecar?: boolean;
  /** Handshake secret. Generated per launch when omitted; never logged and never sent in an event. */
  token?: string;
  /**
   * Where the shell reads the socket path + handshake token from. Defaults to
   * `<kittenHome>/engine.json` for a production launch (no explicit `socketPath`); an explicit
   * path is used verbatim, and `null` keeps a test/fixture engine off the shared file entirely.
   */
  infoPath?: string | null;
  /** How long an unauthenticated connection may stay open before the engine closes it. */
  handshakeTimeoutMs?: number;
  /** Runtime health watchdog interval. Default 15s; 0 disables (tests/fixtures). */
  runtimeWatchdogMs?: number;
}

/**
 * The pushed model-runtime state (`runtime.state` broadcast). App-global and transient — it is
 * deliberately NOT persisted in any conversation's event log; late joiners seed from the enriched
 * `runtime.status` response instead.
 */
export interface RuntimeStatePayload {
  /** `loading` = the server is alive and reading weights (llama.cpp answers 503 meanwhile). */
  phase: "starting" | "probing" | "loading" | "ready" | "failed" | "stopped" | "external";
  endpoint: string;
  model: string;
  sidecarModel?: string;
  /** The server's actual context window for this launch, when known. */
  ctxTokens?: number;
  pid?: number | null;
  /** Something other than the managed process owns the endpoint. */
  external?: boolean;
  /** The runtime's own last words on a failed launch (bounded stderr tail). */
  stderrTail?: string;
  /** Non-fatal advisories (e.g. a pinned context exceeding the server's real n_ctx). */
  warnings?: string[];
  /** How long the current start/load has been running, for an honest "still loading (1m 20s)". */
  elapsedMs?: number;
  /** The runtime's own recent output, ANSI-cleaned — never a raw escape dump. */
  log?: string;
  ts: number;
}

export interface DesktopEngineHandle {
  socketPath: string;
  /** The handshake secret a client must present in its `hello` frame. */
  token: string;
  /** Where the socket path + token were published, when they were. */
  infoPath: string | null;
  close(): Promise<void>;
  /** Withdraw the published token synchronously — safe to call from a `process.on("exit")` handler,
   *  where async work never runs. A stale token file is what makes the NEXT engine unreachable. */
  closeSync(): void;
}

/** The file the native shell reads to find and authenticate to the hidden engine. */
export interface DesktopEngineInfo {
  socketPath: string;
  token: string;
  pid: number;
  startedAt: number;
  protocolVersion: number;
}

function defaultInfoPath(): string {
  return join(kittenHome(), "engine.json");
}

/** One in-flight sidecar workflow: the job running now, plus the pack-wide cancellation flag. */
interface ActiveSidecarWorkflow {
  jobId: string;
  cancelled: boolean;
}

function tokenOk(given: unknown, token: string): boolean {
  if (typeof given !== "string" || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultSocketPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\kitten-engine-${process.env.USERNAME ?? "user"}`;
  return join(kittenHome(), "engine.sock");
}

/**
 * A Unix-domain socket file may outlive a crashed process, but unlinking it blindly also detaches
 * a live listener and lets a second engine steal the address. Probe first: only ECONNREFUSED is a
 * stale socket. Timeouts and permission errors are treated as occupied/unsafe to replace.
 */
async function prepareUnixSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32" || !existsSync(socketPath)) return;
  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(socketPath);
    const finish = (value: boolean): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(value);
    };
    probe.once("connect", () => finish(false));
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(true);
      else { probe.destroy(); reject(error); }
    });
    probe.setTimeout(500, () => finish(false));
  });
  if (!stale) {
    const error = new Error(`listen EADDRINUSE: address already in use ${socketPath}`) as NodeJS.ErrnoException;
    error.code = "EADDRINUSE";
    throw error;
  }
  try { unlinkSync(socketPath); }
  catch (error) { if (existsSync(socketPath)) throw error; }
}

function response(id: string, result: unknown): DesktopResponse {
  // A successful frame always carries `result`. JSON.stringify drops an `undefined` value, and a
  // typed client that requires the field would otherwise report a clean success as a hard failure.
  return { protocolVersion: DESKTOP_PROTOCOL_VERSION, id, ok: true, result: result ?? null };
}

function failure(id: string, error: unknown, code = "ENGINE_ERROR"): DesktopResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { protocolVersion: DESKTOP_PROTOCOL_VERSION, id, ok: false, error: { code, message: message.slice(0, 1000) } };
}

function eventFromKitten(e: KittenEvent): DesktopEvent {
  const { id, type, conversationId, seq, ts, schemaVersion: _schemaVersion, ...payload } = e;
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    eventId: e.id,
    type: e.type,
    conversationId: e.conversationId,
    seq: e.seq,
    timestamp: e.ts,
    payload,
  };
}

function settingsFor(opts: DesktopEngineOptions, projectRoot?: string) {
  return loadKittenSettings(projectRoot ?? opts.projectRoot ?? process.cwd());
}

/** Resolve a project's explicit model config without letting the default values returned by
 * loadKittenSettings overwrite engine/test overrides when the project has no local config. */
function runtimeForProject(root: string, fallback: { models: KittenModels; llm: KittenLLM }, opts: DesktopEngineOptions): { models: KittenModels; llm: KittenLLM } {
  const projectConfig = join(root, ".kitten", "config.json");
  if (!existsSync(projectConfig)) return fallback;
  const settings = loadKittenSettings(root);
  const models = tierSidecar({ ...fallback.models, ...settings.models, ...(opts.endpoint ? { baseUrl: opts.endpoint } : {}) });
  return { models, llm: new KittenLLM(models) };
}

function modelTierMismatch(role: "main" | "sidecar", model: string): string | null {
  const estimatedB = estimateModelB(model);
  if (estimatedB === undefined) return null;
  const valid = role === "main" ? estimatedB >= 35 && estimatedB <= 200 : estimatedB >= 2 && estimatedB <= 9;
  return valid ? null : `${role} model '${model}' is estimated at ${estimatedB}B and does not fit Kitten's ${role === "main" ? "35B-200B main" : "2B-9B sidecar"} tier`;
}

function modelTierWarnings(models: KittenModels): string[] {
  return [
    modelTierMismatch("main", models.main),
    models.sidecar ? modelTierMismatch("sidecar", models.sidecar) : null,
  ].filter((warning): warning is string => Boolean(warning));
}

function bakeoffCandidates(raw: unknown, active: KittenModels): Array<{ role: "main" | "sidecar"; model: string }> {
  const candidates: Array<{ role: "main" | "sidecar"; model: string }> = [];
  const add = (role: "main" | "sidecar", model: string): void => {
    const id = model.trim();
    if (!id || candidates.some((item) => item.role === role && item.model === id)) return;
    if (modelTierMismatch(role, id)) return;
    if (candidates.filter((item) => item.role === role).length >= 3) return;
    if (candidates.length >= 6) return;
    candidates.push({ role, model: id });
  };
  // Always retain the user's current pair, then add discovered same-tier candidates.
  add("main", active.main);
  if (active.sidecar) add("sidecar", active.sidecar);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") continue;
      if (!item || typeof item !== "object") continue;
      const record = item as { role?: unknown; model?: unknown };
      const role = record.role === "sidecar" ? "sidecar" : record.role === "main" ? "main" : null;
      if (role && typeof record.model === "string") add(role, record.model);
    }
  }
  return candidates;
}

function sidecarConcurrency(models: KittenModels): number {
  const canonical = (value: string): string => {
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
      return `${url.protocol}//${url.host}${path}`.toLowerCase();
    } catch {
      return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase();
    }
  };
  const main = canonical(models.baseUrl);
  const dedicated = models.sidecarBaseUrl?.trim() ? canonical(models.sidecarBaseUrl) : undefined;
  return dedicated && dedicated !== main ? 3 : 1;
}

function endpointHostPort(baseUrl: string): { host: string; port: number } {
  const url = new URL(baseUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid runtime endpoint port in ${baseUrl}`);
  return { host: url.hostname || "127.0.0.1", port };
}

/**
 * Wait for a runtime to come up, with two rules the old 5-second version got wrong:
 *   • A server that answers 503 "Loading model" is WORKING, not broken — a 25 GB Q5_K_M takes
 *     minutes to read off disk, and the old loop declared failure and killed it. While the endpoint
 *     reports loading, the deadline is extended: only a dead process or a hard timeout stops us.
 *   • If the process EXITS, stop instantly instead of waiting out the clock for a corpse.
 */
async function waitForEndpoint(
  baseUrl: string,
  timeoutMs = 15_000,
  opts: { alive?: () => boolean; onProgress?: (info: { elapsedMs: number; loading: boolean; detail?: string }) => void; loadingTimeoutMs?: number } = {},
): Promise<Awaited<ReturnType<typeof probeEndpoint>>> {
  const started = Date.now();
  const loadingBudget = opts.loadingTimeoutMs ?? 20 * 60_000; // a very large model on a slow disk
  let deadline = started + timeoutMs;
  let last = await probeEndpoint(baseUrl);
  let announced = 0;
  while (!last.reachable && Date.now() < deadline) {
    if (opts.alive && !opts.alive()) break; // the process died; no point waiting for its endpoint
    if (last.loading) {
      // Loading is progress: keep going up to the (much larger) loading budget.
      deadline = Math.max(deadline, Math.min(started + loadingBudget, Date.now() + 60_000));
    }
    const elapsed = Date.now() - started;
    if (opts.onProgress && elapsed - announced >= 2000) {
      announced = elapsed;
      opts.onProgress({ elapsedMs: elapsed, loading: Boolean(last.loading), detail: last.error });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    last = await probeEndpoint(baseUrl);
  }
  return last;
}

type ManagedRuntimeProcess = ReturnType<typeof spawnManagedRuntime>;
type ManagedRuntimeHandle = { main: ManagedRuntimeProcess; sidecar: ManagedRuntimeProcess | null };
type ManagedRuntimeHolder = { current: ManagedRuntimeHandle | null };

interface ManagedRuntimeLaunchRequest {
  executable: string;
  mainModelPath: string;
  sidecarModelPath?: string;
  baseUrl: string;
  sidecarBaseUrl?: string;
  backend?: Parameters<typeof buildLaunchPlan>[0]["backend"];
  contextTokens?: number;
  /** User launch tuning (settings.runtimeTuning) applied to the MAIN model's plan. */
  tuning?: RuntimeTuning;
  /** The id the served model should advertise, so /v1/models matches what Kitten asks for. */
  modelAlias?: string;
  /** "cpu" (default) keeps the sidecar in RAM so it runs in real parallel with the GPU-bound main. */
  sidecarDevice?: "cpu" | "gpu";
  runtimeRoot: string;
  bootstrapScript?: string;
  probeTimeoutMs?: number;
  /** Live launch progress (loading elapsed, the server's own last words) for the UI. */
  onProgress?: (info: { phase: "starting" | "loading"; elapsedMs: number; detail?: string; log?: string }) => void;
}

interface ManagedRuntimeLaunchResult {
  mainProcess: ManagedRuntimeProcess;
  sidecarProcess: ManagedRuntimeProcess | null;
  baseUrl: string;
  sidecarBaseUrl?: string;
  plan: ReturnType<typeof buildLaunchPlan>;
  probe: Awaited<ReturnType<typeof probeEndpoint>>;
  sidecarProbe?: Awaited<ReturnType<typeof probeEndpoint>>;
}

async function stopOneManagedProcess(active: ManagedRuntimeProcess | null): Promise<void> {
  if (!active) return;
  active.stop();
  if (active.process.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      active.process.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function stopManagedRuntime(holder: { current: ManagedRuntimeHandle | null }): Promise<void> {
  const active = holder.current;
  if (!active) return;
  await Promise.all([stopOneManagedProcess(active.main), stopOneManagedProcess(active.sidecar)]);
  holder.current = null;
}

/**
 * Fold a measured calibration into the tuning for this launch.
 *
 * The static plan is deliberately safe and therefore leaves a few percent on the table — only a
 * measurement can find the exact edge of the cliff, and once one exists it should be what runs. A
 * value the user pinned themselves always wins: calibration informs the "auto" path, it does not
 * overrule a person.
 */
function calibratedTuning(settings: KittenSettings, modelPath: string | undefined): RuntimeTuning {
  const tuning = settings.runtimeTuning;
  if (!modelPath || !existsSync(modelPath)) return tuning;
  if (tuning.cpuMoe === "off") return tuning;
  const pinnedSplit = typeof tuning.cpuMoeLayers === "number" || tuning.cpuMoeLayers === "all";
  if (pinnedSplit) return tuning;
  try {
    const hardware = detectHardware();
    const gpu = hardware.gpus.find((device) => device.backend !== "unknown" && device.vramBytes);
    const record = readCalibration(calibrationFingerprint({
      modelPath, modelBytes: statSync(modelPath).size, gpuName: gpu?.name, vramBytes: gpu?.vramBytes,
    }));
    if (!record) return tuning;
    return { ...tuning, cpuMoe: "on", cpuMoeLayers: record.cpuMoeLayers };
  } catch { return tuning; }
}

/**
 * Hold a submission until the model can actually answer it.
 *
 * A 25 GB MoE takes tens of seconds to load, and Kitten used to start the turn the instant the user
 * pressed Run — straight into `fetch failed` if the server had not bound its socket yet, or
 * `HTTP 503 "Loading model"` if it had. Both surfaced as a failed run beside a model that was about
 * to be perfectly ready. Starting work you cannot do is not resilience, it is a race.
 *
 * Returns true when the endpoint answers, false when the wait was cancelled or ran out. A false is
 * not fatal: the caller proceeds, the request fails honestly, and the reason is the one the server
 * gave rather than a race we created.
 */
async function awaitRuntimeReady(baseUrl: string, timeoutMs: number, signal: AbortSignal | undefined, onWaiting: (elapsedMs: number, loading: boolean) => void): Promise<boolean> {
  const started = Date.now();
  let announced = false;
  for (;;) {
    if (signal?.aborted) return false;
    const probe = await probeEndpoint(baseUrl, 2000);
    if (probe.reachable) return true;
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) return false;
    // Only say something once the wait is long enough to be worth explaining.
    if (elapsed > 1500) { onWaiting(elapsed, Boolean(probe.loading)); announced = true; }
    await new Promise((resolve) => setTimeout(resolve, announced ? 1000 : 400));
  }
}

/** "auto" means the launch plan sizes n_ctx from the machine; a pinned number reaches the server. */
function explicitContextTokens(settings: KittenSettings): number | undefined {
  return typeof settings.contextWindowTokens === "number" && settings.contextWindowTokens > 0 ? settings.contextWindowTokens : undefined;
}

/**
 * The llama-server this machine should use: the configured one if it is still there, otherwise the
 * best one Kitten can find (it ships one itself). Choosing a binary is not a decision worth asking a
 * user to make — the weights are.
 */
function resolveRuntimeExecutable(settings: KittenSettings): { executable?: string; autoDetected: boolean } {
  const configured = resolveServerBinary(settings.managedRuntime.executable);
  if (configured) return { executable: configured, autoDetected: false };
  // The hardware profile is what tells a CUDA build from a CPU-only one among LM Studio's backends.
  const found = discoverRuntimeExecutables([], detectHardware())[0];
  return { executable: found, autoDetected: Boolean(found) };
}

/** The weights to load: the configured file if it still exists, else the largest local .gguf. */
function resolveMainWeights(settings: KittenSettings): { path?: string; autoDetected: boolean } {
  const configured = settings.managedRuntime.mainModelPath;
  if (configured && existsSync(configured)) return { path: configured, autoDetected: false };
  const candidates = listModelFiles([configured, settings.managedRuntime.sidecarModelPath]);
  // Largest first: the quant someone downloaded on purpose is the big one, and a 2B sidecar file
  // sitting in the same tree must never be mistaken for the main model.
  const best = [...candidates].sort((a, b) => b.bytes - a.bytes)[0];
  return { path: best?.path, autoDetected: Boolean(best) };
}

const OOM_STDERR = /out of memory|failed to allocate|cuda\S*\s*alloc|ggml_backend_\S*_buffer/i;

/** Start one managed llama.cpp process (and optionally its dedicated sidecar) with one shared
 * validation/probe path. Manual runtime.start and startup auto-recovery must not drift apart.
 * With an auto-sized context, one OOM step-down retry at the next-lower ladder rung: a mis-estimate
 * costs one retry, never a dead runtime with a hex dump. */
/**
 * The launch currently in flight, so a second caller joins it instead of starting a rival.
 *
 * `launchManagedRuntimeOnce` begins by stopping whatever is running — which is correct for a restart
 * and catastrophic for a race. The engine auto-starts the runtime when it boots, and the shell calls
 * `runtime.ensure` as soon as it activates a conversation, so the two overlapped: the second launch
 * killed the first one's server about two seconds into a fifteen-second load, then the next ensure
 * killed that one, and so on. The symptom was a runtime that "did not become reachable" while
 * llama-server was never alive long enough to be seen in the process list.
 */
let launchInFlight: Promise<ManagedRuntimeLaunchResult> | null = null;

async function launchManagedRuntime(request: ManagedRuntimeLaunchRequest, holder: ManagedRuntimeHolder): Promise<ManagedRuntimeLaunchResult> {
  if (launchInFlight) return launchInFlight;
  const attempt = launchManagedRuntimeInner(request, holder).finally(() => { launchInFlight = null; });
  launchInFlight = attempt;
  return attempt;
}

async function launchManagedRuntimeInner(request: ManagedRuntimeLaunchRequest, holder: ManagedRuntimeHolder): Promise<ManagedRuntimeLaunchResult> {
  try {
    return await launchManagedRuntimeOnce(request, holder);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.contextTokens === undefined && OOM_STDERR.test(message)) {
      const plan = buildLaunchPlan({ runtime: "managed-llama-cpp", backend: request.backend, mainModel: request.mainModelPath });
      const idx = (CTX_LADDER as readonly number[]).indexOf(plan.contextTokens);
      if (idx > 0) return await launchManagedRuntimeOnce({ ...request, contextTokens: CTX_LADDER[idx - 1] }, holder);
    }
    throw error;
  }
}

async function launchManagedRuntimeOnce(request: ManagedRuntimeLaunchRequest, holder: ManagedRuntimeHolder): Promise<ManagedRuntimeLaunchResult> {
  // A configured path can point at the folder the server lives in; that passes an existence check and
  // then fails at spawn with an unreadable OS error. Resolve it to the binary first.
  const executable = resolveServerBinary(request.executable);
  if (!executable) {
    throw new Error(request.executable
      ? `no llama-server was found at ${request.executable} — set the runtime under Settings, Local runtime`
      : "no llama-server is configured");
  }
  request = { ...request, executable };
  if (!request.mainModelPath || !existsSync(request.mainModelPath)) throw new Error("managed main model path does not exist");
  const sidecarBaseUrl = request.sidecarModelPath
    ? (request.sidecarBaseUrl ?? (() => {
      const url = new URL(request.baseUrl);
      const port = Number(url.port || 80);
      url.port = String(port + 1);
      return url.toString();
    })())
    : undefined;
  const endpoint = endpointHostPort(request.baseUrl);
  const sidecarEndpoint = sidecarBaseUrl ? endpointHostPort(sidecarBaseUrl) : undefined;
  // Ask the binary what it supports before composing a command for it.
  const capability = detectServerFlags(request.executable);
  const plan = buildLaunchPlan({ runtime: "managed-llama-cpp", backend: request.backend, mainModel: request.mainModelPath, modelAlias: request.modelAlias, contextTokens: request.contextTokens, tuning: request.tuning, supportedFlags: capability.flags, supportedFlagsHelp: capability.helpText });
  const args = [...plan.args, "--host", endpoint.host, "--port", String(endpoint.port)];
  if (request.bootstrapScript) {
    if (!existsSync(request.bootstrapScript)) throw new Error("managed runtime bootstrap script does not exist");
    args.unshift(request.bootstrapScript);
  }
  await stopManagedRuntime(holder);
  let mainProcess: ManagedRuntimeProcess | null = null;
  let sidecarProcess: ManagedRuntimeProcess | null = null;
  try {
    mainProcess = spawnManagedRuntime(request.executable, args, request.runtimeRoot);
    if (request.sidecarModelPath && sidecarEndpoint) {
      // The clerical 2B sidecar gets a fixed modest window — auto-sizing it with the main model
      // already resident would double-count the same VRAM. Default device is CPU/RAM: a 2B decodes
      // fine on cores, and it means the sidecar genuinely runs in parallel with the GPU-bound main
      // model instead of contending for the same VRAM.
      const sidecarOnCpu = (request.sidecarDevice ?? "cpu") === "cpu";
      const sidecarPlan = buildLaunchPlan({
        runtime: "managed-llama-cpp", backend: request.backend, mainModel: request.sidecarModelPath, contextTokens: request.contextTokens ?? 8192,
        tuning: sidecarOnCpu ? { gpuLayers: 0, cpuMoe: "off", flashAttn: "off" } : undefined,
        supportedFlags: capability.flags, supportedFlagsHelp: capability.helpText,
      });
      const sidecarArgs = [...sidecarPlan.args, "--host", sidecarEndpoint.host, "--port", String(sidecarEndpoint.port)];
      if (request.bootstrapScript) sidecarArgs.unshift(request.bootstrapScript);
      sidecarProcess = spawnManagedRuntime(request.executable, sidecarArgs, request.runtimeRoot);
    }
  } catch (error) {
    if (mainProcess) await stopOneManagedProcess(mainProcess);
    if (sidecarProcess) await stopOneManagedProcess(sidecarProcess);
    throw error;
  }
  holder.current = { main: mainProcess, sidecar: sidecarProcess };
  const alive = (child: ManagedRuntimeProcess | null): boolean => Boolean(child && child.process.exitCode === null && !child.process.killed);
  // Weight loading is the long pole, and it is PROGRESS, not failure: wait patiently, report the wait.
  const probe = await waitForEndpoint(request.baseUrl, request.probeTimeoutMs ?? 15_000, {
    alive: () => alive(mainProcess),
    onProgress: (info) => request.onProgress?.({ phase: info.loading ? "loading" : "starting", elapsedMs: info.elapsedMs, detail: info.detail, log: cleanRuntimeLog(mainProcess?.stderr() ?? "", 6) }),
  });
  const sidecarProbe = sidecarBaseUrl
    ? await waitForEndpoint(sidecarBaseUrl, request.probeTimeoutMs ?? 15_000, { alive: () => alive(sidecarProcess) })
    : undefined;
  if (!probe.reachable || (sidecarProbe && !sidecarProbe.reachable)) {
    const said = [mainProcess?.stderr(), sidecarProcess?.stderr()].filter((text): text is string => Boolean(text && text.trim())).join("\n");
    await stopManagedRuntime(holder);
    // The runtime almost always says why it refused to start — a missing directory, a rejected flag,
    // out of memory. Report ITS OWN last words, cleaned of ANSI/escape noise, not a raw dump.
    const detail = probe.reachable ? (sidecarProbe?.error ?? "sidecar endpoint probe failed") : (probe.error ?? "endpoint probe failed");
    const reason = runtimeFailureReason(said);
    throw new Error(`managed runtime did not become reachable (${detail})${reason ? `: ${reason}` : ""}`);
  }
  return { mainProcess, sidecarProcess, baseUrl: request.baseUrl, sidecarBaseUrl, plan, probe, sidecarProbe };
}

function suggestReadOnlyTaskPlan(conversationId: string, prompt: string, orientation = ""): Array<Record<string, unknown>> {
  const seed = Date.now().toString(36);
  const bounded = prompt.trim().slice(0, 1800);
  const oriented = orientation.trim().slice(0, 5000);
  const context = oriented ? `\n\nBounded sidecar orientation (advisory; never an edit authorization):\n${oriented}` : "";
  const specialist = inferSidecarSpecialist(prompt);
  const specialistId = `${specialist.agent}-${seed}`;
  return [
    {
      id: `explore-${seed}`,
      conversationId,
      agent: "explore",
      objective: `Map the repository and identify the smallest relevant files and constraints for this request:\n${bounded}${context}`,
      acceptanceCriteria: ["List relevant files and symbols", "Identify constraints and likely verification commands"],
      dependencies: [],
      allowedFiles: [],
      forbiddenFiles: [],
      modelTier: "sidecar",
      workspaceMode: "shared-readonly",
    },
    {
      id: specialistId,
      conversationId,
      agent: specialist.agent,
      objective: `${specialist.objective}\nRequest:\n${bounded}${context}`,
      acceptanceCriteria: specialist.acceptanceCriteria,
      dependencies: [`explore-${seed}`],
      allowedFiles: [],
      forbiddenFiles: [],
      modelTier: "sidecar",
      workspaceMode: "shared-readonly",
    },
    {
      id: `verify-${seed}`,
      conversationId,
      agent: "verify",
      objective: `Define the verification receipts that would prove this request is complete. Do not edit files.\nRequest:\n${bounded}${context}`,
      acceptanceCriteria: ["Name concrete tests or checks", "Separate verified evidence from assumptions"],
      dependencies: [specialistId],
      allowedFiles: [],
      forbiddenFiles: [],
      modelTier: "sidecar",
      workspaceMode: "shared-readonly",
    },
  ];
}

/** Select a bounded sidecar role from explicit task intent. This is deliberately deterministic:
 * the small model may enrich the report, but it never gets to choose a broader permission set. */
function inferSidecarSpecialist(prompt: string): {
  agent: "review" | "architect" | "security" | "debug" | "test" | "release" | "docs" | "performance";
  objective: string;
  acceptanceCriteria: string[];
} {
  const text = prompt.toLowerCase();
  if (/\b(security|secret|auth(?:entication|orization)?|permission|threat|vulnerab|cve|injection|xss|csrf)\b/.test(text)) {
    return {
      agent: "security",
      objective: "Perform a read-only security audit of the explorer's findings. Trace trust boundaries, input validation, authentication/authorization, secret handling, and unsafe commands. Separate confirmed evidence from hypotheses; do not edit files.",
      acceptanceCriteria: ["Cite exact security-relevant files and symbols", "Separate confirmed findings from hypotheses", "Recommend bounded remediation and verification"],
    };
  }
  if (/\b(debug|failure|failing|flaky|error|exception|regression|crash|broken|triage|stack trace)\b/.test(text)) {
    return {
      agent: "debug",
      objective: "Use the explorer's findings to reproduce or narrow the reported failure with the safest focused check. Capture actual output, distinguish the fault from symptoms, and do not edit files.",
      acceptanceCriteria: ["Identify a deterministic reproduction or explain why it is unavailable", "Capture concrete command/output evidence", "Name the narrowest next repair step"],
    };
  }
  if (/\b(test|tests|testing|coverage|fixture|assert|spec|verification|regression suite)\b/.test(text)) {
    return {
      agent: "test",
      objective: "Inspect the explorer's findings for coverage gaps and run focused, non-mutating checks. Follow the repository's existing test conventions and report commands and exit status; do not edit files.",
      acceptanceCriteria: ["Identify the closest existing test conventions", "Name missing edge cases", "Report focused verification evidence"],
    };
  }
  if (/\b(release|deploy|deployment|package|packaging|publish|version|migration|rollback|production|compatib)\b/.test(text)) {
    return {
      agent: "release",
      objective: "Audit the explorer's findings for release readiness: packaging, migrations, compatibility, versioning, rollback, and operational checks. Run only safe local checks and do not edit files.",
      acceptanceCriteria: ["List release blockers and their evidence", "Check packaging/version/migration implications", "Return a concrete go/no-go checklist"],
    };
  }
  if (/\b(documentation|docs|readme|guide|example|api reference|changelog|migration note|user-facing text)\b/.test(text)) {
    return {
      agent: "docs",
      objective: "Audit the explorer's findings against the repository's documentation conventions. Locate stale or missing guidance, examples, API contracts, and migration notes; cite exact files and propose bounded edits without modifying files.",
      acceptanceCriteria: ["Identify the exact documentation surfaces involved", "Separate stale facts from missing coverage", "Propose bounded, verifiable documentation changes"],
    };
  }
  if (/\b(performance|latency|throughput|memory|cpu|gpu|slow|speed|profil(?:e|ing)|benchmark|concurren|token rate)\b/.test(text)) {
    return {
      agent: "performance",
      objective: "Inspect the explorer's findings for latency, memory, throughput, context, and concurrency risks. Run bounded non-mutating measurements where available, report methodology and numbers, and do not edit files.",
      acceptanceCriteria: ["Identify the likely performance bottleneck and evidence", "Report bounded measurements and methodology", "Recommend the narrowest measurable improvement"],
    };
  }
  if (/\b(architect|architecture|design|refactor|restructure|modular|migration plan|boundary|dependency graph)\b/.test(text)) {
    return {
      agent: "architect",
      objective: "Turn the explorer's findings into a smallest-safe architecture plan. Map boundaries, data flow, invariants, risks, and exact files/symbols without inventing APIs or editing files.",
      acceptanceCriteria: ["Map the affected boundaries and data flow", "Identify invariants and migration risks", "Propose a minimal ordered implementation sequence"],
    };
  }
  return {
    agent: "review",
    objective: "Review the request and the explorer's repository findings. Identify risks, edge cases, and a bounded implementation path. Do not edit files.",
    acceptanceCriteria: ["Call out risks and missing context", "Propose a minimal implementation sequence"],
  };
}

async function suggestEditableTaskPlan(conversationId: string, prompt: string, root: string, indexes: Map<string, WorkspaceIndex>, orientation = ""): Promise<{ nodes: Array<Record<string, unknown>>; allowedFiles: string[]; note: string }> {
  const index = getWorkspaceIndex(root, indexes);
  if (!index.overview().files) await index.refresh(root);
  const allowedFiles = index.search(prompt, 10).map((hit) => hit.path).filter((path, index, all) => all.indexOf(path) === index).slice(0, 10);
  if (!allowedFiles.length) return { nodes: [], allowedFiles: [], note: "No bounded candidate files were found. Run the read-only plan and choose files explicitly before implementation." };
  const nodes = suggestReadOnlyTaskPlan(conversationId, prompt, orientation);
  const seed = Date.now().toString(36);
  const reviewId = String(nodes[1].id);
  const implementId = `implement-${seed}`;
  const verifyId = `verify-edit-${seed}`;
  const scope = allowedFiles.join(", ");
  nodes.push({
    id: implementId,
    conversationId,
    agent: "general",
    objective: `Implement the requested change using only the approved files below. Preserve existing behavior outside this scope and run the smallest relevant verification.\nRequest:\n${prompt.trim().slice(0, 1800)}\nApproved files:\n${scope}`,
    acceptanceCriteria: ["Only modify approved files", "Implement the requested behavior", "Report concrete files changed and verification receipts"],
    dependencies: [reviewId],
    allowedFiles,
    forbiddenFiles: [".env", ".git"],
    modelTier: "main",
    workspaceMode: "isolated-worktree",
  });
  nodes.push({
    id: verifyId,
    conversationId,
    agent: "verify",
    objective: `Verify the bounded implementation for this request. Do not edit files. Check the approved files and run the smallest relevant tests/build commands.\nRequest:\n${prompt.trim().slice(0, 1800)}\nApproved files:\n${scope}`,
    acceptanceCriteria: ["Run concrete verification", "Report pass/fail evidence and any remaining risk"],
    dependencies: [implementId],
    allowedFiles,
    forbiddenFiles: [],
    modelTier: "sidecar",
    workspaceMode: "shared-readonly",
  });
  return { nodes, allowedFiles, note: `Main-model implementation is bounded to ${allowedFiles.length} indexed file(s); approval is required before execution.` };
}

/**
 * Workspace intelligence is useful only if it feels instantaneous. Keep one index per
 * project in memory and hydrate it from the project's private .cheater cache on first use.
 * The cache is an optimization: every explicit index operation still refreshes from disk,
 * and failures are deliberately non-fatal so a read-only project remains usable.
 */
function workspaceCachePath(root: string): string {
  return join(root, ".cheater", "workspace-index.json");
}

function getWorkspaceIndex(root: string, indexes: Map<string, WorkspaceIndex>): WorkspaceIndex {
  const normalized = root;
  const existing = indexes.get(normalized);
  if (existing) return existing;
  const index = new WorkspaceIndex();
  try { index.load(workspaceCachePath(normalized)); } catch { /* cache is best effort */ }
  indexes.set(normalized, index);
  return index;
}

function persistWorkspaceIndex(root: string, index: WorkspaceIndex): void {
  try { index.save(workspaceCachePath(root)); } catch { /* read-only or transient workspace; keep serving in-memory results */ }
}

let automaticSidecarCounter = 0;

/** Prepare a small, bounded orientation packet before a foreground run. The sidecar is opportunistic:
 * a dedicated/smaller model gets a short JSON pass, while a missing or co-resident sidecar falls back
 * to the same deterministic workspace index. Either way the main model receives better file/context
 * selection without exposing the entire repository or making the user press a toolbox button. */
async function automaticSidecarContext(text: string, root: string, runtime: { models: KittenModels; llm: KittenLLM }, indexes: Map<string, WorkspaceIndex>, scheduler: SidecarControlPlane, signal?: AbortSignal): Promise<string> {
  const bounded = text.trim().slice(0, 2400);
  if (!bounded) return "";
  const index = getWorkspaceIndex(root, indexes);
  if (!index.overview().files) {
    try { await index.refresh(root); persistWorkspaceIndex(root, index); } catch { /* orientation can still use the prompt */ }
  }
  // There is nothing for a sidecar to localize in a genuinely empty project. Returning the
  // deterministic floor avoids an unnecessary 2B request (and its queue/deadline) on every
  // from-scratch task; the main agent already has the full task and the reliable lane will create
  // the first file. Keep sidecar orientation enabled for existing projects, where file ranking is
  // actually useful.
  if (!index.overview().files) {
    // Yield briefly before returning so the preflight remains cancellable at the desktop protocol
    // boundary (the UI can send Stop after receiving `sidecar.preflight:started`). This is still
    // materially cheaper than invoking a model that has no files to rank.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 10);
      const onAbort = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new Error("submission cancelled")); };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (signal?.aborted) throw new Error("submission cancelled");
    return "[SIDECAR ORIENTATION]\nTask class: from-scratch\nCandidate files: none; the workspace is empty, so create the requested deliverable directly.";
  }
  // Automatic orientation is one bounded structured pass. A separate endpoint is preferred for true
  // concurrency, but a configured sidecar must still be
  // useful on the common single-endpoint LM Studio/llama.cpp setup. KittenLLM.sidecar routes to the
  // main endpoint when sidecarBaseUrl is absent; the scheduler serializes these calls so a model
  // loader can swap weights safely instead of receiving concurrent requests.
  const model = runtime.models.sidecar ? runtime.llm : null;
  const id = `auto-${Date.now().toString(36)}-${(automaticSidecarCounter++).toString(36)}`;
  const cancelJob = (): void => { scheduler.cancel(id); };
  if (signal?.aborted) throw new Error("submission cancelled");
  signal?.addEventListener("abort", cancelJob, { once: true });
  try {
    // One structured pass avoids paying three model-load/queue latencies on a co-resident 2B model.
    // Eight seconds is still bounded and cancellation remains immediate; unreachable endpoints fail
    // fast while real local runtimes get enough time to produce their first JSON response.
    const oriented = await runCatalogJob(scheduler, model, index, { id, type: "orient_task", premise: bounded, text: bounded, query: bounded, files: index.list().map((record) => record.path).slice(0, 64), deadlineMs: 8000 });
    if (signal?.aborted) throw new Error("submission cancelled");
    const value = oriented.value.value && typeof oriented.value.value === "object" ? oriented.value.value as { classification?: unknown; files?: unknown; requirements?: unknown } : {};
    const label = typeof value.classification === "string" ? value.classification : "general";
    if (label === "question") return `[SIDECAR ORIENTATION]\nTask class: question\nNo files were selected; answer without modifying the workspace.`;
    const files = Array.isArray(value.files) ? value.files.map((item) => item && typeof item === "object" && "path" in item ? String((item as { path: unknown }).path) : String(item ?? "")).filter(Boolean).slice(0, 12) : [];
    const requirements = value.requirements;
    const reqs = Array.isArray(requirements) ? requirements.map(String).filter(Boolean).slice(0, 8) : [];
    return [
      "[SIDECAR ORIENTATION]",
      `Task class: ${label}; source: ${oriented.source === "sidecar" ? "sidecar model (validated)" : "deterministic floor"}`,
      files.length ? `Candidate files (inspect first, not an edit authorization): ${files.join(", ")}` : "Candidate files: none confidently ranked; discover before editing.",
      reqs.length ? `Explicit requirements: ${reqs.join(" | ")}` : "Explicit requirements: none extracted; preserve existing behavior and verify.",
    ].join("\n");
  } finally {
    signal?.removeEventListener("abort", cancelJob);
  }
}

async function automaticSidecarTitle(text: string, runtime: { models: KittenModels; llm: KittenLLM }, scheduler: SidecarControlPlane): Promise<string> {
  const bounded = text.trim().slice(0, 1200);
  if (!bounded) return "";
  const model = runtime.models.sidecar ? runtime.llm : null;
  const result = await runCatalogJob(scheduler, model, undefined, { id: `title-${Date.now().toString(36)}-${(automaticSidecarCounter++).toString(36)}`, type: "title", premise: bounded, text: bounded, deadlineMs: 1200 });
  return typeof result.value.value === "string" ? result.value.value.replace(/\s+/g, " ").trim().slice(0, 72) : "";
}

/** Keep long-running conversations coherent without spending main-model tokens on clerical history
 * rewriting. The sidecar receives only bounded, already-rendered turn summaries; its result is an
 * advisory preamble and the deterministic ContextBuilder remains the source of truth/fallback. */
async function automaticSidecarCompaction(conversationId: string, app: KittenApp, runtime: { models: KittenModels; llm: KittenLLM }, scheduler: SidecarControlPlane, signal?: AbortSignal): Promise<string> {
  const events = app.getEvents(conversationId, 0);
  if (events.length < 24) return "";
  const history = events.map((event) => {
    if (event.type === "user.message") return `USER: ${event.text}`;
    if (event.type === "assistant.final") return `KITTEN: ${event.text}`;
    if (event.type === "run.completed") return `RUN: ${event.summary} (${event.verified ? "verified" : "unverified"})`;
    if (event.type === "run.failed") return `RUN FAILED: ${event.error}`;
    if (event.type === "run.cancelled") return "RUN CANCELLED";
    return "";
  }).filter(Boolean).join("\n").slice(-18_000);
  if (!history.trim()) return "";
  const model = runtime.models.sidecar ? runtime.llm : null;
  const id = `compact-${Date.now().toString(36)}-${(automaticSidecarCounter++).toString(36)}`;
  const cancel = (): void => { scheduler.cancel(id); };
  if (signal?.aborted) throw new Error("submission cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await runCatalogJob(scheduler, model, undefined, { id, type: "compress_context", premise: conversationId, text: history, maxChars: 5000, deadlineMs: 1800 });
    if (signal?.aborted) throw new Error("submission cancelled");
    const compacted = result.value.value;
    return typeof compacted === "string" && compacted.trim() ? `[SIDECAR COMPACTED HISTORY]\n${compacted.trim().slice(0, 5000)}` : "";
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}



function sanitizeSettingsUpdate(value: unknown): SettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.update requires an object");
  const raw = value as Record<string, unknown>;
  const update: SettingsUpdate = {};
  for (const key of ["baseUrl", "sidecarBaseUrl", "mainModel", "sidecarModel", "embedModel", "runtimeExecutable", "mainModelPath", "sidecarModelPath"] as const) if (typeof raw[key] === "string" && raw[key].trim()) update[key] = raw[key].trim();
  if (raw.approvalPolicy === "ask" || raw.approvalPolicy === "auto-allow" || raw.approvalPolicy === "auto-deny") update.approvalPolicy = raw.approvalPolicy;
  if (typeof raw.contextWindowTokens === "number" && Number.isFinite(raw.contextWindowTokens) && raw.contextWindowTokens > 0) update.contextWindowTokens = Math.floor(raw.contextWindowTokens);
  else if (raw.contextWindowTokens === "auto") update.contextWindowTokens = "auto";
  if (raw.taskCompiler === "off" || raw.taskCompiler === "auto" || raw.taskCompiler === "force") update.taskCompiler = raw.taskCompiler;
  if (raw.webAccess === "allowlist" || raw.webAccess === "open" || raw.webAccess === "off") update.webAccess = raw.webAccess;
  if (raw.fastPath === "auto" || raw.fastPath === "off") update.fastPath = raw.fastPath;
  // Runtime tuning knobs (the llama.cpp control surface).
  const countOrAuto = (value: unknown): number | "auto" | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : value === "auto" ? "auto" : undefined;
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
    typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
  const assign = <K extends keyof SettingsUpdate>(key: K, value: SettingsUpdate[K] | undefined): void => { if (value !== undefined) update[key] = value; };
  assign("gpuLayers", countOrAuto(raw.gpuLayers));
  assign("cpuMoe", oneOf(raw.cpuMoe, ["auto", "on", "off"] as const));
  assign("cpuMoeLayers", raw.cpuMoeLayers === "all" ? "all" : countOrAuto(raw.cpuMoeLayers));
  assign("flashAttn", oneOf(raw.flashAttn, ["auto", "on", "off"] as const));
  assign("kvCacheType", oneOf(raw.kvCacheType, ["auto", "q8_0", "f16", "q4_0"] as const));
  assign("kvOffload", oneOf(raw.kvOffload, ["auto", "on", "off"] as const));
  assign("threads", countOrAuto(raw.threads));
  assign("batchSize", countOrAuto(raw.batchSize));
  assign("ubatchSize", countOrAuto(raw.ubatchSize));
  assign("loadMode", oneOf(raw.loadMode, ["auto", "none", "mmap", "mlock", "mmap+mlock"] as const));
  assign("mainGpu", countOrAuto(raw.mainGpu));
  assign("parallelSlots", countOrAuto(raw.parallelSlots));
  assign("speculation", oneOf(raw.speculation, ["auto", "ngram", "mtp", "off"] as const));
  if (typeof raw.tensorSplit === "string") update.tensorSplit = raw.tensorSplit.trim();
  assign("sidecarDevice", oneOf(raw.sidecarDevice, ["cpu", "gpu"] as const));
  if (typeof raw.extraArgs === "string") update.extraArgs = raw.extraArgs.trim();
  if (typeof raw.argsOverride === "string") update.argsOverride = raw.argsOverride.trim();
  if (!Object.keys(update).length) throw new Error("settings.update contained no valid non-secret settings");
  // Settings are a durable source of truth, so reject a known-size model that would
  // put either lane outside Kitten's supported contract. Unknown-size IDs remain
  // allowed because many hosted/local providers do not encode parameter count.
  const mainTierError = update.mainModel ? modelTierMismatch("main", update.mainModel) : null;
  const sidecarTierError = update.sidecarModel ? modelTierMismatch("sidecar", update.sidecarModel) : null;
  if (mainTierError) throw new Error(mainTierError);
  if (sidecarTierError) throw new Error(sidecarTierError);
  return update;
}

export async function startDesktopEngine(opts: DesktopEngineOptions = {}): Promise<DesktopEngineHandle> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  await prepareUnixSocket(socketPath);
  const settings = loadKittenSettings(opts.projectRoot ?? process.cwd());
  // Injected runners/LLMs are test and embedding compatibility surfaces; production launches do
  // not provide either, so the user-facing desktop path remains sidecar-free by default.
  const legacySidecarEnabled = opts.enableLegacySidecar ?? Boolean(opts.runner || opts.llm || opts.models?.sidecar || opts.models?.sidecarBaseUrl);
  const initialModels = tierSidecar({ ...DEFAULT_MODELS, ...settings.models, ...opts.models, baseUrl: opts.endpoint ?? opts.models?.baseUrl ?? settings.models.baseUrl });
  const runtime = { models: initialModels, llm: opts.llm ?? new KittenLLM(initialModels) };
  // Keep the policy layer alive in the native engine even when no optional cache capability is
  // advertised; adapters can enable it later without changing the desktop payload shape.
  const policyRuntime = new AgentRuntime().register(new CacheScoutPolicy());
  policyRuntime.setEnabled("cache-scout", process.env.KITTEN_CACHE_SCOUT !== "0");
  const store = ConversationStore.open(opts.store ?? storePath());
  let appRef: KittenApp | null = null;
  const app = new KittenApp({
    store,
    runner: opts.runner ?? ((ctx) => {
      const projectRoot = appRef?.getConversation(ctx.conversationId)?.projectRoot ?? opts.projectRoot ?? process.cwd();
      const projectSettings = loadKittenSettings(projectRoot);
      return defaultRunner(runtimeForProject(projectRoot, runtime, opts).llm, { webAccess: projectSettings.webAccess, fastPath: projectSettings.fastPath })(ctx);
    }),
    projectRoot: opts.projectRoot ?? process.cwd(),
    model: runtime.models.main,
    ...(legacySidecarEnabled ? { sidecarModel: runtime.models.sidecar } : {}),
    // "auto": interim harness value until a launched/probed server reports its true n_ctx (the
    // reconcile in pushRuntimeState overwrites this with the measured number).
    contextWindowTokens: typeof settings.contextWindowTokens === "number" ? settings.contextWindowTokens : 16384,
    approvalPolicy: settings.approvalPolicy,
    taskCompiler: settings.taskCompiler,
    ...(legacySidecarEnabled ? { sidecarAssist: new SidecarAssist({ llm: runtime.llm, index: (projectRoot) => getWorkspaceIndex(projectRoot, indexes) }) } : {}),
    // Only hand the compiler an index that has actually been populated: an empty one would rank
    // nothing while looking like grounding succeeded. `indexes` is captured, not read, at construction.
    workspaceIndex: (projectRoot) => {
      const index = indexes.get(projectRoot);
      return index && index.overview().files > 0 ? index : undefined;
    },
  });
  appRef = app;

  const token = opts.token ?? randomBytes(24).toString("hex");
  const infoPath = opts.infoPath === null ? null : (opts.infoPath ?? (opts.socketPath ? null : defaultInfoPath()));
  const handshakeTimeoutMs = Math.max(250, opts.handshakeTimeoutMs ?? 10_000);
  const clients = new Set<Socket>();
  const unauthenticated = new Set<Socket>();
  // Stop must stop the whole workflow, not just the step that happens to be running when the user
  // presses it, so the pack's remaining steps observe one shared cancellation flag.
  const indexes = new Map<string, WorkspaceIndex>();
  const sidecar = new SidecarControlPlane(sidecarConcurrency(initialModels));
  const sidecarWorkflowActive = new Map<string, ActiveSidecarWorkflow>();
  const taskControllers = new Map<string, AbortController>();
  const submitControllers = new Map<string, AbortController>();
  const modelDownloadControllers = new Map<string, AbortController>();
  const verificationControllers = new Map<string, AbortController>();
  const benchmarkControllers = new Map<string, AbortController>();
  /** In-flight tuning measurements, so a long calibration can be cancelled from the panel. */
  const calibrationControllers = new Map<string, AbortController>();
  const managedRuntime: { current: ManagedRuntimeHandle | null } = { current: null };
  const broadcast = (e: ReturnType<typeof eventFromKitten>): void => {
    const frame = encodeFrame(e);
    for (const client of clients) if (!client.destroyed) client.write(frame);
  };
  const unsubscribe = app.subscribe((e) => broadcast(eventFromKitten(e)));

  // ── runtime.state: the pushed llama.cpp lifecycle ──────────────────────────────────────────────
  // Broadcast on change only (same channel as bakeoff/download progress: no conversationId, not
  // persisted). `last` doubles as the late-joiner seed via the enriched runtime.status response.
  const runtimeState: { last: RuntimeStatePayload | null; launching: boolean } = { last: null, launching: false };
  const pushRuntimeState = (next: Omit<RuntimeStatePayload, "ts" | "endpoint" | "model"> & { endpoint?: string; model?: string }): void => {
    const payload: RuntimeStatePayload = {
      endpoint: next.endpoint ?? runtime.models.baseUrl,
      model: next.model ?? runtime.models.main,
      ...(legacySidecarEnabled && runtime.models.sidecar ? { sidecarModel: runtime.models.sidecar } : {}),
      ...next,
      ts: Date.now(),
    };
    // A loading tick carries a changing elapsed time, so it must not be deduped away.
    const key = (s: RuntimeStatePayload): string => `${s.phase}|${s.endpoint}|${s.model}|${s.ctxTokens ?? 0}|${s.pid ?? 0}|${s.external ? 1 : 0}|${s.phase === "loading" ? s.elapsedMs ?? 0 : 0}`;
    if (runtimeState.last && key(runtimeState.last) === key(payload)) { runtimeState.last = payload; return; }
    runtimeState.last = payload;
    broadcast({ protocolVersion: DESKTOP_PROTOCOL_VERSION, eventId: `runtime-${payload.ts.toString(36)}-${payload.phase}`, type: "runtime.state", timestamp: payload.ts, payload: payload as unknown as Record<string, unknown> });
    // Close the context loop: once an endpoint is live, read its ACTUAL n_ctx from /props and let the
    // harness budget follow the server instead of the configured wish (llama.cpp may clamp --ctx-size
    // to the model's training window, and an external LM Studio was never ours to size). Re-pushing
    // with the probed value is loop-safe: an unchanged ctx hits the identical-key early return above.
    if (payload.phase === "ready" || payload.phase === "external") {
      const endpoint = payload.endpoint;
      const timer = setTimeout(async () => {
        try {
          const probed = await probeContextSize(endpoint, runtime.models.apiKey);
          if (!probed || probed <= 0) return;
          app.setContextWindowTokens(probed);
          if (!runtimeState.last || (runtimeState.last.phase !== "ready" && runtimeState.last.phase !== "external")) return;
          const pinned = explicitContextTokens(settingsFor(opts));
          pushRuntimeState({
            phase: runtimeState.last.phase, pid: runtimeState.last.pid ?? null, external: runtimeState.last.external,
            endpoint, ctxTokens: probed,
            ...(pinned && pinned > probed ? { warnings: [`contextWindowTokens ${pinned} exceeds the server's n_ctx ${probed}; the harness budget follows the server`] } : {}),
          });
        } catch { /* the plan value stands */ }
      }, 50);
      timer.unref();
    }
  };

  // Watchdog: the UI must learn within one interval that llama.cpp died (or came back) even when
  // nothing else is happening. Edge-triggered with a 2-strike debounce so a llama.cpp that is slow
  // to answer /models mid-generation never flaps the status line.
  const watchdogMs = opts.runtimeWatchdogMs ?? 15_000;
  let watchdogStrikes = 0;
  let watchdogProbing = false;
  const watchdog = watchdogMs > 0 ? setInterval(async () => {
    if (!clients.size || runtimeState.launching || watchdogProbing) return;
    watchdogProbing = true;
    try {
      const probe = await probeEndpoint(runtime.models.baseUrl, 2000);
      const managedRunning = Boolean(managedRuntime.current?.main && managedRuntime.current.main.process.exitCode === null);
      if (probe.reachable) {
        watchdogStrikes = 0;
        if (!runtimeState.last || runtimeState.last.phase === "failed" || runtimeState.last.phase === "stopped") {
          pushRuntimeState(managedRunning
            ? { phase: "ready", pid: managedRuntime.current?.main.process.pid ?? null }
            : { phase: "external", external: true });
        }
      } else if (runtimeState.last && (runtimeState.last.phase === "ready" || runtimeState.last.phase === "external")) {
        watchdogStrikes++;
        if (watchdogStrikes >= 2) {
          watchdogStrikes = 0;
          pushRuntimeState({ phase: "failed", stderrTail: managedRuntime.current?.main.stderr()?.split(/\r?\n/).filter(Boolean).slice(-8).join("\n") || "endpoint stopped responding" });
        }
      }
    } catch { /* the watchdog itself must never throw */ }
    finally { watchdogProbing = false; }
  }, watchdogMs) : null;
  watchdog?.unref();

  // The local socket is reachable by other processes running as this user, and on Windows the
  // default named-pipe ACL is wider still. Nothing is served — not even liveness, and above all not
  // the event stream, which carries prompts, code and diffs — until a connection presents the
  // per-launch handshake token published in the engine info file.
  const server = createServer((socket) => {
    unauthenticated.add(socket);
    const deadline = setTimeout(() => {
      if (clients.has(socket)) return;
      try { socket.write(encodeFrame(failure("handshake", "engine handshake timed out", "EUNAUTHORIZED"))); } catch { /* closing anyway */ }
      socket.destroy();
    }, handshakeTimeoutMs);
    deadline.unref();
    const forget = (): void => { clearTimeout(deadline); clients.delete(socket); unauthenticated.delete(socket); };
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      let frames;
      try { frames = decoder.push(chunk); } catch (e) { socket.destroy(new Error(String(e))); return; }
      for (const frame of frames) {
        const cmd = frame as DesktopCommand;
        const id = typeof cmd.id === "string" && cmd.id ? cmd.id : "unauthenticated";
        if (cmd.type === "hello" || !clients.has(socket)) {
          if (cmd.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
            socket.write(encodeFrame(failure(id, `unsupported protocol version ${cmd.protocolVersion}`)));
            continue;
          }
          // One wrong or missing token closes the connection: a local process must not be able to
          // probe the engine, guess the secret, or linger on the channel.
          if (cmd.type !== "hello" || !tokenOk((cmd.payload as { token?: unknown } | undefined)?.token, token)) {
            socket.write(encodeFrame(failure(id, cmd.type === "hello" ? "engine handshake token is invalid" : "engine handshake required", "EUNAUTHORIZED")));
            socket.destroy();
            return;
          }
          clearTimeout(deadline);
          unauthenticated.delete(socket);
          clients.add(socket);
          socket.write(encodeFrame(response(id, { authenticated: true, protocolVersion: DESKTOP_PROTOCOL_VERSION, pid: process.pid })));
          continue;
        }
        void handleCommand(cmd, app, socket, { runtime, opts, indexes, sidecar, sidecarWorkflowActive, taskControllers, submitControllers, modelDownloadControllers, verificationControllers, benchmarkControllers, calibrationControllers, managedRuntime, runtimeState, pushRuntimeState, emit: (type, payload) => broadcast({ protocolVersion: DESKTOP_PROTOCOL_VERSION, eventId: `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, type, timestamp: Date.now(), payload }) });
      }
    });
    socket.on("close", forget);
    socket.on("error", forget);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) {
    // Losing the socket lock (another engine already owns it) must not leave this process holding an
    // open store handle and a live subscription: the loser exits without touching the live run ledger.
    unsubscribe();
    sidecar.cancelAll();
    app.close();
    throw error;
  }

  // Recovery runs only once the socket is bound. Binding is also the single-instance lock: a second
  // engine that loses the race must not flip the live instance's in-flight runs to `interrupted`.
  app.recover();
  if (infoPath) {
    const info: DesktopEngineInfo = { socketPath, token, pid: process.pid, startedAt: Date.now(), protocolVersion: DESKTOP_PROTOCOL_VERSION };
    writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
  }

  // A configured local runtime should be a remembered app setting, not a per-launch ritual. Do not
  // auto-start injected test engines; production native launches recover the configured process only
  // when its executable and main model still exist. An already-responsive endpoint is left alone.
  if (!opts.runner && !opts.llm && settings.managedRuntime.executable && settings.managedRuntime.mainModelPath
    && existsSync(settings.managedRuntime.executable) && existsSync(settings.managedRuntime.mainModelPath)) {
    try {
      const existing = await probeEndpoint(runtime.models.baseUrl);
      if (existing.reachable) {
        pushRuntimeState({ phase: "external", external: true });
      } else {
        const tierWarnings = modelTierWarnings(runtime.models);
        if (tierWarnings.length) throw new Error(tierWarnings.join("; "));
        const sidecarModelPath = legacySidecarEnabled && settings.managedRuntime.sidecarModelPath && existsSync(settings.managedRuntime.sidecarModelPath)
          ? settings.managedRuntime.sidecarModelPath : undefined;
        runtimeState.launching = true;
        pushRuntimeState({ phase: "starting" });
        const launched = await launchManagedRuntime({
          executable: settings.managedRuntime.executable,
          mainModelPath: settings.managedRuntime.mainModelPath,
          sidecarModelPath,
          // The startup path was the one launch that never set an alias, so /v1/models advertised a
          // file path where every other path advertises the configured model id.
          modelAlias: runtime.models.main,
          baseUrl: runtime.models.baseUrl,
          sidecarBaseUrl: sidecarModelPath ? runtime.models.sidecarBaseUrl : undefined,
          contextTokens: explicitContextTokens(settings),
          tuning: calibratedTuning(settings, settings.managedRuntime.mainModelPath),
          sidecarDevice: settings.runtimeTuning.sidecarDevice,
          runtimeRoot: opts.projectRoot ?? process.cwd(),
          // The same patience as every other launch path. This one was left at 30s, so the startup
          // auto-start gave up on a 25 GB model that was loading perfectly well and then KILLED it —
          // the server's last words were `load_model: loading model`, and Kitten was the thing that
          // stopped it. A timeout that shoots a healthy process is worse than no timeout at all.
          probeTimeoutMs: 240_000,
          onProgress: (info) => pushRuntimeState({ phase: info.phase === "loading" ? "loading" : "starting", elapsedMs: info.elapsedMs, log: info.log }),
        }, managedRuntime);
        runtime.models = { ...runtime.models, baseUrl: launched.baseUrl, sidecarBaseUrl: launched.sidecarBaseUrl };
        runtime.llm = new KittenLLM(runtime.models);
        sidecar.setMaxConcurrent(sidecarConcurrency(runtime.models));
        app.setDefaultModel(runtime.models.main);
        if (legacySidecarEnabled) app.setSidecarModel(runtime.models.sidecar);
        pushRuntimeState({ phase: "ready", pid: launched.mainProcess.process.pid, ctxTokens: launched.plan.contextTokens });
      }
    } catch (error) {
      // Startup recovery is opportunistic: the native shell still opens so the user can inspect or
      // repair the runtime path from Model setup and press Start local runtime explicitly. The pushed
      // failed state is what makes that repairable instead of silent.
      pushRuntimeState({ phase: "failed", stderrTail: error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200) });
    } finally {
      runtimeState.launching = false;
    }
  }

  return {
    socketPath,
    token,
    infoPath,
    async close() {
      unsubscribe();
      if (watchdog) clearInterval(watchdog);
      sidecar.cancelAll();
      await stopManagedRuntime(managedRuntime);
      for (const controller of submitControllers.values()) controller.abort("engine-closing");
      for (const controller of taskControllers.values()) controller.abort("engine-closing");
      for (const controller of modelDownloadControllers.values()) controller.abort("engine-closing");
      for (const controller of verificationControllers.values()) controller.abort("engine-closing");
      for (const controller of benchmarkControllers.values()) controller.abort("engine-closing");
      for (const client of clients) client.destroy();
      for (const client of unauthenticated) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.close();
      if (infoPath) { try { unlinkSync(infoPath); } catch { /* a later launch overwrites it anyway */ } }
      if (process.platform !== "win32") { try { unlinkSync(socketPath); } catch {} }
    },
    /** The one thing that MUST happen on the way out, in a form an `exit` handler can call: stop
     *  advertising a token that no longer opens anything. Everything else the OS reclaims. */
    closeSync() {
      if (infoPath) { try { unlinkSync(infoPath); } catch { /* a later launch overwrites it anyway */ } }
    },
  };
}

async function handleCommand(frame: DesktopCommand, app: KittenApp, socket: Socket, context: { runtime: { models: KittenModels; llm: KittenLLM }; opts: DesktopEngineOptions; indexes: Map<string, WorkspaceIndex>; sidecar: SidecarControlPlane; sidecarWorkflowActive: Map<string, ActiveSidecarWorkflow>; taskControllers: Map<string, AbortController>; submitControllers: Map<string, AbortController>; modelDownloadControllers: Map<string, AbortController>; verificationControllers: Map<string, AbortController>; benchmarkControllers: Map<string, AbortController>; calibrationControllers: Map<string, AbortController>; managedRuntime: { current: ManagedRuntimeHandle | null }; runtimeState: { last: RuntimeStatePayload | null; launching: boolean }; pushRuntimeState: (next: Omit<RuntimeStatePayload, "ts" | "endpoint" | "model"> & { endpoint?: string; model?: string }) => void; emit: (type: string, payload: unknown) => void }): Promise<void> {
  const { runtime, opts, indexes, sidecar, sidecarWorkflowActive, taskControllers, submitControllers, modelDownloadControllers, verificationControllers, benchmarkControllers, calibrationControllers, managedRuntime, runtimeState, pushRuntimeState } = context;
  const legacySidecarEnabled = opts.enableLegacySidecar ?? Boolean(opts.runner || opts.llm || opts.models?.sidecar || opts.models?.sidecarBaseUrl);
  if (frame.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
    socket.write(encodeFrame(failure(frame.id, `unsupported protocol version ${frame.protocolVersion}`)));
    return;
  }
  try {
    const p = (frame.payload ?? {}) as Record<string, unknown>;
    let result: unknown;
    switch (frame.type) {
      case "health": result = { protocolVersion: DESKTOP_PROTOCOL_VERSION, pid: process.pid, ready: true }; break;
      case "agent.list": result = listAgents(Boolean(p.includeHidden), typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot : opts.projectRoot ?? process.cwd()); break;
      case "settings.inspect": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const current = settingsFor(opts, projectRoot);
        const active = runtimeForProject(projectRoot, runtime, opts);
        result = {
          models: { baseUrl: active.models.baseUrl, sidecarBaseUrl: active.models.sidecarBaseUrl, main: active.models.main, sidecar: active.models.sidecar, embed: active.models.embed },
          managedRuntime: current.managedRuntime,
          approvalPolicy: current.approvalPolicy,
          contextWindowTokens: current.contextWindowTokens,
          /** The server's measured n_ctx for the current launch, when a runtime is up. */
          effectiveContextTokens: runtimeState.last?.ctxTokens ?? null,
          taskCompiler: current.taskCompiler,
          webAccess: current.webAccess,
          runtimeTuning: current.runtimeTuning,
          warnings: [...current.warnings, ...modelTierWarnings(active.models)],
        };
        break;
      }
      case "settings.update": {
        const update = sanitizeSettingsUpdate(p.update);
        const root = typeof p.projectRoot === "string" ? p.projectRoot : (opts.projectRoot ?? process.cwd());
        const scope = p.scope === "project" ? "project" : "user";
        const before = loadKittenSettings(root);
        const mergedModels = {
          ...before.models,
          ...(update.mainModel ? { main: update.mainModel } : {}),
          ...(update.sidecarModel ? { sidecar: update.sidecarModel } : {}),
        };
        const mergedTierWarnings = modelTierWarnings(mergedModels);
        if (mergedTierWarnings.length) throw new Error(mergedTierWarnings.join("; "));
        saveKittenSettings(update, scope, root);
        const fresh = loadKittenSettings(root);
        runtime.models = tierSidecar(fresh.models);
        runtime.llm = new KittenLLM(runtime.models);
        sidecar.setMaxConcurrent(sidecarConcurrency(runtime.models));
        app.setApprovalPolicy(fresh.approvalPolicy);
        app.setDefaultModel(runtime.models.main);
        if (legacySidecarEnabled) app.setSidecarModel(runtime.models.sidecar);
        // "auto" keeps the harness on the live server's measured n_ctx (or the interim default).
        app.setContextWindowTokens(typeof fresh.contextWindowTokens === "number" ? fresh.contextWindowTokens : runtimeState.last?.ctxTokens ?? 16384);
        app.setTaskCompiler(fresh.taskCompiler);
        result = {
          models: { baseUrl: runtime.models.baseUrl, sidecarBaseUrl: runtime.models.sidecarBaseUrl, main: runtime.models.main, sidecar: runtime.models.sidecar, embed: runtime.models.embed },
          managedRuntime: fresh.managedRuntime,
          approvalPolicy: fresh.approvalPolicy,
          contextWindowTokens: fresh.contextWindowTokens,
          effectiveContextTokens: runtimeState.last?.ctxTokens ?? null,
          taskCompiler: fresh.taskCompiler,
          webAccess: fresh.webAccess,
          runtimeTuning: fresh.runtimeTuning,
          warnings: [...fresh.warnings, ...modelTierWarnings(runtime.models)],
        };
        break;
      }
      case "model.probe": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        result = await probeEndpoint(String(p.baseUrl ?? active.models.baseUrl));
        break;
      }
      case "model.local-discover": {
        const candidates = Array.isArray(p.candidates) ? p.candidates.map(String) : undefined;
        result = await discoverLocalEndpoints(candidates, typeof p.timeoutMs === "number" ? Math.max(200, Math.min(3000, p.timeoutMs)) : 900);
        break;
      }
      case "model.discover": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const baseUrl = String(p.baseUrl ?? active.models.baseUrl).trim();
        if (!baseUrl) throw new Error("model.discover requires a baseUrl");
        const discoveryModels = { ...active.models, baseUrl };
        result = await discoverModels(new KittenLLM(discoveryModels), typeof p.provider === "string" && p.provider.trim() ? p.provider.trim() : "local");
        break;
      }
      case "model.validate": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const role = p.role === "sidecar" ? "sidecar" : "main";
        if (role === "sidecar" && !legacySidecarEnabled) { result = { valid: false, verified: false, role, error: "sidecar runtime is disabled" }; break; }
        const model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : role === "sidecar" ? active.models.sidecar : active.models.main;
        const endpoint = typeof p.baseUrl === "string" && p.baseUrl.trim() ? p.baseUrl.trim() : role === "sidecar" && active.models.sidecarBaseUrl ? active.models.sidecarBaseUrl : active.models.baseUrl;
        if (!model) { result = { valid: false, verified: false, role, error: "no model configured" }; break; }
        const client = endpoint === active.models.baseUrl ? active.llm : new KittenLLM({ ...active.models, baseUrl: endpoint, main: model, sidecar: model });
        result = { role, model, endpoint, ...(await validateModel(client, model, typeof p.provider === "string" && p.provider.trim() ? p.provider.trim() : "local", undefined, { probeAdvertised: p.probe === true, timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined })) };
        break;
      }
      case "model.health": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const role = p.role === "sidecar" ? "sidecar" : "main";
        if (role === "sidecar" && !legacySidecarEnabled) { result = { endpoint: active.models.baseUrl, role, configured: "", endpointReachable: false, rows: [], recommendations: [], warning: "sidecar runtime is disabled" }; break; }
        const configured = role === "sidecar" ? active.models.sidecar : active.models.main;
        const endpoint = role === "sidecar" && active.models.sidecarBaseUrl ? active.models.sidecarBaseUrl : active.models.baseUrl;
        if (!configured) { result = { endpoint, role, configured: "", endpointReachable: false, rows: [], recommendations: [], warning: "no model configured" }; break; }
        const client = endpoint === active.models.baseUrl ? active.llm : new KittenLLM({ ...active.models, baseUrl: endpoint, main: configured, sidecar: configured });
        result = await inspectModelHealth(client, role, configured, { timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined, maxCandidates: typeof p.maxCandidates === "number" ? p.maxCandidates : undefined });
        break;
      }
      case "model.select": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const role = p.role === "sidecar" ? "sidecar" : "main";
        const model = String(p.model ?? "").trim();
        if (!model) throw new Error("model.select requires a model id");
        const tierError = modelTierMismatch(role, model);
        if (p.allowMismatch !== true && tierError) throw new Error(`${tierError}; pass an explicit override only for diagnostics`);
        if (role === "sidecar" && !legacySidecarEnabled) throw new Error("sidecar runtime is disabled; configure an explicit legacy sidecar to use this lane");
        const endpoint = role === "sidecar" && active.models.sidecarBaseUrl ? active.models.sidecarBaseUrl : active.models.baseUrl;
        const client = endpoint === active.models.baseUrl ? active.llm : new KittenLLM({ ...active.models, baseUrl: endpoint, main: model, sidecar: model });
        const validation = await validateModel(client, model, typeof p.provider === "string" && p.provider.trim() ? p.provider.trim() : "local", undefined, { probeAdvertised: true, timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : 45_000 });
        // A wrong name is refused. A right name whose weights are still loading is accepted with an
        // honest warning: a cold 35B cannot answer inside a selection dialog, and refusing to save it
        // left the user unable to configure the model they actually have.
        if (!validation.valid) throw new Error(validation.error ?? `model '${model}' is not served by this endpoint`);
        const scope = p.scope === "user" ? "user" : "project";
        saveKittenSettings(role === "sidecar" ? { sidecarModel: model } : { mainModel: model }, scope, projectRoot);
        // Keep the already-running engine honest for the current session. This is an explicit user
        // action; no automatic downgrade ever changes the configured main tier.
        if (role === "sidecar") runtime.models.sidecar = model;
        else runtime.models.main = model;
        runtime.llm = new KittenLLM(runtime.models);
        if (role === "sidecar") {
          if (!legacySidecarEnabled) throw new Error("sidecar runtime is disabled; configure an explicit legacy sidecar to use this lane");
          app.setSidecarModel(model);
        } else app.setDefaultModel(model);
        result = { selected: true, role, model, endpoint, scope, verified: validation.verified === true, ...(validation.verified ? {} : { warning: validation.error ?? `model '${model}' has not answered yet` }) };
        break;
      }
      case "model.benchmark": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : active.models.main;
        result = await benchmarkModel(active.llm, { model, samples: typeof p.samples === "number" ? p.samples : 2, timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined });
        break;
      }
      case "model.benchmark-battery": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const battery = await benchmarkModelBattery(active.llm, {
          models: [
            { role: "main", model: active.models.main },
            ...(active.models.sidecar && active.models.sidecar !== active.models.main ? [{ role: "sidecar" as const, model: active.models.sidecar }] : []),
          ],
          samples: typeof p.samples === "number" ? p.samples : 2,
          timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
        });
        result = { ...battery, reportPath: saveModelBenchmarkBattery(projectRoot, battery) };
        break;
      }
      case "model.coding-benchmark": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const models: Array<{ role: "main" | "sidecar"; model: string }> = [{ role: "main", model: active.models.main }];
        if (active.models.sidecar && active.models.sidecar !== active.models.main) models.push({ role: "sidecar", model: active.models.sidecar });
        const taskIds = Array.isArray(p.taskIds) ? p.taskIds.filter((item): item is string => typeof item === "string") : undefined;
        const battery = await benchmarkCodingBattery(active.llm, {
          models,
          taskIds,
          timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
        });
        result = { ...battery, reportPath: saveCodingBenchmarkBattery(projectRoot, battery) };
        break;
      }
      case "model.project-benchmark": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const models: Array<{ role: "main" | "sidecar"; model: string }> = [{ role: "main", model: active.models.main }];
        if (active.models.sidecar && active.models.sidecar !== active.models.main) models.push({ role: "sidecar", model: active.models.sidecar });
        const taskIds = Array.isArray(p.taskIds) ? p.taskIds.filter((item): item is string => typeof item === "string") : undefined;
        const battery = await benchmarkProjectBattery(active.llm, {
          models,
          taskIds,
          timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
        });
        result = { ...battery, reportPath: saveProjectBenchmarkBattery(projectRoot, battery) };
        break;
      }
      case "model.bakeoff": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const models = bakeoffCandidates(p.models, active.models);
        const bakeoffId = String(p.id ?? `model-bakeoff-${Date.now().toString(36)}`);
        if (benchmarkControllers.has(bakeoffId)) throw new Error(`model bakeoff already running: ${bakeoffId}`);
        const controller = new AbortController();
        benchmarkControllers.set(bakeoffId, controller);
        try {
          const bakeoff = await benchmarkModelBakeoff(active.llm, {
            models,
            maxModels: models.length,
            timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
            signal: controller.signal,
            onProgress: (progress) => context.emit("model.bakeoff.progress", { id: bakeoffId, projectRoot, ...progress }),
          });
          if (controller.signal.aborted) throw new Error("model bakeoff cancelled");
          result = { ...bakeoff, id: bakeoffId, reportPath: saveModelBakeoff(projectRoot, bakeoff) };
        } finally { benchmarkControllers.delete(bakeoffId); }
        break;
      }
      case "model.bakeoff.cancel": {
        const id = String(p.id ?? "");
        const controller = benchmarkControllers.get(id);
        if (!controller) result = false;
        else { controller.abort("cancelled"); result = true; }
        break;
      }
      case "model.capabilities": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(projectRoot, runtime, opts);
        const role = p.role === "sidecar" ? "sidecar" : "main";
        if (role === "sidecar" && !legacySidecarEnabled) { result = { available: false, role, reason: "sidecar runtime is disabled" }; break; }
        const model = role === "sidecar" ? active.models.sidecar : active.models.main;
        const baseUrl = role === "sidecar" && active.models.sidecarBaseUrl ? active.models.sidecarBaseUrl : active.models.baseUrl;
        if (!model) { result = { available: false, role, reason: "no sidecar model configured" }; break; }
        const probeModels = baseUrl === active.models.baseUrl ? active.llm : new KittenLLM({ ...active.models, baseUrl, main: model, sidecar: model });
        const shouldProbe = p.probe !== false;
        result = shouldProbe
          ? await probeCapabilities(probeModels, model)
          : (readCachedCapabilities(baseUrl, model) ?? { available: false, role, baseUrl, model, reason: "no cached capability probe" });
        break;
      }
      case "model.catalog": {
        const raw = typeof p.raw === "string" ? p.raw : JSON.stringify(p.document ?? p.entries ?? []);
        result = parseModelCatalog(raw);
        break;
      }
      case "model.launch-plan": {
        const planRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const planSettings = settingsFor(opts, planRoot);
        const modelAlias = String(p.mainModel ?? runtime.models.main);
        // Keep explicit sidecar payloads tier-validated for compatibility/diagnostics, but never
        // infer or launch the lane unless legacy mode was explicitly enabled.
        const sidecarModel = typeof p.sidecarModel === "string" ? p.sidecarModel : undefined;
        const tierError = modelTierMismatch("main", modelAlias) ?? (sidecarModel ? modelTierMismatch("sidecar", sidecarModel) : null);
        if (tierError) throw new Error(tierError);
        // A preview that does not use the real weights file is a preview of a different launch: the
        // file is what the VRAM/expert/context heuristics measure, and the model id is only a label.
        const previewWeights = typeof p.mainModelPath === "string" && p.mainModelPath.trim()
          ? p.mainModelPath.trim()
          : planSettings.managedRuntime.mainModelPath ?? modelAlias;
        // Likewise the flag set: previewing flags the installed build would silently skip is how the
        // command box and the actual launch drift apart.
        const previewExecutable = typeof p.executable === "string" && p.executable.trim() ? p.executable.trim() : resolveRuntimeExecutable(planSettings).executable;
        const previewCapability = previewExecutable && existsSync(previewExecutable) ? detectServerFlags(previewExecutable) : null;
        // Tuning comes from the payload when the settings panel previews unsaved values, else from
        // the saved settings — the preview must show the command that would actually run.
        const tuning: RuntimeTuning = p.tuning && typeof p.tuning === "object" ? p.tuning as RuntimeTuning : planSettings.runtimeTuning;
        result = buildLaunchPlan({
          runtime: typeof p.runtime === "string" ? p.runtime as never : undefined,
          backend: typeof p.backend === "string" ? p.backend as never : undefined,
          mainModel: previewWeights,
          modelAlias,
          sidecarModel: legacySidecarEnabled ? sidecarModel : undefined,
          contextTokens: typeof p.contextTokens === "number" ? p.contextTokens : explicitContextTokens(planSettings),
          sidecarMode: typeof p.sidecarMode === "string" ? p.sidecarMode as never : undefined,
          tuning,
          ...(previewCapability ? { supportedFlags: previewCapability.flags, supportedFlagsHelp: previewCapability.helpText } : {}),
        });
        break;
      }
      case "model.inspect-weights": {
        // What one picked .gguf implies: its size and layer count, the id it should be served under,
        // and the expert split and context the machine can actually hold. This is what lets the
        // settings panel ask for weights and nothing else.
        const weightsRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const requested = typeof p.path === "string" && p.path.trim() ? p.path.trim() : settingsFor(opts, weightsRoot).managedRuntime.mainModelPath;
        if (!requested) throw new Error("model.inspect-weights requires a .gguf path");
        result = inspectWeights(requested);
        break;
      }
      case "runtime.autoconfig": {
        // Everything Kitten can work out for itself before the user is asked anything: which server
        // binary to use, which weights are already on this machine, and what the hardware allows.
        const autoRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const autoSettings = settingsFor(opts, autoRoot);
        const autoHardware = detectHardware();
        const executable = resolveRuntimeExecutable(autoSettings);
        const weights = resolveMainWeights(autoSettings);
        const files = listModelFiles([autoSettings.managedRuntime.mainModelPath, autoSettings.managedRuntime.sidecarModelPath]);
        const inspection = weights.path ? inspectWeights(weights.path) : null;
        const warnings: string[] = [];
        if (!executable.executable) warnings.push("No llama-server was found beside the app, among the LM Studio backends, or on PATH. Point Kitten at one under Local runtime, or use an endpoint you start yourself.");
        if (!weights.path) warnings.push("No .gguf weights were found beside the configured model or in the LM Studio folders. Choose a file in Local runtime.");
        // `apply` is the only side effect in this handler, and it only ever fills in blanks.
        if (p.apply === true && (executable.autoDetected || weights.autoDetected)) {
          const update: SettingsUpdate = {};
          if (executable.autoDetected && executable.executable) update.runtimeExecutable = executable.executable;
          if (weights.autoDetected && weights.path) update.mainModelPath = weights.path;
          if (Object.keys(update).length) {
            try { saveKittenSettings(update, "project", autoRoot); }
            catch (error) { warnings.push(`Could not save the detected setup: ${error instanceof Error ? error.message : String(error)}`); }
          }
        }
        result = {
          projectRoot: autoRoot,
          executable: executable.executable ?? null,
          executableAutoDetected: executable.autoDetected,
          executables: discoverRuntimeExecutables([], autoHardware),
          mainModelPath: weights.path ?? null,
          weightsAutoDetected: weights.autoDetected,
          weights: inspection,
          suggestedModelId: weights.path ? suggestModelId(weights.path) : null,
          files,
          hardware: autoHardware,
          warnings,
        };
        break;
      }
      case "model.files": {
        // Everything already on this machine a user could load: the configured weights' own folders
        // plus the LM Studio trees. This is how "use the model I downloaded yesterday" becomes a
        // dropdown instead of a filesystem safari.
        const filesRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const fileSettings = settingsFor(opts, filesRoot);
        result = listModelFiles(
          [fileSettings.managedRuntime.mainModelPath, fileSettings.managedRuntime.sidecarModelPath],
          Array.isArray(p.extraDirs) ? p.extraDirs.map(String) : [],
        );
        break;
      }
      case "model.recommend": {
        const hardware = detectHardware();
        const recommendations = recommendModelProfiles(hardware);
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        result = { hardware, recommendations, summary: profileSummary(recommendations), latestBakeoff: latestModelBakeoffSummary(projectRoot) };
        break;
      }
      case "runtime.status": {
        const current = managedRuntime.current;
        const running = (child: ManagedRuntimeProcess | null): boolean => Boolean(child && child.process.exitCode === null && !child.process.killed);
        result = {
          running: running(current?.main ?? null),
          pid: current?.main.process.pid ?? null,
          sidecarRunning: running(current?.sidecar ?? null),
          sidecarPid: current?.sidecar?.process.pid ?? null,
          // Late-joiner seed for the pushed runtime.state stream (a fresh shell asks once, then listens).
          state: runtimeState.last,
        };
        break;
      }
      case "runtime.ensure": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const projectSettings = settingsFor(opts, projectRoot);
        const active = runtimeForProject(projectRoot, runtime, opts);
        // Finding the server binary is Kitten's job, not the user's: it ships one, and a fresh
        // install that only knows which weights to load must still be able to start.
        const resolvedExecutable = resolveRuntimeExecutable(projectSettings);
        const executable = resolvedExecutable.executable;
        const mainModelPath = projectSettings.managedRuntime.mainModelPath;
        if (!executable || !mainModelPath || !existsSync(mainModelPath)) {
          result = { configured: false, running: false, projectRoot, missing: !executable ? "runtime" : "weights" };
          break;
        }
        if (resolvedExecutable.autoDetected) {
          try { saveKittenSettings({ runtimeExecutable: executable }, "project", projectRoot); } catch { /* a read-only project must not block the launch */ }
        }
        const mainTierError = modelTierMismatch("main", active.models.main);
        const sidecarTierError = active.models.sidecar ? modelTierMismatch("sidecar", active.models.sidecar) : null;
        if (mainTierError || sidecarTierError) {
          result = { configured: true, running: false, projectRoot, tierMismatch: mainTierError ?? sidecarTierError };
          break;
        }
        const existing = await probeEndpoint(active.models.baseUrl);
        if (existing.reachable) {
          pushRuntimeState({ phase: "external", external: true, endpoint: active.models.baseUrl, model: active.models.main });
          result = { configured: true, running: false, external: true, endpoint: active.models.baseUrl, projectRoot };
          break;
        }
        // Something is already starting this model: join it rather than killing it and starting over.
        if (runtimeState.launching) {
          result = { configured: true, running: true, joined: true, endpoint: active.models.baseUrl, projectRoot };
          break;
        }
        const sidecarModelPath = legacySidecarEnabled && projectSettings.managedRuntime.sidecarModelPath && existsSync(projectSettings.managedRuntime.sidecarModelPath)
          ? projectSettings.managedRuntime.sidecarModelPath : undefined;
        runtimeState.launching = true;
        pushRuntimeState({ phase: "starting", endpoint: active.models.baseUrl, model: active.models.main });
        let launched: ManagedRuntimeLaunchResult;
        try {
          launched = await launchManagedRuntime({
            executable, mainModelPath, sidecarModelPath,
            modelAlias: active.models.main,
            baseUrl: active.models.baseUrl,
            sidecarBaseUrl: sidecarModelPath ? active.models.sidecarBaseUrl : undefined,
            contextTokens: explicitContextTokens(projectSettings),
            tuning: calibratedTuning(projectSettings, mainModelPath),
            sidecarDevice: projectSettings.runtimeTuning.sidecarDevice,
            runtimeRoot: projectRoot,
            // Weight loading is PROGRESS, not failure. A 25 GB Q5_K_M reads for a minute or more from
            // a cold page cache, and a 30s ceiling turned that into "the runtime did not become
            // reachable" — declaring a perfectly healthy load dead. The probe already gives up the
            // moment the process actually exits, so patience here costs nothing and buys correctness.
            probeTimeoutMs: 240_000,
            onProgress: (info) => pushRuntimeState({ phase: info.phase === "loading" ? "loading" : "starting", endpoint: active.models.baseUrl, model: active.models.main, elapsedMs: info.elapsedMs, log: info.log }),
          }, managedRuntime);
        } catch (error) {
          pushRuntimeState({ phase: "failed", endpoint: active.models.baseUrl, model: active.models.main, stderrTail: error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200) });
          throw error;
        } finally {
          runtimeState.launching = false;
        }
        runtime.models = { ...runtime.models, ...active.models, baseUrl: launched.baseUrl, sidecarBaseUrl: launched.sidecarBaseUrl };
        runtime.llm = new KittenLLM(runtime.models);
        sidecar.setMaxConcurrent(sidecarConcurrency(runtime.models));
        app.setDefaultModel(runtime.models.main);
        if (legacySidecarEnabled) app.setSidecarModel(runtime.models.sidecar);
        pushRuntimeState({ phase: "ready", pid: launched.mainProcess.process.pid, ctxTokens: launched.plan.contextTokens });
        result = { configured: true, running: true, pid: launched.mainProcess.process.pid, sidecarPid: launched.sidecarProcess?.process.pid ?? null, endpoint: launched.baseUrl, sidecarEndpoint: launched.sidecarBaseUrl, projectRoot };
        break;
      }
      case "runtime.calibrate": {
        // Measure this machine rather than reasoning about it. Each rung is a cold model load, so
        // this is explicitly a thing the user asks for, reports progress while it runs, and is
        // remembered afterwards so it is never paid for twice.
        const calRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const calSettings = settingsFor(opts, calRoot);
        const executable = resolveRuntimeExecutable(calSettings).executable;
        const weights = calSettings.managedRuntime.mainModelPath;
        if (!executable) throw new Error("no llama-server to calibrate with — set one under Local runtime");
        if (!weights || !existsSync(weights)) throw new Error("choose model weights before calibrating");
        // The runtime under test needs the card to itself.
        await stopManagedRuntime(managedRuntime);
        pushRuntimeState({ phase: "stopped" });
        const controller = new AbortController();
        calibrationControllers.set(calRoot, controller);
        try {
          const record = await calibrateRuntime({
            executable, modelPath: weights, projectRoot: calRoot,
            maxRungs: typeof p.maxRungs === "number" ? p.maxRungs : undefined,
            signal: controller.signal,
            onProgress: (progress) => context.emit("runtime.calibration", progress),
          });
          result = record;
        } finally {
          calibrationControllers.delete(calRoot);
        }
        break;
      }
      case "runtime.calibrate.cancel": {
        for (const controller of calibrationControllers.values()) controller.abort("cancelled");
        result = { cancelled: true };
        break;
      }
      case "runtime.discover":
        result = { executables: discoverRuntimeExecutables([], detectHardware()) };
        break;
      case "runtime.log": {
        // The runtime's own output, cleaned — the UI shows THIS instead of inventing an explanation.
        const current = managedRuntime.current;
        result = {
          main: cleanRuntimeLog(current?.main.stderr() ?? "", Math.max(10, Math.min(400, Number(p.maxLines ?? 200)))),
          sidecar: cleanRuntimeLog(current?.sidecar?.stderr() ?? "", 60),
          running: Boolean(current?.main && current.main.process.exitCode === null),
          state: runtimeState.last,
        };
        break;
      }
      case "runtime.capabilities": {
        // What flags this llama-server build actually advertises: the UI greys out what it cannot do
        // and stops pretending a flag exists when the binary has never heard of it.
        const capRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        const exe = typeof p.executable === "string" && p.executable.trim() ? p.executable.trim() : settingsFor(opts, capRoot).managedRuntime.executable;
        if (!exe || !existsSync(exe)) { result = { available: false, flags: [], reason: "no runtime executable configured" }; break; }
        const detected = detectServerFlags(exe);
        result = { available: detected.flags.size > 0, executable: exe, flags: [...detected.flags].sort(), helpText: detected.helpText.slice(0, 20_000) };
        break;
      }
      case "runtime.stop":
        await stopManagedRuntime(managedRuntime);
        pushRuntimeState({ phase: "stopped" });
        result = { stopped: true };
        break;
      case "runtime.start": {
        const sidecarRequested = legacySidecarEnabled || Boolean(p.sidecarModelPath || p.sidecarModel || p.sidecarBaseUrl);
        const executable = String(p.executable ?? "").trim();
        const mainModelPath = String(p.mainModelPath ?? "").trim();
        const sidecarModelPath = sidecarRequested && typeof p.sidecarModelPath === "string" && p.sidecarModelPath.trim() ? p.sidecarModelPath.trim() : undefined;
        const baseUrl = typeof p.baseUrl === "string" && p.baseUrl.trim() ? p.baseUrl.trim() : runtime.models.baseUrl;
        const requestedSidecarBaseUrl = sidecarRequested && typeof p.sidecarBaseUrl === "string" && p.sidecarBaseUrl.trim() ? p.sidecarBaseUrl.trim() : undefined;
        const requestedMainModel = typeof p.mainModel === "string" && p.mainModel.trim() ? p.mainModel.trim() : undefined;
        const requestedSidecarModel = sidecarRequested && typeof p.sidecarModel === "string" && p.sidecarModel.trim() ? p.sidecarModel.trim() : undefined;
        const requestedMainTierError = requestedMainModel ? modelTierMismatch("main", requestedMainModel) : null;
        const requestedSidecarTierError = requestedSidecarModel ? modelTierMismatch("sidecar", requestedSidecarModel) : null;
        if (requestedMainTierError || requestedSidecarTierError) throw new Error(`${requestedMainTierError ?? requestedSidecarTierError}; choose a model in Kitten's supported local tier`);
        const runtimeRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : (opts.projectRoot ?? process.cwd());
        const configuredRuntimeModels = runtimeForProject(runtimeRoot, runtime, opts).models;
        const effectiveMainTierError = modelTierMismatch("main", requestedMainModel ?? configuredRuntimeModels.main);
        const effectiveSidecarTierError = sidecarRequested && (requestedSidecarModel ?? configuredRuntimeModels.sidecar) ? modelTierMismatch("sidecar", requestedSidecarModel ?? configuredRuntimeModels.sidecar!) : null;
        if (effectiveMainTierError || effectiveSidecarTierError) throw new Error(`${effectiveMainTierError ?? effectiveSidecarTierError}; choose a model in Kitten's supported local tier`);
        const sidecarBaseUrl = sidecarModelPath ? (requestedSidecarBaseUrl ?? (() => {
          const url = new URL(baseUrl);
          const port = Number(url.port || 80);
          url.port = String(port + 1);
          return url.toString();
        })()) : undefined;
        saveKittenSettings({
          baseUrl,
          runtimeExecutable: executable,
          mainModelPath,
          ...(requestedMainModel ? { mainModel: requestedMainModel } : {}),
          ...(requestedSidecarModel ? { sidecarModel: requestedSidecarModel } : {}),
          ...(sidecarModelPath ? { sidecarModelPath } : {}),
          ...(sidecarBaseUrl ? { sidecarBaseUrl } : {}),
        }, "project", runtimeRoot);
        const bootstrap = typeof p.bootstrapScript === "string" && p.bootstrapScript.trim() ? p.bootstrapScript.trim() : undefined;
        runtimeState.launching = true;
        pushRuntimeState({ phase: "starting", endpoint: baseUrl, model: requestedMainModel ?? configuredRuntimeModels.main });
        let launched: ManagedRuntimeLaunchResult;
        try {
          launched = await launchManagedRuntime({
            executable, mainModelPath, sidecarModelPath, baseUrl, sidecarBaseUrl,
            modelAlias: requestedMainModel ?? configuredRuntimeModels.main,
            backend: typeof p.backend === "string" ? p.backend as ManagedRuntimeLaunchRequest["backend"] : undefined,
            contextTokens: typeof p.contextTokens === "number" ? p.contextTokens : explicitContextTokens(settingsFor(opts, runtimeRoot)),
            tuning: calibratedTuning(settingsFor(opts, runtimeRoot), mainModelPath),
            sidecarDevice: settingsFor(opts, runtimeRoot).runtimeTuning.sidecarDevice,
            runtimeRoot, bootstrapScript: bootstrap,
            // Weight loading is PROGRESS, not failure. A 25 GB Q5_K_M reads for a minute or more from
            // a cold page cache, and a 30s ceiling turned that into "the runtime did not become
            // reachable" — declaring a perfectly healthy load dead. The probe already gives up the
            // moment the process actually exits, so patience here costs nothing and buys correctness.
            probeTimeoutMs: 240_000,
            onProgress: (info) => pushRuntimeState({ phase: info.phase === "loading" ? "loading" : "starting", endpoint: baseUrl, model: requestedMainModel ?? configuredRuntimeModels.main, elapsedMs: info.elapsedMs, log: info.log }),
          }, managedRuntime);
        } catch (error) {
          pushRuntimeState({ phase: "failed", endpoint: baseUrl, model: requestedMainModel ?? configuredRuntimeModels.main, stderrTail: error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200) });
          throw error;
        } finally {
          runtimeState.launching = false;
        }
        runtime.models.sidecarBaseUrl = sidecarRequested ? sidecarBaseUrl : undefined;
        // Starting a managed runtime is also a model configuration action. Update the live client
        // immediately so the very next native submission uses the endpoint just started instead of
        // silently continuing to call the old default (the settings file alone is not enough for an
        // already-running engine process).
        runtime.models = {
          ...runtime.models,
          baseUrl,
          sidecarBaseUrl: sidecarRequested ? sidecarBaseUrl : undefined,
          ...(requestedMainModel ? { main: requestedMainModel } : {}),
          ...(requestedSidecarModel ? { sidecar: requestedSidecarModel } : sidecarRequested ? {} : { sidecar: undefined }),
        };
        runtime.llm = new KittenLLM(runtime.models);
        sidecar.setMaxConcurrent(sidecarConcurrency(runtime.models));
        app.setDefaultModel(runtime.models.main);
        if (sidecarRequested) app.setSidecarModel(runtime.models.sidecar);
        pushRuntimeState({ phase: "ready", pid: launched.mainProcess.process.pid, ctxTokens: launched.plan.contextTokens });
        result = { started: true, pid: launched.mainProcess.process.pid, endpoint: baseUrl, sidecarEndpoint: sidecarBaseUrl, sidecarPid: launched.sidecarProcess?.process.pid ?? null, launchPlan: launched.plan, probe: launched.probe, sidecarProbe: launched.sidecarProbe };
        break;
      }
      case "model.inspect": result = inspectModel(String(p.path), typeof p.sha256 === "string" ? p.sha256 : undefined); break;
      case "model.download": {
        const entry = p.entry as Partial<ModelCatalogEntry>;
        const destination = String(p.destination ?? "");
        if (!destination || !entry || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.url !== "string" || typeof entry.sha256 !== "string" || (entry.format !== "gguf" && entry.format !== "safetensors") || (entry.role !== "main" && entry.role !== "sidecar")) throw new Error("model.download requires a complete catalog entry and destination");
        const tierError = modelTierMismatch(entry.role, entry.id);
        if (tierError) throw new Error(tierError);
        const downloadId = typeof p.id === "string" && p.id.trim() ? p.id.trim() : entry.id;
        if (modelDownloadControllers.has(downloadId)) throw new Error(`model download already running: ${downloadId}`);
        const controller = new AbortController();
        modelDownloadControllers.set(downloadId, controller);
        try {
          result = await downloadModel(entry as ModelCatalogEntry, destination, { signal: controller.signal, onProgress: (progress) => socket.write(encodeFrame({ protocolVersion: DESKTOP_PROTOCOL_VERSION, eventId: `model:${progress.id}:${progress.phase}:${progress.receivedBytes}`, type: "model.download.progress", timestamp: Date.now(), payload: progress })) });
        } finally { modelDownloadControllers.delete(downloadId); }
        break;
      }
      case "model.download.cancel": {
        const downloadId = String(p.id ?? "");
        const controller = modelDownloadControllers.get(downloadId);
        if (controller) controller.abort("cancelled");
        result = Boolean(controller);
        break;
      }
      case "model.bakeoff.history": {
        const root = String(p.projectRoot ?? opts.projectRoot ?? process.cwd());
        result = listModelBakeoffs(root, typeof p.max === "number" ? p.max : 8);
        break;
      }
      case "workspace.index": {
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        const index = getWorkspaceIndex(root, indexes);
        result = await index.refresh(root, { changedPaths: Array.isArray(p.changedPaths) ? p.changedPaths.map(String) : undefined });
        persistWorkspaceIndex(root, index);
        break;
      }
      case "workspace.verify": {
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        const commands = Array.isArray(p.commands) ? p.commands.map(String) : [];
        const verificationId = String(p.id ?? frame.id);
        if (verificationControllers.has(verificationId)) throw new Error(`workspace verification already running: ${verificationId}`);
        const controller = new AbortController();
        verificationControllers.set(verificationId, controller);
        let verification;
        try { verification = await runWorkspaceVerification(root, commands, { timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined, signal: controller.signal }); }
        finally { verificationControllers.delete(verificationId); }
        const conversationId = String(p.conversationId ?? frame.conversationId);
        if (app.getConversation(conversationId)) app.recordWorkspaceVerification(conversationId, { runId: String(p.runId ?? "verification"), passed: verification.passed, cancelled: verification.cancelled, commands, results: verification.results });
        result = { ...verification, id: verificationId };
        break;
      }
      case "workspace.verify.cancel": {
        const verificationId = String(p.id ?? "");
        const controller = verificationControllers.get(verificationId);
        if (controller) controller.abort("cancelled");
        result = Boolean(controller);
        break;
      }
      case "workspace.overview": {
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        result = getWorkspaceIndex(root, indexes).overview();
        break;
      }
      case "workspace.files": {
        // Listing the project is not a search. The file browser opened onto an empty pane because the
        // only way to see anything was to type a query first.
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        const index = getWorkspaceIndex(root, indexes);
        if (!index.overview().files) { await index.refresh(root); persistWorkspaceIndex(root, index); }
        const limit = Math.max(1, Math.min(2000, Number(p.limit ?? 400)));
        result = index.list()
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, limit)
          .map((record) => ({ path: record.path, language: record.language, isTest: record.isTest, symbols: record.symbols.slice(0, 8), bytes: record.bytes }));
        break;
      }
      case "workspace.search": {
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        const index = getWorkspaceIndex(root, indexes);
        if (!index.overview().files) { await index.refresh(root); persistWorkspaceIndex(root, index); }
        result = index.search(String(p.query ?? ""), Number(p.limit ?? 20));
        break;
      }
      case "workspace.context": {
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        const index = getWorkspaceIndex(root, indexes);
        if (!index.overview().files) { await index.refresh(root); persistWorkspaceIndex(root, index); }
        result = index.buildContext(String(p.query ?? ""), Number(p.maxChars ?? 12000));
        break;
      }
      case "workspace.changes": {
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        result = inspectWorkspaceChanges(root, { maxBytes: typeof p.maxBytes === "number" ? p.maxBytes : undefined, maxFiles: typeof p.maxFiles === "number" ? p.maxFiles : undefined });
        break;
      }
      case "sidecar.catalog": result = [...SIDECAR_JOB_TYPES]; break;
      case "sidecar.workflow.catalog": result = SIDECAR_WORKFLOWS; break;
      case "sidecar.run": {
        const root = String(p.root ?? opts.projectRoot ?? process.cwd());
        const active = runtimeForProject(root, runtime, opts);
        sidecar.setMaxConcurrent(sidecarConcurrency(active.models));
        const requestedType = String(p.type ?? "summarize_output");
        if (!isSidecarJobType(requestedType)) throw new Error(`unknown sidecar job type: ${requestedType}`);
        const type: SidecarJobType = requestedType;
        const index = getWorkspaceIndex(root, indexes);
        if ((type === "rank_files" || type === "select_tests") && !index.overview().files) { await index.refresh(root); persistWorkspaceIndex(root, index); }
        result = await runCatalogJob(sidecar, active.llm, index, { id: String(p.id ?? `sidecar_${Date.now().toString(36)}`), type, premise: String(p.premise ?? ""), text: typeof p.text === "string" ? p.text : undefined, query: typeof p.query === "string" ? p.query : undefined, diff: typeof p.diff === "string" ? p.diff : undefined, output: typeof p.output === "string" ? p.output : undefined, files: Array.isArray(p.files) ? p.files.map(String) : undefined, tests: Array.isArray(p.tests) ? p.tests.map(String) : undefined, facts: Array.isArray(p.facts) ? p.facts.map(String) : undefined, maxChars: typeof p.maxChars === "number" ? p.maxChars : undefined });
        break;
      }
      case "sidecar.workflow": {
        const requestedWorkflow = String(p.workflow ?? "");
        const workflow = sidecarWorkflow(requestedWorkflow);
        if (!workflow) throw new Error(`unknown sidecar workflow: ${requestedWorkflow}`);
        const workflowId = String(p.id ?? `workflow_${Date.now().toString(36)}`);
        if (sidecarWorkflowActive.has(workflowId)) throw new Error(`sidecar workflow already running: ${workflowId}`);
        // One state object for the whole pack, registered before the first await: the workflow stays
        // cancellable while the index warms and in the gaps between steps, not only while a step is
        // in flight. A Stop pressed during a slow refresh used to be dropped and every step then ran.
        const state: ActiveSidecarWorkflow = { jobId: "", cancelled: false };
        sidecarWorkflowActive.set(workflowId, state);
        const results: Array<{ id: string; type: SidecarJobType; label: string; result: Awaited<ReturnType<typeof runCatalogJob>> }> = [];
        try {
          const root = String(p.root ?? opts.projectRoot ?? process.cwd());
          const active = runtimeForProject(root, runtime, opts);
          sidecar.setMaxConcurrent(sidecarConcurrency(active.models));
          const index = getWorkspaceIndex(root, indexes);
          if (workflow.steps.some((step) => step.type === "rank_files" || step.type === "select_tests" || step.type === "map_dependencies" || step.type === "summarize_tree") && !index.overview().files) { await index.refresh(root); persistWorkspaceIndex(root, index); }
          for (const step of workflow.steps) {
            if (state.cancelled) break;
            const jobId = `${workflowId}:${step.id}`;
            state.jobId = jobId;
            const stepResult = await runCatalogJob(sidecar, active.llm, index, {
              id: jobId,
              type: step.type,
              premise: `${workflow.id}: ${step.label}`,
              text: typeof p.text === "string" ? p.text : undefined,
              query: typeof p.query === "string" ? p.query : typeof p.text === "string" ? p.text : undefined,
              diff: typeof p.diff === "string" ? p.diff : typeof p.text === "string" ? p.text : undefined,
              output: typeof p.output === "string" ? p.output : typeof p.text === "string" ? p.text : undefined,
              files: Array.isArray(p.files) ? p.files.map(String) : undefined,
              tests: Array.isArray(p.tests) ? p.tests.map(String) : undefined,
              facts: Array.isArray(p.facts) ? p.facts.map(String) : undefined,
              maxChars: typeof p.maxChars === "number" ? p.maxChars : undefined,
            });
            results.push({ id: step.id, type: step.type, label: step.label, result: stepResult });
          }
        } finally { sidecarWorkflowActive.delete(workflowId); }
        result = {
          id: workflowId, workflow: workflow.id, name: workflow.name,
          source: results.some((step) => step.result.source === "sidecar") ? "sidecar" : "deterministic",
          cancelled: state.cancelled,
          completedSteps: results.length,
          totalSteps: workflow.steps.length,
          results,
        };
        break;
      }
      case "sidecar.cancel": {
        const id = String(p.id ?? "");
        const workflowState = sidecarWorkflowActive.get(id);
        if (workflowState) {
          // Cancelling a workflow is authoritative even between steps, where there is no job to kill.
          workflowState.cancelled = true;
          sidecar.cancel(workflowState.jobId || id);
          result = true;
        } else {
          result = sidecar.cancel(id);
        }
        break;
      }
      case "sidecar.cancel-all": sidecar.cancelAll(); result = true; break;
      case "sidecar.stats": result = sidecar.snapshot(); break;
      case "conversation.list": result = app.listConversations({ includeArchived: Boolean(p.includeArchived), search: typeof p.search === "string" ? p.search : undefined }); break;
      case "conversation.get": result = app.getConversation(String(p.id ?? frame.conversationId)); break;
      case "conversation.events": result = app.getEvents(String(p.id ?? frame.conversationId), Number(p.afterSeq ?? 0)); break;
      case "conversation.runs": result = app.getRuns(String(p.id ?? frame.conversationId)); break;
      case "conversation.export": {
        const conversationId = String(p.id ?? frame.conversationId);
        result = { format: "markdown", conversationId, content: app.exportConversationMarkdown(conversationId) };
        break;
      }
      case "support.bundle": {
        const root = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot : opts.projectRoot ?? process.cwd();
        result = { format: "text", content: await gatherSupportInfo(root) };
        break;
      }
      case "task.list": result = app.listTasks(String(p.conversationId ?? frame.conversationId)); break;
      case "task.compiled-get": result = app.getCompiledTask(String(p.runId ?? "")); break;
      case "plan.list": result = app.listPlanArtifacts(String(p.conversationId ?? frame.conversationId)); break;
      case "plan.get": result = app.getPlanArtifact(String(p.planId ?? p.id ?? ""), typeof p.revision === "number" ? p.revision : undefined); break;
      case "plan.create": {
        const conversationId = String(p.conversationId ?? frame.conversationId);
        const prompt = String(p.text ?? p.prompt ?? "").trim();
        if (!prompt) throw new Error("plan.create requires text");
        const conversation = app.getConversation(conversationId);
        const root = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot : conversation?.projectRoot ?? opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(root, runtime, opts);
        const planId = String(p.planId ?? `plan-${Date.now().toString(36)}`);
        const controller = new AbortController();
        taskControllers.set(planId, controller);
        try {
          const orientation = await automaticSidecarContext(prompt, root, active, indexes, sidecar, controller.signal);
          const suggested = await suggestEditableTaskPlan(conversationId, prompt, root, indexes, orientation);
          if (!suggested.nodes.length) throw new Error(suggested.note);
          const files = suggested.allowedFiles;
          result = app.createPlanArtifact({
            id: planId, conversationId, request: prompt, projectRoot: root,
            workspaceFingerprint: workspaceFingerprint(root, files),
            goal: prompt, requirements: [suggested.note], steps: suggested.nodes as never[],
            verification: ["Run the plan's verification step and inspect the resulting diff."],
          });
        } finally { taskControllers.delete(planId); }
        break;
      }
      case "plan.revise": {
        const planId = String(p.planId ?? p.id ?? "");
        if (!planId || !p.patch || typeof p.patch !== "object") throw new Error("plan.revise requires planId and patch");
        result = app.revisePlanArtifact(planId, p.patch as never);
        break;
      }
      case "plan.approve": result = app.approvePlanArtifact(String(p.planId ?? p.id ?? ""), typeof p.revision === "number" ? p.revision : undefined); break;
      case "plan.execute": {
        const planId = String(p.planId ?? p.id ?? "");
        const parentRunId = String(p.parentRunId ?? `plan-run-${Date.now().toString(36)}`);
        const controller = new AbortController();
        taskControllers.set(parentRunId, controller);
        try { result = await app.executePlanArtifact(planId, typeof p.revision === "number" ? p.revision : undefined, parentRunId, controller.signal); }
        finally { taskControllers.delete(parentRunId); }
        break;
      }
      case "plan.resume": {
        const planId = String(p.planId ?? p.id ?? "");
        const parentRunId = String(p.parentRunId ?? `plan-resume-${Date.now().toString(36)}`);
        const controller = new AbortController();
        taskControllers.set(parentRunId, controller);
        try { result = await app.executePlanArtifact(planId, typeof p.revision === "number" ? p.revision : undefined, parentRunId, controller.signal); }
        finally { taskControllers.delete(parentRunId); }
        break;
      }
      case "plan.cancel": {
        const key = String(p.parentRunId ?? p.runId ?? p.planId ?? p.id ?? "");
        const controller = taskControllers.get(key);
        if (controller) { controller.abort("cancelled"); result = true; }
        else { result = app.cancelPlanArtifact(String(p.planId ?? p.id ?? ""), typeof p.revision === "number" ? p.revision : undefined); }
        break;
      }
      case "task.plan-suggest": {
        const conversationId = String(p.conversationId ?? frame.conversationId);
        const prompt = String(p.text ?? p.prompt ?? "").trim();
        if (!prompt) throw new Error("task.plan-suggest requires text");
        const conversation = app.getConversation(conversationId);
        const root = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot : conversation?.projectRoot ?? opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(root, runtime, opts);
        const planId = String(p.parentRunId ?? `task-plan-${Date.now().toString(36)}`);
        const planController = new AbortController();
        taskControllers.set(planId, planController);
        try {
          const orientation = await automaticSidecarContext(prompt, root, active, indexes, sidecar, planController.signal);
          result = { conversationId, nodes: suggestReadOnlyTaskPlan(conversationId, prompt, orientation), orientation, note: "Read-only sidecar plan; no files are modified." };
        } finally { taskControllers.delete(planId); }
        break;
      }
      case "task.plan-edit-suggest": {
        const conversationId = String(p.conversationId ?? frame.conversationId);
        const prompt = String(p.text ?? p.prompt ?? "").trim();
        if (!prompt) throw new Error("task.plan-edit-suggest requires text");
        const conversation = app.getConversation(conversationId);
        const root = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot : conversation?.projectRoot ?? opts.projectRoot ?? process.cwd();
        const active = runtimeForProject(root, runtime, opts);
        const planId = String(p.parentRunId ?? `task-implementation-${Date.now().toString(36)}`);
        const planController = new AbortController();
        taskControllers.set(planId, planController);
        try {
          const orientation = await automaticSidecarContext(prompt, root, active, indexes, sidecar, planController.signal);
          const editablePlan = await suggestEditableTaskPlan(conversationId, prompt, root, indexes, orientation);
          result = { nodes: editablePlan.nodes, allowedFiles: editablePlan.allowedFiles, note: editablePlan.note, orientation };
        } finally { taskControllers.delete(planId); }
        break;
      }
      case "task.run": {
        const parentRunId = String(p.parentRunId ?? `task-plan-${Date.now().toString(36)}`);
        const controller = new AbortController();
        taskControllers.set(parentRunId, controller);
        try { result = await app.runTaskPlan(String(p.conversationId ?? frame.conversationId), parentRunId, controller.signal); }
        finally { taskControllers.delete(parentRunId); }
        break;
      }
      case "task.resume": {
        const parentRunId = String(p.parentRunId ?? `task-resume-${Date.now().toString(36)}`);
        const controller = new AbortController();
        taskControllers.set(parentRunId, controller);
        try { result = await app.resumeTaskPlan(String(p.conversationId ?? frame.conversationId), parentRunId, controller.signal); }
        finally { taskControllers.delete(parentRunId); }
        break;
      }
      case "task.cancel": {
        const controller = taskControllers.get(String(p.parentRunId ?? ""));
        if (!controller) result = false;
        else { controller.abort("cancelled"); result = true; }
        break;
      }
      case "task.plan": {
        const conversationId = String(p.conversationId ?? frame.conversationId);
        const nodes = Array.isArray(p.nodes) ? p.nodes : [];
        result = app.createTaskPlan({ conversationId, nodes: nodes as never[], ts: Date.now() });
        break;
      }
      case "task.spawn": {
        const parentRunId = String(p.parentRunId ?? `manual-subagent-${Date.now().toString(36)}`);
        if (taskControllers.has(parentRunId)) throw new Error(`subagent already running: ${parentRunId}`);
        const controller = new AbortController();
        taskControllers.set(parentRunId, controller);
        try {
          result = await app.spawnChild({ parentConversationId: String(p.parentConversationId ?? frame.conversationId), parentRunId, agent: String(p.agent ?? "general"), prompt: String(p.prompt ?? ""), model: typeof p.model === "string" ? p.model : undefined, projectRoot: typeof p.projectRoot === "string" ? p.projectRoot : undefined, signal: controller.signal });
        } finally { taskControllers.delete(parentRunId); }
        break;
      }
      case "conversation.create": {
        const projectRoot = typeof p.projectRoot === "string" && p.projectRoot.trim() ? p.projectRoot.trim() : opts.projectRoot ?? process.cwd();
        // A project-local config should determine the recorded model on first creation. This keeps
        // resume/model identity honest even when the desktop process was launched from another folder.
        const projectSettings = loadKittenSettings(projectRoot);
        const requestedModel = typeof p.model === "string" && p.model.trim() ? p.model.trim() : projectSettings.models.main;
        const tierError = modelTierMismatch("main", requestedModel);
        if (tierError) throw new Error(tierError);
        result = app.createConversation({ title: String(p.title ?? "New conversation"), projectRoot, model: requestedModel, agent: typeof p.agent === "string" ? p.agent : undefined, effort: typeof p.effort === "string" ? p.effort : undefined });
        break;
      }
      case "conversation.set-effort": {
        const conversationId = String(p.conversationId ?? frame.conversationId);
        result = { updated: app.setEffort(conversationId, String(p.effort ?? "balanced")) };
        break;
      }
      case "conversation.submit": {
        const conversationId = String(p.conversationId ?? frame.conversationId);
        const text = String(p.text ?? "");
        const conversation = app.getConversation(conversationId);
        if (submitControllers.has(conversationId)) throw new Error(`conversation already has a submission in progress: ${conversationId}`);
        const submitController = new AbortController();
        submitControllers.set(conversationId, submitController);
        const activeRuntime = conversation ? runtimeForProject(conversation.projectRoot, runtime, opts) : runtime;
        sidecar.setMaxConcurrent(sidecarConcurrency(activeRuntime.models));
        let contextPreamble = "";
        try {
          // The model has to exist before the turn does. A local runtime that is still reading its
          // weights answers `fetch failed` or 503, and a run started into that fails for a reason
          // that has nothing to do with the user's request.
          //
          // Only for a runtime Kitten manages: an injected runner, a fixture, or a cloud endpoint has
          // nothing to wait for, and polling one that will never answer would be a hang, not a fix.
          const submitSettings = settingsFor(opts, conversation?.projectRoot);
          const managesRuntime = !opts.runner && !opts.llm
            && Boolean(submitSettings.managedRuntime.executable && submitSettings.managedRuntime.mainModelPath);
          if (managesRuntime) {
            const ready = await awaitRuntimeReady(activeRuntime.models.baseUrl, 300_000, submitController.signal, (elapsedMs, loading) => {
              pushRuntimeState({ phase: loading ? "loading" : "starting", endpoint: activeRuntime.models.baseUrl, model: activeRuntime.models.main, elapsedMs });
            });
            if (!ready && submitController.signal.aborted) { result = { cancelled: true, phase: "waiting-for-model" }; break; }
          }
          if (legacySidecarEnabled && p.autoSidecar !== false && conversation) {
            socket.write(encodeFrame({ protocolVersion: DESKTOP_PROTOCOL_VERSION, eventId: `sidecar:${frame.id}:started`, type: "sidecar.preflight", conversationId, timestamp: Date.now(), payload: { phase: "started" } }));
            try {
              contextPreamble = await automaticSidecarContext(text, conversation.projectRoot, activeRuntime, indexes, sidecar, submitController.signal);
              const compactedHistory = await automaticSidecarCompaction(conversationId, app, activeRuntime, sidecar, submitController.signal);
              contextPreamble = [contextPreamble, compactedHistory].filter(Boolean).join("\n\n");
              socket.write(encodeFrame({ protocolVersion: DESKTOP_PROTOCOL_VERSION, eventId: `sidecar:${frame.id}:ready`, type: "sidecar.preflight", conversationId, timestamp: Date.now(), payload: { phase: "ready", source: contextPreamble.includes("sidecar model") ? "sidecar" : "deterministic" } }));
            } catch (error) {
              if (submitController.signal.aborted) { result = { cancelled: true, phase: "preflight" }; break; }
              socket.write(encodeFrame({ protocolVersion: DESKTOP_PROTOCOL_VERSION, eventId: `sidecar:${frame.id}:fallback`, type: "sidecar.preflight", conversationId, timestamp: Date.now(), payload: { phase: "fallback" } }));
            }
          }
          if (submitController.signal.aborted) { result = { cancelled: true, phase: "preflight" }; break; }
          result = await app.submitMessage(conversationId, text, { lane: typeof p.lane === "string" ? p.lane as never : undefined, k: typeof p.k === "number" ? p.k : undefined, effort: typeof p.effort === "string" ? p.effort : undefined, contextPreamble, signal: submitController.signal });
          // A per-message effort is also the user's new preference for this conversation.
          if (typeof p.effort === "string") app.setEffort(conversationId, p.effort);
          if (legacySidecarEnabled && conversation && /^(?:new task|new conversation)$/i.test(conversation.title.trim())) {
            void automaticSidecarTitle(text, activeRuntime, sidecar).then((title) => { if (title) app.rename(conversationId, title); }).catch(() => { /* title is cosmetic; the run must never depend on it */ });
          }
          // Postflight review and failure triage now run inside KittenApp (sidecarAssist), so every
          // client gets them from ONE implementation instead of only the desktop app.
        } finally {
          submitControllers.delete(conversationId);
        }
        break;
      }
      case "conversation.submit.cancel": {
        const conversationId = String(p.conversationId ?? frame.conversationId ?? "");
        const controller = submitControllers.get(conversationId);
        if (controller) controller.abort("cancelled");
        result = Boolean(controller);
        break;
      }
      case "run.cancel": result = app.cancel(String(p.runId)); break;
      case "approval.resolve": result = app.resolveApproval(String(p.runId), String(p.callId), Boolean(p.allowed)); break;
      case "conversation.rename": app.rename(String(p.id ?? frame.conversationId), String(p.title ?? "Untitled")); result = true; break;
      case "conversation.archive": app.archive(String(p.id ?? frame.conversationId), p.archived !== false); result = true; break;
      case "run.undo": result = app.undoRun(String(p.runId)); break;
      case "run.redo": result = app.redoLast(String(p.conversationId ?? frame.conversationId)); break;
      default: throw new Error(`unknown desktop command: ${frame.type}`);
    }
    socket.write(encodeFrame(response(frame.id, result)));
  } catch (e) {
    socket.write(encodeFrame(failure(frame.id, e)));
  }
}

async function main(): Promise<void> {
  const projectFlag = process.argv.indexOf("--project-root");
  const projectRoot = projectFlag >= 0 ? process.argv[projectFlag + 1] : process.cwd();
  const handle = await startDesktopEngine({ projectRoot: projectRoot || process.cwd() });
  const parentFlag = process.argv.indexOf("--parent-pid");
  const parentPid = parentFlag >= 0 ? Number(process.argv[parentFlag + 1]) : 0;
  let parentWatch: NodeJS.Timeout | undefined;
  parentWatch = Number.isInteger(parentPid) && parentPid > 0 ? setInterval(() => {
    try { process.kill(parentPid, 0); }
    catch { if (parentWatch) clearInterval(parentWatch); void handle.close().then(() => process.exit(0)); }
  }, 1000) : undefined;
  parentWatch?.unref();
  process.on("SIGINT", () => void handle.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void handle.close().then(() => process.exit(0)));

  // A stray async throw must not take the whole app down with it. Node terminates the process on an
  // unhandled rejection, and this engine IS the app: when it dies the window is left connected to
  // nothing, its published token goes stale, and every action afterwards fails with a handshake
  // error that says nothing about the actual fault. One failed request is a failed request; it is
  // not a reason to end the session. The other entry points already take this position — this one
  // was the exception, and it is the one whose death is most expensive.
  const survive = (kind: string) => (reason: unknown): void => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    process.stderr.write(`kitten engine: ${kind} (continuing): ${detail}\n`);
  };
  process.on("unhandledRejection", survive("unhandled rejection"));
  process.on("uncaughtException", survive("uncaught exception"));

  // Whatever ends this process, stop advertising a token that no longer opens anything. A client
  // that reads a dead engine's file connects to the NEXT engine with the wrong token.
  process.on("exit", () => { try { handle.closeSync(); } catch { /* exiting anyway */ } });
}

if (process.argv[1]?.endsWith("desktopEngine.js")) void main();
