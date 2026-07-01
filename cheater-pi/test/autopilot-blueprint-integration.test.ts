import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cheaterExtension from "../src/extension.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { registerBlueprintTools } from "../src/blueprint/tools.js";
import { defaultBlueprintState } from "../src/blueprint/state.js";
import { registerMissionTools } from "../src/mission/tools.js";
import { inMemoryMissionStore } from "../src/mission/store.js";

function makePi() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: string[] = [];
  const pi = {
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerTool(def: any) { tools.set(def.name, def); },
    on(name: string, handler: any) { events.set(name, handler); },
    sendUserMessage(text: string) { messages.push(text); },
    getAllTools() { return [...tools.values()]; },
    getCommands() { return [...commands.keys()].map((name) => ({ name })); }
  };
  return { pi, commands, tools, events, messages };
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
    widgets
  };
}

test("extension registers autopilot and blueprint commands/tools", () => {
  const { pi, commands, tools, events } = makePi();
  cheaterExtension(pi);
  assert.ok(commands.has("autopilot-status"));
  assert.ok(commands.has("blueprint-show"));
  assert.ok(commands.has("blueprint-candidates"));
  assert.ok(commands.has("blueprint-approve"));
  assert.ok(commands.has("blueprint-quality-repair"));
  assert.ok(commands.has("commitlet-status"));
  assert.ok(commands.has("rollback-status"));
  assert.ok(commands.has("health-report"));
  assert.ok(commands.has("constraint-graph"));
  assert.ok(commands.has("bench-report"));
  assert.ok(tools.has("cheater_autopilot_route"));
  assert.ok(tools.has("cheater_blueprint_create"));
  assert.ok(tools.has("cheater_blueprint_approve"));
  assert.ok(tools.has("cheater_blueprint_next_packet"));
  assert.ok(tools.has("cheater_blueprint_quality_repair"));
  assert.ok(tools.has("cheater_blueprint_complete_packet"));
  assert.ok(tools.has("cheater_line_edit"));
  assert.ok(tools.has("cheater_reliability_start"));
  assert.ok(tools.has("cheater_bug_worker"));
  assert.ok(tools.has("cheater_commitlet_plan"));
  assert.ok(tools.has("cheater_commitlet_verify"));
  assert.ok(tools.has("cheater_rollback_status"));
  assert.ok(tools.has("cheater_health_report"));
  assert.ok(tools.has("cheater_constraint_graph"));
  assert.ok(tools.has("cheater_bench_report"));
  assert.ok(events.has("before_agent_start"));
  assert.ok(events.has("before_user_message"));
});

test("doctor separates public commands from debug-only internals", async () => {
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
  assert.match(notice, /\/?blueprint-step|blueprint-step/);
  assert.doesNotMatch(notice, /Cheater commands loaded:/);
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

test("blueprint next packet advances past completed inspect packet", async () => {
  const { pi, tools } = makePi();
  defaultBlueprintState.clear();
  const dispatched: string[] = [];
  registerBlueprintTools(pi, {
    config: { ...DEFAULT_CONFIG, blueprintFreshAgentPerPacket: true },
    packetRunner: {
      async runPacket({ packet }) {
        dispatched.push(packet.id);
        return { ok: true, summary: `${packet.id} completed by fake worker`, sessionId: `worker-${packet.id}` };
      }
    }
  });
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "add a /hello command with tests and docs", taskType: "tooling" },
    undefined,
    undefined,
    context
  );
  const first = await tools.get("cheater_blueprint_next_packet").execute("next-1", {}, undefined, undefined, context);
  assert.match(first.content[0].text, /Spawned fresh worker session for packet inspect/);
  const second = await tools.get("cheater_blueprint_next_packet").execute(
    "next-2",
    {},
    undefined,
    undefined,
    context
  );
  assert.doesNotMatch(second.content[0].text, /packet inspect/);
  assert.match(second.content[0].text, /packet implement-/);
  assert.equal(dispatched[0], "inspect");
  assert.match(dispatched[1], /^implement-/);
});

test("blueprint quality repair tool returns planner-only repair draft", async () => {
  const { pi, tools } = makePi();
  defaultBlueprintState.clear();
  registerBlueprintTools(pi, { config: DEFAULT_CONFIG });
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "migrate to latest React API and search the web", taskType: "migration" },
    undefined,
    undefined,
    context
  );
  const plan = defaultBlueprintState.get().currentPlan!;
  defaultBlueprintState.setPlan({
    ...plan,
    qualityGate: {
      ...plan.qualityGate,
      passed: false,
      blockingIssues: ["external evidence is required but no remote docs or web evidence was gathered"],
      remediationActions: ["Attach official docs or ranked web evidence for the external API/version before dispatch."]
    }
  });
  const result = await tools.get("cheater_blueprint_quality_repair").execute("repair", {}, undefined, undefined, context);
  assert.match(result.content[0].text, /planner-only repair draft/);
  assert.equal(result.details.mustRegeneratePlan, true);
  assert.ok(result.details.plannerInstructions.some((item: string) => /Regenerate the Blueprint plan/.test(item)));
});

test("blueprint next packet runs final review automatically when packets are done", async () => {
  const { pi, tools } = makePi();
  defaultBlueprintState.clear();
  registerBlueprintTools(pi, {
    config: { ...DEFAULT_CONFIG, blueprintFreshAgentPerPacket: true },
    packetRunner: {
      async runPacket({ packet }) {
        return { ok: true, summary: `${packet.id} completed`, sessionId: `worker-${packet.id}` };
      }
    }
  });
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "add a /hello command with tests and docs", taskType: "tooling" },
    undefined,
    undefined,
    context
  );
  let result: any;
  for (let i = 0; i < 12; i += 1) {
    result = await tools.get("cheater_blueprint_next_packet").execute(`next-${i}`, {}, undefined, undefined, context);
    if (result.details?.autoFinalReview) break;
  }
  assert.equal(result.details.autoFinalReview, true);
  assert.match(result.content[0].text, /final review/i);
});

test("blueprint next packet refuses unapproved plans until approval is recorded", async () => {
  const { pi, tools } = makePi();
  defaultBlueprintState.clear();
  const dispatched: string[] = [];
  registerBlueprintTools(pi, {
    config: { ...DEFAULT_CONFIG, blueprintFreshAgentPerPacket: true, blueprintRequireApproval: "always" },
    packetRunner: {
      async runPacket({ packet }) {
        dispatched.push(packet.id);
        return { ok: true, summary: `${packet.id} completed`, sessionId: `worker-${packet.id}` };
      }
    }
  });
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "delete dependencies and rewrite routing", taskType: "refactor" },
    undefined,
    undefined,
    context
  );
  const blocked = await tools.get("cheater_blueprint_next_packet").execute("next-blocked", {}, undefined, undefined, context);
  assert.match(blocked.content[0].text, /requires explicit user approval/);
  assert.deepEqual(dispatched, []);
  const approved = await tools.get("cheater_blueprint_approve").execute("approve", { note: "user said yes" }, undefined, undefined, context);
  assert.match(approved.content[0].text, /approved/);
  const next = await tools.get("cheater_blueprint_next_packet").execute("next-approved", {}, undefined, undefined, context);
  assert.match(next.content[0].text, /Spawned fresh worker session/);
  assert.deepEqual(dispatched, ["inspect"]);
});

test("blueprint next packet does not silently complete an already running packet", async () => {
  const { pi, tools } = makePi();
  defaultBlueprintState.clear();
  registerBlueprintTools(pi, {
    config: { ...DEFAULT_CONFIG, blueprintFreshAgentPerPacket: false },
    packetRunner: {
      async runPacket({ packet }) {
        return { ok: true, summary: `${packet.id} completed`, sessionId: `worker-${packet.id}` };
      }
    }
  });
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "add a /hello command with tests and docs", taskType: "tooling" },
    undefined,
    undefined,
    context
  );
  const plan = defaultBlueprintState.get().currentPlan;
  assert.ok(plan);
  const firstPacket = plan!.workPackets.find((packet) => packet.status === "pending");
  assert.ok(firstPacket);
  defaultBlueprintState.updatePacket(firstPacket!.id, "running");
  const second = await tools.get("cheater_blueprint_next_packet").execute("next-2", {}, undefined, undefined, context);
  assert.match(second.content[0].text, /already running/);
  assert.equal(defaultBlueprintState.get().currentPlan?.workPackets.find((packet) => packet.id === firstPacket!.id)?.status, "running");
  const pending = defaultBlueprintState.get().currentPlan?.workPackets.find((packet) => packet.status === "pending");
  assert.ok(pending);
  const badComplete = await tools.get("cheater_blueprint_next_packet").execute("next-bad-complete", { completedPacketId: pending!.id, summary: "skip ahead" }, undefined, undefined, context);
  assert.match(badComplete.content[0].text, /only completes the current running packet/);
  assert.equal(defaultBlueprintState.get().currentPlan?.workPackets.find((packet) => packet.id === pending!.id)?.status, "pending");
});

test("blueprint next packet stops after cancelled or failed state", async () => {
  const { pi, tools } = makePi();
  defaultBlueprintState.clear();
  registerBlueprintTools(pi, {
    config: { ...DEFAULT_CONFIG, blueprintFreshAgentPerPacket: true },
    packetRunner: {
      async runPacket({ packet }) {
        return { ok: packet.id !== "inspect", summary: `${packet.id} failed`, error: "boom" };
      }
    }
  });
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "add a /hello command with tests and docs", taskType: "tooling" },
    undefined,
    undefined,
    context
  );
  const failed = await tools.get("cheater_blueprint_next_packet").execute("next-fail", {}, undefined, undefined, context);
  assert.match(failed.content[0].text, /status: failed/);
  const blocked = await tools.get("cheater_blueprint_next_packet").execute("next-after-fail", {}, undefined, undefined, context);
  assert.match(blocked.content[0].text, /failed packets/);
  defaultBlueprintState.cancel();
  const cancelled = await tools.get("cheater_blueprint_next_packet").execute("next-cancelled", {}, undefined, undefined, context);
  assert.match(cancelled.content[0].text, /cancelled/);
});

test("blueprint planner blocks file tools after plan creation", async () => {
  const { pi, tools, events } = makePi();
  cheaterExtension(pi);
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "modernize templates without looping", taskType: "refactor" },
    undefined,
    undefined,
    context
  );
  const result = await events.get("tool_call")({ type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "templates/about.html" } }, context);
  assert.equal(result.block, true);
  assert.match(result.reason, /fresh worker LLM session/);
});

test("blueprint-force avoids same-session packet prompt blasting", async () => {
  const { pi, commands, messages } = makePi();
  cheaterExtension(pi);
  await commands.get("blueprint-force").handler("add a /hello command with tests", ctx());
  assert.equal(messages.length, 1);
  assert.match(messages[0], /cheater_blueprint_next_packet/);
  assert.doesNotMatch(messages[0], /CHEATER FRESH WORKER SESSION/);
});

test("blueprint-step requests fresh worker dispatch instead of same-session prompt", async () => {
  const { pi, commands, tools, messages } = makePi();
  cheaterExtension(pi);
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "add a /hello command with tests", taskType: "tooling" },
    undefined,
    undefined,
    context
  );
  await commands.get("blueprint-step").handler("", context);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /cheater_blueprint_next_packet/);
  assert.doesNotMatch(messages[0], /contextSketch:/);
  assert.doesNotMatch(messages[0], /relevantSnippets:/);
});

test("legacy blueprint prompt execution is disabled even when config asks otherwise", async () => {
  const { pi, tools } = makePi();
  defaultBlueprintState.clear();
  registerBlueprintTools(pi, {
    config: { ...DEFAULT_CONFIG, blueprintFreshAgentPerPacket: false }
  });
  const context = ctx();
  await tools.get("cheater_blueprint_create").execute(
    "create",
    { goal: "add a /hello command with tests", taskType: "tooling" },
    undefined,
    undefined,
    context
  );
  const result = await tools.get("cheater_blueprint_execute_as_pi_prompts").execute("legacy", {}, undefined, undefined, context);
  assert.match(result.content[0].text, /disabled/);
  assert.equal(result.details.alwaysFreshWorkers, true);
});

test("normal user message triggers router lifecycle hook", async () => {
  const { pi, events } = makePi();
  cheaterExtension(pi);
  const result = await events.get("before_user_message")({ message: "add a /hello command with tests and docs" }, ctx());
  assert.match(result.message, /Cheater Autopilot decision/);
  assert.match(result.message, /blueprint_orchestrator/);
  assert.match(result.message, /Planner session only/);
});

test("bug worker tool gathers evidence and dispatches a fresh bug agent", async () => {
  const { pi, tools } = makePi();
  const store = inMemoryMissionStore({ cwd: process.cwd() });
  const dispatched: string[] = [];
  registerMissionTools(pi, {
    store,
    config: { ...DEFAULT_CONFIG, bugFreshAgentEnabled: true },
    bugRunner: {
      async runBug({ query }) {
        dispatched.push(query);
        return { ok: true, summary: "fake bug worker fixed it", sessionId: "bug-worker-1" };
      }
    }
  });
  const context = ctx();
  store.create({ userGoal: "fix TypeError", missionType: "bug_fix", repoRoot: context.cwd });
  const result = await tools.get("cheater_bug_worker").execute(
    "bug-1",
    { query: "TypeError: cannot read property x", focusedCommand: "node -e \"process.exit(0)\"" },
    undefined,
    undefined,
    context
  );
  assert.match(result.content[0].text, /Spawned fresh bug worker session/);
  assert.deepEqual(dispatched, ["TypeError: cannot read property x"]);
});

test("/blueprint-show is inspection only and no manual slash command is required", async () => {
  const { pi, commands } = makePi();
  cheaterExtension(pi);
  const context = ctx();
  await commands.get("blueprint-show").handler("", context);
  assert.ok(context.widgets.has("cheater-blueprint"));
});
