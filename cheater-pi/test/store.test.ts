import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";

function memStore(): ConversationStore {
  return new ConversationStore(openSqlite(":memory:"));
}

function seedConversation(s: ConversationStore, id = "c1", ts = 1000): void {
  s.createConversation({ id, title: "Fix the parser", projectRoot: "/proj", projectId: "/proj", model: "ornith", mode: "auto", ts });
}

test("createConversation seeds row + conversation.created event at seq 1", () => {
  const s = memStore();
  seedConversation(s);
  const conv = s.getConversation("c1");
  assert.ok(conv);
  assert.equal(conv!.lastSeq, 1);
  assert.equal(conv!.title, "Fix the parser");
  const evs = s.readEvents("c1");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "conversation.created");
  assert.equal(evs[0].seq, 1);
  assert.equal(evs[0].id, "c1:1");
});

test("events get gap-free monotonic seq and replay in order", () => {
  const s = memStore();
  seedConversation(s);
  s.appendEvent("c1", { type: "user.message", text: "hello" }, 1001);
  s.appendEvent("c1", { type: "route.selected", runId: "r1", lane: "reliable", reasons: ["ordinary"], k: 1 }, 1002);
  s.appendEvent("c1", { type: "run.started", runId: "r1", request: "hello", lane: "reliable" }, 1003);
  const evs = s.readEvents("c1");
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(evs.map((e) => e.type), ["conversation.created", "user.message", "route.selected", "run.started"]);
  // incremental replay (reconnect after seq 2)
  assert.deepEqual(s.readEvents("c1", 2).map((e) => e.seq), [3, 4]);
});

test("run projection tracks lifecycle: started -> files -> completed", () => {
  const s = memStore();
  seedConversation(s);
  s.appendEvent("c1", { type: "run.started", runId: "r1", request: "x", lane: "reliable" }, 2000);
  assert.equal(s.getRun("r1")!.status, "running");
  s.appendEvent("c1", { type: "file.changed", runId: "r1", path: "a.py", added: 2, removed: 0 }, 2001);
  s.appendEvent("c1", { type: "file.changed", runId: "r1", path: "a.py", added: 1, removed: 0 }, 2002); // dedup
  s.appendEvent("c1", { type: "file.changed", runId: "r1", path: "b.py", added: 5, removed: 1 }, 2003);
  s.appendEvent("c1", { type: "run.completed", runId: "r1", finished: true, verified: true, lane: "reliable", summary: "done", wallMs: 12, usage: { prompt: 3, completion: 4, reasoning: 1 } }, 2004);
  const run = s.getRun("r1")!;
  assert.equal(run.status, "completed");
  assert.equal(run.finished, true);
  assert.deepEqual(run.filesChanged, ["a.py", "b.py"]);
  assert.deepEqual(run.usage, { prompt: 3, completion: 4, reasoning: 1 });
  assert.equal(run.endedAt, 2004);
});

test("run.failed and receipt.finalized update the projection", () => {
  const s = memStore();
  seedConversation(s);
  s.appendEvent("c1", { type: "run.started", runId: "r2", request: "x", lane: "ascent" }, 3000);
  s.appendEvent("c1", { type: "receipt.finalized", runId: "r2", lines: ["a", "b"], filesChanged: ["z.py"], verified: true }, 3001);
  assert.equal(s.getRun("r2")!.verified, true);
  assert.deepEqual(s.getRun("r2")!.filesChanged, ["z.py"]);
  s.appendEvent("c1", { type: "run.failed", runId: "r2", error: "boom" }, 3002);
  assert.equal(s.getRun("r2")!.status, "failed");
  assert.equal(s.getRun("r2")!.error, "boom");
});

test("recoverInterruptedRuns flips transient runs to interrupted and logs an event", () => {
  const s = memStore();
  seedConversation(s);
  s.appendEvent("c1", { type: "run.started", runId: "live", request: "x", lane: "reliable" }, 4000);
  s.appendEvent("c1", { type: "run.started", runId: "done", request: "y", lane: "reliable" }, 4001);
  s.appendEvent("c1", { type: "run.completed", runId: "done", finished: true, verified: true, lane: "reliable", summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 } }, 4002);
  const recovered = s.recoverInterruptedRuns(9999);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].type, "run.interrupted");
  assert.equal(s.getRun("live")!.status, "interrupted");
  assert.equal(s.getRun("live")!.endedAt, 9999);
  assert.equal(s.getRun("done")!.status, "completed"); // untouched
  // recovery is idempotent — a second pass finds nothing.
  assert.equal(s.recoverInterruptedRuns(10000).length, 0);
});

test("appendEvent to an unknown conversation throws", () => {
  const s = memStore();
  assert.throws(() => s.appendEvent("nope", { type: "user.message", text: "x" }, 1), /unknown conversation/);
});

test("listConversations filters by project, archive, and search", () => {
  const s = memStore();
  s.createConversation({ id: "a", title: "parser bug", projectRoot: "/p1", projectId: "/p1", model: "m", mode: "auto", ts: 10 });
  s.createConversation({ id: "b", title: "web ui", projectRoot: "/p2", projectId: "/p2", model: "m", mode: "auto", ts: 20 });
  s.appendEvent("b", { type: "user.message", text: "make the sidebar collapsible" }, 21);
  assert.deepEqual(s.listConversations({ projectId: "/p1" }).map((c) => c.id), ["a"]);
  assert.deepEqual(s.listConversations({ search: "sidebar" }).map((c) => c.id), ["b"]); // hits message text
  assert.deepEqual(s.listConversations({ search: "parser" }).map((c) => c.id), ["a"]); // hits title
  s.setArchived("a", true, 30);
  assert.deepEqual(s.listConversations().map((c) => c.id), ["b"]); // archived hidden by default
  assert.equal(s.listConversations({ includeArchived: true }).length, 2);
});

test("recent messages stay searchable in a long conversation (index keeps the newest text, not the oldest)", () => {
  // Regression: the search index kept the FIRST 20000 chars, so after a long conversation filled it,
  // every later message fell past the cutoff and became unsearchable.
  const s = memStore();
  s.createConversation({ id: "long", title: "t", projectRoot: "/p", projectId: "/p", model: "m", mode: "auto", ts: 1 });
  s.appendEvent("long", { type: "user.message", text: "alpha ".repeat(5000) }, 2); // ~30000 chars of early bulk
  s.appendEvent("long", { type: "user.message", text: "please add rate limiting to the uploader" }, 3);
  assert.deepEqual(s.listConversations({ search: "rate limiting" }).map((c) => c.id), ["long"], "the newest message must remain searchable");
});

test("data survives close + reopen (durability across process restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-store-"));
  const dbfile = join(dir, "kitten.db");
  const s1 = ConversationStore.open(dbfile);
  seedConversation(s1, "persist", 500);
  s1.appendEvent("persist", { type: "user.message", text: "remember me" }, 501);
  s1.close();
  // Reopen: migrations are a no-op, and every event + conversation is intact.
  const s2 = ConversationStore.open(dbfile);
  const evs = s2.readEvents("persist");
  assert.deepEqual(evs.map((e) => e.type), ["conversation.created", "user.message"]);
  assert.equal(s2.getConversation("persist")!.title, "Fix the parser");
  s2.close();
});
