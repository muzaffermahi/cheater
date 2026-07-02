import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGymCommands } from "../src/gym/commands.js";
import { defaultGymConfig } from "../src/gym/report.js";
import { ZOO_TASKS } from "../src/gym/zoo.js";

function makePi() {
  const commands = new Map();
  const messages: string[] = [];
  const pi = {
    registerCommand(name: string, def: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, def);
    },
    sendUserMessage(text: string) { messages.push(text); }
  };
  return { pi, commands, messages };
}

function makeCtx(cwd: string) {
  const notifications: Array<{ text: string; level: string }> = [];
  return {
    cwd, mode: "agent", isProjectTrusted: () => true,
    ui: {
      notify(text: string, level: "info" | "warning" = "info") {
        notifications.push({ text, level });
      },
      setWidget() { /* ignore */ }
    },
    _notifications: notifications
  };
}

test("registerGymCommands registers all expected commands", () => {
  const { pi, commands } = makePi();
  registerGymCommands(pi, { config: { ...defaultGymConfig() } as any, getCwd: (ctx) => ctx.cwd });
  for (const name of ["gym", "gym-list", "gym-run", "gym-run-suite", "gym-report", "gym-delta", "gym-learn", "gym-clean"]) {
    assert.ok(commands.has(name), `expected command ${name}`);
  }
});

test("/gym-list shows zoo tasks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cmd-list-"));
  const { pi, commands } = makePi();
  registerGymCommands(pi, { config: { ...defaultGymConfig() } as any, getCwd: (ctx) => ctx.cwd });
  const ctx = makeCtx(cwd);
  await commands.get("gym-list")!.handler("", ctx);
  assert.match(ctx._notifications[0].text, /Cheater Gym - /);
  rmSync(cwd, { recursive: true, force: true });
});

test("/gym-run prepares a workspace and sends a user message", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cmd-run-"));
  const { pi, commands, messages } = makePi();
  registerGymCommands(pi, {
    config: { ...defaultGymConfig() } as any,
    getCwd: (ctx) => ctx.cwd,
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  const ctx = makeCtx(cwd);
  await commands.get("gym-run")!.handler("py_off_by_one_001", ctx);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Cheater Reliability task py_off_by_one_001/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/gym-delta writes a delta report file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cmd-delta-"));
  const { pi, commands } = makePi();
  registerGymCommands(pi, { config: { ...defaultGymConfig() } as any, getCwd: (ctx) => ctx.cwd });
  const ctx = makeCtx(cwd);
  await commands.get("gym-delta")!.handler("py_off_by_one_001", ctx);
  assert.match(ctx._notifications[0].text, /vanilla available: false/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/gym-clean clears workspaces", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cmd-clean-"));
  const task = ZOO_TASKS[0];
  const { createWorkspace } = await import("../src/gym/workspace.js");
  createWorkspace(task, { rootDir: cwd, keep: true });
  const { pi, commands } = makePi();
  registerGymCommands(pi, { config: { ...defaultGymConfig() } as any, getCwd: (ctx) => ctx.cwd });
  const ctx = makeCtx(cwd);
  await commands.get("gym-clean")!.handler("", ctx);
  assert.match(ctx._notifications[0].text, /cleared/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/gym-run-suite with mocked runAgent writes a report", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cmd-suite-"));
  const { pi, commands } = makePi();
  registerGymCommands(pi, {
    config: { ...defaultGymConfig() } as any,
    getCwd: (ctx) => ctx.cwd,
    runAgent: async () => ({
      focusedTestsPassed: true, fullTestsPassed: true, reproduced: true, noOpDetected: false,
      memoryUsed: true, evidenceUsed: true, missionStepsCompleted: 4, commandsRun: ["pytest -q"]
    })
  });
  const ctx = makeCtx(cwd);
  await commands.get("gym-run-suite")!.handler("--limit 1", ctx);
  assert.match(ctx._notifications[0].text, /Cheater Gym report/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/gym-run-suite promotes gym successes to bug memory when auto-learn is enabled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cmd-autolearn-"));
  const { pi, commands } = makePi();
  registerGymCommands(pi, {
    config: { ...defaultGymConfig(), gymDefaultLimit: 1, gymAutoLearn: true, gymKeepWorkspaces: false } as any,
    getCwd: (ctx) => ctx.cwd,
    runAgent: async () => ({
      focusedTestsPassed: true, fullTestsPassed: true, reproduced: true, noOpDetected: false,
      memoryUsed: true, evidenceUsed: true, missionStepsCompleted: 4, commandsRun: ["pytest -q"]
    })
  });
  const ctx = makeCtx(cwd);
  await commands.get("gym-run-suite")!.handler("--limit 1", ctx);
  const memoryPath = join(cwd, ".cheater", "bug_memories.jsonl");
  assert.ok(existsSync(memoryPath));
  const text = readFileSync(memoryPath, "utf8");
  assert.match(text, /"source_gym_task_id":/);
  assert.match(text, /"workflow_steps":/);
  assert.match(ctx._notifications[0].text, /learned bug-memory cards: 1/);
  rmSync(cwd, { recursive: true, force: true });
});
