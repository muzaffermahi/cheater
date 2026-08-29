import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { postEditSyntaxGate, pythonImportBaseline, pythonImportRegression, receiptTouchesTheWork } from "../src/core/reliable.js";
import type { ToolContext } from "../src/core/tools.js";
import { DEFAULT_BLUEPRINT_CONFIG } from "../src/blueprint/config.js";

function ctxAt(): ToolContext {
  return { cwd: mkdtempSync(join(tmpdir(), "kt-gate-")), filesRead: new Set(), filesWritten: new Set() };
}
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

test("the self-call arity gate catches a wrong-arity method call a smoke test would miss", async () => {
  // Live bakeoff finding: a produced expression parser had exactly one bad call site,
  // `self._consume(")")`, on the parenthesis path. Its own verification ran "2 + 3", never took that
  // branch, and the finish gate accepted the green receipt. `(1+2)*3` then raised TypeError.
  const ctx = ctxAt();
  const bad = [
    "class P:",
    "    def _consume(self):",
    "        return 1",
    "    def parse(self):",
    "        return self._consume(')')",
    "",
  ].join("\n");
  writeFileSync(join(ctx.cwd, "calc.py"), bad);
  const hit = postEditSyntaxGate({ name: "write", args: { path: "calc.py" } }, { output: "", isError: false }, ctx);
  assert.ok(hit, "a provably-wrong self call must be reported");
  assert.match(hit!, /METHOD CALL CHECK FAILED/);
  assert.match(hit!, /_consume/);

  // Everything it cannot PROVE wrong must pass untouched: correct arity, defaults, *args, decorators,
  // inherited methods, and keyword calls.
  const good = [
    "import functools",
    "class Base:",
    "    def inherited(self, a, b):",
    "        return a + b",
    "class P(Base):",
    "    def one(self, a):",
    "        return a",
    "    def defaulted(self, a, b=2):",
    "        return a + b",
    "    def varargs(self, *args):",
    "        return args",
    "    @property",
    "    def prop(self):",
    "        return 1",
    "    def go(self):",
    "        self.one(1)",
    "        self.defaulted(1)",
    "        self.defaulted(1, 2)",
    "        self.varargs(1, 2, 3)",
    "        self.inherited(1, 2)",
    "        self.one(a=1)",
    "        return self.prop",
    "",
  ].join("\n");
  writeFileSync(join(ctx.cwd, "ok.py"), good);
  const clean = postEditSyntaxGate({ name: "write", args: { path: "ok.py" } }, { output: "", isError: false }, ctx);
  assert.equal(clean, undefined, `no false positive expected, got: ${clean}`);
});


test("the import invariant catches a rename that broke an existing importer", () => {
  // The multi-file failure a model cannot see from the file it edited: rename a function, forget the
  // module that imports it. Neither a syntax check nor a smoke test on the edited file notices.
  const cwd = mkdtempSync(join(tmpdir(), "kt-import-"));
  writeFileSync(join(cwd, "core.py"), "def compute_total(items):\n    return sum(items)\n");
  writeFileSync(join(cwd, "invoice.py"), "from core import compute_total\n\n\ndef build(i):\n    return compute_total(i)\n");
  const baseline = pythonImportBaseline(cwd);
  assert.ok(baseline.includes("core") && baseline.includes("invoice"), `baseline should hold both: ${JSON.stringify(baseline)}`);
  assert.equal(pythonImportRegression(cwd, baseline), undefined, "an untouched repo has no regression");

  // Rename in core.py only — invoice.py's import now dangles.
  writeFileSync(join(cwd, "core.py"), "def compute_subtotal(items):\n    return sum(items)\n");
  const broken = pythonImportRegression(cwd, baseline);
  assert.ok(broken, "a broken importer must be reported");
  assert.match(broken!, /BROKEN modules/);
  assert.match(broken!, /invoice/);

  // Fixing the caller clears it.
  writeFileSync(join(cwd, "invoice.py"), "from core import compute_subtotal\n\n\ndef build(i):\n    return compute_subtotal(i)\n");
  assert.equal(pythonImportRegression(cwd, baseline), undefined, "a consistent repo must pass");
});

test("the import invariant never blames the agent for a repo that was already broken", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kt-import2-"));
  writeFileSync(join(cwd, "fine.py"), "VALUE = 1\n");
  writeFileSync(join(cwd, "needs_missing_dep.py"), "import definitely_not_installed_xyz\n");
  writeFileSync(join(cwd, "already_broken.py"), "from nowhere import thing\n");
  const baseline = pythonImportBaseline(cwd);
  assert.ok(baseline.includes("fine"), "a healthy module is recorded");
  assert.ok(!baseline.includes("needs_missing_dep"), "a module needing an absent package is NOT baselined");
  assert.ok(!baseline.includes("already_broken"), "a pre-broken module is NOT baselined");
  assert.equal(pythonImportRegression(cwd, baseline), undefined, "pre-existing breakage must never block");
});
test("the arity gate also covers module-level functions, and stays quiet when a name could be shadowed", () => {
  const ctx = ctxAt();
  // The free-function twin of the method bug: def summary(rows, column) called with one argument.
  writeFileSync(join(ctx.cwd, "stats.py"), [
    "def summary(rows, column):",
    "    return (rows, column)",
    "",
    "def report(rows):",
    "    return summary(rows)",
    "",
  ].join("\n"));
  const hit = postEditSyntaxGate({ name: "write", args: { path: "stats.py" } }, { output: "", isError: false }, ctx);
  assert.ok(hit, "a provably-wrong module-level call must be reported");
  assert.match(hit!, /summary\(\.\.\.\) passes 1 argument/);

  // Must stay silent wherever the name might not resolve to that definition, or the call is fine.
  writeFileSync(join(ctx.cwd, "ok.py"), [
    "from os.path import join",              // imported name of its own
    "",
    "def helper(a, b=2):",
    "    return a + b",
    "",
    "def shadowed(a):",
    "    return a",
    "",
    "def use():",
    "    shadowed = lambda *a: a",           // locally rebound -> never flagged
    "    shadowed(1, 2, 3)",
    "    helper(1)",
    "    helper(1, 2)",
    "    return join('a', 'b')",
    "",
  ].join("\n"));
  const clean = postEditSyntaxGate({ name: "write", args: { path: "ok.py" } }, { output: "", isError: false }, ctx);
  assert.equal(clean, undefined, `no false positive expected, got: ${clean}`);
});
test("a finish receipt must be about the work, not just any command that exited 0", () => {
  // `python -c "print(1)"` matches the execution pattern and proves nothing about the change.
  const written = ["calc.py"];
  const targets = ["calc.py", "evaluate"];
  assert.equal(receiptTouchesTheWork('python -c "print(1)"', written, targets), false, "an unrelated probe is not a receipt");
  assert.equal(receiptTouchesTheWork('python -c "import os; os.getcwd()"', written, targets), false);
  // Anything that names the produced file, its module, or a contract symbol counts.
  assert.equal(receiptTouchesTheWork('python -c "from calc import evaluate; print(evaluate(\'1+1\'))"', written, targets), true);
  assert.equal(receiptTouchesTheWork("python calc.py", written, targets), true);
  assert.equal(receiptTouchesTheWork("python check_calc.py", ["check_calc.py"], []), true);
  // A whole-project runner exercises the project by definition.
  assert.equal(receiptTouchesTheWork("pytest -q", [], []), true);
  assert.equal(receiptTouchesTheWork("npm test", [], []), true);
  // A stem too short to judge ("a" from a.py) makes the question unanswerable, and the gate abstains
  // rather than blocking a legitimate finish — see the dedicated abstain test below.
  assert.equal(receiptTouchesTheWork("python -c \"print(2)\"", ["a.py"], []), true, "unjudgeable -> abstain");
});


test("receipt relevance is not enforced when nothing is judgeable", () => {
  // A 1-char module stem would match almost any command, so it cannot be judged. Refusing on an
  // unanswerable question would block a legitimate finish; the gate must abstain instead.
  assert.equal(receiptTouchesTheWork('python -c "import a; print(a.x)"', [], ["a.py"]), true);
  assert.equal(receiptTouchesTheWork('python -c "print(1)"', [], []), true, "no names at all -> abstain");
  // But it still bites the moment there IS something judgeable.
  assert.equal(receiptTouchesTheWork('python -c "print(1)"', [], ["calc.py"]), false);
});
