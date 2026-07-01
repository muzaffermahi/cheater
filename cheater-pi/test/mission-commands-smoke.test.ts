import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMissionStore } from "../src/mission/store.js";
import { registerMissionCommands } from "../src/mission/commands.js";
import { saveMemory } from "../src/tools.js";
import { loadConfig } from "../src/config.js";
import type { CheaterConfig } from "../src/types.js";

interface FakeCommand {
  name: string;
  args: string[];
  description: string;
  handler: (args: string, ctx: any) => Promise<void>;
}

function makePi() {
  const commands = new Map<string, FakeCommand>();
  const messages: string[] = [];
  const pi = {
    registerCommand(name: string, def: { description: string; handler: FakeCommand["handler"] }) {
      commands.set(name, { name, args: [], description: def.description, handler: def.handler });
    },
    sendUserMessage(text: string) {
      messages.push(text);
    }
  };
  return { pi: pi as any, commands, messages };
}

function makeCtx(cwd: string) {
  const notifications: Array<{ text: string; level: string }> = [];
  const widgets: Array<{ key: string; lines: string[] }> = [];
  return {
    cwd,
    mode: "agent",
    isProjectTrusted: () => true,
    ui: {
      notify(text: string, level: "info" | "warning" = "info") {
        notifications.push({ text, level });
      },
      setWidget(key: string, lines: string[], _opts: unknown) {
        widgets.push({ key, lines });
      }
    },
    _notifications: notifications,
    _widgets: widgets
  } as any;
}

test("/mission creates an active mission and shows dashboard", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest" } }));
  const { pi, commands, messages } = makePi();
  const store = defaultMissionStore({ cwd });
  const config: CheaterConfig = { missionControlEnabled: true, reproRequiredBeforePatch: true };
  registerMissionCommands(pi, {
    store,
    config,
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  assert.ok(commands.has("mission"), "mission command should be registered");
  assert.ok(commands.has("fix"), "fix command should be registered");
  assert.ok(commands.has("orient"), "orient command should be registered");
  assert.ok(commands.has("repro"), "repro command should be registered");
  assert.ok(commands.has("evidence"), "evidence command should be registered");
  assert.ok(commands.has("playbook"), "playbook command should be registered");
  assert.ok(commands.has("verify"), "verify command should be registered");
  assert.ok(commands.has("learn"), "learn command should be registered");
  assert.ok(commands.has("delta-bench"), "delta-bench command should be registered");

  const ctx = makeCtx(cwd);
  await commands.get("mission")!.handler("Fix failing pagination test", ctx);
  assert.equal(ctx._notifications.length > 0, true, "expected notification");
  assert.match(ctx._notifications[0].text, /mission /);
  assert.equal(messages.length, 1, "expected one user message");
  assert.match(messages[0], /Cheater Mission Control started/);

  const active = store.active();
  assert.ok(active);
  assert.equal(active.userGoal, "Fix failing pagination test");
  assert.ok(active.playbook);
  rmSync(cwd, { recursive: true, force: true });
});

test("/fix routes into a bug_fix mission", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-fix-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  const config: CheaterConfig = { reproRequiredBeforePatch: true };
  registerMissionCommands(pi, {
    store,
    config,
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  const ctx = makeCtx(cwd);
  await commands.get("fix")!.handler("Cannot import requests module", ctx);
  const active = store.active();
  assert.ok(active);
  assert.equal(active.missionType, "bug_fix");
  rmSync(cwd, { recursive: true, force: true });
});

test("/orient scans and shows orientation facts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-orient-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" } }));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  registerMissionCommands(pi, {
    store,
    config: {},
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  const ctx = makeCtx(cwd);
  await commands.get("orient")!.handler("", ctx);
  const text = ctx._notifications[0].text;
  assert.match(text, /languages:/);
  assert.match(text, /test commands:/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/repro with a passing command marks no_change_needed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-repro-pass-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  registerMissionCommands(pi, {
    store,
    config: {},
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  await commands.get("mission")!.handler("Fix bug", makeCtx(cwd));
  const ctx = makeCtx(cwd);
  await commands.get("repro")!.handler("node -e \"process.exit(0)\"", ctx);
  const active = store.active();
  assert.ok(active);
  assert.equal(active.status, "no_change_needed");
  rmSync(cwd, { recursive: true, force: true });
});

test("/repro with no command waits for the user", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-repro-empty-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  registerMissionCommands(pi, {
    store,
    config: {},
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  await commands.get("mission")!.handler("Fix bug", makeCtx(cwd));
  const ctx = makeCtx(cwd);
  await commands.get("repro")!.handler("", ctx);
  const active = store.active();
  assert.ok(active);
  assert.equal(active.status, "waiting_for_user");
  rmSync(cwd, { recursive: true, force: true });
});

test("/verify with a passing command completes the mission", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-verify-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  registerMissionCommands(pi, {
    store,
    config: {},
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  await commands.get("mission")!.handler("Fix bug", makeCtx(cwd));
  const ctx = makeCtx(cwd);
  await commands.get("verify")!.handler("node -e \"process.exit(0)\"", ctx);
  const active = store.active();
  assert.ok(active);
  assert.equal(active.status, "complete");
  rmSync(cwd, { recursive: true, force: true });
});

test("/mission-cancel transitions the mission to cancelled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-cancel-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  registerMissionCommands(pi, {
    store,
    config: {},
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  await commands.get("mission")!.handler("Fix bug", makeCtx(cwd));
  const ctx = makeCtx(cwd);
  await commands.get("mission-cancel")!.handler("", ctx);
  const active = store.active();
  assert.equal(active?.status, "cancelled");
  rmSync(cwd, { recursive: true, force: true });
});

test("/playbook shows the active mission playbook", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-playbook-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  registerMissionCommands(pi, {
    store,
    config: {},
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text),
    sendUserMessage: (piArg, text) => piArg.sendUserMessage(text)
  });
  await commands.get("mission")!.handler("Refactor pagination", makeCtx(cwd));
  const ctx = makeCtx(cwd);
  await commands.get("playbook")!.handler("", ctx);
  const text = ctx._notifications[0].text;
  assert.match(text, /playbook:/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/mission-save persists nothing by default without autoSaveLearning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-save-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  const config: CheaterConfig = { autoSaveLearning: false };
  registerMissionCommands(pi, {
    store,
    config,
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text)
  });
  const mission = store.create({ userGoal: "fix x", missionType: "bug_fix", repoRoot: cwd });
  store.setStatus(mission.id, "complete", "done");
  const ctx = makeCtx(cwd);
  await commands.get("mission-save")!.handler("", ctx);
  rmSync(cwd, { recursive: true, force: true });
});

test("/delta-bench reports empty when no entries exist", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-smoke-bench-"));
  const { pi, commands } = makePi();
  const store = defaultMissionStore({ cwd });
  registerMissionCommands(pi, {
    store,
    config: {},
    getCwd: (ctx) => ctx.cwd,
    saveProjectMemory: (cwd, text) => saveMemory(cwd, text)
  });
  const ctx = makeCtx(cwd);
  await commands.get("delta-bench")!.handler("", ctx);
  assert.match(ctx._notifications[0].text, /no delta-bench/i);
  rmSync(cwd, { recursive: true, force: true });
});
