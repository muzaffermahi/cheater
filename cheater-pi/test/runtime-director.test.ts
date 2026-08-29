import test from "node:test";
import assert from "node:assert/strict";
import { contractForPhase, phaseForAgent, receiptFor } from "../src/core/runtimeDirector.js";

test("Runtime Director resolves phase controls instead of silently using executor defaults", () => {
  const plan = contractForPhase("plan", "balanced", { temperature: 0.4 }, {}, "qwen3.5-35b");
  const repair = contractForPhase("repair", "careful", {}, {}, "qwen3.5-35b");
  assert.equal(plan.phase, "plan");
  assert.equal(plan.role, "planner");
  assert.equal(plan.transport.temperature, 0.4);
  assert.notEqual(plan.transport.maxTokens, repair.transport.maxTokens);
});

test("Runtime Director receipts are honest about external providers", () => {
  const contract = contractForPhase("act", "balanced", {}, {}, "main");
  const receipt = receiptFor(contract, { ownership: "external-compatible", model: "main" });
  assert.equal(receipt.evidence, "sent-only");
  assert.ok(receipt.unverifiable.includes("minP"));
  assert.ok(Object.hasOwn(receipt.requested, "temperature"));
});

test("phase mapping replaces the old sidecar model split", () => {
  assert.equal(phaseForAgent("explore"), "inspect");
  assert.equal(phaseForAgent("debug"), "repair");
  assert.equal(phaseForAgent("general"), "act");
});
