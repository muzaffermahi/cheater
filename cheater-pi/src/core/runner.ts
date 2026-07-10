// Kitten Core — the default, engine-backed Runner. NO Pi.
//
// Translates a routed run into the right core engine (answer/direct/reliable/bon/ascent) and maps the
// engine's low-level AgentEvent stream onto the canonical application events the app persists +
// broadcasts. This is the ONLY place lane→engine lives; the app service stays engine-agnostic and the
// clients stay app-agnostic. Tests inject a scripted Runner instead of this one, so nothing here needs
// a live model to exercise the persistence/replay spine.

import type { Runner, RunContext, RunOutcome } from "./app.js";
import type { AgentEvent } from "./agent.js";
import { runAgent } from "./agent.js";
import { runReliableAgent } from "./reliable.js";
import { runBestOfN } from "./bestofn.js";
import { runAscent, defaultAscentConfig } from "./ascent.js";
import { KittenLLM, DEFAULT_MODELS, tierSidecar } from "./llm.js";
import { changedFilesSince } from "./undo.js";

/** Build the default Runner over a KittenLLM (defaults to the local LM Studio tiering). */
export function defaultRunner(llm: KittenLLM = new KittenLLM(tierSidecar(DEFAULT_MODELS))): Runner {
  return async (ctx: RunContext): Promise<RunOutcome> => {
    if (ctx.lane === "answer") return runAnswer(ctx, llm);
    return runCoding(ctx, llm);
  };
}

/** Answer-only lane: one chat, no write tools, stream the reply as assistant deltas. */
async function runAnswer(ctx: RunContext, llm: KittenLLM): Promise<RunOutcome> {
  const started = Date.now();
  // Merge context into the ONE system message (templates reject a second system message).
  const sys = "You are Kitten, a precise coding assistant. Answer the question directly and concisely. Do not modify any files."
    + (ctx.conversationContext.trim() ? `\n\n${ctx.conversationContext}` : "");
  const chatParams = { model: ctx.model, messages: [{ role: "system" as const, content: sys }, { role: "user" as const, content: ctx.task }], signal: ctx.signal };
  // Stream the answer live (coalesced) so a long explanation on a slow local model isn't a frozen wait.
  let buf = "";
  const r = typeof llm.chatStream === "function"
    ? await llm.chatStream(chatParams, (d) => { if (d.content) { buf += d.content; if (buf.length >= 48) { ctx.emit({ type: "assistant.delta", runId: ctx.runId, text: buf }); buf = ""; } } })
    : await llm.chat(chatParams);
  if (buf) ctx.emit({ type: "assistant.delta", runId: ctx.runId, text: buf });
  const text = r.ok ? r.content : `(model error: ${r.error ?? "unknown"})`;
  ctx.emit({ type: "assistant.final", runId: ctx.runId, text });
  return {
    finished: r.ok,
    summary: text.slice(0, 200),
    wallMs: Date.now() - started,
    usage: { prompt: r.usage.prompt, completion: r.usage.completion, reasoning: r.usage.reasoning },
    receiptLines: [`answer-only lane: ${r.ok ? "answered" : "model error"}`],
    filesChanged: [],
    verified: false,
  };
}

/** Coding lanes: direct/reliable/bon/ascent. Maps AgentEvents → canonical events as they arrive. */
async function runCoding(ctx: RunContext, llm: KittenLLM): Promise<RunOutcome> {
  let toolN = 0;
  const streamedTurns = new Set<number>();
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
      case "tool": {
        const name = e.detail.split("(")[0].trim() || "tool";
        const ok = !(e.data && (e.data as { error?: boolean }).error);
        const output = e.data && typeof (e.data as { output?: string }).output === "string" ? String((e.data as { output?: string }).output) : "";
        ctx.emit({ type: "tool.completed", runId: ctx.runId, callId: `${ctx.runId}:t${toolN++}`, name, ok, durationMs: 0, output });
        break;
      }
      case "gate_block":
        // A deterministic gate (noun/path firewall or finish gate) rejected an action and sent the
        // model back — surface it as a failed check so a UI can show the "bug/repair" state (Goal §4).
        ctx.emit({ type: "verification.failed", runId: ctx.runId, detail: e.detail });
        break;
      default:
        break; // finish/nudge/error are represented by the terminal outcome, not interim events
    }
  };

  const common = { task: ctx.task, cwd: ctx.cwd, llm, model: ctx.model, onEvent, signal: ctx.signal };

  // Route destructive shell commands through the app's approval policy (Goal §8). Catastrophic/RCE/exfil
  // are hard-blocked by the engine's safety floor regardless; this gates merely-destructive ("warn") ones.
  let cmdN = 0;
  const commandGate = async (command: string, assessment: { verdict: string; category: string; message: string }): Promise<{ allowed: boolean; feedback?: string }> => {
    const risk = assessment.verdict === "block" ? "high" as const : "medium" as const;
    const allowed = await ctx.requestApproval(`${ctx.runId}:cmd${cmdN++}`, "bash", `${assessment.category}: ${assessment.message}`, risk);
    return { allowed, feedback: allowed ? undefined : `denied by approval policy: ${assessment.message}` };
  };

  if (ctx.lane === "ascent") return runAscentLane(ctx, llm, onEvent);

  const preamble = ctx.conversationContext || undefined;
  // Stream the single-trajectory lanes (direct/reliable). bon/ascent run multiple candidates in parallel
  // isolated workspaces — interleaving their token streams would be noise, so they don't stream.
  const result = ctx.lane === "bon"
    ? await runBestOfN({ ...common, contextPreamble: preamble }, ctx.k)
    : ctx.lane === "direct"
      ? await runAgent({ ...common, commandGate, contextPreamble: preamble, streamDeltas: true })
      : await runReliableAgent({ ...common, commandGate, contextPreamble: preamble, streamDeltas: true });

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
    ],
    filesChanged: result.filesWritten,
    verified: result.finished,
  };
}

/** Ascent lane: the full pass@k→pass@1 machine. Degrades to reliable if config assembly refuses. */
async function runAscentLane(ctx: RunContext, llm: KittenLLM, onEvent: (e: AgentEvent) => void): Promise<RunOutcome> {
  let config;
  try {
    config = defaultAscentConfig(llm, ctx.cwd);
  } catch (e) {
    // e.g. a poisoned experience store (DisjointnessError). Don't fail the user's run — degrade.
    ctx.emit({ type: "verification.failed", runId: ctx.runId, detail: `ascent setup declined (${(e as Error).message.slice(0, 120)}); using reliable lane` });
    const result = await runReliableAgent({ task: ctx.task, cwd: ctx.cwd, llm, model: ctx.model, onEvent, signal: ctx.signal, contextPreamble: ctx.conversationContext || undefined });
    for (const f of result.filesWritten) ctx.emit({ type: "file.changed", runId: ctx.runId, path: f, added: 0, removed: 0 });
    return {
      finished: result.finished, summary: result.summary || result.stopReason, wallMs: result.wallMs, usage: result.usage,
      receiptLines: [`ascent→reliable fallback: ${result.stopReason} in ${result.turns} turns`], filesChanged: result.filesWritten, verified: result.finished,
    };
  }
  const a = await runAscent(
    { task: ctx.task, cwd: ctx.cwd, taskId: ctx.runId, hardness: {}, forceSamples: ctx.k > 1 ? ctx.k : undefined, onEvent, signal: ctx.signal, contextPreamble: ctx.conversationContext || undefined },
    config
  );
  // The Ascent engine runs candidates in isolated workspaces and adopts the winner into cwd, so it
  // doesn't self-report changed files. Derive them from git against the pre-run snapshot and surface
  // them as events, so the diff view and /undo cover the Ascent lane too.
  const filesChanged = ctx.snapshotRef ? changedFilesSince(ctx.cwd, ctx.snapshotRef) : [];
  for (const f of filesChanged) ctx.emit({ type: "file.changed", runId: ctx.runId, path: f, added: 0, removed: 0 });
  return {
    finished: a.finished,
    summary: a.summary || (a.finished ? "solved" : "unfinished"),
    wallMs: a.wallMs,
    usage: a.usage,
    receiptLines: a.receipts,
    filesChanged,
    verified: a.winnerHasExecutionReceipt,
  };
}
