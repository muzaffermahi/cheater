// Sidecar assist — the advisory layer that runs after a run reaches a terminal state.
//
// The properties that matter are containment properties. This layer touches every run in every
// client, so the tests are mostly about what it must NOT do: never change a grade, never fail a run,
// never claim a deterministic floor was model analysis, and never run at all when absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KittenApp, type RunContext, type RunOutcome } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { SidecarAssist, type RunFacts } from "../src/core/sidecarAssist.js";
import type { KittenEvent } from "../src/core/events.js";
import type { KittenLLM } from "../src/core/llm.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "kitten-assist-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fx", scripts: { test: "node --test" } }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n");
  return root;
}

/** A stub LLM: no network. `content` decides whether the sidecar "answers" or the floor takes over. */
function stubLlm(content: string | null, onCall?: () => void): KittenLLM {
  return {
    models: { baseUrl: "http://stub", main: "main-model", sidecar: "small-model" },
    async sidecar() {
      onCall?.();
      if (content === null) return { ok: false, content: "", reasoning: "", error: "stub down", usage: { prompt: 0, completion: 0, reasoning: 0, total: 0 } };
      return { ok: true, content, reasoning: "", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 } };
    },
  } as unknown as KittenLLM;
}

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
  runId: "run_1", status: "completed", summary: "did the thing", verified: true,
  filesChanged: ["src/a.js"], projectRoot: process.cwd(), evidence: ["ran tests"], ...over,
});

// ── containment ──────────────────────────────────────────────────────────────────────────────────

test("no assist configured means nothing changes", async () => {
  const root = repo();
  const store = ConversationStore.open(":memory:");
  const events: KittenEvent[] = [];
  const app = new KittenApp({
    store, projectRoot: root, taskCompiler: "off",
    runner: async (): Promise<RunOutcome> => ({
      finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 },
      receiptLines: [], filesChanged: ["src/a.js"], verified: true,
    }),
  });
  app.subscribe((e) => events.push(e));
  try {
    const conv = app.createConversation({ projectRoot: root });
    await app.submitMessage(conv.id, "change src/a.js");
    await app.whenAssistSettled();
    assert.equal(events.filter((e) => e.type === "sidecar.postflight").length, 0);
    assert.equal(events.filter((e) => e.type === "sidecar.failure").length, 0);
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a file-changing run is reviewed, and the review never alters the grade", async () => {
  const root = repo();
  const store = ConversationStore.open(":memory:");
  const events: KittenEvent[] = [];
  const app = new KittenApp({
    store, projectRoot: root, taskCompiler: "off",
    // A review that reports HIGH risk must still leave a verified run verified — advisory means advisory.
    sidecarAssist: new SidecarAssist({
      llm: stubLlm(JSON.stringify({
        secrets: ["credential-like assignment"], warnings: ["debug output"], evidenceWarnings: [],
        recommendedTests: [], suggestedCommands: ["npm test"], risk: "high",
        riskReasons: ["possible secret"], generatedTestCases: [],
      })),
      deadlineMs: 500,
    }),
    runner: async (): Promise<RunOutcome> => ({
      finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 },
      receiptLines: [], filesChanged: ["src/a.js"], verified: true,
    }),
  });
  app.subscribe((e) => events.push(e));
  try {
    const conv = app.createConversation({ projectRoot: root });
    const run = await app.submitMessage(conv.id, "change src/a.js");
    await app.whenAssistSettled();

    const postflight = events.find((e) => e.type === "sidecar.postflight");
    assert.ok(postflight, "the review was recorded");
    assert.equal(postflight!.type === "sidecar.postflight" && postflight!.risk, "high");

    assert.equal(run.status, "completed", "status untouched");
    assert.equal(run.verified, true, "a high-risk advisory review must not un-verify a verified run");
    const completed = events.find((e) => e.type === "run.completed");
    assert.equal(completed!.type === "run.completed" && completed!.verified, true);
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed run is triaged, and triage never masks the original error", async () => {
  const root = repo();
  const events: KittenEvent[] = [];
  const app = new KittenApp({
    store: ConversationStore.open(":memory:"), projectRoot: root, taskCompiler: "off",
    sidecarAssist: new SidecarAssist({
      llm: stubLlm(JSON.stringify({ severity: "error", signature: "TypeError: x is not a function", lines: ["at parse()"] })),
      deadlineMs: 500,
    }),
    runner: async () => { throw new Error("engine exploded"); },
  });
  app.subscribe((e) => events.push(e));
  try {
    const conv = app.createConversation({ projectRoot: root });
    const run = await app.submitMessage(conv.id, "fix the parser in src/a.js");
    await app.whenAssistSettled();

    assert.equal(run.status, "failed");
    assert.equal(run.error, "engine exploded", "the original error survives verbatim");
    const failure = events.find((e) => e.type === "sidecar.failure");
    assert.ok(failure, "triage was recorded");
    // run.failed must be emitted BEFORE the advisory card — a UI shows the failure immediately.
    const failedAt = events.findIndex((e) => e.type === "run.failed");
    const cardAt = events.findIndex((e) => e.type === "sidecar.failure");
    assert.ok(failedAt >= 0 && failedAt < cardAt, "the failure is reported before the explanation");
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an assist that throws or times out never fails the run", async () => {
  const root = repo();
  const exploding = new SidecarAssist({ llm: stubLlm(null), deadlineMs: 100 });
  // Force a hard throw from inside the assist, not just a model error.
  (exploding as unknown as { reviewRun: () => Promise<never> }).reviewRun = () => { throw new Error("assist blew up"); };
  const app = new KittenApp({
    store: ConversationStore.open(":memory:"), projectRoot: root, taskCompiler: "off",
    sidecarAssist: exploding,
    runner: async (): Promise<RunOutcome> => ({
      finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 },
      receiptLines: [], filesChanged: ["src/a.js"], verified: true,
    }),
  });
  try {
    const conv = app.createConversation({ projectRoot: root });
    const run = await app.submitMessage(conv.id, "change src/a.js");
    await app.whenAssistSettled();
    assert.equal(run.status, "completed", "the run is unaffected by a broken advisory layer");
    assert.equal(run.verified, true);
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("assist does not block submitMessage", async () => {
  const root = repo();
  let released: () => void = () => {};
  const gate = new Promise<void>((resolve) => { released = resolve; });
  const slow = new SidecarAssist({ llm: stubLlm("{}"), deadlineMs: 5000 });
  (slow as unknown as { reviewRun: () => Promise<unknown> }).reviewRun = async () => {
    await gate;
    return { source: "deterministic", secrets: [], warnings: [], evidenceWarnings: [], recommendedTests: [], suggestedCommands: [], risk: "low", riskReasons: [], generatedTestCases: [] };
  };
  const app = new KittenApp({
    store: ConversationStore.open(":memory:"), projectRoot: root, taskCompiler: "off", sidecarAssist: slow,
    runner: async (): Promise<RunOutcome> => ({
      finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 },
      receiptLines: [], filesChanged: ["src/a.js"], verified: true,
    }),
  });
  try {
    const conv = app.createConversation({ projectRoot: root });
    // Resolves while the advisory pass is still parked on `gate` — that is the whole point.
    const run = await app.submitMessage(conv.id, "change src/a.js");
    assert.equal(run.status, "completed");
    released();
    await app.whenAssistSettled();
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});

// ── honesty ──────────────────────────────────────────────────────────────────────────────────────

test("a deterministic floor is never reported as model analysis", async () => {
  const root = repo();
  try {
    // The stub endpoint is down, so every job falls back. The source must say so.
    const assist = new SidecarAssist({ llm: stubLlm(null), deadlineMs: 300 });
    const review = await assist.reviewRun(facts({ projectRoot: root }));
    assert.equal(review.source, "deterministic", "a fallback must not be labelled 'sidecar'");
    const triage = await assist.triageFailure(facts({ status: "failed", error: "TypeError: boom", projectRoot: root }));
    assert.equal(triage.source, "deterministic");
    assert.ok(triage.signature.length > 0, "the floor still produces a usable signature");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a run that changed nothing is not reviewed at all", async () => {
  const assist = new SidecarAssist({ llm: stubLlm("{}"), deadlineMs: 300 });
  const review = await assist.reviewRun(facts({ filesChanged: [] }));
  assert.equal(review.source, "deterministic");
  assert.deepEqual(review.evidenceWarnings, ["no files changed"]);
  assert.equal(SidecarAssist.needsReview(facts({ filesChanged: [] })), false);
});

test("triage fires on failure and on unverified change, not on a clean verified run", () => {
  assert.equal(SidecarAssist.needsTriage(facts({ status: "failed", filesChanged: [] })), true);
  assert.equal(SidecarAssist.needsTriage(facts({ status: "completed", verified: false })), true, "changed files but no proof is worth explaining");
  assert.equal(SidecarAssist.needsTriage(facts({ status: "completed", verified: true })), false, "a clean verified run needs no explanation");
});

// ── the identity probe: the silent-misconfiguration guard ────────────────────────────────────────

test("identity probe reports when the 'sidecar' is really the main model", async () => {
  // llama.cpp answers a request for an unknown model with whatever is loaded instead of a 404, so a
  // misconfigured sidecar looks exactly like a working one. This must be visible, not inferred.
  const llm = {
    models: { baseUrl: "http://stub/v1", main: "ornith-1.0-35b", sidecar: "qwen3.5-2b" },
  } as unknown as KittenLLM;
  const assist = new SidecarAssist({ llm });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "C:/models/ornith-1.0-35b-Q5_K_M.gguf" }] }),
  })) as unknown as typeof fetch;
  try {
    const identity = await assist.probeIdentity();
    assert.equal(identity.sharedWithMain, true, "a 2B request served by the 35B is shared, not separate");
    assert.match(identity.detail, /answered by the main model/i);
    assert.equal(identity.configured, "qwen3.5-2b");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity probe recognizes a genuinely separate sidecar endpoint", async () => {
  const llm = {
    models: { baseUrl: "http://main/v1", sidecarBaseUrl: "http://side/v1", main: "ornith-1.0-35b", sidecar: "qwen3.5-2b" },
  } as unknown as KittenLLM;
  const assist = new SidecarAssist({ llm });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: [{ id: "qwen3.5-2b" }] }) })) as unknown as typeof fetch;
  try {
    const identity = await assist.probeIdentity();
    assert.equal(identity.separateEndpoint, true);
    assert.equal(identity.sharedWithMain, false, "a separate endpoint removes the contention argument");
  } finally { globalThis.fetch = originalFetch; }
});

test("an unreachable endpoint is reported as unknown, not as agreement", async () => {
  const llm = { models: { baseUrl: "http://stub/v1", main: "m", sidecar: "s" } } as unknown as KittenLLM;
  const assist = new SidecarAssist({ llm });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  try {
    const identity = await assist.probeIdentity();
    assert.equal(identity.served, "");
    assert.equal(identity.sharedWithMain, true, "unknown must assume shared — the conservative direction");
    assert.match(identity.detail, /could not read the model list/i);
  } finally { globalThis.fetch = originalFetch; }
});

// ── step critique (SRFT critic) ───────────────────────────────────────────────────────────────────

test("step critique keeps productive exploration and flags only the failing steps", async () => {
  // The SRFT observation this exists to exploit: a FAILED run is mostly productive. A critic that
  // condemned the whole trajectory would destroy exactly the signal worth keeping.
  const assist = new SidecarAssist({ llm: stubLlm(null), deadlineMs: 300 });
  const critique = await assist.critiqueSteps(facts({ status: "failed" }), [
    "read src/parser.js -> ok",
    "grep tokenize -> ok",
    "bash npm test -> FAILED: AssertionError: expected 5 got 4",
    "edit src/parser.js -> ok",
    "bash npm test -> ok",
  ]);
  assert.equal(critique.steps.length, 5, "every step is labelled");
  assert.equal(critique.steps[2].label, "mistake", "the step whose own output failed");
  assert.equal(critique.steps[3].label, "recover", "the step after a mistake");
  assert.equal(critique.steps[0].label, "good");
  assert.ok(critique.productiveRatio >= 0.75, `productive ratio was ${critique.productiveRatio}`);
});

test("step critique is bounded and silent on an empty trajectory", async () => {
  const assist = new SidecarAssist({ llm: stubLlm(null), deadlineMs: 300 });
  const empty = await assist.critiqueSteps(facts({ status: "failed" }), []);
  assert.deepEqual(empty.steps, [], "nothing to label");
  assert.equal(empty.productiveRatio, 1);

  const many = await assist.critiqueSteps(facts({ status: "failed" }), Array.from({ length: 200 }, (_, i) => `read f${i}.js -> ok`));
  assert.ok(many.steps.length <= 64, `expected a cap, got ${many.steps.length}`);
});

test("a failed run persists its step labels as a durable event", async () => {
  const root = repo();
  const events: KittenEvent[] = [];
  const app = new KittenApp({
    store: ConversationStore.open(":memory:"), projectRoot: root, taskCompiler: "off",
    sidecarAssist: new SidecarAssist({ llm: stubLlm(null), deadlineMs: 300 }),
    runner: async (ctx): Promise<RunOutcome> => {
      ctx.emit({ type: "tool.completed", runId: ctx.runId, callId: "c1", name: "read", target: "src/a.js", ok: true, durationMs: 1, output: "" });
      ctx.emit({ type: "tool.completed", runId: ctx.runId, callId: "c2", name: "bash", target: "npm test", ok: false, durationMs: 1, output: "AssertionError: boom" });
      throw new Error("engine exploded");
    },
  });
  app.subscribe((e) => events.push(e));
  try {
    const conv = app.createConversation({ projectRoot: root });
    await app.submitMessage(conv.id, "fix the parser in src/a.js");
    await app.whenAssistSettled();
    const critique = events.find((e) => e.type === "run.step_critique");
    assert.ok(critique, "the trajectory that used to be a dead end is now labelled");
    assert.equal(critique!.type === "run.step_critique" && critique!.steps.length, 2);
    assert.ok(critique!.type === "run.step_critique" && critique!.productiveRatio < 1, "the failing step is counted");
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a clean verified run is not step-critiqued", async () => {
  const root = repo();
  const events: KittenEvent[] = [];
  const app = new KittenApp({
    store: ConversationStore.open(":memory:"), projectRoot: root, taskCompiler: "off",
    sidecarAssist: new SidecarAssist({ llm: stubLlm(null), deadlineMs: 300 }),
    runner: async (ctx): Promise<RunOutcome> => {
      ctx.emit({ type: "tool.completed", runId: ctx.runId, callId: "c1", name: "read", target: "src/a.js", ok: true, durationMs: 1, output: "" });
      return { finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: ["src/a.js"], verified: true };
    },
  });
  app.subscribe((e) => events.push(e));
  try {
    const conv = app.createConversation({ projectRoot: root });
    await app.submitMessage(conv.id, "change src/a.js");
    await app.whenAssistSettled();
    assert.equal(events.filter((e) => e.type === "run.step_critique").length, 0, "nothing to learn from a clean run");
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});
