import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerHeldOut, heldOutFirewallReport, transfers, renderTransfer, HELD_OUT_SET } from "../src/core/heldout.js";
import { EvalRegistry, DisjointnessError } from "../src/core/disjointness.js";
import { ExperienceStore } from "../src/core/experience.js";

test("registerHeldOut makes the held-out set eval-guarded (stores can't touch it)", async () => {
  const reg = new EvalRegistry();
  registerHeldOut(reg, ["heldout-task-1", "heldout-task-2"]);
  assert.equal(reg.isEvalId("heldout-task-1"), true);
  assert.ok(reg.names().includes(HELD_OUT_SET));
  // The experience store must hard-fail admitting a held-out task.
  const store = new ExperienceStore({ dir: mkdtempSync(join(tmpdir(), "ho-")), registry: reg });
  await assert.rejects(
    () => store.admit({ id: "heldout-task-1", taskText: "x", family: "general", approachShape: "s", filesTouched: [], verified: true }),
    DisjointnessError
  );
});

test("heldOutFirewallReport flags a poisoned store or leaking skill", () => {
  const reg = new EvalRegistry();
  registerHeldOut(reg, ["heldout-task-1"]);
  const clean = heldOutFirewallReport(reg, { experienceIds: ["my-own-run-1"], skillViolations: [] });
  assert.equal(clean.clean, true);
  const dirty = heldOutFirewallReport(reg, { experienceIds: ["heldout-task-1"], skillViolations: ["crypto-hash: token 'heldout-task-1'"] });
  assert.equal(dirty.clean, false);
  assert.equal(dirty.violations.length, 2);
});

test("transfers: a lift that survives held-out is real; a big drop is leakage", () => {
  assert.equal(transfers(0.82, 0.80).transfers, true, "2-pt drop transfers");
  assert.equal(transfers(0.82, 0.55).transfers, false, "27-pt drop is leakage");
  assert.match(renderTransfer(0.82, 0.80), /TRANSFERS/);
  assert.match(renderTransfer(0.82, 0.55), /leakage/i);
});
