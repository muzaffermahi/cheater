import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectByConsensus, isCleanOutcome, runFnProbes, type ProbeOutcome } from "../src/core/synthtest.js";

const out = (vals: unknown[]): ProbeOutcome => ({ results: vals.map((v) => ({ ok: true as const, val: v })) });
const withCrash = (vals: (unknown | "CRASH")[]): ProbeOutcome => ({
  results: vals.map((v) => (v === "CRASH" ? { ok: false as const, err: "ValueError" } : { ok: true as const, val: v }))
});

test("selectByConsensus returns null with fewer than two usable outcomes", () => {
  assert.equal(selectByConsensus([]), null);
  assert.equal(selectByConsensus([out([1, 2])]), null);
  assert.equal(selectByConsensus([out([1]), null]), null);
});

test("selectByConsensus: all attempts agree => not discriminating", () => {
  const pick = selectByConsensus([out([1, 2, 3]), out([1, 2, 3]), out([1, 2, 3])]);
  assert.ok(pick);
  assert.equal(pick!.discriminating, false, "identical outputs cannot separate attempts");
});

test("selectByConsensus: the plurality output wins, minority loses", () => {
  // attempts 0 and 1 agree (2,2); attempt 2 is the odd one out on both probes.
  const pick = selectByConsensus([out([10, 20]), out([10, 20]), out([99, 88])]);
  assert.ok(pick);
  assert.equal(pick!.discriminating, true);
  assert.notEqual(pick!.index, 2, "the minority-output attempt must not win");
  assert.equal(pick!.scores[0], 2);
  assert.equal(pick!.scores[2], 0);
});

test("selectByConsensus: an attempt that crashes where others succeed is penalised", () => {
  const pick = selectByConsensus([out([5, 6]), out([5, 6]), withCrash(["CRASH", "CRASH"])]);
  assert.ok(pick);
  assert.notEqual(pick!.index, 2);
  assert.equal(pick!.crashes[2], 2);
});

test("7 and 7.0 are treated as the same output (numeric canon)", () => {
  const pick = selectByConsensus([out([7]), out([7.0]), out([7])]);
  assert.ok(pick);
  // No disagreement after canonicalisation => not discriminating, all scores equal.
  assert.equal(pick!.discriminating, false);
});

test("isCleanOutcome: true only when every probe returned without crashing", () => {
  assert.equal(isCleanOutcome(out([1, 2, 3])), true);
  assert.equal(isCleanOutcome(withCrash([1, "CRASH"])), false);
  assert.equal(isCleanOutcome(null), false);
  assert.equal(isCleanOutcome({ results: [] }), false);
});

test("runFnProbes executes the target function and captures values + crashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "synth-"));
  writeFileSync(join(dir, "m.py"), "def add(a, b):\n    return a + b\n");
  const o = runFnProbes(dir, { module: "m.py", symbol: "add", inputs: [[1, 2], [3, 4], ["x", 1]] });
  assert.ok(o, "expected an outcome");
  assert.deepEqual(o!.results[0], { ok: true, val: 3 });
  assert.deepEqual(o!.results[1], { ok: true, val: 7 });
  assert.equal(o!.results[2].ok, false, "string + int should crash");
});

test("runFnProbes returns null when the module cannot be loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "synth-"));
  // no module written => import fails => null (no signal)
  const o = runFnProbes(dir, { module: "missing.py", symbol: "f", inputs: [[1]] });
  assert.equal(o, null);
});
