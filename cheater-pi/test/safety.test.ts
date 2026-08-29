import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent } from "../src/core/agent.js";
import type { KittenLLM, ChatParams, ChatResult } from "../src/core/llm.js";
import { KittenApp, type Runner } from "../src/core/app.js";
import { defaultRunner } from "../src/core/runner.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { EFFORT_PROFILES } from "../src/core/effort.js";
import { openSqlite } from "../src/core/store/db.js";

// A scripted LLM that emits a fixed sequence of tool calls (then finish). No network.
function scriptedLlm(steps: Array<{ tool: string; args: Record<string, unknown> } | { finish: string }>): unknown {
  let i = 0;
  const ok = { ok: true as const, content: "", reasoning: "", finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, elapsedMs: 1 };
  return {
    chat: async () => {
      const s = steps[Math.min(i, steps.length - 1)]; i++;
      if ("finish" in s) return { ...ok, toolCalls: [{ id: "f", name: "finish", args: { summary: s.finish }, raw: "{}" }] };
      return { ...ok, toolCalls: [{ id: `t${i}`, name: s.tool, args: s.args, raw: JSON.stringify(s.args) }] };
    },
    sidecar: async () => ({ ok: false }),
    embed: async () => [],
  };
}

test("safety floor: a catastrophic command is hard-blocked even without an approval gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-safe-"));
  const llm = scriptedLlm([{ tool: "bash", args: { command: "rm -rf /" } }, { finish: "done" }]) as never;
  const res = await runAgent({ task: "x", cwd: dir, llm });
  assert.ok(res.events.some((e) => e.kind === "gate_block" && /safety block/.test(e.detail)), "expected a safety block");
  assert.ok(!res.events.some((e) => e.kind === "tool" && /bash/.test(e.detail)), "the command must not have executed");
});

test("a cancelled LLM call mid-generation stops as 'aborted', not 'error'", async () => {
  // Regression: on a mid-generation cancel the LLM returns ok:false error:"cancelled", which
  // /timeout|network/ did not match, so the run was mislabeled stopReason:"error".
  const dir = mkdtempSync(join(tmpdir(), "kitten-cancel-agent-"));
  const cancelledLlm = {
    chat: async () => ({ ok: false, error: "cancelled", content: "", reasoning: "", toolCalls: [], finishReason: "error", usage: { prompt: 0, completion: 0, reasoning: 0, total: 0 }, elapsedMs: 1 }),
    sidecar: async () => ({ ok: false }), embed: async () => [],
  } as never;
  const res = await runAgent({ task: "x", cwd: dir, llm: cancelledLlm });
  assert.equal(res.stopReason, "aborted");
  assert.equal(res.finished, false);
});

test("a finish forced past the rejection budget is flagged forcedFinish (so callers never mark it verified)", async () => {
  // Regression: after maxFinishRejections the gate is bypassed and finished=true is set unconditionally.
  // The reliable/bon lanes derived verified:=finished, recording a run whose verification NEVER passed as
  // verified (a false green). forcedFinish must distinguish a gate-APPROVED finish from a forced one.
  const dir = mkdtempSync(join(tmpdir(), "kitten-forced-"));
  const llm = scriptedLlm([{ finish: "done" }]) as never; // the model keeps calling finish every turn
  const res = await runAgent({
    task: "x", cwd: dir, llm,
    finishGate: async () => ({ allowed: false, feedback: "not verified" }), // gate always rejects
    maxTurns: 8,
  });
  assert.equal(res.finished, true, "finish is force-allowed after the budget to avoid an infinite loop");
  assert.equal(res.forcedFinish, true, "but it is flagged forced (no receipt) so the lane won't record it verified");
});

test("commandGate: a denied destructive command is blocked and fed back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-safe-"));
  const llm = scriptedLlm([{ tool: "bash", args: { command: "git push --force origin main" } }, { finish: "done" }]) as never;
  let asked = "";
  const res = await runAgent({
    task: "x", cwd: dir, llm,
    commandGate: async (cmd, a) => { asked = a.category; return { allowed: false, feedback: "nope" }; },
  });
  assert.equal(asked, "destructive");
  assert.ok(res.events.some((e) => e.kind === "gate_block" && /denied/.test(e.detail)));
  assert.ok(!res.events.some((e) => e.kind === "tool" && /bash/.test(e.detail)), "denied command must not execute");
});

test("commandGate: an approved warn-level command is allowed to run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-safe-"));
  const llm = scriptedLlm([{ tool: "bash", args: { command: "rm -rf ./does-not-exist-subdir" } }, { finish: "done" }]) as never;
  const res = await runAgent({ task: "x", cwd: dir, llm, commandGate: async () => ({ allowed: true }) });
  assert.ok(res.events.some((e) => e.kind === "tool" && /bash/.test(e.detail)), "approved command should execute");
});

// A runner that just asks for approval and reports the answer — exercises the app's policy machinery.
const askingRunner: Runner = async (ctx) => {
  const allowed = await ctx.requestApproval("cmd0", "bash", "destructive: rm -rf build", "high");
  return { finished: allowed, summary: allowed ? "approved" : "denied", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false };
};

function app(policy: "ask" | "auto-allow" | "auto-deny"): KittenApp {
  return new KittenApp({ store: new ConversationStore(openSqlite(":memory:")), runner: askingRunner, approvalPolicy: policy });
}

test("approvalPolicy auto-deny blocks and emits tool.approval_required", async () => {
  const a = app("auto-deny");
  const conv = a.createConversation();
  const run = await a.submitMessage(conv.id, "rm the build dir");
  assert.equal(run.finished, false);
  assert.ok(a.getEvents(conv.id).some((e) => e.type === "tool.approval_required"));
});

test("approvalPolicy auto-allow approves", async () => {
  const a = app("auto-allow");
  const conv = a.createConversation();
  const run = await a.submitMessage(conv.id, "rm the build dir");
  assert.equal(run.finished, true);
});

test("approvalPolicy ask waits for an interactive resolveApproval", async () => {
  const a = app("ask");
  const conv = a.createConversation();
  a.subscribe((e) => { if (e.type === "tool.approval_required") a.resolveApproval(e.runId, e.callId, true); });
  const run = await a.submitMessage(conv.id, "rm the build dir");
  assert.equal(run.finished, true); // resolved allow → runner saw allowed:true
});

test("cancel() unblocks a run parked on a pending interactive approval (no deadlock)", async () => {
  // Regression: cancel() aborted the signal but never resolved the "ask" approval the run was awaiting,
  // so submitMessage hung forever and the run never reached a terminal state.
  const a = app("ask");
  const conv = a.createConversation();
  a.subscribe((e) => { if (e.type === "tool.approval_required") a.cancel(e.runId); }); // cancel instead of answering
  const run = await a.submitMessage(conv.id, "rm the build dir"); // must RESOLVE, not hang
  assert.equal(run.finished, false, "a cancelled run did not finish");
  assert.ok(a.getEvents(conv.id).some((e) => e.type === "run.cancelled"), "the run reached the terminal cancelled state");
});

test("an answer-lane model error is recorded as failed, not completed", async () => {
  // Regression: runAnswer returned finished:false without throwing on a model error, so the app took the
  // success branch and recorded run.completed — an LLM error looked like a completed run (unlike coding lanes).
  const failingLlm = {
    chat: async () => ({ ok: false, error: "boom", content: "", reasoning: "", toolCalls: [], finishReason: "error", usage: { prompt: 0, completion: 0, reasoning: 0, total: 0 }, elapsedMs: 1 }),
    sidecar: async () => ({ ok: false }), embed: async () => [],
  } as never;
  const store = new ConversationStore(openSqlite(":memory:"));
  const kapp = new KittenApp({ store, runner: defaultRunner(failingLlm), projectRoot: process.cwd() });
  const conv = kapp.createConversation({ projectRoot: process.cwd() });
  await kapp.submitMessage(conv.id, "explain how the tokenizer works"); // routes to the answer lane
  const events = kapp.getEvents(conv.id);
  assert.ok(events.some((e) => e.type === "run.failed"), "a model error must terminate as run.failed");
  assert.ok(!events.some((e) => e.type === "run.completed"), "must NOT be recorded as a completed run");
});

// Per-token probabilities are not free — llama.cpp reports roughly a 3x generation slowdown with
// n_probs > 0 — and self-certainty is only ever read to break a tie between candidates. A single
// candidate has nothing to tie with, so it must not pay the tax.
test("logprobs are requested only when a run has candidates to be compared against", async () => {
  const seen: Array<{ logprobs?: boolean; topLogprobs?: number }> = [];
  const llm = {
    models: { baseUrl: "fixture://logprob", main: "main-35b" },
    chat: async (params: ChatParams) => {
      seen.push({ logprobs: (params as { logprobs?: boolean }).logprobs, topLogprobs: (params as { topLogprobs?: number }).topLogprobs });
      return { content: "done", reasoning: "", toolCalls: [], finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, ok: true, elapsedMs: 1 } as ChatResult;
    },
  } as unknown as KittenLLM;

  const base = { task: "say done", cwd: process.cwd(), llm, maxTurns: 1, captureConfidence: true };

  await runAgent({ ...base });
  assert.equal(seen[0].logprobs, false, "an ordinary single run must not pay the logprob tax");
  assert.equal(seen[0].topLogprobs, undefined);

  seen.length = 0;
  await runAgent({ ...base, candidateCount: 1 });
  assert.equal(seen[0].logprobs, false, "one candidate has nothing to be compared against");

  seen.length = 0;
  await runAgent({ ...base, candidateCount: 3 });
  assert.equal(seen[0].logprobs, true, "best-of-N still gets its selection signal");
  assert.equal(seen[0].topLogprobs, 5);

  seen.length = 0;
  await runAgent({ ...base, captureConfidence: false, candidateCount: 3 });
  assert.equal(seen[0].logprobs, false, "the lever still turns it off entirely");
});

// ── The degraded ascent run is still the user's run ──────────────────────────────────────────────
// Regression: when defaultAscentConfig refused (a poisoned experience store), runAscentLane rebuilt a
// THINNER parameter set for its reliable fallback — dropping commandGate, the file scope, and the
// inference phase. A run that degraded therefore executed destructive shell commands with no approval
// prompt at all, silently, on a lane the user had asked to be careful.
test("an ascent run that degrades to reliable keeps its destructive-command approval gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-degrade-"));
  // Poison the experience store so defaultAscentConfig() hard-fails at assembly, exactly as it would
  // if a benchmark solve had been dropped into it.
  const expDir = mkdtempSync(join(tmpdir(), "kitten-degrade-exp-"));
  writeFileSync(join(expDir, "store.jsonl"), JSON.stringify({
    id: "crack-7z-hash", family: "parser", approachShape: "s", filesTouched: [], verified: true, at: 1,
  }) + "\n");
  const prevExp = process.env.KITTEN_EXPERIENCE_DIR;
  process.env.KITTEN_EXPERIENCE_DIR = expDir;

  const llm = scriptedLlm([
    { tool: "bash", args: { command: "git push --force origin main" } },
    { finish: "done" },
  ]) as never;

  const asked: Array<{ tool: string; risk: string }> = [];
  const events: Array<{ type: string }> = [];
  try {
    await defaultRunner(llm, { fastPath: "off" })({
      runId: "r1", conversationId: "c1", task: "force push the branch", lane: "ascent", k: 3, model: "fake",
      cwd: dir, signal: new AbortController().signal, conversationContext: "", hardness: {},
      profile: EFFORT_PROFILES.balanced, snapshotRef: null,
      emit: (p: { type: string }) => events.push(p),
      requestApproval: async (_id: string, tool: string, _detail: string, risk: string) => {
        asked.push({ tool, risk });
        return false; // deny, like an auto-deny policy would
      },
    } as never);
  } finally {
    if (prevExp === undefined) delete process.env.KITTEN_EXPERIENCE_DIR;
    else process.env.KITTEN_EXPERIENCE_DIR = prevExp;
  }

  assert.ok(events.some((e) => e.type === "verification.failed"), "the degradation is reported, not hidden");
  assert.deepEqual(asked, [{ tool: "bash", risk: "medium" }], "the fallback consulted the approval policy");
});
