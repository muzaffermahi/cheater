import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cheaterExtension from "../src/extension.js";
import { defaultBlueprintState } from "../src/blueprint/state.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { noteWorkerBackend, resetWorkerBackendLatch } from "../src/blueprint/worker.js";
import type { BlueprintPlan } from "../src/blueprint/types.js";

function makePi() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: string[] = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const pi = {
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerTool(def: any) { tools.set(def.name, def); },
    on(name: string, handler: any) { events.set(name, handler); },
    sendUserMessage(text: string) { messages.push(text); },
    sendMessage(message: any, options?: any) { customMessages.push({ message, options }); },
    getAllTools() { return [...tools.values()]; },
    getCommands() { return [...commands.keys()].map((name) => ({ name })); }
  };
  return { pi, commands, tools, events, messages, customMessages };
}

function ctx() {
  const widgets = new Map<string, unknown>();
  return {
    cwd: mkdtempSync(join(tmpdir(), "cheater-extension-")),
    model: { id: "test" },
    ui: {
      notify() {},
      setTitle() {},
      setStatus() {},
      setWidget(key: string, value: unknown) { widgets.set(key, value); }
    },
    hasPendingMessages: () => false,
    widgets
  };
}

test("extension registers exactly the one-flow surface: every registered cheater tool is mask-visible", () => {
  const { pi, commands, tools, events } = makePi();
  cheaterExtension(pi);
  assert.ok(commands.has("autopilot-status"));
  assert.ok(commands.has("blueprint-show"));
  assert.ok(commands.has("commitlet-status"));
  assert.ok(commands.has("rollback-status"));
  assert.ok(commands.has("constraint-graph"));
  assert.ok(commands.has("bench-report"));
  assert.ok(tools.has("cheater_line_edit"));
  assert.ok(tools.has("cheater_reliability_start"));
  assert.ok(tools.has("cheater_commitlet_next"));
  assert.ok(tools.has("cheater_finish_gate"));
  assert.ok(tools.has("cheater_verification_run"));
  assert.ok(tools.has("cheater_ledger_status"));
  assert.ok(tools.has("cheater_rollback_status"));
  // The purge: subsystems and tools the model could never see (not in any mask) are GONE,
  // not merely hidden - if masking ever no-ops, there is nothing confusing to expose.
  for (const dead of [
    "cheater_blueprint_create", "cheater_blueprint_next_packet", "cheater_blueprint_approve",
    "cheater_blueprint_quality_repair", "cheater_blueprint_complete_packet", "cheater_blueprint_docs",
    "cheater_mission_start", "cheater_bug_worker", "cheater_focus_test", "cheater_diff_safety_check",
    "cheater_health_report", "cheater_constraint_graph", "cheater_bench_report", "cheater_delta_bench",
    "cheater_autopilot_route", "cheater_commitlet_plan", "cheater_commitlet_guard",
    "cheater_commitlet_verify", "cheater_commitlet_finalize"
  ]) {
    assert.equal(tools.has(dead), false, `${dead} must not be registered - dead model surface`);
  }
  assert.ok(events.has("before_agent_start"));
  assert.ok(events.has("input"));
  assert.ok(events.has("tool_call"));
  assert.ok(events.has("tool_result"));
  assert.ok(events.has("agent_end"));
  assert.equal(events.has("before_user_message"), false, "Pi has no before_user_message event; routing hangs off input");
});

test("doctor separates public commands from debug-only internals and nothing is uncategorized", async () => {
  const { pi, commands } = makePi();
  cheaterExtension(pi);
  let notice = "";
  const context = {
    ...ctx(),
    mode: "agent",
    isProjectTrusted: () => true,
    ui: {
      notify(text: string) { notice = text; },
      setTitle() {},
      setStatus() {},
      setWidget() {}
    }
  };

  await commands.get("doctor").handler("", context);

  assert.match(notice, /Public commands loaded:/);
  assert.match(notice, /Debug commands loaded:/);
  assert.doesNotMatch(notice, /Cheater commands loaded:/);
  for (const name of ["commitlet-status", "rollback-status", "constraint-graph", "bench-report", "model-profile"]) {
    assert.match(notice, new RegExp(name), `${name} must appear in /doctor's public command list`);
  }
  assert.doesNotMatch(notice, /Uncategorized commands loaded/, "every registered Cheater command must be categorized");
});

test("cheater_line_edit applies bounded line edits and refuses stale context", async () => {
  const { pi, tools } = makePi();
  cheaterExtension(pi);
  const context = ctx();
  const file = join(context.cwd, "turtles.html");
  writeFileSync(file, "<h1>Old</h1>\n<p>Keep me</p>\n<footer>Old footer</footer>\n");

  const ok = await tools.get("cheater_line_edit").execute(
    "edit-1",
    { path: "turtles.html", startLine: 1, endLine: 1, expectedText: "Old", replacement: "<h1>Modern turtles</h1>" },
    undefined,
    undefined,
    context
  );
  assert.match(ok.content[0].text, /line edit applied/);
  assert.equal(readFileSync(file, "utf8"), "<h1>Modern turtles</h1>\n<p>Keep me</p>\n<footer>Old footer</footer>\n");

  const stale = await tools.get("cheater_line_edit").execute(
    "edit-2",
    { path: "turtles.html", startLine: 2, endLine: 2, expectedText: "missing", replacement: "<p>Changed</p>" },
    undefined,
    undefined,
    context
  );
  assert.match(stale.content[0].text, /expectedText was not found/);
  assert.match(readFileSync(file, "utf8"), /Keep me/);
});

test("planner file-tool block fires only when real fresh workers can actually spawn", async () => {
  const { pi, events } = makePi();
  defaultBlueprintState.clear();
  cheaterExtension(pi);
  const context = ctx();
  // A minimal active blueprint plan (the block only inspects workPackets statuses).
  defaultBlueprintState.setPlan({
    id: "bp-test",
    workPackets: [{ id: "p1", status: "pending" }]
  } as unknown as BlueprintPlan);

  // Local backend that cannot spawn sub-sessions: the main session IS the worker, so its
  // file tools must NOT be blocked (blocking them would deadlock every complex task).
  resetWorkerBackendLatch();
  const notBlocked = await events.get("tool_call")({ type: "tool_call", toolCallId: "read-0", toolName: "read", input: { path: "templates/about.html" } }, context);
  assert.notEqual(notBlocked?.block, true, "no verified worker backend means the main session must be allowed to edit");

  // Verified worker backend: planner/worker isolation is real and enforced.
  noteWorkerBackend(true);
  const blocked = await events.get("tool_call")({ type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "templates/about.html" } }, context);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /fresh worker/);
  resetWorkerBackendLatch();
  defaultBlueprintState.clear();
});

test("normal interactive input triggers router lifecycle hook via the real Pi input event", async () => {
  const { pi, events } = makePi();
  defaultBlueprintState.clear();
  cheaterExtension(pi);
  const result = await events.get("input")({ type: "input", text: "add a /hello command with tests and docs", source: "interactive" }, ctx());
  assert.equal(result.action, "transform");
  // Header diet: model sees the goal first, then imperative directives only - routing
  // telemetry (mode/discipline/confidence) lives in the TUI widget, not the model message.
  assert.match(result.text, /User request: add a \/hello command/);
  // Lean preamble (default): a tight pointer that still names the entry tool and the drive sequence
  // (the authoritative step-by-step flow lives once in the system prompt, not re-sent every turn).
  assert.match(result.text, /cheater_run ONCE/);
  assert.match(result.text, /cheater_reliability_start/);
  assert.match(result.text, /cheater_commitlet_next/);
  assert.match(result.text, /cheater_finish_gate/);
  // The instruction no longer claims "planner only, do not edit" - that deadlocked complex
  // tasks on local backends that cannot spawn sub-sessions (the model IS the worker there).
  assert.doesNotMatch(result.text, /planner only/i);
  assert.doesNotMatch(result.text, /confidence:|executionDiscipline/);
});

test("extension-sourced input (e.g. finish-gate nudge) is not re-routed through autopilot", async () => {
  const { pi, events } = makePi();
  cheaterExtension(pi);
  const result = await events.get("input")({ type: "input", text: "Cheater Finish Gate: ...", source: "extension" }, ctx());
  assert.deepEqual(result, { action: "continue" });
});

test("/blueprint-show is inspection only and no manual slash command is required", async () => {
  const { pi, commands } = makePi();
  cheaterExtension(pi);
  const context = ctx();
  await commands.get("blueprint-show").handler("", context);
  assert.ok(context.widgets.has("cheater-blueprint"));
});

test("loop-governor terminal verdict never locks out reads, and never hard-blocks an in-session build", async () => {
  const { pi, events } = makePi();
  defaultBlueprintState.clear();
  cheaterExtension(pi);
  const toolCall = events.get("tool_call");
  assert.ok(toolCall, "tool_call handler registered");

  // An active in-session scaffold build: the model IS the driver, so a terminal loop/identical-call
  // verdict must be DOWNGRADED to a warning, never a hard block (the reported deadlock).
  defaultCommitletState.setPlan({
    id: "p", createdAt: new Date().toISOString(), repoRoot: ".", userGoal: "build", summary: "s",
    commitlets: [{ id: "c1-scaffold-config", status: "running", scope: "scaffold", allowedFiles: ["src/App.tsx"] }],
    currentIndex: 0, status: "running", globalConstraints: [], finalVerification: [],
    finalReview: { accepted: false, summary: "", commitlets: [], finalVerification: [], health: { score: 0, passed: false, warnings: [], blockingIssues: [], metrics: { diffLines: 0, filesTouched: 0, duplicationDelta: 0, complexityDelta: 0, largeFunctionDelta: 0, assertionDelta: 0 } }, blockingIssues: [], warnings: [], suggestedFollowups: [] },
    risk: "low", buildMode: "scaffold"
  } as any);
  liveSessionState.reset("build");

  // Hammer byte-identical writes to drive the detectors terminal.
  let writeResult: any = {};
  for (let i = 0; i < 9; i += 1) {
    writeResult = await events.get("tool_call")({ toolName: "write", toolCallId: `w${i}`, input: { path: "src/App.tsx", content: "SAME" } }, ctx());
  }
  assert.ok(!writeResult?.block, "an in-session build is warned in-band, never hard-locked, on a loop verdict");

  // A read is NEVER blocked - it is the escape hatch the model needs to diagnose and break the loop.
  const readResult: any = await events.get("tool_call")({ toolName: "read", toolCallId: "r1", input: { path: "src/App.tsx" } }, ctx());
  assert.ok(!readResult?.block, "read-only tools are never blocked by the loop governor");
  defaultCommitletState.clear();
});

test("read-repeat loop warnings are suppressed during an in-session build, but still delivered otherwise", async () => {
  const { pi, events } = makePi();
  defaultBlueprintState.clear();
  cheaterExtension(pi);
  const toolCall = events.get("tool_call");
  const toolResult = events.get("tool_result");

  const hammerReads = async (): Promise<string[]> => {
    liveSessionState.reset("x");
    const texts: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = `rd${i}`;
      await toolCall({ toolName: "read", toolCallId: id, input: { path: "src/App.tsx" } }, ctx());
      const res: any = await toolResult({ toolName: "read", toolCallId: id, input: { path: "src/App.tsx" }, content: [{ type: "text", text: "contents" }] }, ctx());
      texts.push((res?.content ?? []).map((c: any) => c.text ?? "").join(" "));
    }
    return texts;
  };

  // In-session build active -> re-reading a file to fix build errors is normal, so the noise is gone.
  defaultCommitletState.setPlan({
    id: "p", createdAt: new Date().toISOString(), repoRoot: ".", userGoal: "build", summary: "s",
    commitlets: [{ id: "c1-scaffold-config", status: "running", scope: "scaffold", allowedFiles: ["src/App.tsx"] }],
    currentIndex: 0, status: "running", globalConstraints: [], finalVerification: [],
    finalReview: { accepted: false, summary: "", commitlets: [], finalVerification: [], health: { score: 0, passed: false, warnings: [], blockingIssues: [], metrics: { diffLines: 0, filesTouched: 0, duplicationDelta: 0, complexityDelta: 0, largeFunctionDelta: 0, assertionDelta: 0 } }, blockingIssues: [], warnings: [], suggestedFollowups: [] },
    risk: "low", buildMode: "scaffold"
  } as any);
  const withBuild = await hammerReads();
  assert.equal(withBuild.filter((t) => /same file read too often/.test(t)).length, 0, "read-loop noise is suppressed during an in-session build");

  // No active build -> the warning still surfaces (the suppression is conditional, not a blanket mute).
  defaultCommitletState.clear();
  const withoutBuild = await hammerReads();
  assert.ok(withoutBuild.some((t) => /same file read too often/.test(t)), "outside a build the read-loop warning still surfaces");
  defaultCommitletState.clear();
});
