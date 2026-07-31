// The live-activity event pipeline: tool.started / tool.output / real durations, the finish-gate
// verification bridge, and the router's hardness reaching route.selected. These are the events that
// turn the run from a black box into a narrated activity feed — each test drives the REAL translator
// (agent loop → runner → canonical events), no live model.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent, type AgentEvent } from "../src/core/agent.js";
import { bashTool } from "../src/core/tools.js";
import { defaultRunner } from "../src/core/runner.js";
import { KittenApp, type RunContext, type Runner } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";
import type { KittenLLM, ChatParams, ChatResult } from "../src/core/llm.js";
import type { EventPayload, KittenEvent } from "../src/core/events.js";
import { EFFORT_PROFILES } from "../src/core/effort.js";

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────

/** A scripted LLM: returns the next canned turn per chat() call. Enough surface for the agent loop. */
function scriptedLlm(turns: Array<Partial<ChatResult>>): KittenLLM {
  let i = 0;
  const next = (): ChatResult => {
    const t = turns[Math.min(i++, turns.length - 1)];
    return {
      content: "", reasoning: "", toolCalls: [], finishReason: "stop",
      usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, ok: true, elapsedMs: 1,
      ...t,
    };
  };
  return { chat: async (_p: ChatParams) => next(), models: { main: "fake" } } as unknown as KittenLLM;
}

function runCtx(overrides: Partial<RunContext> & { emit: (p: EventPayload) => void; cwd: string }): RunContext {
  return {
    runId: "runX", conversationId: "convX", task: "task", lane: "direct", k: 1, model: "fake",
    signal: new AbortController().signal, conversationContext: "", hardness: {}, profile: EFFORT_PROFILES.balanced, snapshotRef: null,
    requestApproval: async () => true,
    ...overrides,
  } as RunContext;
}

// ── E1: live tool state ─────────────────────────────────────────────────────────────────────────

test("bash tool streams bounded output chunks while running; final output stays authoritative", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-bash-"));
  const chunks: string[] = [];
  const res = await bashTool.execute(
    { command: `node -e "for (let i = 0; i < 50; i++) console.log('line-' + i + '-' + 'x'.repeat(60))"` },
    { cwd, filesRead: new Set(), filesWritten: new Set(), onOutput: (c) => chunks.push(c) },
  );
  assert.equal(res.isError, false);
  assert.ok(chunks.length >= 1, "at least one streamed chunk");
  assert.ok(chunks.length <= 8, `hard cap of 8 chunks (got ${chunks.length})`);
  for (const c of chunks) assert.ok(c.length <= 2048, "each chunk is bounded");
  assert.match(res.output, /line-49-/, "the completion output still carries the full (truncated) result");
});

test("agent loop emits tool_start before tool, sharing a call number and a real duration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-agent-"));
  const llm = scriptedLlm([
    { toolCalls: [{ id: "c1", name: "bash", args: { command: "node -e \"console.log('hi')\"" }, raw: "" }] },
    { toolCalls: [{ id: "c2", name: "finish", args: { summary: "done" }, raw: "" }] },
  ]);
  const events: AgentEvent[] = [];
  const r = await runAgent({ task: "say hi", cwd, llm, onEvent: (e) => events.push(e) });
  assert.equal(r.finished, true);
  const start = events.find((e) => e.kind === "tool_start");
  const done = events.find((e) => e.kind === "tool");
  assert.ok(start, "tool_start emitted before execution");
  assert.ok(done, "tool completion event emitted");
  assert.equal(start!.data?.name, "bash");
  assert.equal(start!.data?.call, done!.data?.call, "started/completed share the call number");
  assert.ok(typeof done!.data?.durationMs === "number" && (done!.data!.durationMs as number) >= 0, "real duration recorded");
  assert.ok(events.indexOf(start!) < events.indexOf(done!), "start strictly precedes completion");
});

test("direct lane: runner translates to paired tool.started/tool.completed with target and duration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-runner-"));
  const llm = scriptedLlm([
    { toolCalls: [{ id: "c1", name: "bash", args: { command: "node -e \"console.log('ok')\"" }, raw: "" }] },
    { toolCalls: [{ id: "c2", name: "finish", args: { summary: "done" }, raw: "" }] },
  ]);
  const emitted: EventPayload[] = [];
  const runner = defaultRunner(llm);
  await runner(runCtx({ cwd, lane: "direct", emit: (p) => emitted.push(p) }));
  const started = emitted.filter((e) => e.type === "tool.started");
  const completed = emitted.filter((e) => e.type === "tool.completed");
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(started[0].type === "tool.started" && started[0].callId, completed[0].type === "tool.completed" && completed[0].callId, "callIds pair");
  if (started[0].type === "tool.started") {
    assert.equal(started[0].name, "bash");
    assert.match(started[0].target ?? "", /node -e/);
  }
  if (completed[0].type === "tool.completed") {
    assert.equal(completed[0].ok, true);
    assert.ok(completed[0].durationMs >= 0);
  }
});

// ── No random stops: recoverable model errors retry in-run ──────────────────────────────────────

test("a truncated tool-call 500 is retried with corrective guidance instead of killing the run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-retry-"));
  // Turn 1 fails the way llama.cpp fails on an oversized tool call; turn 2 succeeds.
  let calls = 0;
  const seenMessages: string[][] = [];
  const llm = {
    models: { main: "fake" },
    chat: async (p: ChatParams): Promise<ChatResult> => {
      calls++;
      seenMessages.push(p.messages.map((m) => `${m.role}:${String(m.content).slice(0, 300)}`));
      if (calls === 1) {
        return { content: "", reasoning: "", toolCalls: [], finishReason: "", usage: { prompt: 0, completion: 0, reasoning: 0, total: 0 }, ok: false, error: "HTTP 500: Failed to parse tool call arguments as JSON: parse error - invalid string: missing closing quote", elapsedMs: 1 };
      }
      return { content: "", reasoning: "", toolCalls: [{ id: "c", name: "finish", args: { summary: "done in small steps" }, raw: "" }], finishReason: "tool_calls", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, ok: true, elapsedMs: 1 };
    },
  } as unknown as KittenLLM;
  const events: import("../src/core/agent.js").AgentEvent[] = [];
  const r = await runAgent({ task: "rewrite the page", cwd, llm, onEvent: (e) => events.push(e) });
  assert.equal(r.finished, true, "the run recovered instead of dying");
  assert.equal(r.stopReason, "finish");
  assert.ok(events.some((e) => e.kind === "nudge" && /retrying \(1\/3\)/.test(e.detail)), "the retry is announced");
  const secondCall = seenMessages[1] ?? [];
  assert.ok(secondCall.some((m) => /SMALLER pieces/.test(m)), "the retry carries the smaller-steps guidance");
});

test("a hard non-transient model error still fails honestly after the retry budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-hard-"));
  const llm = {
    models: { main: "fake" },
    chat: async (): Promise<ChatResult> => ({ content: "", reasoning: "", toolCalls: [], finishReason: "", usage: { prompt: 0, completion: 0, reasoning: 0, total: 0 }, ok: false, error: "HTTP 401: bad api key", elapsedMs: 1 }),
  } as unknown as KittenLLM;
  const r = await runAgent({ task: "x", cwd, llm });
  assert.equal(r.finished, false);
  assert.equal(r.stopReason, "error");
  assert.match(r.summary, /HTTP 401/);
});

// ── E2: the finish-gate verification bridge ─────────────────────────────────────────────────────

test("reliable lane: finish gate emits verification.started + passed once an execution receipt exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-verify-"));
  writeFileSync(join(cwd, "a.py"), "x = 1\n", "utf8");
  const llm = scriptedLlm([
    // Run the change (an execution receipt for the held-out finish gate), then finish.
    { toolCalls: [{ id: "c1", name: "bash", args: { command: "python -c \"print(1)\"" }, raw: "" }] },
    { toolCalls: [{ id: "c2", name: "finish", args: { summary: "done" }, raw: "" }] },
  ]);
  const emitted: EventPayload[] = [];
  const runner = defaultRunner(llm);
  await runner(runCtx({ cwd, lane: "reliable", task: "check a.py", emit: (p) => emitted.push(p) }));
  const types = emitted.map((e) => e.type);
  assert.ok(types.includes("verification.started"), `verification.started missing (${types.join(", ")})`);
  assert.ok(types.includes("verification.passed"), `verification.passed missing (${types.join(", ")})`);
  const passed = emitted.find((e) => e.type === "verification.passed");
  if (passed?.type === "verification.passed") assert.match(passed.detail, /receipt|passed/i);
});

// ── E4: the plan surfaces ───────────────────────────────────────────────────────────────────────

test("a task-graph plan emits plan.updated snapshots and ordered step events into the durable stream", async () => {
  let t = 0; let n = 0;
  const scripted: Runner = async () => ({ finished: true, summary: "child done", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: true });
  const app = new KittenApp({ store: new ConversationStore(openSqlite(":memory:")), runner: scripted, now: () => ++t, newId: (p) => `${p}${n++}`, projectRoot: process.cwd(), model: "m" });
  const conv = app.createConversation();
  app.createTaskPlan({
    conversationId: conv.id,
    nodes: [
      { id: "n1", agent: "explore", objective: "survey the repo", workspaceMode: "shared-readonly" },
      { id: "n2", agent: "explore", objective: "summarize findings", dependencies: ["n1"], workspaceMode: "shared-readonly" },
    ] as never[],
  }, "runP");
  await app.runTaskPlan(conv.id, "runP");
  const events = app.getEvents(conv.id);
  const types = events.map((e) => e.type);
  assert.ok(types.filter((x) => x === "plan.updated").length >= 2, "plan.updated on create + around execution");
  const stepStarts = events.filter((e) => e.type === "step.started");
  const stepEnds = events.filter((e) => e.type === "step.completed");
  assert.equal(stepStarts.length, 2, "both nodes started");
  assert.equal(stepEnds.length, 2, "both nodes completed");
  if (stepEnds[0].type === "step.completed") assert.equal(stepEnds[0].status, "completed");
  // Dependency order: n1 must start before n2.
  const firstStart = stepStarts[0];
  if (firstStart.type === "step.started") assert.equal(firstStart.stepId, "n1");
  // Snapshots carry the DAG shape a renderer needs.
  const snapshot = events.find((e) => e.type === "plan.updated");
  if (snapshot?.type === "plan.updated") {
    assert.equal(snapshot.source, "task-graph");
    assert.deepEqual(snapshot.steps.map((s) => s.id), ["n1", "n2"]);
    assert.deepEqual(snapshot.steps[1].dependsOn, ["n1"]);
  }
  app.close();
});

// ── E6: run.status completeness ─────────────────────────────────────────────────────────────────

test("an ask-policy approval emits waiting_approval and returns to running after resolution", async () => {
  let t = 0; let n = 0;
  const scripted: Runner = async (ctx: RunContext) => {
    const allowed = await ctx.requestApproval("c1", "bash", "rm -rf build", "medium");
    assert.equal(allowed, true);
    return { finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false };
  };
  const app = new KittenApp({ store: new ConversationStore(openSqlite(":memory:")), runner: scripted, now: () => ++t, newId: (p) => `${p}${n++}`, projectRoot: "/proj", model: "m", approvalPolicy: "ask" });
  const conv = app.createConversation();
  app.subscribe((e) => {
    if (e.type === "tool.approval_required") queueMicrotask(() => app.resolveApproval(e.runId, e.callId, true));
  });
  await app.submitMessage(conv.id, "clean the build dir");
  const statuses = app.getEvents(conv.id).filter((e) => e.type === "run.status");
  assert.ok(statuses.some((e) => e.type === "run.status" && e.status === "waiting_approval"), "waiting_approval surfaced");
  assert.ok(statuses.some((e) => e.type === "run.status" && e.status === "running"), "resumed to running after resolution");
  app.close();
});

// ── E3: hardness threading ──────────────────────────────────────────────────────────────────────

test("route.selected carries the deterministic hardness score", async () => {
  let t = 0; let n = 0;
  const scripted: Runner = async (ctx: RunContext) => {
    // The router's raw signal must reach the runner (it used to be re-derived as {}).
    assert.ok(ctx.hardness && typeof ctx.hardness === "object", "RunContext.hardness populated");
    return { finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false };
  };
  const app = new KittenApp({ store: new ConversationStore(openSqlite(":memory:")), runner: scripted, now: () => ++t, newId: (p) => `${p}${n++}`, projectRoot: "/proj", model: "m" });
  const seen: KittenEvent[] = [];
  app.subscribe((e) => seen.push(e));
  const conv = app.createConversation();
  await app.submitMessage(conv.id, "fix the crash in parser.py when the input is empty");
  const route = seen.find((e) => e.type === "route.selected");
  assert.ok(route && route.type === "route.selected");
  assert.ok(typeof route.hardness === "number", "hardness recorded on route.selected");
});
