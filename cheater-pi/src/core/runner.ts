// Kitten Core — the default, engine-backed Runner. NO Pi.
//
// Translates a routed run into the right core engine (answer/direct/reliable/bon/ascent) and maps the
// engine's low-level AgentEvent stream onto the canonical application events the app persists +
// broadcasts. This is the ONLY place lane→engine lives; the app service stays engine-agnostic and the
// clients stay app-agnostic. Tests inject a scripted Runner instead of this one, so nothing here needs
// a live model to exercise the persistence/replay spine.

import type { Runner, RunContext, RunOutcome } from "./app.js";
import type { InferenceCompleted } from "./events.js";
import type { AgentEvent } from "./agent.js";
import { runAgent } from "./agent.js";
import { runReliableAgent, type ReliableParams } from "./reliable.js";
import { runBestOfN } from "./bestofn.js";
import { runAscent, defaultAscentConfig } from "./ascent.js";
import { KittenLLM, DEFAULT_MODELS } from "./llm.js";
import { changedFilesSince } from "./undo.js";
import { getAgent } from "./agents.js";
import { CORE_TOOLS, type Tool } from "./tools.js";
import { makeWebTools, type WebAccessMode } from "./webTools.js";
import { runCompiledFast } from "./compiledFast.js";
import { contractForPhase, phaseForAgent, type InferencePhase } from "./runtimeDirector.js";
import type { InferenceOverrides } from "./inferenceProfiles.js";
import { resolveBenchmarkProfile, type BenchmarkProfile } from "./benchmark.js";

export interface RunnerOpts {
  /** Web tool reach (settings.webAccess). Default "open" — the product default the user chose. */
  webAccess?: WebAccessMode;
  fastPath?: "auto" | "off";
}

/** Build the default Runner over a KittenLLM (defaults to the local LM Studio tiering). */
export function defaultRunner(llm: KittenLLM = new KittenLLM(DEFAULT_MODELS), opts: RunnerOpts = {}): Runner {
  const benchmarkProfile = resolveBenchmarkProfile();
  return async (ctx: RunContext): Promise<RunOutcome> => {
    const effective = applyBenchmarkProfile(ctx, benchmarkProfile);
    // Resolve capability truth before constructing any phase contract. A provider that does not
    // acknowledge native samplers must be reported as sent-only instead of silently claiming they
    // activated.
    if (typeof llm.prepareRuntime === "function") await llm.prepareRuntime();
    if (effective.lane === "answer") return runAnswer(effective, llm);
    return runCoding(effective, llm, opts);
  };
}

/** Benchmark-only routing clamp. Product defaults remain unchanged when KITTEN_BENCH_PROFILE is absent. */
function applyBenchmarkProfile(ctx: RunContext, profile: BenchmarkProfile): RunContext {
  if (profile === "full") return ctx;
  const noAscent = profile === "minimal" || profile === "no-ascent" || profile === "no-learned";
  const noSidecar = profile === "minimal" || profile === "no-sidecar";
  const lane = noAscent && ctx.lane === "ascent" ? "reliable" : ctx.lane;
  return {
    ...ctx,
    lane,
    k: noAscent ? 1 : ctx.k,
    spawnTask: noSidecar ? undefined : ctx.spawnTask,
    profile: noAscent ? { ...ctx.profile, scoutFiles: 0, kFloor: 1, kCap: 1, maxRepairRounds: 0 } : ctx.profile,
  };
}

function agentConfig(ctx: RunContext, llm: KittenLLM, opts: RunnerOpts = {}): { systemPrompt?: string; model: string; tools: Tool[]; phase: InferencePhase; inferenceOverrides: InferenceOverrides; maxTurns?: number } {
  const definition = getAgent(ctx.agent ?? "general", ctx.cwd);
  // Sidecar is compatibility metadata only. Every supported agent runs through the primary runtime;
  // phase-specific controls are applied by the Runtime Director below.
  const model = ctx.model;
  const phase = phaseForAgent(definition?.name ?? ctx.agent);
  const inferenceOverrides = definition?.temperature === undefined ? {} : { temperature: definition.temperature };
  const permission = definition?.permission ?? {};
  const tools = CORE_TOOLS.filter((tool) => {
    const name = tool.schema.name;
    if ((name === "edit" || name === "write") && permission.edit === "deny") return false;
    if (name === "bash" && permission.bash === "deny") return false;
    if (name === "task" && permission.task === "deny") return false;
    return true;
  });
  // Web tools: triple-gated — settings reach, effort profile, agent permission. Subagents default
  // deny (a bounded worker must stay bounded); the primary agent defaults allow.
  const webAccess = opts.webAccess ?? "open";
  const webPermission = permission.web ?? (definition?.mode === "subagent" ? "deny" : "allow");
  const web = webAccess !== "off" && ctx.profile.webEnabled && webPermission !== "deny"
    ? makeWebTools({ mode: webAccess })
    : [];
  return { systemPrompt: definition?.systemPrompt, model, tools: [...tools, ...web], phase, inferenceOverrides, maxTurns: definition?.steps };
}

/** Answer-only lane: one chat, no write tools, stream the reply as assistant deltas. */
async function runAnswer(ctx: RunContext, llm: KittenLLM): Promise<RunOutcome> {
  const started = Date.now();
  const profile = agentConfig(ctx, llm);
  // Merge context into the ONE system message (templates reject a second system message).
  const sys = (profile.systemPrompt ?? "You are Kitten, a precise coding assistant.") + " Answer the question directly and concisely. Do not modify any files."
    + (ctx.conversationContext.trim() ? `\n\n${ctx.conversationContext}` : "");
  const contract = contractForPhase("answer", ctx.profile.level, profile.inferenceOverrides, llm.inferenceCapabilities ?? {}, ctx.model);
  const chatParams = { model: ctx.model, messages: [{ role: "system" as const, content: sys }, { role: "user" as const, content: ctx.task }], signal: ctx.signal, ...contract.transport, role: contract.role };
  // Stream the answer live (coalesced) so a long explanation on a slow local model isn't a frozen wait.
  let buf = "";
  const r = typeof llm.chatStream === "function"
    ? await llm.chatStream(chatParams, (d) => { if (d.content) { buf += d.content; if (buf.length >= 48) { ctx.emit({ type: "assistant.delta", runId: ctx.runId, text: buf }); buf = ""; } } })
    : await llm.chat(chatParams);
  if (buf) ctx.emit({ type: "assistant.delta", runId: ctx.runId, text: buf });
  // A model error / cancel in the answer lane must terminate as failed/cancelled — not be recorded as a
  // "completed" run like a successful answer (the coding lanes already fail on error via a throw). The
  // app's submitMessage maps this throw to run.failed, or run.cancelled when the signal was aborted.
  if (!r.ok) throw new Error(r.error ? `model error: ${r.error}` : "model error");
  ctx.emit({ type: "assistant.final", runId: ctx.runId, text: r.content });
  return {
    finished: true,
    summary: r.content.slice(0, 200),
    wallMs: Date.now() - started,
    usage: { prompt: r.usage.prompt, completion: r.usage.completion, reasoning: r.usage.reasoning },
    receiptLines: ["answer-only lane: answered", ...(r.formatRescues ? [`format rescues: ${r.formatRescues}`] : [])],
    filesChanged: [],
    verified: false,
  };
}

/** Coding lanes: direct/reliable/bon/ascent. Maps AgentEvents → canonical events as they arrive. */
async function runCoding(ctx: RunContext, llm: KittenLLM, opts: RunnerOpts = {}): Promise<RunOutcome> {
  const profile = agentConfig(ctx, llm, opts);
  let toolN = 0;
  const streamedTurns = new Set<number>();
  // Live tool state streams only on the single-trajectory lanes: bon/ascent run k parallel candidates
  // whose interleaved started/output events would be noise (candidates already get candidate.* cards).
  const liveToolState = ctx.lane === "direct" || ctx.lane === "reliable";
  // Pair started↔completed via the agent's per-call number when present; fall back to a local counter
  // for scripted/legacy AgentEvents that predate `data.call` (they never mix within one run).
  const callIdOf = (e: AgentEvent): string => {
    const n = e.data && typeof (e.data as { call?: number }).call === "number" ? (e.data as { call: number }).call : toolN++;
    return `${ctx.runId}:t${n}`;
  };
  const onEvent = (e: AgentEvent): void => {
    switch (e.kind) {
      case "assistant_delta":
        streamedTurns.add(e.turn);
        if (e.detail) ctx.emit({ type: "assistant.delta", runId: ctx.runId, text: e.detail });
        break;
      case "reasoning_delta":
        if (e.detail) ctx.emit({ type: "reasoning.delta", runId: ctx.runId, text: e.detail });
        break;
      case "assistant":
        // Non-streaming fallback: emit the whole turn content as one delta. When this turn already
        // streamed, skip — the deltas covered it (no duplicate text; Goal §3).
        if (!streamedTurns.has(e.turn) && e.detail && e.detail !== "(tool call)") ctx.emit({ type: "assistant.delta", runId: ctx.runId, text: e.detail });
        break;
      case "tool_start": {
        if (!liveToolState) break;
        const data = (e.data ?? {}) as { name?: string; target?: string };
        const name = String(data.name ?? e.detail.split("(")[0].trim() ?? "tool");
        ctx.emit({ type: "tool.started", runId: ctx.runId, callId: callIdOf(e), name, ...(data.target ? { target: String(data.target) } : {}) });
        break;
      }
      case "tool_output":
        if (liveToolState && e.detail) ctx.emit({ type: "tool.output", runId: ctx.runId, callId: callIdOf(e), chunk: e.detail });
        break;
      case "tool": {
        const name = e.detail.split("(")[0].trim() || "tool";
        const ok = !(e.data && (e.data as { error?: boolean }).error);
        const output = e.data && typeof (e.data as { output?: string }).output === "string" ? String((e.data as { output?: string }).output) : "";
        // The agent already renders `name(brief args) -> ok`; carry the argument through as `target` so a
        // client can say "read src/parser.ts" instead of just "read".
        const open = e.detail.indexOf("(");
        const close = e.detail.lastIndexOf(")");
        const target = open >= 0 && close > open ? e.detail.slice(open + 1, close).trim() : "";
        const durationMs = e.data && typeof (e.data as { durationMs?: number }).durationMs === "number" ? (e.data as { durationMs: number }).durationMs : 0;
        ctx.emit({ type: "tool.completed", runId: ctx.runId, callId: callIdOf(e), name, ...(target ? { target } : {}), ok, durationMs, output });
        break;
      }
      case "inference.completed": {
        const d = e.data ?? {};
        ctx.emit({ type: "inference.completed", runId: ctx.runId, role: String(d.role ?? "executor"), cacheTokens: Number(d.cacheTokens ?? 0), promptTokens: Number(d.promptTokens ?? 0), promptMs: Number(d.promptMs ?? 0), predictedTokens: Number(d.predictedTokens ?? 0), predictedMs: Number(d.predictedMs ?? 0), decodeTokensPerSecond: Number(d.decodeTokensPerSecond ?? 0), ...(d.runtimeReceipt && typeof d.runtimeReceipt === "object" ? { runtimeReceipt: d.runtimeReceipt as InferenceCompleted["runtimeReceipt"] } : {}) });
        break;
      }
      case "gate_block":
        // A deterministic gate (noun/path firewall or finish gate) rejected an action and sent the
        // model back — surface it as a failed check so a UI can show the "bug/repair" state (Goal §4).
        ctx.emit({ type: "verification.failed", runId: ctx.runId, detail: e.detail });
        break;
      case "error":
        // A model error mid-run is exactly when the user starts wondering if the app is dead. Say it.
        ctx.emit({ type: "run.status", runId: ctx.runId, status: "running", detail: `model error: ${e.detail.slice(0, 200)}` });
        break;
      case "nudge":
        // Only the recovery nudges are user-relevant ("retrying (2/3)"); pacing nudges stay internal.
        if (/retrying/i.test(e.detail)) ctx.emit({ type: "run.status", runId: ctx.runId, status: "running", detail: e.detail.slice(0, 200) });
        break;
      default:
        break; // finish is represented by the terminal outcome, not interim events
    }
  };

  // The effort dial's bounds reach the agent loop here: turn cap and thinking budget were previously
  // never set from the app path (every run got the 40-turn default and the model's own thinking).
  const deadline = startEffortDeadline(ctx);
  const common = {
    task: ctx.task, cwd: ctx.cwd, llm, model: profile.model, systemPrompt: profile.systemPrompt, tools: profile.tools,
    spawnTask: ctx.spawnTask, allowedFiles: ctx.allowedFiles, forbiddenFiles: ctx.forbiddenFiles, onEvent, signal: deadline.signal,
    maxTurns: profile.maxTurns ?? ctx.profile.maxTurns,
    reasoningBudget: ctx.profile.reasoningBudget,
    effort: ctx.profile.level,
    inferencePhase: profile.phase,
    inferenceOverrides: profile.inferenceOverrides,
    bootProfile: { ownership: llm.runtimeOwnership, model: profile.model },
  };

  // Route destructive shell commands through the app's approval policy (Goal §8). Catastrophic/RCE/exfil
  // are hard-blocked by the engine's safety floor regardless; this gates merely-destructive ("warn") ones.
  let cmdN = 0;
  const commandGate = async (command: string, assessment: { verdict: string; category: string; message: string }): Promise<{ allowed: boolean; feedback?: string }> => {
    const risk = assessment.verdict === "block" ? "high" as const : "medium" as const;
    const allowed = await ctx.requestApproval(`${ctx.runId}:cmd${cmdN++}`, "bash", `${assessment.category}: ${assessment.message}`, risk);
    return { allowed, feedback: allowed ? undefined : `denied by approval policy: ${assessment.message}` };
  };

  // The ascent lane can decline to assemble (a poisoned experience store) and fall back to reliable.
  // That fallback must run with the SAME guards as a first-class reliable run — approval gating above
  // all — so it is handed the built parameter bag rather than reconstructing a thinner one.
  if (ctx.lane === "ascent") return runAscentLane(ctx, llm, onEvent, profile, { ...common, commandGate });

  const preamble = ctx.conversationContext || undefined;
  // Stream the single-trajectory lanes (direct/reliable). bon/ascent run multiple candidates in parallel
  // isolated workspaces — interleaving their token streams would be noise, so they don't stream.
  let executionStrategy: RunOutcome["executionStrategy"] = "agent";
  let result;
  if (ctx.lane === "reliable" && ctx.profile.level === "fast" && opts.fastPath !== "off") {
    const fast = await runCompiledFast({ task: ctx.task, cwd: ctx.cwd, llm, model: profile.model, tools: profile.tools, onEvent, signal: deadline.signal, allowedFiles: ctx.allowedFiles, forbiddenFiles: ctx.forbiddenFiles });
    if (fast.eligibility.eligible && fast.verified) {
      result = fast.result;
      executionStrategy = "compiled-fast";
    } else {
      executionStrategy = "compiled-fast-to-reliable";
      result = await runReliableAgent({ ...common, commandGate, contextPreamble: preamble, streamDeltas: true, onVerification: verificationSink(ctx), scoutFiles: ctx.profile.scoutFiles, extraDirective: fast.diagnostic ? `A compiled Fast attempt made a single mutation but verification failed: ${fast.diagnostic}. Preserve and repair that change, then run one compact check.` : undefined });
    }
  } else if (ctx.lane === "bon") {
    result = await runBestOfN({ ...common, contextPreamble: preamble }, ctx.k, {
      onSlateEntry: (entry) => {
        ctx.emit({ type: "candidate.started", runId: ctx.runId, index: entry.attempt });
        ctx.emit({ type: "candidate.completed", runId: ctx.runId, index: entry.attempt, finished: entry.finished, summary: entry.stopReason });
      }
    });
  } else if (ctx.lane === "direct") {
    result = await runAgent({ ...common, commandGate, contextPreamble: preamble, streamDeltas: true });
  } else {
    result = await runReliableAgent({ ...common, commandGate, contextPreamble: preamble, streamDeltas: true, onVerification: verificationSink(ctx), scoutFiles: ctx.profile.scoutFiles });
  }

  deadline.dispose();

  // Surface changed files as file.changed events (winner provenance is trivial here — single trajectory).
  for (const f of result.filesWritten) ctx.emit({ type: "file.changed", runId: ctx.runId, path: f, added: 0, removed: 0 });

  return {
    finished: result.finished,
    summary: result.summary || result.stopReason,
    wallMs: result.wallMs,
    usage: result.usage,
    receiptLines: [
      `${ctx.lane} lane: ${result.stopReason} in ${result.turns} turns (${(result.wallMs / 1000).toFixed(1)}s)`,
      `files: ${result.filesWritten.join(", ") || "none"}`,
      ...(result.runtimeReceipt ? [`runtime: ${result.runtimeReceipt.phase}/${result.runtimeReceipt.role} ${result.runtimeReceipt.evidence}${result.runtimeReceipt.dropped.length ? `; dropped ${result.runtimeReceipt.dropped.join(",")}` : ""}`] : []),
      ...(result.formatRescues ? [`format rescues: ${result.formatRescues} optional structured-output constraint(s) removed after endpoint rejection`] : []),
    ],
    filesChanged: result.filesWritten,
    // The reliable lane's finish gate requires an execution receipt, so a gate-APPROVED reliable finish
    // is verified. A FORCED finish (rejection budget exhausted → auto-allowed to avoid a loop) obtained
    // no receipt and must not be verified. The DIRECT lane has NO finish gate — "finished" only means the
    // model stopped, never verified (§4).
    verified: ctx.lane === "direct" ? false : (result.finished && !result.forcedFinish),
    executionStrategy,
    performance: result.inferenceTimings ? {
      modelCalls: result.inferenceTimings.modelCalls,
      cacheTokens: result.inferenceTimings.cacheTokens ?? 0,
      promptTokens: result.inferenceTimings.promptTokens ?? result.usage.prompt,
      promptMs: result.inferenceTimings.promptMs ?? 0,
      predictedTokens: result.inferenceTimings.predictedTokens ?? result.usage.completion,
      predictedMs: result.inferenceTimings.predictedMs ?? 0,
      decodeTokensPerSecond: result.inferenceTimings.predictedTokensPerSecond ?? 0,
      effectiveOutputRate: result.wallMs > 0 ? result.usage.completion / (result.wallMs / 1000) : 0,
    } : undefined,
  };
}

/**
 * The lanes' cancellation signal. **There is deliberately no automatic wall-clock deadline.**
 *
 * An earlier version armed the effort profile's ceiling as a timer-backed AbortSignal, so
 * "Fast ≈ 3 min … Think Hard ≈ 45 min" was enforced rather than advertised. That was removed on
 * purpose: a timer that fires mid-candidate throws away work the run had already done, and the
 * ceiling it enforced was a UI hint about typical cost, not a contract the user asked for. What
 * bounds a run now is `maxTurns`, the budget governor's between-round accounting, and the user's
 * own cancel — all of which stop at a seam where partial work survives.
 *
 * A harness that genuinely needs a hard clock (a benchmark runner whose grader kills the container)
 * owns that timeout itself and cancels through `ctx.signal`; the TB2 adapter does exactly this.
 *
 * This helper stays as the single place the lanes obtain their signal, so reintroducing a bound —
 * should one ever be justified — is one function, not eight call sites.
 */
function startEffortDeadline(ctx: RunContext): { signal: AbortSignal; expired: () => boolean; dispose: () => void } {
  return { signal: ctx.signal ?? new AbortController().signal, expired: () => false, dispose: () => { /* no automatic deadline */ } };
}

/** Map the reliable lane's finish-gate progress onto canonical verification events. */
function verificationSink(ctx: RunContext): (e: { phase: "started" | "evidence" | "passed"; what?: string; check?: string; passed?: boolean; durationMs?: number; detail?: string }) => void {
  return (e) => {
    if (e.phase === "started") ctx.emit({ type: "verification.started", runId: ctx.runId, what: e.what ?? "verification" });
    else if (e.phase === "evidence") ctx.emit({ type: "verification.evidence", runId: ctx.runId, check: e.check ?? "check", passed: e.passed ?? false, durationMs: e.durationMs ?? 0 });
    else ctx.emit({ type: "verification.passed", runId: ctx.runId, detail: e.detail ?? "verified" });
  };
}

/**
 * The winner's own summary is the last thing its agent said — which, after a long run, is often a
 * transport or context error from a turn that happened AFTER the work was already done and verified.
 * Reporting that verbatim on a green run is actively misleading: observed live, a from-scratch build
 * that scored 13/13 on a hidden oracle was summarized as
 * "model call failed: HTTP 500: Context size has been exceeded."
 *
 * So when execution evidence passed, lead with what was actually achieved and keep the error as
 * trailing context — never drop it, because a run that hit its context ceiling is worth knowing about.
 */
function ascentSummary(a: { summary: string; winnerHasExecutionReceipt: boolean }, adopted: boolean): string {
  const summary = a.summary.trim();
  if (!adopted) return summary || "no candidate adopted";
  const terminalError = /^(?:model call failed|HTTP \d{3}\b|request failed|stream error)/i.test(summary);
  if (!summary) return a.winnerHasExecutionReceipt ? "solved (verified)" : "implemented (not independently verified)";
  if (terminalError && a.winnerHasExecutionReceipt) {
    return `solved (verified by execution); a later model call did not complete: ${summary.slice(0, 200)}`;
  }
  return summary;
}

/** Ascent lane: the full pass@k→pass@1 machine. Degrades to reliable if config assembly refuses. */
async function runAscentLane(ctx: RunContext, llm: KittenLLM, onEvent: (e: AgentEvent) => void, profile: { systemPrompt?: string; model: string }, fallback: ReliableParams): Promise<RunOutcome> {
  // Ascent's own bound is config.ceiling, consulted BETWEEN rounds by the budget governor; this is
  // just the user's cancellation signal (see startEffortDeadline — no automatic clock).
  const deadline = startEffortDeadline(ctx);
  // Pair started↔completed by the agent's own per-call number, so the completion closes the card the
  // start opened. A local counter would advance twice per call and never match.
  let leadToolN = 0;
  const leadCallId = (e: AgentEvent): string => {
    const n = e.data && typeof (e.data as { call?: number }).call === "number" ? (e.data as { call: number }).call : leadToolN++;
    return `${ctx.runId}:lead${n}`;
  };
  let config;
  try {
    config = defaultAscentConfig(llm, ctx.cwd);
  } catch (e) {
    // e.g. a poisoned experience store (DisjointnessError). Don't fail the user's run — degrade.
    ctx.emit({ type: "verification.failed", runId: ctx.runId, detail: `ascent setup declined (${(e as Error).message.slice(0, 120)}); using reliable lane` });
    // A degraded run is still the user's run. Rebuilding a thinner parameter set here is how it
    // silently lost its destructive-shell approval gate, its file scope, and its inference phase —
    // the fallback now inherits the caller's full bag and overrides only what is lane-local.
    const result = await runReliableAgent({
      ...fallback,
      signal: deadline.signal,
      contextPreamble: ctx.conversationContext || undefined,
      onVerification: verificationSink(ctx),
      scoutFiles: ctx.profile.scoutFiles,
    });
    for (const f of result.filesWritten) ctx.emit({ type: "file.changed", runId: ctx.runId, path: f, added: 0, removed: 0 });
    return {
      finished: result.finished, summary: result.summary || result.stopReason, wallMs: result.wallMs, usage: result.usage,
    receiptLines: [`ascent→reliable fallback: ${result.stopReason} in ${result.turns} turns`, ...(result.formatRescues ? [`format rescues: ${result.formatRescues}`] : [])], filesChanged: result.filesWritten, verified: result.finished && !result.forcedFinish,
    };
  }
  config.onCandidate = async ({ phase, attempt, reason }) => {
    if (phase === "completed") ctx.emit({ type: "candidate.completed", runId: ctx.runId, index: attempt.index, finished: attempt.result.finished, summary: attempt.result.summary, usage: attempt.result.usage });
    else ctx.emit({ type: "candidate.rejected", runId: ctx.runId, index: attempt.index, reason: reason ?? "candidate rejected" });
  };
  config.onCandidateStart = ({ index, lead }) => ctx.emit({ type: "candidate.started", runId: ctx.runId, index, lead });
  // The lead candidate's reasoning and tool calls carry the live view. Its assistant PROSE is
  // deliberately not forwarded: on this lane the transcript must show the adopted winner's answer, and
  // a lead that loses would have written text the user then sees attributed to the run.
  config.onLeadEvent = (e: AgentEvent): void => {
    switch (e.kind) {
      case "reasoning_delta":
        if (e.detail) ctx.emit({ type: "reasoning.delta", runId: ctx.runId, text: e.detail });
        break;
      case "tool_start": {
        const data = (e.data ?? {}) as { name?: string; target?: string };
        const name = String(data.name ?? e.detail.split("(")[0].trim() ?? "tool");
        ctx.emit({ type: "tool.started", runId: ctx.runId, callId: leadCallId(e), name, ...(data.target ? { target: String(data.target) } : {}) });
        break;
      }
      // Every started card MUST be closed. Without this the lead's tool rows stayed open for the whole
      // run and the end-of-run sweep marked all of them "✗ stopped" — the UI reporting a clean read as
      // a killed one, which reads exactly like the harness aborting the model's own verification.
      case "tool": {
        const name = e.detail.split("(")[0].trim() || "tool";
        const data = (e.data ?? {}) as { error?: boolean; output?: string; durationMs?: number };
        const open = e.detail.indexOf("(");
        const close = e.detail.lastIndexOf(")");
        const target = open >= 0 && close > open ? e.detail.slice(open + 1, close).trim() : "";
        ctx.emit({
          type: "tool.completed", runId: ctx.runId, callId: leadCallId(e), name,
          ...(target ? { target } : {}),
          ok: !data.error, durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
          output: typeof data.output === "string" ? data.output : "",
        });
        break;
      }
      default:
        break;
    }
  };
  // Live repair/verification progress → canonical events (the ascent machine was previously silent
  // for its whole multi-minute verify+repair phase — the definition of the black box).
  config.onProgress = (e) => {
    switch (e.kind) {
      case "repair.started": ctx.emit({ type: "repair.started", runId: ctx.runId, round: e.round, seed: e.reason }); break;
      case "verification.started": ctx.emit({ type: "verification.started", runId: ctx.runId, what: e.what }); break;
      case "verification.evidence": ctx.emit({ type: "verification.evidence", runId: ctx.runId, check: `#${e.index} ${e.check}`, passed: e.passed, durationMs: e.durationMs }); break;
      case "verification.passed": ctx.emit({ type: "verification.passed", runId: ctx.runId, detail: e.detail }); break;
      case "verification.failed": ctx.emit({ type: "verification.failed", runId: ctx.runId, detail: e.detail }); break;
    }
  };
  // The effort profile arms the previously-unset compute ceiling and repair bound, and clamps k.
  config.ceiling = ctx.profile.ceiling;
  config.maxRepairRounds = ctx.profile.maxRepairRounds;
  const a = await runAscent(
    {
      task: ctx.task, cwd: ctx.cwd, taskId: ctx.runId, hardness: ctx.hardness,
      forceSamples: ctx.k > 1 ? ctx.k : undefined,
      kFloor: ctx.profile.kFloor, kCap: ctx.profile.kCap,
      maxTurns: ctx.profile.maxTurns,
      onEvent, signal: deadline.signal, contextPreamble: ctx.conversationContext || undefined, model: profile.model,
    },
    config
  );
  // The Ascent engine runs candidates in isolated workspaces and adopts the winner into cwd, so it
  // doesn't self-report changed files. Derive them from git against the pre-run snapshot and surface
  // them as events, so the diff view and /undo cover the Ascent lane too.
  // Prefer git (it distinguishes changed from merely-present), but fall back to what adoption
  // actually copied. A non-git workspace has no snapshot, and reporting `[]` there made a run that
  // wrote four correct files claim it changed nothing — which silently disables /undo, empties the
  // diff view, and skips postflight review.
  const fromGit = ctx.snapshotRef ? changedFilesSince(ctx.cwd, ctx.snapshotRef) : [];
  const filesChanged = fromGit.length ? fromGit : a.adoptedFiles;
  for (const f of filesChanged) ctx.emit({ type: "file.changed", runId: ctx.runId, path: f, added: 0, removed: 0 });
  // Distinguish FINISHED (a winner was selected + adopted — work was produced and a candidate self-
  // verified) from VERIFIED (independent execution proof). A correct stateful/class solve with no clean
  // worked examples adopts a winner but earns no receipt → finished:true, verified:false = "checked",
  // NOT a red failure (§4: don't collapse these). Measurement (cli.ts --ascent) still uses the receipt.
  const adopted = a.winner != null;
  deadline.dispose();
  return {
    finished: adopted,
    summary: ascentSummary(a, adopted),
    wallMs: a.wallMs,
    usage: a.usage,
    receiptLines: [
      ...a.receipts,
    ],
    filesChanged,
    verified: a.winnerHasExecutionReceipt,
  };
}
