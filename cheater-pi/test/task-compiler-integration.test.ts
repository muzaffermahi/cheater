// Task Compiler — integration with the real request path.
//
// These tests drive KittenApp.submitMessage (the single entry every client uses) with a scripted
// Runner, so they exercise the ACTUAL wiring — compile → persist trace → route → context injection —
// without needing a live model.
//
// The properties that matter most here are the safety ones: `off` must be a true no-op, an invalid
// contract must be discarded rather than applied, a compiler crash must never fail a user's run, and
// the contract the verifier reads back after a restart must be the one the run was actually held to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KittenApp, type RunContext, type RunOutcome } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import type { KittenEvent } from "../src/core/events.js";
import { deserializeCompiledTask, type CompiledTask } from "../src/core/taskCompiler/index.js";

function nodeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "kitten-tci-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture", scripts: { test: "node --test", typecheck: "tsc --noEmit" },
    dependencies: { express: "^4.0.0" },
  }, null, 2));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "export.ts"), "export function exportJson(): string { return '{}'; }\n");
  return root;
}

interface Harness {
  app: KittenApp;
  store: ConversationStore;
  events: KittenEvent[];
  /** The conversationContext the scripted Runner actually received. */
  seenContext: string[];
  root: string;
  close(): void;
}

function harness(opts: { taskCompiler?: "off" | "auto" | "force" } = {}): Harness {
  const root = nodeRepo();
  const store = ConversationStore.open(":memory:");
  const events: KittenEvent[] = [];
  const seenContext: string[] = [];
  let n = 0;
  const app = new KittenApp({
    store,
    projectRoot: root,
    taskCompiler: opts.taskCompiler ?? "auto",
    now: () => 1_700_000_000_000 + n,
    newId: (prefix) => `${prefix}_${++n}`,
    runner: async (ctx: RunContext): Promise<RunOutcome> => {
      seenContext.push(ctx.conversationContext);
      return {
        finished: true, summary: "scripted", wallMs: 1,
        usage: { prompt: 0, completion: 0, reasoning: 0 },
        receiptLines: ["scripted runner"], filesChanged: [], verified: false,
      };
    },
  });
  app.subscribe((event) => events.push(event));
  return { app, store, events, seenContext, root, close: () => { app.close(); try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

// ── the flag is a real off switch ────────────────────────────────────────────────────────────────

test("taskCompiler=off is a true no-op: no event, no trace, no context change", async () => {
  const h = harness({ taskCompiler: "off" });
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    const run = await h.app.submitMessage(conv.id, "Add Markdown export to src/export.ts.");
    assert.equal(h.events.filter((e) => e.type === "task.compiled").length, 0, "no compiler event");
    assert.equal(h.app.getCompiledTask(run.id), null, "no persisted trace");
    assert.ok(!h.seenContext[0].includes("Compiled task contract"), "no contract injected");
    assert.equal(run.status, "completed", "the run still executes normally");
  } finally { h.close(); }
});

test("taskCompiler=auto compiles, persists the trace, and injects the contract", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    const run = await h.app.submitMessage(conv.id, "Add a caching layer for the export service.");

    const compiled = h.events.find((e) => e.type === "task.compiled");
    assert.ok(compiled, "task.compiled was emitted");
    assert.equal(compiled!.type === "task.compiled" && compiled!.family, "feature_implementation");

    const record = h.app.getCompiledTask(run.id);
    assert.ok(record, "the trace is persisted");
    const task = deserializeCompiledTask(record!.ir);
    assert.ok(task, "the IR round-trips");
    assert.equal(task!.taskId, run.id);
    assert.ok(record!.promptEpoch.startsWith("epoch_"), "the prompt epoch is recorded");

    assert.ok(h.seenContext[0].includes("Compiled task contract"), "the contract reached the runner");
    assert.ok(h.seenContext[0].includes("must"), "the contract carries binding requirements");
  } finally { h.close(); }
});

// ── ordering: volatile material stays last ───────────────────────────────────────────────────────

test("the contract is appended AFTER durable history so the stable prefix survives", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    await h.app.submitMessage(conv.id, "Add Markdown export to src/export.ts.");
    await h.app.submitMessage(conv.id, "Now add CSV export too.");

    const second = h.seenContext[1];
    const historyAt = second.indexOf("## Conversation so far");
    const contractAt = second.indexOf("## Compiled task contract");
    assert.ok(historyAt >= 0, "durable history is present on the second turn");
    assert.ok(contractAt > historyAt, "the per-turn contract comes after the history block");
  } finally { h.close(); }
});

// ── clarification ────────────────────────────────────────────────────────────────────────────────

test("a blocking contradiction asks one question and never calls the runner", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    const run = await h.app.submitMessage(conv.id, "You must add a new endpoint for user search. Do not add a new endpoint.");

    assert.equal(h.seenContext.length, 0, "the expensive runner was never invoked");
    const asked = h.events.find((e) => e.type === "task.clarification_requested");
    assert.ok(asked, "the clarification event was recorded");
    const answer = h.events.find((e) => e.type === "assistant.final");
    assert.ok(answer && answer.type === "assistant.final" && answer.text.includes("?"), "the user receives a question");

    // Honest terminal state: a turn that produced an answer, not a verified change.
    assert.equal(run.status, "completed");
    assert.equal(run.verified, false, "asking is never verified work");
    assert.deepEqual(run.filesChanged, [], "nothing was changed");
    const receipt = h.events.find((e) => e.type === "receipt.finalized");
    assert.ok(receipt && receipt.type === "receipt.finalized" && receipt.lines.some((l) => /no model call was made/i.test(l)),
      "the receipt states plainly that no model call happened");
  } finally { h.close(); }
});

test("a bare follow-up is answered, not asked about — prior turns give \"it\" a referent", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    // Fresh conversation: "fix it" genuinely has no referent, so asking is correct.
    await h.app.submitMessage(conv.id, "fix it");
    assert.equal(h.seenContext.length, 0, "the first bare request is asked about");

    // After a real turn, the SAME words resolve against history and must run.
    await h.app.submitMessage(conv.id, "Add Markdown export to src/export.ts.");
    const before = h.seenContext.length;
    await h.app.submitMessage(conv.id, "fix it");
    assert.equal(h.seenContext.length, before + 1, "the follow-up reaches the runner instead of being blocked");
  } finally { h.close(); }
});

test("the repository capsule alone is not conversation history", async () => {
  // A first turn in any git repo has a non-empty preamble (the capsule). Treating that as history
  // would silently disable the blocking check on exactly the requests that need it.
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    const built = (h.app as unknown as { context: { build(id: string, cwd: string): { hasPriorTurns: boolean } } }).context.build(conv.id, h.root);
    assert.equal(built.hasPriorTurns, false, "a brand-new conversation has no prior turns");
  } finally { h.close(); }
});

test("an explicit lane override suppresses clarification — the user's choice wins", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    await h.app.submitMessage(conv.id, "You must add a new endpoint. Do not add a new endpoint.", { lane: "direct" });
    assert.equal(h.seenContext.length, 1, "the run executed despite the contradiction");
    assert.equal(h.events.filter((e) => e.type === "task.clarification_requested").length, 0);
  } finally { h.close(); }
});

// ── routing ──────────────────────────────────────────────────────────────────────────────────────

test("an investigation is routed to the answer lane with the compiler's reason recorded", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    await h.app.submitMessage(conv.id, "Where is the export format decided?");
    const route = h.events.find((e) => e.type === "route.selected");
    assert.ok(route && route.type === "route.selected");
    assert.equal(route!.type === "route.selected" && route!.lane, "answer");
  } finally { h.close(); }
});

test("an explicit lane override is never redirected by the compiler", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    await h.app.submitMessage(conv.id, "Where is the export format decided?", { lane: "reliable" });
    const route = h.events.find((e) => e.type === "route.selected");
    assert.equal(route!.type === "route.selected" && route!.lane, "reliable", "the user's lane survives");
  } finally { h.close(); }
});

// ── failure containment ──────────────────────────────────────────────────────────────────────────

test("a compiler failure never fails the user's run", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    // A project root that does not exist makes every grounding read fail. The run must still work.
    const broken = h.app.createConversation({ projectRoot: join(h.root, "does", "not", "exist") });
    const run = await h.app.submitMessage(broken.id, "Add Markdown export.");
    assert.equal(run.status, "completed", "the run completed regardless");
    assert.ok(conv.id !== broken.id);
  } finally { h.close(); }
});

test("an empty request does not crash the request path", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    const run = await h.app.submitMessage(conv.id, "   ");
    assert.ok(["completed", "failed"].includes(run.status), `unexpected status ${run.status}`);
  } finally { h.close(); }
});

// ── durability ───────────────────────────────────────────────────────────────────────────────────

test("the verifier reads back the ORIGINAL contract, not a post-hoc summary", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    const run = await h.app.submitMessage(conv.id, "Add Markdown export to src/export.ts. Do not break JSON export.");

    const record = h.app.getCompiledTask(run.id)!;
    const task = deserializeCompiledTask(record.ir) as CompiledTask;
    // The contract was compiled BEFORE the run; a later summary cannot have replaced it.
    assert.ok(task.requirements.some((r) => r.strength === "must_not" && /json export/i.test(r.text)),
      "the original prohibition survives in the persisted contract");
    assert.ok(task.verification.requiredChecks.length + task.verification.regressionChecks.length > 0,
      "the verification contract is persisted with it");

    // And it survives a fresh reader over the same store — the restart case.
    const rows = h.store.listTaskCompilations(conv.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, run.id);
    assert.equal(rows[0].ir, record.ir, "bytes are stable across reads");
  } finally { h.close(); }
});

test("recompiling a run replaces its contract instead of accumulating versions", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    const run = await h.app.submitMessage(conv.id, "Add Markdown export.");
    h.store.saveTaskCompilation({
      runId: run.id, conversationId: conv.id, mode: "enrich", family: "refactor",
      ir: "{}", trace: "{}", ts: 1,
    });
    const rows = h.store.listTaskCompilations(conv.id);
    assert.equal(rows.length, 1, "upsert, not append");
    assert.equal(rows[0].family, "refactor");
  } finally { h.close(); }
});

// ── the compiler layer stays observable ──────────────────────────────────────────────────────────

test("telemetry records stage facts and never an aggregate quality score", async () => {
  const h = harness();
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    await h.app.submitMessage(conv.id, "Add Markdown export to src/export.ts.");
    const event = h.events.find((e) => e.type === "task.compiled");
    assert.ok(event && event.type === "task.compiled");
    const payload = event as Extract<KittenEvent, { type: "task.compiled" }>;
    assert.ok(payload.repositoryQueries > 0, "repository queries are counted");
    assert.ok(payload.rawRequestTokens > 0);
    assert.ok(typeof payload.totalMs === "number");
    assert.ok(payload.promptEpoch.startsWith("epoch_"));
    const keys = Object.keys(payload).map((k) => k.toLowerCase());
    for (const banned of ["confidence", "score", "quality", "difficulty", "certainty"]) {
      assert.ok(!keys.some((k) => k.includes(banned)), `telemetry leaks "${banned}"`);
    }
  } finally { h.close(); }
});

test("runtime flag changes take effect without a restart", async () => {
  const h = harness({ taskCompiler: "auto" });
  try {
    const conv = h.app.createConversation({ projectRoot: h.root });
    await h.app.submitMessage(conv.id, "Add Markdown export.");
    assert.equal(h.events.filter((e) => e.type === "task.compiled").length, 1);

    h.app.setTaskCompiler("off");
    assert.equal(h.app.getTaskCompiler(), "off");
    await h.app.submitMessage(conv.id, "Add CSV export.");
    assert.equal(h.events.filter((e) => e.type === "task.compiled").length, 1, "no new compilation after disabling");
  } finally { h.close(); }
});
