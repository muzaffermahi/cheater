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
    // Run THE CHANGE — the receipt must exercise a.py, not just any command that exits 0.
    { toolCalls: [{ id: "c1", name: "bash", args: { command: "python -c \"import a; print(a.x)\"" }, raw: "" }] },
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

// ── E12b: the effort ceiling is a real deadline ─────────────────────────────────────────────────

test("a run is never stopped by an effort wall-clock ceiling", async () => {
  // Wall-clock ceilings are intentionally ignored. A local model can spend longer in prefill or
  // reasoning than a mode's old limit; only explicit cancellation/max-turn or token controls apply.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-deadline-"));
  writeFileSync(join(cwd, "marker.txt"), "content the model keeps re-reading\n");
  let calls = 0;
  // A model that never stops asking for another turn: without a deadline this runs to maxTurns.
  const neverFinishes = {
    chat: async (p: ChatParams): Promise<ChatResult> => {
      await new Promise((r) => setTimeout(r, 25));
      // Mirror the real client: an aborted call comes back as a failure result, it does not throw.
      if (p.signal?.aborted) {
        return { content: "", reasoning: "", toolCalls: [], finishReason: "error",
                 usage: { prompt: 0, completion: 0, reasoning: 0, total: 0 }, ok: false, error: "cancelled", elapsedMs: 1 };
      }
      // Keep calling a tool: bare content twice in a row trips the stall detector, which would end
      // the run before the deadline and prove nothing about the ceiling.
      calls += 1;
      return { content: "", reasoning: "", toolCalls: [{ id: `c${calls}`, name: "read", args: { path: "marker.txt" }, raw: "" }],
               finishReason: "tool_calls", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, ok: true, elapsedMs: 25 };
    },
    models: { main: "fake" },
  } as unknown as KittenLLM;

  const events: EventPayload[] = [];
  const profile = { ...EFFORT_PROFILES.fast, level: "fast" as const, maxTurns: 3, ceiling: { maxWallMs: 1 } };
  const started = Date.now();
  const outcome = await defaultRunner(neverFinishes)(runCtx({
    cwd, lane: "direct", profile, emit: (p) => events.push(p),
  }));
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 60, `the 1ms ceiling must not abort the model, took ${elapsed}ms`);
  assert.ok(!outcome.receiptLines.some((l) => /effort ceiling/i.test(l)), "no automatic wall-clock stop is reported");
  assert.ok(!events.some((e) => e.type === "run.status" && /effort ceiling/i.test(e.detail ?? "")), "the UI receives no wall-clock stop");
});

test("a run inside its ceiling is untouched by the deadline", async () => {
  // The other half: arming a timer must not perturb a normal run, and must not leave the process
  // held open by a pending timer.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-deadline-ok-"));
  const quick = scriptedLlm([{ toolCalls: [{ id: "f1", name: "finish", args: { summary: "done" }, raw: "" }] }]);
  const profile = { ...EFFORT_PROFILES.balanced, ceiling: { maxWallMs: 60_000 } };
  const outcome = await defaultRunner(quick)(runCtx({
    cwd, lane: "direct", profile, emit: () => { /* ignore */ },
  }));
  assert.equal(outcome.finished, true);
  assert.ok(!outcome.receiptLines.some((l) => /effort ceiling/i.test(l)),
    "a run that finished in time must not be reported as ceilinged");
});

test("a profile with no wall-clock ceiling still runs", async () => {
  // Defensive: ceiling is optional in the type, and a 0/absent value must mean "unbounded", never
  // "abort immediately" — the same class of bug as reasoningBudget:0 disabling thinking.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-deadline-none-"));
  const profile = { ...EFFORT_PROFILES.balanced, ceiling: { maxWallMs: 0 } };
  const outcome = await defaultRunner(scriptedLlm([{ toolCalls: [{ id: "f1", name: "finish", args: { summary: "done" }, raw: "" }] }]))(runCtx({
    cwd, lane: "direct", profile, emit: () => { /* ignore */ },
  }));
  assert.equal(outcome.finished, true, "maxWallMs 0 must mean unbounded, not instant abort");
});

// ── a rejected tool call must say WHICH argument and WHY ────────────────────────────────────────

test("a tool call rejected for bad arguments names the reason, and oversized payloads get real advice", async () => {
  // From the bakeoff's mini_sql run: llama.cpp's own parser broke on a ~12KB write payload, and all
  // the transcript said was "bad args for write". The model cannot correct what it cannot see, and
  // neither can the person watching. Worse, the stock advice ("re-emit with valid JSON") is useless
  // to a model that just emitted 12KB of valid-looking JSON — the actionable fix is to split it.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-badargs-"));
  const huge = "x".repeat(9000);
  const events: AgentEvent[] = [];
  const sent: string[] = [];
  const llm = {
    chat: async (p: ChatParams): Promise<ChatResult> => {
      for (const m of p.messages) if (m.role === "tool") sent.push(String(m.content ?? ""));
      if (sent.length === 0) {
        return { content: "", reasoning: "", finishReason: "tool_calls", ok: true, elapsedMs: 1,
                 usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 },
                 toolCalls: [{ id: "c1", name: "write", args: {}, argError: "invalid JSON args: Unterminated string in JSON at position 8999", raw: huge }] };
      }
      return { content: "", reasoning: "", finishReason: "stop", ok: true, elapsedMs: 1,
               usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 },
               toolCalls: [{ id: "f1", name: "finish", args: { summary: "gave up" }, raw: "" }] };
    },
    models: { main: "fake" },
  } as unknown as KittenLLM;

  await runAgent({ task: "write a big file", cwd, llm, model: "fake", onEvent: (e) => events.push(e), maxTurns: 4 });

  const rejection = events.find((e) => e.kind === "tool" && e.detail.startsWith("bad args"));
  assert.ok(rejection, "the rejection must still be reported");
  assert.match(rejection.detail, /invalid JSON args/, "the event must carry the parser's actual reason");
  assert.match(rejection.detail, /KB payload/, "and flag that the payload was oversized");
  assert.equal((rejection.data as { argBytes?: number }).argBytes, huge.length);

  const toolReply = sent.find((s) => /invalid JSON args/.test(s));
  assert.ok(toolReply, "the model must be told why");
  assert.match(toolReply, /smaller pieces/, "an oversized payload gets advice it can act on, not 'use valid JSON'");
});

test("KITTEN_CEILING_MS cannot reintroduce an automatic wall-clock stop", async () => {
  const { effortProfile, EFFORT_PROFILES } = await import("../src/core/effort.js");

  const overridden = effortProfile("balanced", { KITTEN_CEILING_MS: "840000" } as NodeJS.ProcessEnv);
  assert.equal(overridden.ceiling.maxWallMs, undefined);
  assert.equal(overridden.ceiling.maxTokens, EFFORT_PROFILES.balanced.ceiling.maxTokens,
    "only the wall clock moves; the token ceiling is untouched");
  assert.equal(overridden.maxTurns, EFFORT_PROFILES.balanced.maxTurns);
  assert.equal(overridden.kCap, EFFORT_PROFILES.balanced.kCap);

  // Nothing set: the profile is returned exactly as declared.
  assert.equal(effortProfile("balanced", {} as NodeJS.ProcessEnv).ceiling.maxWallMs, undefined);

  // Garbage and non-positive values are IGNORED, never taken literally. A ceiling of 0 would abort
  // the run instantly -- the same trap as reasoningBudget 0 silently disabling thinking.
  for (const bad of ["0", "-5", "abc", "", "   "]) {
    assert.equal(effortProfile("balanced", { KITTEN_CEILING_MS: bad } as NodeJS.ProcessEnv).ceiling.maxWallMs,
      undefined, `KITTEN_CEILING_MS=${JSON.stringify(bad)} must be ignored`);
  }
});

// ── The output cap is diagnosed where the length is known ────────────────────────────────────────
//
// Observed live: a single-file Pac-Man clone killed all four ascent candidates. The model put the
// whole HTML into one `write` argument, the 4096-token cap cut the JSON string mid-value, and the
// ONLY symptom was llama.cpp rejecting its own model's output with a generic parse-error 500. The
// cap is knowable here, one layer before that, and must be reported as itself.

test("a generation stopped by the output cap is retried with split-the-write guidance", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-length-"));
  let calls = 0;
  const seenMessages: string[][] = [];
  const llm = {
    models: { main: "fake" },
    chat: async (p: ChatParams): Promise<ChatResult> => {
      calls++;
      seenMessages.push(p.messages.map((m) => `${m.role}:${String(m.content).slice(0, 400)}`));
      if (calls === 1) {
        // Cut off mid-argument: content but no usable tool call, finish_reason "length".
        return { content: "{\"path\":\"game.html\",\"content\":\"<!DOCTYPE html><html", reasoning: "", toolCalls: [], finishReason: "length", usage: { prompt: 10, completion: 4096, reasoning: 0, total: 4106 }, ok: true, elapsedMs: 1 };
      }
      return { content: "", reasoning: "", toolCalls: [{ id: "c", name: "finish", args: { summary: "wrote it in sections" }, raw: "" }], finishReason: "tool_calls", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, ok: true, elapsedMs: 1 };
    },
  } as unknown as KittenLLM;
  const events: import("../src/core/agent.js").AgentEvent[] = [];
  const r = await runAgent({ task: "build a pac-man clone in one html file", cwd, llm, onEvent: (e) => events.push(e) });
  assert.equal(r.finished, true, "a truncated turn is recoverable, not fatal");
  assert.ok(
    events.some((e) => e.kind === "nudge" && /length cap/.test(e.detail)),
    `the cap is named, not left as a server parse error: ${JSON.stringify(events.filter((e) => e.kind === "nudge").map((e) => e.detail))}`
  );
  const secondCall = seenMessages[1] ?? [];
  assert.ok(secondCall.some((m) => /SEVERAL smaller calls/.test(m)), "the retry tells the model how to split the write");
  // A truncated turn must NOT be treated as the model declining to act — that path stops the run.
  assert.ok(!events.some((e) => e.kind === "nudge" && /nudging to act/.test(e.detail)), "not mistaken for an idle turn");
});

test("a model that keeps overrunning the cap stops instead of retrying forever", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-live-length-loop-"));
  let calls = 0;
  const llm = {
    models: { main: "fake" },
    chat: async (): Promise<ChatResult> => {
      calls++;
      return { content: "partial…", reasoning: "", toolCalls: [], finishReason: "length", usage: { prompt: 1, completion: 4096, reasoning: 0, total: 4097 }, ok: true, elapsedMs: 1 };
    },
  } as unknown as KittenLLM;
  const r = await runAgent({ task: "x", cwd, llm });
  assert.equal(r.finished, false);
  assert.ok(calls <= 8, `bounded, not an infinite retry loop (got ${calls} calls)`);
});
