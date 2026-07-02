import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { repairMissingSentinelPrompt, sentinelFor } from "../reliability/sentinels.js";
import type { ReliabilityPacketOutputFormat } from "../reliability/types.js";
import { createCheaterLineEditTool } from "../tools.js";
import type { CheaterConfig } from "../types.js";
import { blueprintConfig } from "./config.js";
import type { BlueprintPlan, WorkPacket } from "./types.js";

export interface FreshAgentPacketResult {
  ok: boolean;
  summary: string;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
}

export interface FreshAgentPacketRunner {
  runPacket(params: {
    cwd: string;
    plan: BlueprintPlan;
    packet: WorkPacket;
    prompt: string;
    config: CheaterConfig;
    // The parent session's currently selected model (ctx.model from the tool call site).
    // Without this, createAgentSession re-resolves a model from global settings defaults,
    // which is silently unrelated to whatever model the user is actually driving Cheater
    // with - a worker for a Sonnet session could spawn on a completely different model.
    model?: unknown;
    // Per-attempt reasoning-depth jitter for verified resampling. Pi's SDK has no sampling
    // temperature option (verified against its type declarations), so thinking level is the
    // one sampling knob a caller can vary; Pi clamps it to the model's capabilities.
    thinkingLevel?: "off" | "low" | "medium" | "high";
  }): Promise<FreshAgentPacketResult>;
}

let workerDepth = 0;

// Process-level worker-backend latch. A broken backend (no provider/auth, model offline)
// can take tens of seconds to fail inside createAgentSession; after the first structured
// failure we remember it so heuristic real-worker defaults degrade instantly instead of
// paying that cost per commitlet. An explicit spawnFreshWorker=true request still retries.
let backendLatch: "unknown" | "available" | "unavailable" = "unknown";

export function workerBackendState(): "unknown" | "available" | "unavailable" {
  return backendLatch;
}

export function noteWorkerBackend(ok: boolean): void {
  backendLatch = ok ? "available" : "unavailable";
}

export function resetWorkerBackendLatch(): void {
  backendLatch = "unknown";
}

export interface WorkerBackendProbeResult {
  ok: boolean;
  reason: string;
  modelId?: string;
}

/**
 * Verified backend probe: resolves the bootstrap deadlock where real workers auto-enable
 * only from the latch, but the latch only flips after a real worker runs. The probe creates
 * a throwaway session and checks that a MODEL WITH AUTH actually resolved (createAgentSession
 * succeeds even with nothing configured - the model is only validated at resolution time, so
 * `session.model` being defined is the evidence). No model tokens are spent. The outcome
 * latches, so the probe runs at most once per process; explicit spawnFreshWorker=true still
 * resets the latch for a retry. `createFn` is injectable so tests never touch the real SDK.
 */
export async function probeWorkerBackend(
  cwd: string,
  createFn: (options: Record<string, unknown>) => Promise<{ session: { model?: { id?: string }; dispose?: () => void } }> = createAgentSession as any
): Promise<WorkerBackendProbeResult> {
  if (backendLatch !== "unknown") {
    return { ok: backendLatch === "available", reason: `already latched: ${backendLatch}` };
  }
  try {
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
    const sessionManager = SessionManager.create(cwd, undefined, { id: `cheater-backend-probe-${process.pid.toString(36)}` });
    const { session } = await createFn({ cwd, sessionManager, settingsManager, noTools: "all" });
    const modelId = session.model?.id;
    try { session.dispose?.(); } catch { /* probe cleanup is best-effort */ }
    if (modelId) {
      noteWorkerBackend(true);
      return { ok: true, reason: `worker backend verified: model ${modelId} resolved with auth`, modelId };
    }
    noteWorkerBackend(false);
    return { ok: false, reason: "no model/auth resolvable for fresh worker sessions" };
  } catch (err) {
    noteWorkerBackend(false);
    return { ok: false, reason: `worker backend probe failed: ${(err as Error).message}` };
  }
}

// Prompt-time errors that prove the backend itself is broken (vs. the packet failing).
const BACKEND_ERROR_PATTERN = /no model selected|no api key|no models available|not logged in|use \/login/i;

export function isBackendError(message: string): boolean {
  return BACKEND_ERROR_PATTERN.test(message ?? "");
}

export function isBlueprintWorkerSession(): boolean {
  return workerDepth > 0;
}

export function isIsolatedWorkerSession(): boolean {
  return workerDepth > 0;
}

export async function withIsolatedWorker<T>(fn: () => Promise<T>): Promise<T> {
  workerDepth += 1;
  try {
    return await fn();
  } finally {
    workerDepth -= 1;
  }
}

export function effectiveAgentTokenCap(config: CheaterConfig = {}, modelContextWindow?: number): number {
  const requested = Math.trunc(config.maxContextTokens ?? config.blueprintMaxAgentTokens ?? 100000);
  const blueprintRequested = Math.trunc(config.blueprintMaxAgentTokens ?? requested);
  const configured = Number.isFinite(requested) && requested > 0 ? requested : 100000;
  const blueprintCap = Number.isFinite(blueprintRequested) && blueprintRequested > 0 ? blueprintRequested : configured;
  const modelCap = modelContextWindow && modelContextWindow > 0 ? Math.trunc(modelContextWindow) : Number.POSITIVE_INFINITY;
  return Math.max(1024, Math.min(100000, Math.max(8000, configured), Math.max(8000, blueprintCap), modelCap));
}

/**
 * Context budget for the MAIN interactive session (planner/orchestrator), which is a
 * completely different thing from a fresh worker's per-file packet budget. A worker is
 * deliberately kept tiny (one file, ~12k) so it stays focused; the main session has to hold
 * the whole conversation, the plan, the spec, and progress, and must breathe up to the
 * model's real context window. Capping it at the worker budget (the old bug) made a 100k-ctx
 * model believe it had 12k tokens and panic about "sharing components to save budget".
 *
 * Default: 90% of the model's real context window (leaving room for the reply). Only shrink
 * below that if the user explicitly sets maxSessionContextTokens. Falls back to a generous
 * 100k when the window is unknown.
 */
export function mainSessionContextCap(config: CheaterConfig = {}, modelContextWindow?: number): number {
  const window = modelContextWindow && modelContextWindow > 0 ? Math.trunc(modelContextWindow) : undefined;
  const roomy = window ? Math.floor(window * 0.9) : 100000;
  const requested = config.maxSessionContextTokens;
  if (typeof requested === "number" && requested > 0) {
    // An explicit user cap is honored but never allowed to exceed the real window.
    return window ? Math.min(requested, window) : requested;
  }
  return roomy;
}

export function contextCompactRatio(config: CheaterConfig = {}): number {
  const ratio = Number(config.contextCompactRatio ?? 0.85);
  if (!Number.isFinite(ratio)) return 0.85;
  return Math.max(0.5, Math.min(0.95, ratio));
}

export function compactThresholdTokens(config: CheaterConfig = {}, modelContextWindow?: number): number {
  return Math.floor(effectiveAgentTokenCap(config, modelContextWindow) * contextCompactRatio(config));
}

export function compactSettingsForCap(contextWindow: number | undefined, cap: number, threshold = Math.floor(cap * 0.85)) {
  const window = contextWindow && contextWindow > 0 ? contextWindow : cap + 32768;
  const reserveTokens = Math.max(8192, window - threshold);
  const keepRecentTokens = Math.min(12000, Math.max(4000, Math.floor(cap / 6)));
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens
  };
}

// The worker's tool allowlist. `write` is NOT optional: a from-scratch packet's primary
// operation is creating a new file, Pi's `edit` errors ENOENT on missing files, and
// cheater_line_edit requires an existing file. A worker without `write` gets cornered into
// bash heredocs / node -e one-liners, whose quoting explodes on Windows Git Bash - observed
// live as a 29k-token retry loop that hung the whole flow.
export const WORKER_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "cheater_line_edit"];

export function workerPrompt(plan: BlueprintPlan, packet: WorkPacket, prompt: string, cap: number, sentinel: string): string {
  const files = packet.filesToTouch.map((file) => file.path).join(", ") || "(none)";
  const platformNote = process.platform === "win32"
    ? "- Platform: Windows; the bash tool is Git Bash. Quoting is fragile here - avoid heredocs and multi-line inline scripts entirely."
    : "";
  return [
    "CHEATER FRESH WORKER SESSION",
    "",
    `Global goal: ${plan.userGoal}`,
    `Packet: ${packet.id} - ${packet.title}`,
    `Packet type: ${packet.type}`,
    `Allowed files for this packet: ${files}`,
    `Hard token cap for this worker: ${cap}`,
    `Required packet end sentinel: ${sentinel}`,
    "",
    "Rules:",
    "- You are the code-changing worker, not the planner.",
    "- Execute only this one packet, then stop. You are not allowed to roll into the next file.",
    "- To CREATE a new file, use the write tool (path + full content) in ONE call. Never create files via bash heredocs, echo, cat, or node -e: shell quoting will corrupt the content.",
    "- For existing files, read the exact target lines and use cheater_line_edit or the smallest Pi edit.",
    platformNote,
    "- If this packet touches a file, do not inspect or edit unrelated sibling templates/styles/source files.",
    "- If another file seems necessary, stop with BLOCKED_NEXT_FILE instead of editing it; the planner will summon a new fresh worker.",
    "- Do not rewrite an entire existing template, stylesheet, or source file unless the packet explicitly requires full replacement.",
    "- If a tool fails twice the same way, STOP and report the blocker in your summary instead of trying variations.",
    "- End with PACKET_RESULT, SUMMARY, FILES_TOUCHED, and VERIFY lines.",
    `- Your final assistant message must end with exactly this required packet end sentinel: ${sentinel}`,
    "",
    prompt
  ].filter(Boolean).join("\n");
}

function packetSessionId(packet: WorkPacket): string {
  const safeId = packet.id.replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 48) || "packet";
  return `cheater-${safeId}-${Date.now().toString(36)}`;
}

function compactText(text: string | undefined, fallback: string): string {
  const cleaned = (text ?? "").trim().replace(/\n{3,}/g, "\n\n");
  if (!cleaned) return fallback;
  return cleaned.length <= 1600 ? cleaned : `${cleaned.slice(0, 1600)}\n...`;
}

function outputFormatFor(packet: WorkPacket): ReliabilityPacketOutputFormat {
  if (packet.type === "review") return "review";
  if (packet.type === "implement" || packet.type === "repair") return "patch";
  return "json";
}

function hasEndingSentinel(text: string | undefined, sentinel: string): boolean {
  return (text ?? "").trimEnd().endsWith(sentinel);
}

function compactSentinelBody(text: string | undefined, sentinel: string, fallback: string): string {
  const trimmed = (text ?? "").trimEnd();
  const body = trimmed.endsWith(sentinel) ? trimmed.slice(0, -sentinel.length).trimEnd() : trimmed;
  return compactText(body, fallback);
}

export const sdkFreshAgentPacketRunner: FreshAgentPacketRunner = {
  async runPacket({ cwd, plan, packet, prompt, config, model, thinkingLevel }) {
    if (config.packetOneFilePerWorkerEnabled !== false && packet.filesToTouch.length > (config.packetMaxFilesToTouch ?? 1)) {
      return {
        ok: false,
        summary: `Packet ${packet.id} violates one-file-per-worker discipline: ${packet.filesToTouch.map((file) => file.path).join(", ")}`,
        error: "packet_scope_too_broad"
      };
    }
    return withIsolatedWorker(async () => {
      const requiredSentinel = sentinelFor(outputFormatFor(packet), blueprintConfig(config));
      const cap = effectiveAgentTokenCap(config);
      const threshold = compactThresholdTokens(config);
      // Session creation must fail structurally, not reject the caller's promise: a missing
      // provider/model config or a dead local backend is an expected condition the commitlet
      // layer degrades from (falls back to a simulated in-session prompt), not a crash.
      let session: any;
      try {
        const settingsManager = SettingsManager.inMemory({
          compaction: compactSettingsForCap(undefined, cap, threshold),
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time"
        }, { projectTrusted: true });
        const sessionManager = SessionManager.create(cwd, undefined, { id: packetSessionId(packet) });
        ({ session } = await createAgentSession({
          cwd,
          sessionManager,
          settingsManager,
          tools: WORKER_TOOLS,
          customTools: [createCheaterLineEditTool()],
          // Inherit the parent session's model so a worker never silently runs on whatever
          // global default happens to be configured instead of the model the user picked.
          ...(model ? { model: model as any } : {}),
          ...(thinkingLevel ? { thinkingLevel: thinkingLevel as any } : {})
        }));
      } catch (err) {
        noteWorkerBackend(false);
        return {
          ok: false,
          summary: `Could not create a fresh worker session for ${packet.id}: ${(err as Error).message}`,
          error: "worker_backend_unavailable"
        };
      }
      // Session creation is NOT proof the backend works: Pi creates a session even with no
      // model/auth configured and only fails at prompt() ("No model selected"). Only a
      // resolved model counts as evidence for the availability latch.
      if (session.model?.id) {
        noteWorkerBackend(true);
      } else {
        noteWorkerBackend(false);
        try { session.dispose(); } catch { /* best-effort */ }
        return {
          ok: false,
          summary: `Fresh worker session for ${packet.id} has no resolvable model (no provider/auth configured).`,
          error: "worker_backend_unavailable"
        };
      }
      // Wall-clock guard: on a slow local backend a wedged worker (e.g. a tool-retry loop)
      // used to hang the calling tool - and the whole main session - indefinitely with zero
      // feedback. When the deadline passes we abort the worker session and return a
      // structured failure the commitlet layer can degrade from.
      const timeoutMs = Math.max(60_000, config.commitletWorkerTimeoutMs ?? 10 * 60_000);
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        try { session.abort?.(); } catch { /* best-effort */ }
      }, timeoutMs);
      try {
        const contextWindow = session.model?.contextWindow;
        const effectiveCap = effectiveAgentTokenCap(config, contextWindow);
        const effectiveThreshold = compactThresholdTokens(config, contextWindow);
        session.settingsManager.applyOverrides({
          compaction: compactSettingsForCap(contextWindow, effectiveCap, effectiveThreshold),
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time"
        });
        session.setAutoCompactionEnabled(true);
        session.setSessionName(`Cheater worker ${packet.id}`);
        await session.prompt(workerPrompt(plan, packet, prompt, effectiveCap, requiredSentinel), { source: "extension" });
        let assistantText = session.getLastAssistantText();
        if (timedOut) {
          return {
            ok: false,
            summary: `Worker for ${packet.id} exceeded the ${Math.round(timeoutMs / 60000)}m wall-clock limit and was aborted. Last output: ${compactText(assistantText, "(none)")}`,
            error: "worker_timeout",
            sessionId: session.sessionId,
            sessionFile: session.sessionFile
          };
        }
        if (!hasEndingSentinel(assistantText, requiredSentinel)) {
          await session.prompt(repairMissingSentinelPrompt(assistantText ?? "", requiredSentinel), { source: "extension" });
          assistantText = session.getLastAssistantText();
        }
        if (!hasEndingSentinel(assistantText, requiredSentinel)) {
          const lastOutput = compactText(assistantText, "(no assistant output)");
          return {
            ok: false,
            summary: `Worker session for ${packet.id} did not return the required end sentinel ${requiredSentinel} after one repair attempt. Last output: ${lastOutput}`,
            error: `missing_packet_end_sentinel:${requiredSentinel}`,
            sessionId: session.sessionId,
            sessionFile: session.sessionFile
          };
        }
        return {
          ok: true,
          summary: compactSentinelBody(assistantText, requiredSentinel, `${packet.title} completed.`),
          sessionId: session.sessionId,
          sessionFile: session.sessionFile
        };
      } catch (err) {
        const message = (err as Error).message;
        if (timedOut) {
          return {
            ok: false,
            summary: `Worker for ${packet.id} exceeded the ${Math.round(timeoutMs / 60000)}m wall-clock limit and was aborted.`,
            error: "worker_timeout",
            sessionId: session.sessionId,
            sessionFile: session.sessionFile
          };
        }
        // "No model selected" / "No API key" at prompt time proves the BACKEND is broken,
        // not the packet: latch it (so heuristic defaults degrade instantly) and return the
        // structured error the commitlet layer already degrades from.
        if (isBackendError(message)) {
          noteWorkerBackend(false);
          return {
            ok: false,
            summary: `Worker backend unavailable for ${packet.id}: ${message}`,
            error: "worker_backend_unavailable",
            sessionId: session.sessionId,
            sessionFile: session.sessionFile
          };
        }
        return {
          ok: false,
          summary: `Worker session failed for ${packet.id}: ${message}`,
          error: message,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile
        };
      } finally {
        clearTimeout(deadline);
        session.dispose();
      }
    });
  }
};
