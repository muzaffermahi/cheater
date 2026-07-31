import test from "node:test";
import assert from "node:assert/strict";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";
import { TaskGraphController, buildTaskCapsule, validateTaskPlan } from "../src/core/taskGraph.js";

function store(): ConversationStore {
  const s = new ConversationStore(openSqlite(":memory:"));
  s.createConversation({ id: "c1", title: "Task", projectRoot: "/tmp", projectId: "/tmp", model: "main", mode: "auto", ts: 1 });
  return s;
}

test("task graph rejects cycles, unknown dependencies, and shared edit workers", () => {
  assert.throws(() => validateTaskPlan({ conversationId: "c1", nodes: [
    { id: "a", agent: "implement", objective: "edit code", dependencies: [], workspaceMode: "shared-readonly" },
  ] as never[] }), /isolated-worktree/);
  assert.throws(() => validateTaskPlan({ conversationId: "c1", nodes: [
    { id: "a", agent: "implement", objective: "edit code", dependencies: [], workspaceMode: "isolated-worktree", allowedFiles: [] },
  ] as never[] }), /allowedFiles/);
  assert.throws(() => validateTaskPlan({ conversationId: "c1", nodes: [
    { id: "a", agent: "explore", objective: "map", dependencies: ["missing"] },
  ] as never[] }), /unknown node/);
  assert.throws(() => validateTaskPlan({ conversationId: "c1", nodes: [
    { id: "a", agent: "explore", objective: "map", dependencies: ["b"] },
    { id: "b", agent: "explore", objective: "map", dependencies: ["a"] },
  ] as never[] }), /cycle/);
});

test("task graph persists nodes, runs dependencies, and never includes parent transcript", async () => {
  const s = store();
  const controller = new TaskGraphController(s, () => 10);
  controller.createPlan({ conversationId: "c1", ts: 10, nodes: [
    { id: "orient", agent: "explore", objective: "map repository", dependencies: [], allowedFiles: ["src"], workspaceMode: "shared-readonly" },
    { id: "impl", agent: "implement", objective: "implement the fix", dependencies: ["orient"], allowedFiles: ["src/a.ts"], workspaceMode: "isolated-worktree" },
    { id: "verify", agent: "verify", objective: "run tests", dependencies: ["impl"], workspaceMode: "shared-readonly" },
  ] as never[] });
  const order: string[] = [];
  const result = await controller.runUntilSettled("c1", async (node, capsule) => {
    order.push(node.id);
    assert.equal(capsule.parentTranscriptIncluded, false);
    return { report: `${node.id} done`, evidence: [`${node.id}: receipt`] };
  });
  assert.deepEqual(order, ["orient", "impl", "verify"]);
  assert.ok(result.every((node) => node.status === "completed"));
  const persisted = s.getTaskNode("impl")!;
  assert.equal(persisted.workspaceMode, "isolated-worktree");
  assert.deepEqual(persisted.evidence, ["impl: receipt"]);
});

test("failed dependency blocks descendants and capsule fields are bounded", async () => {
  const s = store();
  const controller = new TaskGraphController(s);
  controller.createPlan({ conversationId: "c1", nodes: [
    { id: "bad", agent: "explore", objective: "fail", dependencies: [] },
    { id: "after", agent: "verify", objective: "should not run", dependencies: ["bad"] },
  ] as never[] });
  await controller.runUntilSettled("c1", async () => { throw new Error("no model"); });
  assert.equal(s.getTaskNode("after")!.status, "blocked");
  const capsule = buildTaskCapsule(s.getTaskNode("bad")!, "x".repeat(100_000), ["fact".repeat(1000)], 1000);
  assert.ok(capsule.repoBrief.length < 1000);
  assert.equal(capsule.parentTranscriptIncluded, false);
});

test("task graph fans out independent sidecar scouts and serializes main work", async () => {
  const s = store();
  const controller = new TaskGraphController(s);
  controller.createPlan({ conversationId: "c1", nodes: [
    { id: "scout-a", agent: "explore", objective: "map A", dependencies: [], modelTier: "sidecar" },
    { id: "scout-b", agent: "explore", objective: "map B", dependencies: [], modelTier: "sidecar" },
    { id: "main", agent: "implement", objective: "implement the fix", dependencies: ["scout-a", "scout-b"], modelTier: "main", workspaceMode: "isolated-worktree", allowedFiles: ["src/a.ts"] },
  ] as never[] });
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  await controller.runUntilSettled("c1", async (node) => {
    active += 1; peak = Math.max(peak, active); order.push(node.id);
    await new Promise((resolve) => setTimeout(resolve, node.id.startsWith("scout") ? 12 : 1));
    active -= 1;
    return { report: `${node.id} done`, evidence: [] };
  }, { maxConcurrent: 2, maxConcurrentFor: (ready) => ready.some((node) => node.modelTier === "main") ? 1 : 2 });
  assert.equal(peak, 2);
  assert.deepEqual(order.slice(0, 2).sort(), ["scout-a", "scout-b"]);
  assert.equal(order[2], "main");
});

test("task graph resumes only incomplete nodes and preserves completed work", async () => {
  const s = store();
  const controller = new TaskGraphController(s);
  controller.createPlan({ conversationId: "c1", nodes: [
    { id: "done", agent: "explore", objective: "complete scout", dependencies: [] },
    { id: "retry", agent: "review", objective: "retry review", dependencies: ["done"] },
  ] as never[] });
  let first = true;
  await controller.runUntilSettled("c1", async (node) => {
    if (node.id === "retry" && first) { first = false; throw new Error("temporary endpoint failure"); }
    return { report: `${node.id} fresh`, evidence: [`${node.id}:receipt`] };
  });
  assert.equal(s.getTaskNode("done")!.status, "completed");
  assert.equal(s.getTaskNode("retry")!.status, "failed");
  controller.resume("c1");
  assert.equal(s.getTaskNode("done")!.report, "done fresh");
  assert.equal(s.getTaskNode("retry")!.status, "queued");
  await controller.runUntilSettled("c1", async (node) => ({ report: `${node.id} resumed`, evidence: [`${node.id}:new`] }));
  assert.equal(s.getTaskNode("done")!.report, "done fresh");
  assert.equal(s.getTaskNode("retry")!.status, "completed");
});
