import test from "node:test";
import assert from "node:assert/strict";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";
import { KittenApp } from "../src/core/app.js";
import { taskTool, readTool, writeTool, editTool } from "../src/core/tools.js";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// The project root is an absolute boundary, not something the task scope opts into. An unbounded
// task (empty allow-list) is "anywhere in the workspace" — never anywhere on the disk.
test("file tools cannot escape the project root, with or without a task scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-scope-root-"));
  const outside = await mkdtemp(join(tmpdir(), "kitten-scope-outside-"));
  await writeFile(join(outside, "secret.txt"), "top secret\n", "utf8");
  const ctx = { cwd: root, filesRead: new Set<string>(), filesWritten: new Set<string>(), allowedFiles: [] as string[] };
  try {
    for (const path of ["../secret.txt", "../../etc/passwd", join(outside, "secret.txt")]) {
      const read = await readTool.execute({ path }, ctx);
      assert.equal(read.isError, true, `read escaped the root via ${path}`);
      assert.match(read.output, /outside the project root/);
      const written = await writeTool.execute({ path, content: "owned" }, ctx);
      assert.equal(written.isError, true, `write escaped the root via ${path}`);
      assert.match(written.output, /outside the project root/);
      const edited = await editTool.execute({ path, search: "top secret", replace: "owned" }, ctx);
      assert.equal(edited.isError, true, `edit escaped the root via ${path}`);
    }
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "top secret\n");

    // Ordinary in-project work, including a file that does not exist yet, still succeeds.
    const created = await writeTool.execute({ path: "src/new/created.ts", content: "export const ok = 1;\n" }, ctx);
    assert.equal(created.isError, false, created.output);
    assert.equal((await readTool.execute({ path: "src/new/created.ts" }, ctx)).isError, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlink inside the project cannot be used to write outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-scope-link-"));
  const outside = await mkdtemp(join(tmpdir(), "kitten-scope-link-target-"));
  const ctx = { cwd: root, filesRead: new Set<string>(), filesWritten: new Set<string>(), allowedFiles: [] as string[] };
  try {
    try { await symlink(outside, join(root, "escape"), "dir"); }
    catch { return; } // unprivileged Windows sessions cannot create symlinks; nothing to assert
    const written = await writeTool.execute({ path: "escape/owned.txt", content: "owned" }, ctx);
    assert.equal(written.isError, true, "a junction/symlink must not widen the project root");
    assert.match(written.output, /outside the project root/);
    assert.equal(existsSync(join(outside, "owned.txt")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("scope matching follows the filesystem's own case rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-scope-case-"));
  const ctx = { cwd: root, filesRead: new Set<string>(), filesWritten: new Set<string>(), allowedFiles: [] as string[], forbiddenFiles: ["secrets"] };
  try {
    assert.equal((await writeTool.execute({ path: "secrets/key.txt", content: "x" }, ctx)).isError, true);
    const mixedCase = await writeTool.execute({ path: "Secrets/key.txt", content: "x" }, ctx);
    if (process.platform === "win32" || process.platform === "darwin") {
      // Same file to the OS, so it must be the same answer to the scope gate.
      assert.equal(mixedCase.isError, true, "a case variant bypassed a forbidden path");
    } else {
      assert.equal(mixedCase.isError, false, mixedCase.output);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
