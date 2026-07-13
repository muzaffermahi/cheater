import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextBuilder } from "../src/core/context.js";
import { KittenApp, type Runner } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";

function seededStore(): { store: ConversationStore; id: string } {
  const store = new ConversationStore(openSqlite(":memory:"));
  const id = "c1";
  store.createConversation({ id, title: "t", projectRoot: "/proj", projectId: "/proj", model: "m", mode: "auto", ts: 1 });
  // Turn 1: a reliable run that changed roman.py and verified.
  store.appendEvent(id, { type: "user.message", text: "fix int_to_roman in roman.py" }, 2);
  store.appendEvent(id, { type: "run.started", runId: "r1", request: "fix int_to_roman in roman.py", lane: "reliable" }, 3);
  store.appendEvent(id, { type: "file.changed", runId: "r1", path: "roman.py", added: 5, removed: 2 }, 4);
  store.appendEvent(id, { type: "receipt.finalized", runId: "r1", lines: ["ok"], filesChanged: ["roman.py"], verified: true }, 5);
  store.appendEvent(id, { type: "run.completed", runId: "r1", finished: true, verified: true, lane: "reliable", summary: "added subtractive pairs", wallMs: 10, usage: { prompt: 1, completion: 1, reasoning: 0 } }, 6);
  return { store, id };
}

test("ContextBuilder folds prior turns (request, outcome, files, verification) into the preamble", () => {
  const { store, id } = seededStore();
  const built = new ContextBuilder(store).build(id, "/nonexistent-cwd");
  assert.match(built.preamble, /Conversation so far/);
  assert.match(built.preamble, /fix int_to_roman/);
  assert.match(built.preamble, /added subtractive pairs/);
  assert.match(built.preamble, /roman\.py/);
  assert.match(built.preamble, /verified/);
  assert.ok(built.coveredSeq >= 6);
});

test("ContextBuilder surfaces a cancelled run honestly (not '(in progress)')", () => {
  // Regression: digestTurns ignored run.cancelled/run.interrupted, so pendingRequest fell through to the
  // end-of-loop push and a cancelled run was described to the model as "in progress / no outcome".
  const store = new ConversationStore(openSqlite(":memory:"));
  const id = "cc";
  store.createConversation({ id, title: "t", projectRoot: "/proj", projectId: "/proj", model: "m", mode: "auto", ts: 1 });
  store.appendEvent(id, { type: "user.message", text: "refactor auth.py" }, 2);
  store.appendEvent(id, { type: "run.started", runId: "r1", request: "refactor auth.py", lane: "reliable" }, 3);
  store.appendEvent(id, { type: "file.changed", runId: "r1", path: "auth.py", added: 3, removed: 1 }, 4);
  store.appendEvent(id, { type: "run.cancelled", runId: "r1" }, 5);
  const built = new ContextBuilder(store).build(id, "/nonexistent-cwd");
  assert.match(built.preamble, /cancelled/, "a cancelled run must be labeled cancelled");
  assert.doesNotMatch(built.preamble, /in progress/, "must NOT be mislabeled as in progress");
});

test("ContextBuilder returns no prior-turn block for a brand-new conversation", () => {
  const store = new ConversationStore(openSqlite(":memory:"));
  store.createConversation({ id: "fresh", title: "t", projectRoot: "/proj", projectId: "/proj", model: "m", mode: "auto", ts: 1 });
  const built = new ContextBuilder(store).build("fresh", "/nonexistent-cwd");
  assert.doesNotMatch(built.preamble, /Conversation so far/);
});

test("ContextBuilder does not leak across conversations", () => {
  const { store } = seededStore();
  store.createConversation({ id: "other", title: "t", projectRoot: "/proj2", projectId: "/proj2", model: "m", mode: "auto", ts: 1 });
  store.appendEvent("other", { type: "user.message", text: "totally unrelated parser work" }, 2);
  const built = new ContextBuilder(store).build("other", "/nonexistent-cwd");
  assert.doesNotMatch(built.preamble, /int_to_roman/); // c1's history must not appear
});

// The app must inject the built context into the runner so the MODEL sees prior turns.
function capturingApp(store: ConversationStore): { app: KittenApp; lastContext: () => string } {
  let last = "";
  let t = 100;
  const runner: Runner = async (ctx) => {
    last = ctx.conversationContext;
    ctx.emit({ type: "assistant.final", runId: ctx.runId, text: "done" });
    return { finished: true, summary: "did it", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: true };
  };
  const app = new KittenApp({ store, runner, now: () => ++t, newId: (p) => `${p}${t}`, projectRoot: "/proj" });
  return { app, lastContext: () => last };
}

test("app injects prior-turn context into a follow-up message (same process)", async () => {
  const { app, lastContext } = capturingApp(new ConversationStore(openSqlite(":memory:")));
  const conv = app.createConversation({ projectRoot: "/proj" });
  await app.submitMessage(conv.id, "add a helper called slugify to util.py");
  assert.doesNotMatch(lastContext(), /Conversation so far/); // turn 1 has no prior context
  await app.submitMessage(conv.id, "now do the same for the parser");
  assert.match(lastContext(), /Conversation so far/);         // turn 2 sees turn 1
  assert.match(lastContext(), /slugify/);                     // the actual prior request
});

test("resume after process restart still informs the model (P0 exit criterion)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-ctx-"));
  const dbfile = join(dir, "kitten.db");
  const s1 = ConversationStore.open(dbfile);
  const a1 = capturingApp(s1);
  const conv = a1.app.createConversation({ projectRoot: "/proj" });
  await a1.app.submitMessage(conv.id, "implement a stack VM in vm.py with push and pop");
  s1.close();

  // Fresh process: a brand-new app over the same DB. A follow-up must carry the prior turn.
  const s2 = ConversationStore.open(dbfile);
  const a2 = capturingApp(s2);
  await a2.app.submitMessage(conv.id, "why did that fail?");
  assert.match(a2.lastContext(), /Conversation so far/);
  assert.match(a2.lastContext(), /stack VM/);
  s2.close();
});
