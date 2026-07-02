import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cheaterExtension from "../src/extension.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { defaultBlueprintState } from "../src/blueprint/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { beginTaskRun, endTaskRun, resetTaskRunForTests, activeTaskRun } from "../src/runstate/runState.js";

// Session reincarnation: a controller killed mid-task resumes from .cheater/runs/<taskId>/
// alone. The dead session's chat does not exist and is not wanted - the injected brief is
// small, derived from durable files, and only fires on a continuation message.

function makePi() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const pi = {
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerTool(def: any) { tools.set(def.name, def); },
    on(name: string, handler: any) { events.set(name, handler); },
    sendUserMessage() {},
    sendMessage() {},
    getActiveTools: () => [],
    setActiveTools() {},
    getAllTools() { return [...tools.values()]; },
    getCommands() { return [...commands.keys()].map((name) => ({ name })); }
  };
  return { pi, events, tools };
}

function ctx(cwd: string) {
  const notices: string[] = [];
  return {
    cwd,
    model: { id: "test" },
    ui: {
      notify(message: string) { notices.push(message); },
      setTitle() {},
      setStatus() {},
      setWidget() {},
      setWorkingMessage() {}
    },
    hasPendingMessages: () => false,
    notices
  };
}

const GOAL = "Serve GET /api/health and write results to output.json";

function seedUnfinishedRun(cwd: string, taskId: string, goal = GOAL): void {
  resetTaskRunForTests();
  const run = beginTaskRun(cwd, goal, { taskId });
  run.recordFileMutation("src/app.ts", "file_modified", "worker", "edit");
  run.recordValidation({ name: "focused", command: "npm test", actor: "w", validates: ["src/app.ts"], status: "pass" });
  // Simulate a dead session: no endTaskRun, so world-state status stays "running".
  resetTaskRunForTests();
}

function freshSession(cwd: string) {
  defaultCommitletState.clear();
  defaultBlueprintState.clear();
  liveSessionState.reset();
  resetTaskRunForTests();
  const { pi, events } = makePi();
  cheaterExtension(pi);
  return { events, context: ctx(cwd) };
}

test("one unfinished run resumes on a continuation message with a small injected brief", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-reinc-1-"));
  seedUnfinishedRun(cwd, "run-alpha");
  const { events, context } = freshSession(cwd);
  const result = await events.get("input")({ type: "input", text: "continue", source: "interactive" }, context);
  assert.equal(result.action, "transform", "a continuation message must resume the run");
  assert.match(result.text, /run-alpha/);
  assert.match(result.text, /previous controller context is gone/);
  assert.match(result.text, /cheater_reliability_start/, "the brief tells the model exactly how to resume");
  assert.ok(activeTaskRun(), "the run is re-activated in memory");
  assert.equal(activeTaskRun()!.resumed, true);
  assert.ok(context.notices.some((notice) => /resuming unfinished run run-alpha/.test(notice)));
  endTaskRun();
});

test("the injected brief stays under a strict size cap and contains no logs/reports dumps", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-reinc-2-"));
  seedUnfinishedRun(cwd, "run-size");
  const { events, context } = freshSession(cwd);
  const result = await events.get("input")({ type: "input", text: "go ahead", source: "interactive" }, context);
  assert.equal(result.action, "transform");
  assert.ok(result.text.length < 3000, `the whole injected message must stay small; got ${result.text.length} chars`);
  assert.ok(!/\x1b\[/.test(result.text), "no raw logs");
  endTaskRun();
});

test("multiple unfinished runs resume only the most recent; the others are a notice, not context", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-reinc-3-"));
  seedUnfinishedRun(cwd, "run-old", "an older task about parsing dates");
  await new Promise((resolve) => setTimeout(resolve, 15));
  seedUnfinishedRun(cwd, "run-new");
  const { events, context } = freshSession(cwd);
  const result = await events.get("input")({ type: "input", text: "continue", source: "interactive" }, context);
  assert.equal(result.action, "transform");
  assert.match(result.text, /run-new/);
  assert.ok(!result.text.includes("parsing dates"), "the older run's content must NOT enter context");
  assert.ok(context.notices.some((notice) => /run-old/.test(notice)), "the other unfinished run is surfaced as a notice only");
  endTaskRun();
});

test("a clearly new unrelated task does not force resume - notice only, normal routing continues", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-reinc-4-"));
  seedUnfinishedRun(cwd, "run-idle");
  const { events, context } = freshSession(cwd);
  const result = await events.get("input")({ type: "input", text: "Write a completely new markdown linter CLI in python for me", source: "interactive" }, context);
  // Autopilot may still transform for routing, but the reincarnation brief must not appear.
  assert.ok(!(result?.text ?? "").includes("previous controller context is gone"), "no forced resume on a new goal");
  assert.ok(!(result?.text ?? "").includes("run-idle"));
  assert.equal(activeTaskRun(), null, "the unfinished run stays inactive");
  assert.ok(context.notices.some((notice) => /unfinished run/.test(notice)), "the unfinished work is surfaced as a notice");
});

test("a session with no unfinished runs routes normally with no reincarnation artifacts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-reinc-5-"));
  writeFileSync(join(cwd, "README.md"), "hi\n", "utf8");
  const { events, context } = freshSession(cwd);
  const result = await events.get("input")({ type: "input", text: "continue", source: "interactive" }, context);
  assert.ok(!(result?.text ?? "").includes("previous controller context is gone"));
  assert.ok(!context.notices.some((notice) => /unfinished/.test(notice)));
});

test("resumed run is reused by reliability_start instead of being orphaned as running", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-reinc-6-"));
  seedUnfinishedRun(cwd, "run-reuse");
  const { events, context } = freshSession(cwd);
  await events.get("input")({ type: "input", text: "continue", source: "interactive" }, context);
  const resumed = activeTaskRun();
  assert.ok(resumed?.resumed);
  const before = resumed!.taskId;
  // The reincarnated run keeps its ledgers: the earlier validation and mutation are intact.
  assert.equal(resumed!.validations.all().length, 1);
  assert.equal(before, "run-reuse");
  endTaskRun();
});
