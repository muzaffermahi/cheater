import test from "node:test";
import assert from "node:assert/strict";
import { parseReproOutput, runRepro } from "../src/mission/repro.js";

test("passing command produces alreadyPassing state", () => {
  const result = runRepro({ cwd: process.cwd(), command: "node -e \"process.exit(0)\"" });
  assert.equal(result.ran, true);
  assert.equal(result.result.alreadyPassing, true);
  assert.equal(result.result.exitCode, 0);
  assert.equal(result.result.failureKind, "none");
});

test("failing pytest output parses failing test", () => {
  const text = `============================= test session starts ==============================
FAILED tests/test_pagination.py::test_offset - AssertionError
assert 5 == 6
FAILED tests/test_pagination.py::test_anchor - AssertionError
2 failed in 0.12s
`;
  const parsed = parseReproOutput(text);
  assert.equal(parsed.failureKind, "test_assertion_error");
  assert.equal(parsed.failingTests.length, 2);
  assert.ok(parsed.failingTests.some((t) => t.includes("test_offset")));
});

test("import error parses package and symbol", () => {
  const text = "ModuleNotFoundError: No module named 'requests'\n";
  const parsed = parseReproOutput(text);
  assert.equal(parsed.failureKind, "import_error");
  assert.match(parsed.errorType, /modulenotfounderror/i);
});

test("no command asks instead of patching", () => {
  const result = runRepro({ cwd: process.cwd(), command: "" });
  assert.equal(result.ran, false);
  assert.equal(result.result.failureKind, "no_command");
  assert.equal(result.result.reproduced, false);
});

test("environment failure detected on missing command", () => {
  const result = runRepro({ cwd: process.cwd(), command: "definitely_not_a_real_binary_xyz" });
  assert.equal(result.result.environmentFailure, true);
});
