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
    signal: new AbortController().signal, conversationContext: "", hardness: {}, snapshotRef: null,
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
