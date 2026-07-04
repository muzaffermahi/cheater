import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { clampBool, clampNum, clampStr, clampStrList, extractJsonObject } from "../src/sidecar/schemas.js";
import { deterministicDistill, distillFailureSidecar, renderDistillation } from "../src/sidecar/jobs.js";
import { nullSidecarClient, resolveSidecarClient, sdkSidecarClient, sidecarConfig, SIDECAR_REPROBE_COOLDOWN_MS } from "../src/sidecar/client.js";
import { sidecarDoctor } from "../src/sidecar/command.js";
import type { SidecarClient, SidecarCompletion } from "../src/sidecar/types.js";
import { buildCompletionReceipt, gradeCommitlet } from "../src/commitlet/kernel.js";
import { createCommitletPlan } from "../src/commitlet/planner.js";
import { routeAutopilot } from "../src/autopilot/router.js";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { defaultCommitletState } from "../src/commitlet/state.js";

/** A fake sidecar client with a scripted completion, so job logic is tested without a backend. */
function fakeClient(available: boolean, complete: () => Promise<SidecarCompletion>): SidecarClient {
  return { available: () => available, complete };
}

// --- schema extraction ----------------------------------------------------------------------

test("extractJsonObject pulls one balanced object from prose and respects braces inside strings", () => {
  assert.deepEqual(extractJsonObject('sure: {"a": 1, "b": "has } brace"} trailing prose'), { a: 1, b: "has } brace" });
  assert.deepEqual(extractJsonObject('{"nested": {"x": 1}} then {"y": 2}'), { nested: { x: 1 } });
  assert.equal(extractJsonObject("no json at all"), null);
  assert.equal(extractJsonObject("[1,2,3]"), null, "a top-level array is not an object");
  assert.equal(extractJsonObject('{"a": 1'), null, "unbalanced braces yield null");
  assert.equal(extractJsonObject('{"a": nope}'), null, "malformed JSON yields null");
});

test("clamp helpers coerce, bound, and reject off-shape sidecar fields", () => {
  assert.equal(clampStr("  hi   there ", 100), "hi there");
  assert.equal(clampStr(42, 100), undefined);
  assert.equal(clampStr("", 100), undefined);
  assert.equal(clampStr("abcdef", 3), "abc");
  assert.deepEqual(clampStrList(["a", 1, "b", "c"], 2, 10), ["a", "b"]);
  assert.deepEqual(clampStrList("nope", 2, 10), []);
  assert.equal(clampNum("5", 0, 10, 1), 5);
  assert.equal(clampNum(99, 0, 10, 1), 10);
  assert.equal(clampNum("x", 0, 10, 3), 3);
  assert.equal(clampBool("yes", false), true);
  assert.equal(clampBool("garbage", true), true, "unparseable booleans fall back");
});

// --- deterministic floor ---------------------------------------------------------------------

test("deterministicDistill picks the strongest error line as the cause", () => {
  const distilled = deterministicDistill("running tests\nAssertionError: expected 2 got 1\nmore noise");
  assert.match(distilled.cause, /AssertionError: expected 2 got 1/);
  assert.ok(distilled.hint.length > 0);
  assert.deepEqual(distilled.dontRepeat, []);
});

test("renderDistillation makes a compact repair block", () => {
  const block = renderDistillation({ cause: "off-by-one", hint: "return n not n-1", dontRepeat: ["do not edit tests", "do not broaden scope"] });
  assert.match(block, /Repair focus \(distilled\):/);
  assert.match(block, /likely cause: off-by-one/);
  assert.match(block, /smallest fix: return n not n-1/);
  assert.match(block, /do not repeat: do not edit tests; do not broaden scope/);
});

// --- distillFailure job: sidecar improves, deterministic always the floor --------------------

test("distillFailureSidecar falls back deterministically when the sidecar is unavailable", async () => {
  const outcome = await distillFailureSidecar(nullSidecarClient, "TypeError: x is not a function");
  assert.equal(outcome.source, "deterministic");
  assert.match(outcome.value.cause, /TypeError/);
  assert.match(outcome.note, /unavailable/);
  assert.equal(outcome.label, "distill_failure");
});

test("distillFailureSidecar uses a well-formed sidecar reply", async () => {
  const client = fakeClient(true, async () => ({ ok: true, text: 'here: {"cause":"off-by-one","hint":"return n not n-1","dontRepeat":["do not edit the test"]}', elapsedMs: 3 }));
  const outcome = await distillFailureSidecar(client, "AssertionError: expected 2");
  assert.equal(outcome.source, "sidecar");
  assert.equal(outcome.value.cause, "off-by-one");
  assert.equal(outcome.value.hint, "return n not n-1");
  assert.deepEqual(outcome.value.dontRepeat, ["do not edit the test"]);
});

test("distillFailureSidecar falls back when the sidecar errors or times out", async () => {
  const client = fakeClient(true, async () => ({ ok: false, error: "sidecar timed out after 8000ms", elapsedMs: 8000 }));
  const outcome = await distillFailureSidecar(client, "boom: something failed");
  assert.equal(outcome.source, "deterministic");
  assert.match(outcome.note, /timed out|failed/);
});

test("distillFailureSidecar falls back when the sidecar returns unusable output", async () => {
  const client = fakeClient(true, async () => ({ ok: true, text: "I cannot help with that.", elapsedMs: 2 }));
  const outcome = await distillFailureSidecar(client, "ImportError: no module named x");
  assert.equal(outcome.source, "deterministic");
  assert.match(outcome.value.cause, /ImportError/);
});

// --- config: off by default, deterministic floor --------------------------------------------

test("the sidecar is off by default and resolves to the always-unavailable null client", () => {
  assert.equal(sidecarConfig(DEFAULT_CONFIG).enabled, false);
  assert.equal(resolveSidecarClient(DEFAULT_CONFIG, { model: {}, cwd: "." }).available(), false);
  assert.equal(nullSidecarClient.available(), false);
});

// --- LIVE WIRING: gradeCommitlet actually consults the sidecar and the receipt proves it -----

test("gradeCommitlet routes a failed verification through the sidecar and the receipt records it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-sidecar-wire-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

  const decision = routeAutopilot({ cwd: root, message: "fix the value in a.ts" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "fix the value in a.ts", autopilotDecision: decision });
  const base = {
    ...plan.commitlets[0],
    allowedFiles: ["src/a.ts"],
    expectedFilesTouched: ["src/a.ts"],
    focusedVerification: [{ command: "node -e \"console.error('AssertionError: expected 2 got 1'); process.exit(1)\"", purpose: "fail", required: true }]
  };
  // Snapshot the clean file, then make a small in-scope edit so the diff guard passes but the
  // focused verification (above) fails - that is the path that consults the sidecar.
  const rollbackPoint = createRollbackPoint(root, base);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  const commitlet = { ...base, rollbackPoint, status: "running" as const };

  defaultCommitletState.clear();
  liveSessionState.reset("fix the value in a.ts");

  let sidecarCalls = 0;
  const sidecar: SidecarClient = {
    available: () => true,
    async complete() {
      sidecarCalls += 1;
      return { ok: true, text: '{"cause":"a should be 2 not 1","hint":"set a = 2","dontRepeat":["do not touch tests"]}', elapsedMs: 4 };
    }
  };

  const grade = await gradeCommitlet(root, commitlet, DEFAULT_CONFIG, { sidecar });

  // The verification failed, so a bounded repair was queued and the sidecar was consulted once.
  assert.equal(sidecarCalls, 1, "the failed verification path must consult the sidecar exactly once");
  assert.equal(grade.advance, true, "a failed non-repair commitlet advances by queuing a repair");
  const repair = (grade.details as { repair?: { spec: { observedFailure: string; acceptanceCriteria: string[] }; purpose: string } }).repair;
  assert.ok(repair, "a repair commitlet must be created");
  // The distilled note reaches the repair worker's observedFailure (informed repair, R4)...
  assert.match(repair.spec.observedFailure, /Repair focus \(distilled\):/);
  assert.match(repair.spec.observedFailure, /a should be 2 not 1/);
  // ...but stays OUT of the acceptance criteria / purpose (evidence-isolation invariant).
  assert.ok(!repair.spec.acceptanceCriteria.some((line) => /Repair focus \(distilled\)/.test(line)), "distilled evidence must not leak into acceptance criteria");
  assert.doesNotMatch(repair.purpose, /Repair focus \(distilled\)/);

  // The completion receipt reports the sidecar usage from ground-truth ledger entries.
  const ledger = liveSessionState.getLedger();
  assert.ok(ledger, "the live session must hold a ledger");
  const receipt = buildCompletionReceipt(ledger!);
  assert.match(receipt, /sidecar: 1 call\(s\), 1 used, 0 fell back \(distill_failure\)/);

  defaultCommitletState.clear();
});

test("gradeCommitlet with the null sidecar behaves exactly as before (no sidecar receipt line)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-sidecar-off-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
  const decision = routeAutopilot({ cwd: root, message: "fix the value in b.ts" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "fix the value in b.ts", autopilotDecision: decision });
  const base = {
    ...plan.commitlets[0],
    allowedFiles: ["src/b.ts"],
    expectedFilesTouched: ["src/b.ts"],
    focusedVerification: [{ command: "node -e \"console.error('AssertionError: nope'); process.exit(1)\"", purpose: "fail", required: true }]
  };
  const rollbackPoint = createRollbackPoint(root, base);
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
  defaultCommitletState.clear();
  liveSessionState.reset("fix the value in b.ts");

  // Default resolver with the sidecar disabled -> null client -> no sidecar entry, no crash.
  const grade = await gradeCommitlet(root, { ...base, rollbackPoint, status: "running" as const }, DEFAULT_CONFIG, { sidecar: resolveSidecarClient(DEFAULT_CONFIG, { cwd: root, model: {} }) });
  assert.equal(grade.advance, true);
  const receipt = buildCompletionReceipt(liveSessionState.getLedger()!);
  assert.doesNotMatch(receipt, /sidecar:/, "no sidecar line when the sidecar is off");
  defaultCommitletState.clear();
});

// --- self-healing latch: a transient first failure must not black out the whole session ---------

function fakeSession(modelId: string | undefined, reply = "OK") {
  return {
    model: modelId ? { id: modelId } : {},
    async prompt() { /* no-op */ },
    getLastAssistantText: () => reply,
    abort() { /* no-op */ },
    dispose() { /* no-op */ }
  };
}

test("sdkSidecarClient self-heals after a TRANSIENT failure (re-probes past the cooldown)", async () => {
  let clock = 1000;
  let attempt = 0;
  const client = sdkSidecarClient({
    cwd: ".", model: { id: "small" }, timeoutMs: 8000, maxOutputTokens: 64, now: () => clock,
    createFn: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ECONNREFUSED"); // endpoint still warming up
      return { session: fakeSession("small") };
    }
  });
  const r1 = await client.complete({ prompt: "hi" });
  assert.equal(r1.ok, false);
  assert.equal(client.available(), false, "blacked out right after a transient failure");
  assert.equal(client.state?.().failKind, "transient");
  clock += SIDECAR_REPROBE_COOLDOWN_MS - 1;
  assert.equal(client.available(), false, "still offline within the cooldown");
  clock += 2;
  assert.equal(client.available(), true, "re-opens after the cooldown for a re-probe");
  const r2 = await client.complete({ prompt: "hi" });
  assert.equal(r2.ok, true, "the re-probe succeeds once the endpoint is up");
  assert.equal(client.state?.().latch, "available");
});

test("sdkSidecarClient stays down PERMANENTLY when no model resolves (a config error)", async () => {
  let clock = 0;
  const client = sdkSidecarClient({
    cwd: ".", model: {}, timeoutMs: 8000, maxOutputTokens: 64, now: () => clock,
    createFn: async () => ({ session: fakeSession(undefined) }) // a session, but no model.id
  });
  const r = await client.complete({ prompt: "hi" });
  assert.equal(r.ok, false);
  assert.equal(client.state?.().failKind, "permanent");
  clock += SIDECAR_REPROBE_COOLDOWN_MS * 10;
  assert.equal(client.available(), false, "a permanent (no-model) failure never re-probes");
});

// --- /sidecar doctor classifies the failure into an actionable reason ------------------------

test("sidecarDoctor names the exact reason the sidecar is dark (or that it is online)", async () => {
  assert.match(await sidecarDoctor({}, {}), /OFF/);
  assert.match(await sidecarDoctor({ sidecarEnabled: true }, {}, fakeClient(false, async () => ({ ok: false, error: "x", elapsedMs: 0 }))), /NO MODEL/);
  assert.match(await sidecarDoctor({ sidecarEnabled: true, sidecarModel: "m" }, {}, fakeClient(false, async () => ({ ok: false, error: "x", elapsedMs: 0 }))), /could not be resolved/);
  assert.match(await sidecarDoctor({ sidecarModel: "m" }, {}, fakeClient(true, async () => ({ ok: true, text: "OK", modelId: "m", elapsedMs: 5 }))), /ONLINE/);
  assert.match(await sidecarDoctor({ sidecarModel: "m" }, {}, fakeClient(true, async () => ({ ok: false, error: "sidecar timed out after 8000ms", elapsedMs: 8000 }))), /TIMED OUT/);
  assert.match(await sidecarDoctor({ sidecarModel: "m" }, {}, fakeClient(true, async () => ({ ok: false, error: "sidecar session failed: ECONNREFUSED", elapsedMs: 1 }))), /UNREACHABLE/);
});
