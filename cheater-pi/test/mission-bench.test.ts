import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeltaBenchEntry, loadDeltaBench, recordDeltaBench, summarizeDeltaBench } from "../src/mission/bench.js";

test("records metrics and writes report", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-bench-"));
  recordDeltaBench({
    cwd,
    entry: buildDeltaBenchEntry({
      mode: "cheater",
      missionType: "test_failure",
      success: true,
      reproductionDone: true,
      noOpDetected: false,
      memoryUsed: true,
      evidenceConfidence: 0.8,
      filesRead: 5,
      filesEdited: 1,
      testsRun: 1,
      rawCommandFailures: 1,
      verification: "focused ok",
      userAccepted: true,
      notes: ""
    })
  });
  const entries = loadDeltaBench(cwd);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mode, "cheater");
  assert.equal(entries[0].success, true);
  rmSync(cwd, { recursive: true, force: true });
});

test("handles missing vanilla mode gracefully", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-bench-"));
  const summary = summarizeDeltaBench(loadDeltaBench(cwd));
  assert.equal(summary.total, 0);
  assert.equal(summary.successRate, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test("summarize computes success rate and reproduction rate", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-bench-"));
  recordDeltaBench({
    cwd,
    entry: buildDeltaBenchEntry({
      mode: "cheater",
      missionType: "bug_fix",
      success: true,
      reproductionDone: true,
      noOpDetected: false,
      memoryUsed: true,
      evidenceConfidence: 0.7,
      filesRead: 3,
      filesEdited: 1,
      testsRun: 1,
      rawCommandFailures: 1,
      verification: "focused ok",
      userAccepted: true
    })
  });
  recordDeltaBench({
    cwd,
    entry: buildDeltaBenchEntry({
      mode: "vanilla",
      missionType: "bug_fix",
      success: false,
      reproductionDone: false,
      noOpDetected: false,
      memoryUsed: false,
      evidenceConfidence: 0.1,
      filesRead: 8,
      filesEdited: 4,
      testsRun: 1,
      rawCommandFailures: 3,
      verification: "broad FAIL",
      userAccepted: false
    })
  });
  const summary = summarizeDeltaBench(loadDeltaBench(cwd));
  assert.equal(summary.total, 2);
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.reproductionRate, 0.5);
  assert.equal(summary.byMode.cheater, 1);
  assert.equal(summary.byMode.vanilla, 1);
  rmSync(cwd, { recursive: true, force: true });
});
