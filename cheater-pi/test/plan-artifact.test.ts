import test from "node:test";
import assert from "node:assert/strict";
import { approvePlan, createPlanArtifact, isApprovedExact, revisePlan } from "../src/core/planArtifact.js";

const input = { id: "p1", conversationId: "c1", request: "Add a feature", projectRoot: process.cwd(), workspaceFingerprint: "fp", now: 1,
  steps: [{ id: "s1", title: "Implement", objective: "edit src/a.ts", allowedFiles: ["src/a.ts"], acceptanceCriteria: ["tests pass"] }] };

test("plan approval binds execution to the exact immutable revision", () => {
  const plan = createPlanArtifact(input);
  assert.equal(plan.revision, 1); assert.equal(plan.status, "draft"); assert.ok(plan.hash);
  const approved = approvePlan(plan, 2);
  assert.equal(approved.approvedHash, approved.hash); assert.equal(isApprovedExact(approved), true);
  const revised = revisePlan(approved, { goal: "Add a safer feature" }, 3);
  assert.equal(revised.revision, 2); assert.equal(revised.status, "draft");
  assert.equal(revised.approvedHash, undefined); assert.equal(isApprovedExact(revised), false);
  assert.notEqual(revised.hash, approved.hash);
});
