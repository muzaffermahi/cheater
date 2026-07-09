import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractWorkedExamples, extractSetupVars, buildExampleTest, runExampleTest, renderExampleFailures
} from "../src/core/workedExamples.js";

test("extracts `symbol(args) -> result` / `== result` / `returns result` with balanced brackets", () => {
  const task = 'Implement `min_coins`. Examples: `min_coins([1,3,4], 6)` returns `2`. min_coins([2], 3) -> -1. `min_coins([], 0) == 0`.';
  const ex = extractWorkedExamples(task, ["min_coins"]);
  assert.equal(ex.length, 3);
  assert.deepEqual(ex[0], { call: "min_coins([1,3,4], 6)", expected: "2" });
  assert.deepEqual(ex[1], { call: "min_coins([2], 3)", expected: "-1" });
});

test("handles nested brackets in args and expected (list/dict literals)", () => {
  const task = 'query(data, "$.users[*].name")  ->  ["ann", "bob"]';
  const ex = extractWorkedExamples(task, ["query"]);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].call, 'query(data, "$.users[*].name")');
  assert.equal(ex[0].expected, '["ann", "bob"]');
});

test("skips abbreviated (ellipsis) examples that would false-fail", () => {
  const task = 'query(data, "$") -> [{"users": [...], "count": 2}]';
  assert.equal(extractWorkedExamples(task, ["query"]).length, 0, "an ellipsis expected is not a real literal");
});

test("extractSetupVars picks up `data = {...}` definitions", () => {
  const task = 'data = {"users": [{"name": "ann"}], "count": 2}\nquery(data, "$.count") -> [2]';
  const vars = extractSetupVars(task);
  assert.ok(vars.some((v) => v.startsWith("data = ")));
});

test("buildExampleTest + runExampleTest: correct impl passes, buggy impl reports the failing case", () => {
  const good = mkdtempSync(join(tmpdir(), "we-good-"));
  writeFileSync(join(good, "solution.py"), "def double(x):\n    return x * 2\n");
  const examples = [{ call: "double(3)", expected: "6" }, { call: "double(0)", expected: "0" }];
  const rg = runExampleTest(good, "solution.py", examples);
  assert.equal(rg.ran, true);
  assert.equal(rg.passed, 2);
  assert.equal(rg.failures.length, 0);

  const bad = mkdtempSync(join(tmpdir(), "we-bad-"));
  writeFileSync(join(bad, "solution.py"), "def double(x):\n    return x + 2\n");
  const rb = runExampleTest(bad, "solution.py", examples);
  // x+2: double(3)=5≠6 and double(0)=2≠0 → both fail.
  assert.equal(rb.failures.length, 2);
  assert.match(renderExampleFailures(rb), /ground truth/);
  assert.match(renderExampleFailures(rb), /double\(3\)/);
});

test("runExampleTest returns ran:false when the module is missing (no false signal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "we-none-"));
  const r = runExampleTest(dir, "solution.py", [{ call: "f(1)", expected: "1" }]);
  assert.equal(r.ran, false);
});

test("no examples => empty extraction, gate is a no-op", () => {
  assert.deepEqual(extractWorkedExamples("no examples here", ["f"]), []);
  assert.deepEqual(extractWorkedExamples("f(1)->2", []), [], "no symbols => nothing");
});
