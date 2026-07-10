import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KittenApp, type Runner, type RunContext } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";
import type { KittenEvent } from "../src/core/events.js";

// Deterministic app harness: monotonic clock ticks + counter ids, so events + assertions are stable.
function makeApp(store: ConversationStore, runner: Runner): KittenApp {
  let t = 0; let n = 0;
  return new KittenApp({ store, runner, now: () => ++t, newId: (p) => `${p}${n++}`, projectRoot: "/proj", model: "ornith" });
}

// A scripted runner: emits realistic run-scoped events, then finishes. No model, fully deterministic.
const scripted: Runner = async (ctx: RunContext) => {
  ctx.emit({ type: "assistant.delta", runId: ctx.runId, text: "on it" });
  ctx.emit({ type: "tool.completed", runId: ctx.runId, callId: `${ctx.runId}:t0`, name: "edit", ok: true, durationMs: 1, output: "wrote a.py" });
  ctx.emit({ type: "file.changed", runId: ctx.runId, path: "a.py", added: 3, removed: 0 });
  return { finished: true, summary: "edited a.py", wallMs: 5, usage: { prompt: 1, completion: 2, reasoning: 0 }, receiptLines: ["reliable lane: finish in 2 turns"], filesChanged: ["a.py"], verified: true };
};

test("createConversation broadcasts conversation.created", () => {
  const app = makeApp(new ConversationStore(openSqlite(":memory:")), scripted);
  const seen: KittenEvent[] = [];
  app.subscribe((e) => seen.push(e));
  const conv = app.createConversation({ title: "Fix parser" });
  assert.equal(conv.title, "Fix parser");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "conversation.created");
});

test("submitMessage persists the full ordered run and returns a completed run", async () => {
  const app = makeApp(new ConversationStore(openSqlite(":memory:")), scripted);
  const conv = app.createConversation();
  const run = await app.submitMessage(conv.id, "fix the off-by-one in a.py");
  assert.equal(run.status, "completed");
  assert.equal(run.finished, true);
  assert.deepEqual(run.filesChanged, ["a.py"]);
  assert.equal(run.verified, true);

  const types = app.getEvents(conv.id).map((e) => e.type);
  assert.deepEqual(types, [
    "conversation.created", "user.message", "route.selected", "run.started",
    "assistant.delta", "tool.completed", "file.changed",
    "run.completed", "receipt.finalized",
  ]);
});

test("EXIT CONDITION: a headless run persists and replays a complete conversation through the shared API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-app-"));
  const dbfile = join(dir, "kitten.db");

  // Session 1: run a task, capturing everything the app broadcast.
  const app1 = makeApp(ConversationStore.open(dbfile), scripted);
  const broadcast: KittenEvent[] = [];
  app1.subscribe((e) => broadcast.push(e));
  const conv = app1.createConversation({ title: "Replay me" });
  await app1.submitMessage(conv.id, "add a helper to util.py");
  app1.close(); // simulate process exit

  // Session 2 ("restart"): a brand-new app over the SAME database replays the identical conversation.
  const app2 = makeApp(ConversationStore.open(dbfile), scripted);
  app2.recover(); // no transient runs; should be a no-op
  const replay = app2.getEvents(conv.id);

  assert.equal(replay.length, broadcast.length, "replay length matches what was broadcast live");
  assert.deepEqual(replay.map((e) => e.id), broadcast.map((e) => e.id));
  assert.deepEqual(replay.map((e) => e.type), broadcast.map((e) => e.type));
  assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(broadcast)), "full replay is byte-identical to the live stream");

  // The run projection is fully restored, not re-derived on the fly.
  const runs = app2.getRuns(conv.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  assert.deepEqual(runs[0].filesChanged, ["a.py"]);
  app2.close();
});

test("crash recovery: a run left transient at restart becomes interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-recover-"));
  const dbfile = join(dir, "kitten.db");
  const store1 = ConversationStore.open(dbfile);
  const app1 = makeApp(store1, scripted);
  const conv = app1.createConversation();
  // Simulate a crash mid-run: run.started persisted, no terminal event.
  store1.appendEvent(conv.id, { type: "run.started", runId: "crashed", request: "x", lane: "reliable" }, 500);
  store1.close();

  const app2 = makeApp(ConversationStore.open(dbfile), scripted);
  const recovered: KittenEvent[] = [];
  app2.subscribe((e) => recovered.push(e));
  const events = app2.recover();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "run.interrupted");
  assert.equal(recovered.length, 1); // broadcast to subscribers too
  assert.equal(app2.getRuns(conv.id).find((r) => r.id === "crashed")!.status, "interrupted");
  app2.close();
});

test("cancel: an in-flight run stops with run.cancelled and preserved history", async () => {
  const cancellable: Runner = async (ctx) => {
    ctx.emit({ type: "tool.completed", runId: ctx.runId, callId: "x", name: "bash", ok: true, durationMs: 1, output: "" });
    await new Promise<void>((res) => {
      if (ctx.signal.aborted) return res();
      ctx.signal.addEventListener("abort", () => res(), { once: true });
    });
    return { finished: false, summary: "cancelled", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false };
  };
  const app = makeApp(new ConversationStore(openSqlite(":memory:")), cancellable);
  const conv = app.createConversation();
  // Cancel the run as soon as it starts.
  app.subscribe((e) => { if (e.type === "run.started") app.cancel(e.runId); });
  const run = await app.submitMessage(conv.id, "do a long thing");
  assert.equal(run.status, "cancelled");
  const types = app.getEvents(conv.id).map((e) => e.type);
  assert.ok(types.includes("run.cancelled"));
  assert.ok(types.includes("user.message")); // history preserved
});

test("router: question -> answer lane, change -> reliable lane", async () => {
  let lane = "";
  const spy: Runner = async (ctx) => {
    lane = ctx.lane;
    return { finished: true, summary: "", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false };
  };
  const app = makeApp(new ConversationStore(openSqlite(":memory:")), spy);
  const conv = app.createConversation();
  await app.submitMessage(conv.id, "why does the parser drop trailing commas?");
  assert.equal(lane, "answer");
  await app.submitMessage(conv.id, "fix the parser to keep trailing commas");
  assert.equal(lane, "reliable");
  // The chosen lane + reasons are recorded for inspection.
  const route = app.getEvents(conv.id).find((e) => e.type === "route.selected");
  assert.ok(route && "reasons" in route && (route as { reasons: string[] }).reasons.length > 0);
});

test("a runner that throws is recorded as run.failed, history intact", async () => {
  const boom: Runner = async () => { throw new Error("engine exploded"); };
  const app = makeApp(new ConversationStore(openSqlite(":memory:")), boom);
  const conv = app.createConversation();
  const run = await app.submitMessage(conv.id, "fix it");
  assert.equal(run.status, "failed");
  assert.equal(run.error, "engine exploded");
  assert.ok(app.getEvents(conv.id).some((e) => e.type === "user.message"));
});
