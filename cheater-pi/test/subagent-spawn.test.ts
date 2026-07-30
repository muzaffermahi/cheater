import test from "node:test";
import assert from "node:assert/strict";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";
import { KittenApp } from "../src/core/app.js";
import { taskTool, readTool, writeTool } from "../src/core/tools.js";

test("spawnChild creates a navigable child conversation and parent receipts", async () => {
  const store = new ConversationStore(openSqlite(":memory:"));
  const app = new KittenApp({ store, runner: async (ctx) => ({ finished: true, verified: true, summary: `done: ${ctx.task}`, wallMs: 1, usage: { prompt: 2, completion: 3, reasoning: 0 }, receiptLines: ["test evidence"], filesChanged: [], model: ctx.model }) });
  const parent = app.createConversation({ title: "Parent" });
  const child = await app.spawnChild({ parentConversationId: parent.id, parentRunId: "parent-run", agent: "explore", prompt: "find the parser" });
  assert.equal(child.conversation.parentConversationId, parent.id);
  assert.equal(child.conversation.agent, "explore");
  assert.equal(child.run.status, "completed");
  const parentEvents = app.getEvents(parent.id);
  assert.equal(parentEvents.some((event) => event.type === "task.started"), true);
  const completed = parentEvents.find((event) => event.type === "task.completed");
  assert.equal(completed?.childConversationId, child.conversation.id);
  assert.equal(completed?.status, "completed");
});

test("cancelling a parent run propagates through durable child conversations", async () => {
  const store = new ConversationStore(openSqlite(":memory:"));
  let app!: KittenApp;
  let parentId = "";
  app = new KittenApp({ store, runner: async (ctx) => {
    if (ctx.conversationId === parentId) {
      await app.spawnChild({ parentConversationId: parentId, parentRunId: ctx.runId, agent: "verify", prompt: "run checks" });
      return { finished: true, verified: false, summary: "parent", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] };
    }
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { finished: false, verified: false, summary: "child cancelled", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] };
  }});
  const parent = app.createConversation({ title: "Parent" });
  parentId = parent.id;
  let parentRun = "";
  const stop = app.subscribe((event) => {
    if (event.type === "run.started" && event.conversationId === parent.id) {
      parentRun = event.runId;
      setTimeout(() => app.cancel(parentRun), 0);
    }
  });
  const result = await app.submitMessage(parent.id, "delegate");
  stop();
  assert.equal(parentRun.length > 0, true);
  assert.equal(result.status, "cancelled");
  const child = store.listChildConversations(parent.id)[0];
  assert.ok(child);
  assert.equal(store.listRuns(child.id)[0]?.status, "cancelled");
});

test("task tool is bounded and delegates only through the injected app hook", async () => {
  const calls: Array<{ agent: string; prompt: string }> = [];
  const result = await taskTool.execute({ agent: "explore", prompt: "find the parser" }, {
    cwd: process.cwd(), filesRead: new Set(), filesWritten: new Set(),
    spawnTask: async (input) => { calls.push(input); return { conversationId: "child", runId: "run", status: "completed", summary: "found it" }; }
  });
  assert.equal(result.isError, false);
  assert.match(result.output, /child child/);
  assert.equal(calls[0]?.agent, "explore");
  assert.equal(calls[0]?.prompt, "find the parser");
  const denied = await taskTool.execute({ agent: "general", prompt: "x" }, { cwd: process.cwd(), filesRead: new Set(), filesWritten: new Set() });
  assert.equal(denied.isError, true);
});

test("task file scopes are enforced by the real read/write tools", async () => {
  const ctx = { cwd: process.cwd(), filesRead: new Set<string>(), filesWritten: new Set<string>(), allowedFiles: ["src/only.ts"] };
  assert.equal((await readTool.execute({ path: "README.md" }, ctx)).isError, true);
  assert.equal((await writeTool.execute({ path: "other.ts", content: "x" }, ctx)).isError, true);
  const forbidden = { ...ctx, allowedFiles: [], forbiddenFiles: ["secrets"] };
  assert.equal((await writeTool.execute({ path: "secrets/key.txt", content: "x" }, forbidden)).isError, true);
});
