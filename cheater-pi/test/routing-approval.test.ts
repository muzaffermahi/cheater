import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cheaterExtension, { CHEATER_TOOL_MODES, cheaterToolsForMode } from "../src/extension.js";
import { classifyAutopilotTask, HIGH_RISK_INTENT, elevatesToHighRisk } from "../src/autopilot/classifier.js";
import { routeAutopilot, buildAutopilotInstruction } from "../src/autopilot/router.js";
import { buildSystemPrompt } from "../src/prompts.js";
import { registerCheaterTools } from "../src/tools.js";
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
  assert.notEqual(decision.executionMode, "careful_repro", "an app build is not a bug hunt");
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

test("a feature that DELETES end-user data is not the same as destroying the repo (no approval block)", () => {
  // These describe app behavior to BUILD; the destructive verb is the feature, not a command
  // aimed at the working repo. Under opt-in approval they must NOT hard-lock asking permission.
  for (const message of [
    "add a feature to permanently delete all archived files older than 30 days",
    "build a UI to delete files from the uploads folder",
    "add a 'wipe everything' button that clears all data",
    "let users delete all their files at once",
    "add a button to purge the cache directory"
  ]) {
    assert.equal(elevatesToHighRisk(message.toLowerCase()), false, message);
    const decision = routeAutopilot({ cwd: process.cwd(), message, requireApproval: true });
    assert.notEqual(decision.executionDiscipline, "blocked_needs_user", message);
  }
});

test("a genuine destructive action on THIS repo still blocks under opt-in approval", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "delete all files in the temp folder and start fresh", requireApproval: true });
  assert.equal(elevatesToHighRisk("delete all files in the temp folder and start fresh"), true);
  assert.equal(decision.executionDiscipline, "blocked_needs_user");
});

test("standalone 'tag as bug' is a labeling feature, not a bug fix", () => {
  const tagging = classifyAutopilotTask({ message: "tag incoming feedback items as bug, feature, or praise", cwd: process.cwd() });
  assert.equal(tagging.taskKind, "feature_addition", "product-vocabulary 'bug' in a label list must not route as bug_fix");
  // A real defect report still classifies as a bug fix.
  assert.equal(classifyAutopilotTask({ message: "there is a bug in the parser", cwd: process.cwd() }).taskKind, "bug_fix");
  assert.equal(classifyAutopilotTask({ message: "fix the bug, then add tests", cwd: process.cwd() }).taskKind, "bug_fix");
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

// --- prefill economy: lean preamble + prefix stability -------------------------------------------

test("lean autopilot preamble is a tight pointer (not the full flow block), keeping per-turn prefill small", () => {
  const decision = routeAutopilot({ cwd: process.cwd(), message: "add a /hello command with tests" });
  const full = buildAutopilotInstruction(decision, "", false);
  const lean = buildAutopilotInstruction(decision, "", true);
  assert.match(full, /Cheater flow/, "the full form carries the explicit 5-line flow block");
  assert.doesNotMatch(lean, /Cheater flow/, "the lean form drops the verbose block (the flow lives in the system prompt)");
  assert.match(lean, /cheater_run ONCE/, "lean still names the entry tool");
  assert.match(lean, /cheater_finish_gate/, "lean still names the completion gate");
  assert.ok(lean.length < full.length, "lean is materially shorter than the full block");
  // A plain question already reduces to one short line - identical lean or full.
  const q = routeAutopilot({ cwd: process.cwd(), message: "what is a closure?" });
  assert.equal(buildAutopilotInstruction(q, "", true), buildAutopilotInstruction(q, "", false));
});

test("stable tool surface: after a code task, a follow-up question keeps the code tools visible (KV-cache prefix stability)", async () => {
  const { pi, events, activeTools } = makePi();
  defaultAutopilotState.clear();
  defaultCommitletState.clear();
  liveSessionState.reset();
  cheaterExtension(pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "cheater-stable-surface-"));
  const input = events.get("input");

  await input({ type: "input", text: "add a /hello command with tests", source: "interactive" }, fakeCtx(cwd));
  assert.ok(activeTools.includes("cheater_commitlet_next"), "a code task exposes the execute/planner surface");

  // A follow-up question routes answer_only (which would drop commitlet_next). With stablePromptPrefix
  // default-on, the tool surface stays put so the local KV-cache prompt prefix is not invalidated; the
  // answer_only INSTRUCTION still routes the model to just answer.
  const q = await input({ type: "input", text: "what does that command print?", source: "interactive" }, fakeCtx(cwd));
  assert.match(q.text, /genuinely a question, answer it directly/, "the instruction still routes the model to just answer a real question");
  assert.ok(activeTools.includes("cheater_commitlet_next"), "the code tool surface stays stable across the follow-up question");
  defaultAutopilotState.clear();
  defaultCommitletState.clear();
});

test("finding #7: a 'write/generate me a file' task routes ACTIONABLE, not answer_only", () => {
  // These used to classify unknown->answer_only, and the model was told "this is a question, do not
  // edit files" - so it answered in chat and produced nothing. "write"/"save"/"generate" now count.
  for (const message of [
    "I have a decompressor in /app/decomp.c. Write me data.comp that decompresses to data.txt.",
    "Write a regex that matches dates. Save your regex in /app/regex.txt.",
    "Generate a self-signed certificate and save it to /app/ssl/server.crt.",
    "Compute the token count and write the integer to /app/answer.txt."
  ]) {
    const decision = routeAutopilot({ cwd: process.cwd(), message });
    assert.notEqual(decision.executionMode, "answer_only", `"${message.slice(0, 45)}..." must not route answer_only`);
  }
});

test("finding #7: a genuine question still routes answer_only (no false-execute from print/output/compute)", () => {
  for (const message of [
    "What does that command print?",
    "How does the caching layer work?",
    "Explain the authentication flow.",
    "What is the output of this function?"
  ]) {
    const decision = routeAutopilot({ cwd: process.cwd(), message });
    assert.equal(decision.executionMode, "answer_only", `"${message}" should stay answer_only`);
  }
});

test("finding #7: the softened answer_only preamble no longer flatly forbids editing", () => {
  const instr = buildAutopilotInstruction({ executionMode: "answer_only" } as never, "");
  assert.doesNotMatch(instr, /Do not edit files/i);
  assert.match(instr, /perform it NOW with your tools/i);
});

test("stable system-prompt prefix: the volatile git status trails the stable content (cache-friendly ordering)", async () => {
  const { pi, events } = makePi();
  cheaterExtension(pi as any);
  const before = events.get("before_agent_start");
  assert.ok(before, "before_agent_start handler registered");
  const result = await before({ systemPrompt: "PI-BASE-SYSTEM" }, fakeCtx(process.cwd()));
  const text: string = result.systemPrompt;
  assert.match(text, /## Environment/, "the stable environment block is present");
  assert.match(text, /git:/, "git status is still shown to the model");
  assert.match(text, /room to work/, "the context-cap line is present");
  // Ordering: stable env + cap come first, the volatile git line LAST, so the long prefix stays cacheable.
  assert.ok(text.indexOf("## Environment") < text.indexOf("git:"), "stable env precedes the git line");
  assert.ok(text.indexOf("room to work") < text.indexOf("git:"), "the git line trails the stable cap line");
});

// --- minimal system prompt + bug memory off by default -------------------------------------------

test("minimal system prompt is the default: the one flow, but no worked example and no bug-memory section", () => {
  const def = buildSystemPrompt({});
  assert.match(def, /The one Cheater flow/, "the flow is always present");
  assert.doesNotMatch(def, /Worked example/, "the exemplar is dropped by default (minimal)");
  assert.doesNotMatch(def, /Bug-memory/, "no bug-memory guidance is shown by default");
  // Both are restorable via config for later A/B testing.
  assert.match(buildSystemPrompt({ minimalSystemPrompt: false }), /Worked example/, "the exemplar returns when minimal is off");
  assert.match(buildSystemPrompt({ bugMemoryEnabled: true }), /Bug-memory/, "the bug-memory section returns when enabled");
});

test("bug-memory tool is hidden by default: not registered and filtered from every mask", () => {
  const off = new Map<string, any>();
  registerCheaterTools({ registerTool: (def: any) => off.set(def.name, def) } as any, {});
  assert.equal(off.has("cheater_bug_memory_search"), false, "not registered by default");
  const on = new Map<string, any>();
  registerCheaterTools({ registerTool: (def: any) => on.set(def.name, def) } as any, { bugMemoryEnabled: true });
  assert.equal(on.has("cheater_bug_memory_search"), true, "registered when the feature is enabled");
  // The mask filter matches the registration gate, so applyToolMask never activates a missing tool.
  assert.equal(cheaterToolsForMode("execute", {}).includes("cheater_bug_memory_search"), false, "filtered from the mask by default");
  assert.equal(cheaterToolsForMode("execute", { bugMemoryEnabled: true }).includes("cheater_bug_memory_search"), true, "in the mask when enabled");
});
