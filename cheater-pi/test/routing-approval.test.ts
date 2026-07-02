import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cheaterExtension, { CHEATER_TOOL_MODES } from "../src/extension.js";
import { classifyAutopilotTask, HIGH_RISK_INTENT } from "../src/autopilot/classifier.js";
import { routeAutopilot } from "../src/autopilot/router.js";
import { defaultAutopilotState } from "../src/autopilot/status.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";

// Regression suite for a live incident: a from-scratch app-build spec was misrouted as a
// high-risk bug fix ("delete tasks" + "tag as bug" in the FEATURE LIST tripped the risk and
// bug_fix patterns), the harness demanded approval, and then the user's "proceed" was
// re-classified as answer_only - which masked cheater_reliability_start out of the model's
// tool schema entirely. The model, narrating "launching the planner now", could only emit
// bug_memory_search over and over. These tests pin every link of that chain.

const FOUNDER_OS_SPEC = [
  "Create a complete local-first web app from scratch.",
  "App name: FounderOS",
  "Use Vite + React + TypeScript. No backend, no external API keys.",
  "Task/roadmap board: create/edit/delete tasks, priority and owner fields.",
  "Customer feedback inbox: tag as bug, feature, praise, churn-risk.",
  "Add at least a small test setup or validation script if practical.",
  "If build fails, fix it. Do not claim done until the app builds successfully."
].join("\n");

test("a from-scratch creation spec classifies as feature work, not a bug fix", () => {
  const result = classifyAutopilotTask({ message: FOUNDER_OS_SPEC, cwd: process.cwd() });
  assert.equal(result.taskKind, "feature_addition");
  assert.notEqual(result.risk, "high", "feature-list words like 'delete tasks' must not make the spec high-risk");
});

test("the spec routes to a code-changing mode with no approval block", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: FOUNDER_OS_SPEC });
  assert.notEqual(decision.executionMode, "answer_only");
  assert.notEqual(decision.executionMode, "mission_control", "an app build is not a bug hunt");
  assert.notEqual(decision.executionDiscipline, "blocked_needs_user");
});

test("high-risk intent still blocks: destructive verbs aimed at repo/file/data objects", () => {
  assert.equal(HIGH_RISK_INTENT.test("delete all files in src and start over"), true);
  assert.equal(HIGH_RISK_INTENT.test("remove the database table for users"), true);
  assert.equal(HIGH_RISK_INTENT.test("bump the dependency to react 19 and update the lockfile"), true);
  assert.equal(HIGH_RISK_INTENT.test("create/edit/delete tasks with priority fields"), false);
  assert.equal(HIGH_RISK_INTENT.test("tag as bug, feature, praise, churn-risk"), false);
  assert.equal(HIGH_RISK_INTENT.test("users can delete their own comments"), false);
});

test("autonomy by default: even a destructive request does NOT block for approval", () => {
  const destructive = "delete all files in the legacy folder and rebuild the module";
  const autonomous = routeAutopilot({ cwd: process.cwd(), message: destructive });
  assert.notEqual(autonomous.executionDiscipline, "blocked_needs_user", "default is one-prompt autonomy, no approval gate");
});

test("opt-in approval: requireApproval blocks destructive intent, and userApprovedHighRisk clears it", () => {
  const destructive = "delete all files in the legacy folder and rebuild the module";
  const blocked = routeAutopilot({ cwd: process.cwd(), message: destructive, requireApproval: true });
  assert.equal(blocked.executionDiscipline, "blocked_needs_user");
  const approved = routeAutopilot({ cwd: process.cwd(), message: destructive, requireApproval: true, repoHints: { userApprovedHighRisk: true } });
  assert.notEqual(approved.executionDiscipline, "blocked_needs_user");
});

test("answer_only mask keeps cheater_reliability_start visible - a misroute can never lock out the flow", () => {
  assert.ok(CHEATER_TOOL_MODES.answer_only.includes("cheater_reliability_start"));
});

// --- full wiring: blocked request, then "proceed" ------------------------------------------

function makePi() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const activeTools: string[] = [];
  const pi = {
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerTool(def: any) { tools.set(def.name, def); },
    on(name: string, handler: any) { events.set(name, handler); },
    sendUserMessage() {},
    sendMessage() {},
    getAllTools() { return [...tools.values()]; },
    getCommands() { return [...commands.keys()].map((name) => ({ name })); },
    getActiveTools() { return activeTools.length ? [...activeTools] : [...tools.keys(), "read", "edit", "bash"]; },
    setActiveTools(names: string[]) { activeTools.splice(0, activeTools.length, ...names); }
  };
  return { pi, events, activeTools };
}

function fakeCtx(cwd: string) {
  return {
    cwd,
    ui: { notify() {}, setTitle() {}, setStatus() {}, setWidget() {} },
    hasPendingMessages: () => false
  };
}

test("live wiring: autonomy by default - a scary-sounding request runs the flow without any approval stop", async () => {
  const { pi, events, activeTools } = makePi();
  defaultAutopilotState.clear();
  defaultCommitletState.clear();
  liveSessionState.reset();
  cheaterExtension(pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "cheater-autonomy-"));
  const input = events.get("input");
  assert.ok(input, "input handler registered");

  // A destructive-sounding request must NOT stop for approval under the default config; it
  // goes straight into the flow. This is the whole "one prompt until done" contract.
  const destructive = "delete all files in the legacy folder and rebuild the module from scratch";
  const decision = await input({ type: "input", text: destructive, source: "interactive" }, fakeCtx(cwd));
  assert.equal(decision.action, "transform");
  assert.doesNotMatch(decision.text, /ask the user for explicit approval/, "no approval gate by default");
  assert.doesNotMatch(decision.text, /Stop before editing/);
  assert.match(decision.text, /cheater_reliability_start/, "the model is told to start the flow immediately");
  assert.ok(activeTools.includes("cheater_reliability_start"), "planner tool is always in the model's schema");
  defaultAutopilotState.clear();
  defaultCommitletState.clear();
});

test("live wiring: a bare ack after a normal code decision re-issues that decision instead of re-classifying", async () => {
  const { pi, events, activeTools } = makePi();
  defaultAutopilotState.clear();
  defaultCommitletState.clear();
  liveSessionState.reset();
  cheaterExtension(pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "cheater-ack-"));
  const input = events.get("input");

  const first = await input({ type: "input", text: FOUNDER_OS_SPEC, source: "interactive" }, fakeCtx(cwd));
  assert.equal(first.action, "transform");
  assert.match(first.text, /cheater_reliability_start/);

  // The model asked a clarifying question; the user answers with a bare go-ahead.
  const second = await input({ type: "input", text: "yes", source: "interactive" }, fakeCtx(cwd));
  assert.equal(second.action, "transform");
  assert.match(second.text, /confirmed the previous request/);
  assert.match(second.text, /FounderOS/, "the original goal context must be restated");
  assert.match(second.text, /cheater_reliability_start/);
  assert.ok(activeTools.includes("cheater_reliability_start"));
  defaultAutopilotState.clear();
  defaultCommitletState.clear();
});
