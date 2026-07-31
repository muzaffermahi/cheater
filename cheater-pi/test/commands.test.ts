import test from "node:test";
import assert from "node:assert/strict";
import { KittenApp } from "../src/core/app.js";
import { KittenLLM } from "../src/core/llm.js";
import { loadKittenSettings } from "../src/core/settings.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { runCommand, type CommandContext, type CommandFrame } from "../src/core/commands.js";

function context(): { ctx: CommandContext; frames: CommandFrame[]; prints: string[] } {
  const store = ConversationStore.open(":memory:");
  const app = new KittenApp({ store, runner: async () => ({ finished: true, verified: true, summary: "fixture", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] }) });
  const frames: CommandFrame[] = [];
  const prints: string[] = [];
  return {
    frames,
    prints,
    ctx: {
      app,
      store,
      llm: new KittenLLM({ baseUrl: "http://127.0.0.1:1/v1", main: "fixture" }),
      settings: loadKittenSettings(process.cwd()),
      session: { conversationId: null, model: "fixture", provider: null, lane: null },
      cwd: process.cwd(),
      io: { print: (text) => prints.push(text), table: (rows) => frames.push({ type: "table", rows }), frame: (frame) => frames.push(frame) },
    },
  };
}

test("shared command registry exposes working agents, provider, export, and redo commands", async () => {
  const setup = context();
  const conversation = setup.ctx.app.createConversation({ title: "Command parity" });
  setup.ctx.session.conversationId = conversation.id;
  assert.equal(await runCommand(setup.ctx, "/agents"), true);
  assert.ok(setup.frames.some((frame) => frame.type === "table" && frame.rows?.some((row) => row[0] === "explore")));
  assert.equal(await runCommand(setup.ctx, "/provider local"), true);
  assert.equal(setup.ctx.session.provider, "local");
  assert.equal(await runCommand(setup.ctx, "/export"), true);
  assert.ok(setup.frames.some((frame) => frame.type === "text" && frame.text?.includes("# Command parity")));
  assert.equal(await runCommand(setup.ctx, "/redo"), true);
  assert.match(setup.prints.at(-1) ?? "", /redo: no undone run/i);
  setup.ctx.app.close();
});
