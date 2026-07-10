import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectByConsensus, isCleanOutcome, runFnProbes, pickFnTarget, argsFromCall, type ProbeOutcome } from "../src/core/synthtest.js";

test("argsFromCall: parses positional args of a worked-example call into a JSON tuple", () => {
  assert.deepEqual(argsFromCall('next_times("*/15 * * * *", "2024-01-01T00:07", 4)', "next_times"), ["*/15 * * * *", "2024-01-01T00:07", 4]);
  assert.deepEqual(argsFromCall("f([1,3,4], 6)", "f"), [[1, 3, 4], 6]);
  assert.deepEqual(argsFromCall("g()", "g"), []);
  assert.equal(argsFromCall("h('single-quoted')", "h"), null, "non-JSON (single quotes) → null, sidecar covers it");
  assert.equal(argsFromCall("other(1,2)", "f"), null, "symbol mismatch → null");
});

test("pickFnTarget: a spurious second module falls back to the conventional entry (glob's x.py bug)", () => {
  // glob's contract extraction pulled ["solution.py","x.py"]; the old code bailed (needs exactly 1) and
  // silently disabled consensus. Now it prefers the conventional primary.
  assert.deepEqual(pickFnTarget({ files: ["solution.py", "x.py"], symbols: ["matches"] } as any), { module: "solution.py", symbol: "matches" });
  assert.deepEqual(pickFnTarget({ files: ["solution.py"], symbols: ["query"] } as any), { module: "solution.py", symbol: "query" });
  // No conventional primary among several ⇒ still null (genuinely ambiguous).
  assert.equal(pickFnTarget({ files: ["a.py", "b.py"], symbols: ["f"] } as any), null);
  // Class-only symbols ⇒ null (consensus-by-call doesn't fit).
  assert.equal(pickFnTarget({ files: ["solution.py"], symbols: ["Foo", "Bar"] } as any), null);
});

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

test("selectByConsensus: all attempts RAISING the same exception is agreement, not a crash", () => {
  // A malformed-input probe where every correct candidate raises ValueError. That agreement must SCORE
  // and must NOT count as everyone crashing (which wrongly made correct exception-raisers ineligible).
  const raise = (): ProbeOutcome => ({ results: [{ ok: false as const, err: "ValueError" }, { ok: true as const, val: 9 }] });
  const a = raise(), b = raise(), c = raise();
  const pick = selectByConsensus([a, b, c]);
  assert.ok(pick);
  assert.equal(pick!.crashes[0], 0, "raising where the plurality also raises is not a crash");
  assert.equal(pick!.scores[0], 2, "matches the plurality on both probes (the exception AND the value)");
});

test("selectByConsensus: a DIVERGENT exception (raises where plurality returns a value) is still a crash", () => {
  // Two candidates return a value on probe 0; the third raises there → that IS a real bug signal.
  const good = (): ProbeOutcome => ({ results: [{ ok: true as const, val: 5 }] });
  const bad: ProbeOutcome = { results: [{ ok: false as const, err: "KeyError" }] };
  const pick = selectByConsensus([good(), good(), bad]);
  assert.ok(pick);
  assert.equal(pick!.crashes[2], 1, "raising where the consensus returned a value is a crash");
  assert.notEqual(pick!.index, 2);
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
