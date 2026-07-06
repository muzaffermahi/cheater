import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BLUEPRINT_CONFIG } from "../src/blueprint/config.js";
import { LoopGovernor } from "../src/reliability/loopGovernor.js";
import { modelProfile, inferModelClass, inferParamBillions } from "../src/reliability/modelProfile.js";
import { operatingRulesFor } from "../src/reliability/packetPrompt.js";
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

test("#8 hardTaskLoopBudget extends the terminal cap for genuine iteration, not for spinning", () => {
  const cfg = { ...DEFAULT_BLUEPRINT_CONFIG, maxLoopBreaksPerPacket: 1, sameFileReadLimit: 1, hardTaskLoopBudget: 2 };
  // Genuine iteration: a repeated read triggers the break, but the packet ALSO shows 2 distinct edited
  // files + 2 distinct failing commands -> real progress -> the cap is extended (break 1 not terminal).
  const iterating = [
    { kind: "read_file" as const, value: "a.ts" },
    { kind: "read_file" as const, value: "a.ts" },
    { kind: "patch" as const, value: "p1", changedFiles: ["f1.py"] },
    { kind: "patch" as const, value: "p2", changedFiles: ["f2.py"] },
    { kind: "failed_command" as const, value: "gcc build.c" },
    { kind: "failed_command" as const, value: "python run.py" }
  ];
  assert.equal(new LoopGovernor(cfg, "p8a").observeTools(iterating)?.terminal, false, "progress earns budget");
  assert.equal(new LoopGovernor({ ...cfg, hardTaskLoopBudget: 0 }, "p8b").observeTools(iterating)?.terminal, true, "budget off -> terminal at base cap");
  // Spinning: one file, one command -> no distinct progress -> no budget -> terminal at the base cap.
  const spinning = [
    { kind: "read_file" as const, value: "a.ts" },
    { kind: "read_file" as const, value: "a.ts" },
    { kind: "patch" as const, value: "p1", changedFiles: ["f1.py"] },
    { kind: "failed_command" as const, value: "gcc build.c" }
  ];
  assert.equal(new LoopGovernor(cfg, "p8c").observeTools(spinning)?.terminal, true, "spinning is not granted budget");
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

test("model profile uses small defaults for 9b and larger context for 30b+", () => {
  assert.equal(modelProfile("qwen-9b", DEFAULT_BLUEPRINT_CONFIG).hardContextCeiling, 12000);
  assert.equal(modelProfile("mixtral-30b", DEFAULT_BLUEPRINT_CONFIG).hardContextCeiling, 24000);
});

test("inferModelClass covers the whole 7-35B target band, not just three sizes", () => {
  // Small (<=10B).
  for (const name of ["qwen2.5-coder-7b-instruct", "deepseek-coder-6.7b", "codegemma-7b", "gemma-2-9b-it", "llama-3.1-8b"]) {
    assert.equal(inferModelClass(name), "small", name);
  }
  // Medium (11-23B): the previously-uncovered sweet spot - Qwen2.5-Coder-14B, Codestral-22B,
  // StarCoder2-15B, CodeLlama-13B - all used to fall to "unknown".
  for (const name of ["qwen2.5-coder-14b-instruct", "codestral-22b", "starcoder2-15b", "codellama-13b", "phi-4-14b", "internlm2-20b"]) {
    assert.equal(inferModelClass(name), "medium", name);
  }
  // Sizeless "codestral" resolves via the tiny family fallback (22B -> medium).
  assert.equal(inferModelClass("codestral-latest"), "medium");
  // Large (24B+): Gemma-2-27B, Qwen2.5-Coder-32B, DeepSeek-Coder-33B, Mistral-Small-24B.
  for (const name of ["gemma-2-27b-it", "qwen2.5-coder-32b-instruct", "deepseek-coder-33b-instruct", "mistral-small-24b", "yi-34b"]) {
    assert.equal(inferModelClass(name), "large", name);
  }
});

test("inferParamBillions is not fooled by quantization tags or version numbers", () => {
  // Quant suffixes must never be read as a parameter count.
  assert.equal(inferParamBillions("qwen2.5-coder-14b-instruct-q4_k_m"), 14);
  assert.equal(inferParamBillions("qwen2.5-coder-7b-instruct-q8_0"), 7);
  assert.equal(inferParamBillions("deepseek-coder-33b-instruct.Q4_K_M.gguf"), 33);
  assert.equal(inferParamBillions("codellama-13b-4bit"), 13);
  assert.equal(inferParamBillions("gemma-2-27b-it-fp16"), 27);
  // A bare quant string with no size token yields no false positive.
  assert.equal(inferParamBillions("my-local-model-q4_k_m"), null);
  // These stay classified correctly end to end despite the quant tag.
  assert.equal(inferModelClass("qwen2.5-coder-14b-instruct-q4_k_m"), "medium");
});

test("inferParamBillions reads sparse-MoE NxMb ids by effective size, not the expert size", () => {
  // Mixtral-8x7b is a big model; reading the bare "7b" as small was the trap.
  assert.equal(inferModelClass("mixtral-8x7b-instruct"), "medium");
  assert.equal(inferModelClass("mixtral-8x22b"), "large");
});

test("unrecognized model names stay 'unknown' with neutral rules, never assumed weak", () => {
  assert.equal(inferModelClass("my-custom-finetune"), "unknown");
  assert.equal(inferParamBillions("default"), null);
  // Unknown keeps the tight budget (never over-feed) but neutral (not small-specific) rules.
  assert.equal(modelProfile("default", DEFAULT_BLUEPRINT_CONFIG).packetContextBudget, DEFAULT_BLUEPRINT_CONFIG.packetContextBudgetTokens9B);
  assert.deepEqual(operatingRulesFor("unknown"), [
    "Keep context narrow and execute only this packet.",
    "Stop when acceptance criteria are met or a blocker is found."
  ]);
});

test("medium tier gets its own budget between small and large", () => {
  const medium = modelProfile("qwen2.5-coder-14b", DEFAULT_BLUEPRINT_CONFIG);
  assert.equal(medium.class, "medium");
  assert.ok(medium.packetContextBudget > modelProfile("qwen-7b", DEFAULT_BLUEPRINT_CONFIG).packetContextBudget);
  assert.ok(medium.packetContextBudget < modelProfile("qwen-32b", DEFAULT_BLUEPRINT_CONFIG).packetContextBudget);
  assert.equal(medium.paramsBillions, 14);
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
