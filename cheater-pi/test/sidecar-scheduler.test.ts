import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidecarScheduler } from "../src/sidecar/scheduler.js";
import { sidecarConfig } from "../src/sidecar/client.js";
import { compressCapsuleSidecar, prepareContextSidecar, routeGoalSidecar } from "../src/sidecar/jobs.js";
import { buildCommitletExecutionPrompt } from "../src/commitlet/executor.js";
import { createCommitletPlan } from "../src/commitlet/planner.js";
import { routeAutopilot } from "../src/autopilot/router.js";
import type { SidecarClient, SidecarCompletion } from "../src/sidecar/types.js";

function fakeClient(available: boolean, complete: () => Promise<SidecarCompletion>): SidecarClient {
  return { available: () => available, complete };
}
const okClient = (text: string) => fakeClient(true, async () => ({ ok: true, text, elapsedMs: 1 }));

// --- config auto-enable ----------------------------------------------------------------------

test("sidecar auto-enables when a model is set and defaults parallelism to gap", () => {
  assert.equal(sidecarConfig({}).enabled, false);
  assert.equal(sidecarConfig({ sidecarModel: "qwen2.5-3b" }).enabled, true, "setting a model auto-enables");
  assert.equal(sidecarConfig({ sidecarModel: "qwen2.5-3b", sidecarEnabled: false }).enabled, false, "explicit off wins");
  assert.equal(sidecarConfig({ sidecarEnabled: true }).enabled, true, "explicit on works with main-model fallback");
  assert.equal(sidecarConfig({}).parallelism, "gap");
  assert.equal(sidecarConfig({ sidecarParallelism: "concurrent" }).parallelism, "concurrent");
});

// --- scheduler: never blocks, prefetch-or-run, discard-on-premise-change ----------------------

test("dispatch prefetches and getOrRun uses the ready result (a hit)", async () => {
  sidecarScheduler.reset();
  sidecarScheduler.configure(okClient("hi"), "gap");
  let ran = 0;
  sidecarScheduler.dispatch("job", "k1", "premise-A", async () => { ran += 1; return "prefetched"; });
  await sidecarScheduler.settle();
  const out = await sidecarScheduler.getOrRun("job", "k1", "premise-A", async () => "live");
  assert.equal(out, "prefetched");
  assert.equal(ran, 1, "the job ran once in the background");
  assert.equal(sidecarScheduler.stats().hits, 1);
});

test("getOrRun never blocks on a pending job - it runs the fallback live", async () => {
  sidecarScheduler.reset();
  sidecarScheduler.configure(okClient("hi"), "gap");
  let resolveJob: (v: string) => void = () => {};
  sidecarScheduler.dispatch("job", "k2", "p", () => new Promise<string>((r) => { resolveJob = r; }));
  // Job is still pending - peek returns undefined and getOrRun runs the fallback now.
  assert.equal(sidecarScheduler.peek("k2", "p"), undefined);
  const out = await sidecarScheduler.getOrRun("job", "k2", "p", async () => "live-fallback");
  assert.equal(out, "live-fallback");
  assert.equal(sidecarScheduler.stats().fallbacks, 1);
  resolveJob("late"); // clean up
  await sidecarScheduler.settle();
});

test("a prefetch for a stale premise is ignored (discarded, counts as waste)", async () => {
  sidecarScheduler.reset();
  sidecarScheduler.configure(okClient("hi"), "gap");
  sidecarScheduler.dispatch("job", "k3", "old-premise", async () => "stale");
  await sidecarScheduler.settle();
  const out = await sidecarScheduler.getOrRun("job", "k3", "NEW-premise", async () => "fresh");
  assert.equal(out, "fresh", "premise changed -> ignore the prefetch, run live");
  assert.equal(sidecarScheduler.stats().waste, 1, "the unread prefetch is counted as waste");
});

test("off mode and a downed client both make dispatch a no-op (getOrRun runs the fallback)", async () => {
  sidecarScheduler.reset();
  sidecarScheduler.configure(okClient("hi"), "off");
  let ran = 0;
  sidecarScheduler.dispatch("job", "k4", "p", async () => { ran += 1; return "x"; });
  await sidecarScheduler.settle();
  assert.equal(ran, 0, "off mode does not run background jobs");
  const out = await sidecarScheduler.getOrRun("job", "k4", "p", async () => "fallback");
  assert.equal(out, "fallback");

  sidecarScheduler.reset();
  sidecarScheduler.configure(fakeClient(false, async () => ({ ok: false, error: "down", elapsedMs: 0 })), "gap");
  assert.equal(sidecarScheduler.enabled(), false, "a downed client disables background work");
});

// --- new jobs: sidecar improves, deterministic is always the floor ---------------------------

test("routeGoalSidecar refines a low-confidence route, else falls back to the regex classification", async () => {
  const fallback = await routeGoalSidecar(fakeClient(false, async () => ({ ok: false, error: "x", elapsedMs: 0 })), "do a thing", { taskKind: "unknown", confidence: 0.4 });
  assert.equal(fallback.source, "deterministic");
  assert.equal(fallback.value.taskKind, "unknown");

  const good = await routeGoalSidecar(okClient('{"taskKind":"bug_fix","editIntent":true,"confidence":0.8}'), "the login crashes", { taskKind: "unknown", confidence: 0.4 });
  assert.equal(good.source, "sidecar");
  assert.equal(good.value.taskKind, "bug_fix");
  assert.equal(good.value.editIntent, true);

  const offShape = await routeGoalSidecar(okClient('{"taskKind":"not-a-real-kind"}'), "x", { taskKind: "feature_addition", confidence: 0.5 });
  assert.equal(offShape.source, "deterministic", "an unknown taskKind is rejected");
  assert.equal(offShape.value.taskKind, "feature_addition");
});

test("compressCapsuleSidecar compresses many facts but leaves small sets alone", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `fact number ${i} about src/mod${i}.ts`);
  const compressed = await compressCapsuleSidecar(okClient('{"facts":["A uses src/x.ts","B calls run()"]}'), many, "add feature", { maxFacts: 6 });
  assert.equal(compressed.source, "sidecar");
  assert.deepEqual(compressed.value.facts, ["A uses src/x.ts", "B calls run()"]);

  const few = await compressCapsuleSidecar(okClient("{}"), ["only one fact"], "goal", { maxFacts: 6 });
  assert.equal(few.source, "deterministic", "few facts need no compression");
  assert.deepEqual(few.value.facts, ["only one fact"]);

  const down = await compressCapsuleSidecar(fakeClient(false, async () => ({ ok: false, error: "x", elapsedMs: 0 })), many, "goal", { maxFacts: 3 });
  assert.equal(down.source, "deterministic");
  assert.equal(down.value.facts.length, 3, "falls back to a head-slice of the raw facts");
});

// --- working AHEAD: a prefetched capsule reaches the worker packet ----------------------------

test("a prefetched compressed capsule flows into the next worker packet (sidecar works ahead)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-prefetch-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const decision = routeAutopilot({ cwd: root, message: "change the value in a.ts" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "change the value in a.ts", autopilotDecision: decision });
  const commitlet = { ...plan.commitlets[0], allowedFiles: ["src/a.ts"] };

  // Seed the scheduler as if an idle-window prefetch already compressed this commitlet's facts.
  sidecarScheduler.reset();
  sidecarScheduler.configure(okClient("x"), "gap");
  sidecarScheduler.dispatch("compress_capsule", `capsule:${commitlet.id}`, commitlet.id, async () => ({ facts: ["PREFETCHED_FACT: follow the sibling pattern in src/sibling.ts"] }));
  await sidecarScheduler.settle();

  const prompt = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, commitlet).prompt;
  assert.match(prompt, /PREFETCHED_FACT: follow the sibling pattern in src\/sibling\.ts/, "the prefetched facts must reach the packet");
  sidecarScheduler.reset();
});

// --- prepareContextSidecar: the flagship parallel context job (facts + files + orientation) ------

test("prepareContextSidecar prioritizes candidate files, compresses facts, and adds orientation", async () => {
  const manyFacts = Array.from({ length: 12 }, (_, i) => `fact ${i}`);
  const client = okClient('{"files":["src/b.ts","src/a.ts"],"facts":["A calls run()","B holds state"],"orientation":["start in src/b.ts"]}');
  const out = await prepareContextSidecar(client, { goal: "wire b to a", rawFacts: manyFacts, candidateFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] });
  assert.equal(out.source, "sidecar");
  assert.deepEqual(out.value.files, ["src/b.ts", "src/a.ts"], "the clerk reordered the real candidates");
  assert.deepEqual(out.value.facts, ["A calls run()", "B holds state"]);
  assert.deepEqual(out.value.orientation, ["start in src/b.ts"]);
});

test("prepareContextSidecar never invents a file outside the candidate set (widens nothing)", async () => {
  const out = await prepareContextSidecar(
    okClient('{"files":["../secret.ts","src/a.ts"],"facts":["x"]}'),
    { goal: "g", rawFacts: ["f1", "f2", "f3", "f4", "f5", "f6", "f7"], candidateFiles: ["src/a.ts", "src/b.ts"] }
  );
  assert.deepEqual(out.value.files, ["src/a.ts"], "the invented ../secret.ts is dropped; only real candidates survive");
});

test("prepareContextSidecar falls back to the deterministic floor when the clerk is down", async () => {
  const down = fakeClient(false, async () => ({ ok: false, error: "x", elapsedMs: 0 }));
  const out = await prepareContextSidecar(down, { goal: "g", rawFacts: ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"], candidateFiles: ["src/a.ts", "src/b.ts"] }, { maxFacts: 3 });
  assert.equal(out.source, "deterministic");
  assert.deepEqual(out.value.facts, ["f1", "f2", "f3"], "head-slice of the raw facts");
  assert.deepEqual(out.value.files, ["src/a.ts", "src/b.ts"], "candidate order as given");
  assert.deepEqual(out.value.orientation, []);
});

test("a prepared context bundle (facts + orientation) flows into the worker packet", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-prep-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const decision = routeAutopilot({ cwd: root, message: "change the value in a.ts" });
  const plan = createCommitletPlan({ repoRoot: root, userGoal: "change the value in a.ts", autopilotDecision: decision });
  const commitlet = { ...plan.commitlets[0], allowedFiles: ["src/a.ts"] };

  sidecarScheduler.reset();
  sidecarScheduler.configure(okClient("x"), "concurrent");
  sidecarScheduler.dispatch("prepare_context", `capsule:${commitlet.id}`, commitlet.id, async () => ({
    facts: ["PREP_FACT: a is exported"],
    files: ["src/a.ts"],
    orientation: ["edit the exported const in src/a.ts"]
  }));
  await sidecarScheduler.settle();

  const prompt = buildCommitletExecutionPrompt({ ...plan, repoRoot: root }, commitlet).prompt;
  assert.match(prompt, /PREP_FACT: a is exported/, "prepared facts reach the packet");
  assert.match(prompt, /orientation: edit the exported const in src\/a\.ts/, "orientation notes reach the packet");
  sidecarScheduler.reset();
});

// --- Track 1: create-time contract cards (the fix for "sidecar idle in commitlet 2") -------------

test("prepareContextSidecar fires on a NEW file when a contract is given (Track 1 - no longer idle)", async () => {
  // From-scratch commitlet: one new candidate file, no repo facts. Without a contract it early-returns.
  const noContract = await prepareContextSidecar(okClient('{"orientation":["x"]}'), { goal: "build it", rawFacts: [], candidateFiles: ["src/new.ts"] });
  assert.equal(noContract.source, "deterministic", "nothing to organize -> deterministic, the clerk is not called");

  // WITH an already-decided contract, the clerk fires and organizes it into a build card.
  const withContract = await prepareContextSidecar(
    okClient('{"orientation":["must export createApp()","match the src/server.ts pattern"]}'),
    { goal: "build it", rawFacts: [], candidateFiles: ["src/new.ts"], contract: ["must export createApp()"], siblings: ["src/server.ts"] }
  );
  assert.equal(withContract.source, "sidecar", "a contract gives the clerk work even for a brand-new file");
  assert.ok(withContract.value.orientation.length > 0, "the build card has orientation notes");
});

test("prepareContextSidecar deterministic floor carries the contract as orientation (Track 1)", async () => {
  const down = fakeClient(false, async () => ({ ok: false, error: "x", elapsedMs: 0 }));
  const out = await prepareContextSidecar(down, { goal: "g", rawFacts: [], candidateFiles: ["src/new.ts"], contract: ["must export foo", "must be pure"] });
  assert.equal(out.source, "deterministic");
  assert.deepEqual(out.value.orientation, ["must export foo", "must be pure"], "even with no clerk, the new file gets its contract as orientation");
});

// --- Track 2: concurrent pool + latency telemetry -----------------------------------------------

test("scheduler accepts a concurrent pool and tracks job latency (Track 2)", async () => {
  sidecarScheduler.reset();
  sidecarScheduler.configure(okClient("x"), "concurrent", undefined, 3);
  let ran = 0;
  sidecarScheduler.dispatch("prepare_context", "k1", "p1", async () => { ran += 1; return "a"; });
  sidecarScheduler.dispatch("prepare_context", "k2", "p2", async () => { ran += 1; return "b"; });
  await sidecarScheduler.settle();
  assert.equal(ran, 2, "both jobs ran under the pool");
  assert.equal(typeof sidecarScheduler.avgLatencyMs(), "number", "average job latency is tracked");
  sidecarScheduler.reset();
});
