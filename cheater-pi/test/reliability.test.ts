import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BLUEPRINT_CONFIG } from "../src/blueprint/config.js";
import { LoopGovernor } from "../src/reliability/loopGovernor.js";
import { modelProfile } from "../src/reliability/modelProfile.js";
import { renderFreshCallPacket, freshCallPacketFromWorkPacket } from "../src/reliability/packetPrompt.js";
import { stripSentinel } from "../src/reliability/sentinels.js";
import { runReliabilityBenchmark } from "../src/reliability/bench.js";
import { splitPacketsByTouchedFile } from "../src/reliability/perFilePackets.js";
import type { BlueprintPlan, WorkPacket } from "../src/blueprint/types.js";

test("loop governor detects repeated text and tool loops", () => {
  const governor = new LoopGovernor(DEFAULT_BLUEPRINT_CONFIG, "p1");
  assert.equal(Boolean(governor.observeText("Repeat this sentence for reliability loop detection testing. Repeat this sentence for reliability loop detection testing. Repeat this sentence for reliability loop detection testing.")), true);
  const tools = new LoopGovernor(DEFAULT_BLUEPRINT_CONFIG, "p2");
  // Reading the same file a few times is normal iteration; the governor only breaks once
  // reads exceed the (recalibrated, more permissive) sameFileReadLimit.
  const reads = Array.from({ length: DEFAULT_BLUEPRINT_CONFIG.sameFileReadLimit + 1 }, () => ({ kind: "read_file" as const, value: "src/a.ts" }));
  const event = tools.observeTools(reads);
  assert.match(event?.reason ?? "", /same file read/);
  assert.equal(event?.recovery.action, "inspect_one_file");
  assert.match(event?.recovery.instruction ?? "", /Inspect exactly one/);
  assert.equal(event?.recovery.terminal, false);
});

test("loop governor emits one forced recovery action and stops after max breaks", () => {
  const failed = new LoopGovernor(DEFAULT_BLUEPRINT_CONFIG, "p3");
  // The same failed command must repeat past sameFailedCommandLimit before the governor
  // intervenes (one retry is normal); flag/number variants still collapse to one family.
  const failedCalls = Array.from({ length: DEFAULT_BLUEPRINT_CONFIG.sameFailedCommandLimit + 1 }, () => ({ kind: "failed_command" as const, value: "npm test -- commands" }));
  const failedEvent = failed.observeTools([
    { kind: "patch", value: "src/a.ts", changedFiles: ["src/a.ts"] },
    ...failedCalls
  ]);
  assert.equal(failedEvent?.recovery.action, "edit_one_file");
  assert.equal(failedEvent?.recovery.target, "src/a.ts");
  assert.match(failedEvent?.recovery.instruction ?? "", /Edit only src\/a\.ts/);

  const noProgress = new LoopGovernor(DEFAULT_BLUEPRINT_CONFIG, "p4");
  const noProgressEvent = noProgress.observeNoProgress([
    { kind: "read_file", value: "src/a.ts" },
    { kind: "search", value: "registerCommand" },
    { kind: "read_file", value: "src/b.ts" }
  ], []);
  assert.equal(noProgressEvent?.recovery.action, "inspect_one_file");
  assert.equal(noProgressEvent?.recovery.target, "src/b.ts");

  const terminal = new LoopGovernor({ ...DEFAULT_BLUEPRINT_CONFIG, maxLoopBreaksPerPacket: 1 }, "p5");
  const terminalEvent = terminal.observeText("Repeat this sentence for reliability loop detection testing. Repeat this sentence for reliability loop detection testing. Repeat this sentence for reliability loop detection testing.");
  assert.equal(terminalEvent?.terminal, true);
  assert.equal(terminalEvent?.recovery.action, "stop_blocked");
  assert.match(terminalEvent?.recovery.instruction ?? "", /Stop this packet/);
});

test("stop sentinels strip and report missing sentinel safely", () => {
  assert.deepEqual(stripSentinel("{\"ok\":true}@@END_JSON@@", "@@END_JSON@@"), { ok: true, body: "{\"ok\":true}", repaired: false });
  assert.equal(stripSentinel("partial", "@@END_JSON@@").ok, false);
});

test("fresh-call packet trims previous state and renders sentinel", () => {
  const packet: WorkPacket = {
    id: "p1",
    title: "Edit one file",
    type: "implement",
    status: "pending",
    dependsOn: [],
    estimatedModelCalls: 1,
    maxModelCalls: 1,
    filesToInspect: [{ path: "src/a.ts", reason: "target" }],
    filesToTouch: [{ path: "src/a.ts", reason: "target" }],
    allowedTools: ["read", "edit"],
    forbiddenActions: [],
    promptContract: "fresh-agent run",
    acceptanceCriteria: ["file updated"],
    verification: [],
    simulationChecks: [],
    risk: "low"
  };
  const plan = { userGoal: "Do the thing", workPackets: [packet] } as BlueprintPlan;
  const fresh = freshCallPacketFromWorkPacket({
    plan,
    packet,
    previousState: ["a", "b", "c", "d"],
    contextBudgetTokens: 1000,
    config: DEFAULT_BLUEPRINT_CONFIG
  });
  assert.deepEqual(fresh.previousState, ["b", "c", "d"]);
  assert.match(renderFreshCallPacket(fresh), /@@END_PATCH@@/);
});

test("fresh-call packet and splitter enforce one file per worker", () => {
  const packet: WorkPacket = {
    id: "p1",
    title: "Edit files",
    type: "implement",
    status: "pending",
    dependsOn: ["inspect"],
    estimatedModelCalls: 1,
    maxModelCalls: 1,
    filesToInspect: [
      { path: "src/a.ts", reason: "target" },
      { path: "src/b.ts", reason: "target" }
    ],
    filesToTouch: [
      { path: "src/a.ts", reason: "target" },
      { path: "src/b.ts", reason: "target" }
    ],
    allowedTools: ["read", "edit"],
    forbiddenActions: [],
    promptContract: "fresh-agent run",
    acceptanceCriteria: ["files updated"],
    verification: [],
    simulationChecks: [],
    risk: "medium"
  };
  const split = splitPacketsByTouchedFile([packet], 1);
  assert.equal(split.length, 2);
  assert.ok(split.every((item) => item.filesToTouch.length === 1));
  assert.deepEqual(split[1].dependsOn, [split[0].id]);
  const plan = { userGoal: "Do the thing", workPackets: [packet] } as BlueprintPlan;
  const fresh = freshCallPacketFromWorkPacket({
    plan,
    packet,
    contextBudgetTokens: 1000,
    config: DEFAULT_BLUEPRINT_CONFIG
  });
  assert.deepEqual(fresh.filesToTouch, ["src/a.ts"]);
  assert.match(renderFreshCallPacket(fresh), /Do not continue to another file/);
});

test("model profile uses small defaults for 9b and larger MoE context", () => {
  assert.equal(modelProfile("qwen-9b", DEFAULT_BLUEPRINT_CONFIG).hardContextCeiling, 12000);
  assert.equal(modelProfile("mixtral-30b", DEFAULT_BLUEPRINT_CONFIG).hardContextCeiling, 24000);
});

test("reliability benchmark records offline metrics", () => {
  const results = runReliabilityBenchmark({ cwd: process.cwd(), variant: "B", limit: 2, config: DEFAULT_BLUEPRINT_CONFIG });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.toolCalls > 0));
});

test("reliability benchmark variant E records retrieval gate metrics", () => {
  const results = runReliabilityBenchmark({ cwd: process.cwd(), variant: "E", limit: 2, config: DEFAULT_BLUEPRINT_CONFIG });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.retrievalGateTrusted === true));
});
