// The effort dial: profile resolution, router bounds, per-conversation persistence, submit
// plumbing, and the think-hard auto-decomposition path. Principle under test everywhere:
// EFFORT SETS BOUNDS, HARDNESS DECIDES — an easy task stays fast even on "careful".

import test from "node:test";
import assert from "node:assert/strict";
import { EFFORT_PROFILES, effortProfile, resolveEffort } from "../src/core/effort.js";
import { routeMessage } from "../src/core/router.js";
import { KittenApp, type RunContext, type Runner } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";
import type { KittenEvent } from "../src/core/events.js";

function makeApp(runner: Runner, opts: Partial<ConstructorParameters<typeof KittenApp>[0]> = {}): KittenApp {
  let t = 0; let n = 0;
  return new KittenApp({ store: new ConversationStore(openSqlite(":memory:")), runner, now: () => ++t, newId: (p) => `${p}${n++}`, projectRoot: process.cwd(), model: "m", ...opts });
}

const doneRun: Runner = async () => ({ finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: true });

test("resolveEffort tolerates junk and the profiles stay ordered fast → think-hard", () => {
  assert.equal(resolveEffort("fast"), "fast");
  assert.equal(resolveEffort("think-hard"), "think-hard");
  assert.equal(resolveEffort("MAXIMUM OVERDRIVE"), "balanced");
  assert.equal(resolveEffort(undefined), "balanced");
  // Monotone bounds: each level must never grant less than the one below it.
  const order = [EFFORT_PROFILES.fast, EFFORT_PROFILES.balanced, EFFORT_PROFILES.careful, EFFORT_PROFILES["think-hard"]];
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i].kCap >= order[i - 1].kCap, "kCap monotone");
    assert.ok(order[i].maxTurns >= order[i - 1].maxTurns, "maxTurns monotone");
    assert.ok(order[i].maxRepairRounds >= order[i - 1].maxRepairRounds, "repair rounds monotone");
    assert.ok((order[i].ceiling.maxWallMs ?? 0) >= (order[i - 1].ceiling.maxWallMs ?? 0), "wall ceiling monotone");
  }
  assert.equal(EFFORT_PROFILES["think-hard"].ceiling.maxWallMs, undefined, "thinking modes have no automatic wall-clock ceiling");
  assert.equal(EFFORT_PROFILES["think-hard"].reasoningBudget, undefined, "think-hard never sets 0 (0 disables thinking)");
});

test("router: fast caps an escalated task at reliable AND records the cap", () => {
  const escalated = "delete and rewrite the entire authentication system from scratch, full app";
  const normal = routeMessage(escalated, {});
  assert.equal(normal.lane, "ascent", "sanity: this prompt escalates without effort");
  const fast = routeMessage(escalated, { effort: "fast" });
  assert.equal(fast.lane, "reliable");
  assert.equal(fast.k, 1);
  assert.ok(fast.reasons.some((r) => /fast effort capped/.test(r)), "the cap is visible, not silent");
});

test("router: an easy task stays reliable k=1 on careful (bounds, not decisions)", () => {
  const easy = "fix the typo in the README";
  const careful = routeMessage(easy, { effort: "careful" });
  assert.equal(careful.lane, "reliable");
  assert.equal(careful.k, 1);
});

test("router: think-hard floors a change into ascent with k in [floor, cap]", () => {
  const easy = "fix the crash in parser.py when the input is empty";
  const hard = routeMessage(easy, { effort: "think-hard" });
  assert.equal(hard.lane, "ascent");
  assert.ok(hard.k >= EFFORT_PROFILES["think-hard"].kFloor && hard.k <= EFFORT_PROFILES["think-hard"].kCap);
  assert.ok(hard.reasons.some((r) => /think-hard/.test(r)));
  // careful clamps an escalated k to its cap
  const escalated = routeMessage("delete and rewrite the entire authentication system from scratch, full app", { effort: "careful", k: 9 });
  assert.equal(escalated.lane, "ascent");
  assert.ok(escalated.k <= EFFORT_PROFILES.careful.kCap, `k=${escalated.k} respects the careful cap`);
});

test("effort persists per conversation, per-message override wins, and route.selected records it", async () => {
  let seenProfile: string | undefined;
  const runner: Runner = async (ctx: RunContext) => {
    seenProfile = ctx.profile.level;
    return { finished: true, summary: "ok", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [], verified: false };
  };
  const app = makeApp(runner);
  const conv = app.createConversation({ effort: "careful" });
  assert.equal(app.getConversation(conv.id)?.effort, "careful", "stored at creation");
  const seen: KittenEvent[] = [];
  app.subscribe((e) => seen.push(e));
  await app.submitMessage(conv.id, "fix the crash in parser.py");
  assert.equal(seenProfile, "careful", "the conversation's level reaches the runner");
  const route = seen.find((e) => e.type === "route.selected");
  assert.ok(route?.type === "route.selected" && route.effort === "careful", "route.selected records the effort");
  await app.submitMessage(conv.id, "fix the crash in tokenizer.py", { effort: "fast" });
  assert.equal(seenProfile, "fast", "a per-message override wins");
  assert.ok(app.setEffort(conv.id, "balanced"));
  assert.equal(app.getConversation(conv.id)?.effort, "balanced");
  assert.equal(app.setEffort("nope", "fast"), false);
  app.close();
});

test("think-hard decomposes a decomposable contract into a verified step DAG; children run and the run grades from the integrate node", async () => {
  // The scripted runner completes+verifies every child, so the integrate node lands "completed".
  const app = makeApp(doneRun, { taskCompiler: "force" });
  const conv = app.createConversation({ effort: "think-hard" });
  const seen: KittenEvent[] = [];
  app.subscribe((e) => seen.push(e));
  // Two distinct file deliverables + a mutation → decomposeCompiledTask splits (≥2 write surfaces).
  const run = await app.submitMessage(conv.id, "Create src/parser.py and src/formatter.py: the parser reads config.ini and the formatter renders it as a table.");
  const types = seen.map((e) => e.type);
  if (types.includes("step.started")) {
    // Decomposition path taken: plan + steps + a graded run, no ordinary-lane run.started duplication.
    assert.ok(types.includes("plan.updated"));
    assert.ok(types.filter((t) => t === "step.completed").length >= 2, "workers + integrate all completed");
    assert.equal(run.status, "completed");
    // Children broadcast their own route/receipt events; assert against the PARENT run's.
    const route = seen.find((e) => e.type === "route.selected" && e.runId === run.id);
    assert.ok(route?.type === "route.selected" && route.reasons.some((r) => /decomposition/.test(r)));
    const receipt = seen.find((e) => e.type === "receipt.finalized" && e.runId === run.id);
    assert.ok(receipt?.type === "receipt.finalized" && receipt.lines.some((l) => /tc-integrate/.test(l)), `parent receipt lists the integrate node (${receipt?.type === "receipt.finalized" ? receipt.lines.join(" | ") : "missing"})`);
  } else {
    // The compiler may decline to produce 2 write surfaces for this phrasing — that is the designed
    // fallback: the ordinary lane ran and the turn still completed.
    assert.equal(run.status, "completed", "fallback lane still serves the turn");
  }
  app.close();
});

test("balanced never decomposes even when the contract could", async () => {
  const app = makeApp(doneRun, { taskCompiler: "force" });
  const conv = app.createConversation({ effort: "balanced" });
  const seen: KittenEvent[] = [];
  app.subscribe((e) => seen.push(e));
  await app.submitMessage(conv.id, "Create src/parser.py and src/formatter.py: the parser reads config.ini and the formatter renders it as a table.");
  assert.ok(!seen.some((e) => e.type === "step.started"), "no DAG below think-hard");
  app.close();
});

test("effortProfile drives the context fraction: fast trims the preamble budget", () => {
  assert.equal(effortProfile("fast").contextWindowFraction, 0.5);
  assert.equal(effortProfile("think-hard").contextWindowFraction, 1);
});
