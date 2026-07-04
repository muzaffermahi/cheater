import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { devLog, extractParts, messageText, registerDevLog, roleOf } from "../src/dev/devLog.js";

function makeFakePi() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, opts: any) { commands.set(name, opts); }
  };
  const fire = async (event: string, ...args: any[]) => { for (const h of handlers.get(event) ?? []) await h(...args); };
  return { pi, handlers, commands, fire };
}

// --- pure helpers ---------------------------------------------------------------------------

test("extractParts splits reasoning (thinking) from visible text", () => {
  const parts = extractParts({ role: "assistant", content: [
    { type: "thinking", thinking: "let me reason" },
    { type: "text", text: "here is the answer" },
    { type: "tool_use", name: "bash" }
  ] });
  assert.deepEqual(parts, [
    { kind: "thinking", text: "let me reason" },
    { kind: "text", text: "here is the answer" }
  ]);
});

test("extractParts handles a plain string message and messageText returns visible text only", () => {
  assert.deepEqual(extractParts({ role: "user", content: "hello" }), [{ kind: "text", text: "hello" }]);
  assert.equal(messageText({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "shown" }] }), "shown");
  assert.equal(roleOf({ role: "user" }), "user");
});

// --- lifecycle ------------------------------------------------------------------------------

test("the dev log is a no-op until enabled, and enabling creates the marker + a trace file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-devlog-life-"));
  devLog.disable(cwd);
  assert.equal(devLog.isEnabled(), false);
  devLog.userInput("this must not be written"); // no-op when disabled - must not throw or create files
  assert.equal(devLog.currentFile(), null);

  const file = devLog.enable(cwd, "openai/qwen");
  assert.equal(devLog.isEnabled(), true);
  assert.ok(existsSync(join(cwd, ".cheater", "dev-logs", ".enabled")), "marker persists the toggle across sessions");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /Cheater dev trace - silent instrumentation/);

  devLog.disable(cwd);
  assert.equal(devLog.isEnabled(), false);
  assert.ok(!existsSync(join(cwd, ".cheater", "dev-logs", ".enabled")), "disable removes the marker");
});

test("resumeIfMarked re-opens a fresh trace when a prior session left the marker", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-devlog-resume-"));
  devLog.disable(cwd);
  devLog.enable(cwd);          // writes the marker
  devLog.disable(cwd);         // removes marker + turns off... so re-arm manually:
  // Simulate "marker present but this process not yet logging" by enabling then only clearing state.
  const file = devLog.enable(cwd);
  const marker = join(cwd, ".cheater", "dev-logs", ".enabled");
  assert.ok(existsSync(marker));
  // A brand-new process (state reset) with the marker still on disk should resume.
  (devLog as unknown as { enabled: boolean; file: string | null }).enabled = false;
  (devLog as unknown as { enabled: boolean; file: string | null }).file = null;
  assert.equal(devLog.resumeIfMarked(cwd), true);
  assert.equal(devLog.isEnabled(), true);
  assert.notEqual(devLog.currentFile(), file, "resume opens a NEW per-session file");
  devLog.disable(cwd);
});

// --- LIVE WIRING: registerDevLog taps drive a real trace file --------------------------------

test("registerDevLog records prompts, reasoning, tool calls, results, and timing to the trace", async () => {
  const { pi, commands, fire } = makeFakePi();
  registerDevLog(pi as any);
  assert.ok(commands.has("dev"), "the /dev command is registered");

  const cwd = mkdtempSync(join(tmpdir(), "cheater-devlog-wire-"));
  const ctx = { cwd, model: { id: "openai/qwen" }, ui: { notify() { /* user-facing only */ } } };
  devLog.disable(cwd);
  await commands.get("dev")!.handler("on", ctx);
  assert.equal(devLog.isEnabled(), true);

  await fire("agent_start", {}, ctx);
  await fire("turn_start", { turnIndex: 0 });
  await fire("message_start", { message: { role: "user", content: "add a /hello command" } });
  await fire("message_start", { message: { role: "assistant", content: "" } }); // must NOT log as USER
  await fire("tool_execution_start", { toolCallId: "call_abc123", toolName: "bash", args: { command: "npm test" } });
  await fire("tool_execution_end", { toolCallId: "call_abc123", toolName: "bash", result: { content: [{ type: "text", text: "3 passing" }] }, isError: false });
  await fire("turn_end", {
    turnIndex: 0,
    message: { role: "assistant", content: [{ type: "thinking", thinking: "I should edit commands.ts" }, { type: "text", text: "Done, added /hello." }] },
    toolResults: [{}]
  });

  const content = readFileSync(devLog.currentFile()!, "utf8");
  assert.match(content, /\] USER\n {4}add a \/hello command/);
  assert.match(content, /\] THINK\n {4}I should edit commands\.ts/, "reasoning trace is captured");
  assert.match(content, /\] ASSISTANT\n {4}Done, added \/hello\./);
  assert.match(content, /\] TOOL bash #abc123\n {4}\$ npm test/, "the command and its args are captured");
  assert.match(content, /\] RESULT bash #abc123 \([\d.]+s, ok\)\n {4}3 passing/, "result + duration + status are captured");
  assert.match(content, /\] TURN 0 END \(elapsed [\d.]+s, tools=1\)/, "turn timing is captured");
  // The empty assistant message_start must not have produced a spurious USER entry.
  assert.equal((content.match(/\] USER\n/g) ?? []).length, 1);

  await commands.get("dev")!.handler("off", ctx);
  assert.equal(devLog.isEnabled(), false);
  assert.ok(!existsSync(join(cwd, ".cheater", "dev-logs", ".enabled")));
});
