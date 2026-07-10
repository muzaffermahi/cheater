import test from "node:test";
import assert from "node:assert/strict";
import { deriveBans, forbiddenScan, renderBanViolation, logitBiasForBans } from "../src/core/constraints.js";
import { extractAcceptanceContract } from "../src/runstate/contract.js";

test("deriveBans pulls forbidden modules/builtins from the task's stated prohibitions", () => {
  const c1 = extractAcceptanceContract("Implement matching yourself. Do NOT use the `re` or `regex` modules.");
  assert.deepEqual(new Set(deriveBans(c1, "")), new Set(["re", "regex"]));
  const c2 = extractAcceptanceContract("A safe evaluator. Do NOT use `eval`, `exec`, `compile`, or `__import__`.");
  const b2 = new Set(deriveBans(c2, ""));
  assert.ok(b2.has("eval") && b2.has("exec") && b2.has("compile") && b2.has("__import__"));
  // No prohibition => no bans (kitten never enforces an unstated rule).
  assert.deepEqual(deriveBans(extractAcceptanceContract("Implement glob matching in solution.py."), ""), []);
});

test("forbiddenScan detects a banned import / builtin, passes clean source", () => {
  assert.match(forbiddenScan("import re\ndef f(): ...", ["re"]) || "", /import re/);
  assert.match(forbiddenScan("from re import match\n", ["re"]) || "", /from re/);
  assert.match(forbiddenScan("import importlib\nm = importlib.import_module('re')", ["re"]) || "", /import/);
  assert.match(forbiddenScan("def f(s): return eval(s)", ["eval"]) || "", /eval\s*\(/);
  assert.equal(forbiddenScan("def f(x):\n    return x*2", ["re", "eval"]), null, "clean source has no violation");
  assert.equal(forbiddenScan("# the word retry mentions re but isn't an import", ["re"]), null, "word-boundary: 'retry' is not 're'");
  assert.equal(forbiddenScan("anything", []), null);
});

test("renderBanViolation names the construct + the ban for repair", () => {
  const msg = renderBanViolation("import re", ["re", "regex"]);
  assert.match(msg, /import re/);
  assert.match(msg, /FORBIDS/);
  assert.match(msg, /rejected outright/);
});

test("logitBiasForBans returns {} without a tokenizer (non-native engine → finish-gate scan carries it)", async () => {
  const fakeLlm = { tokenize: async () => [] } as any; // LM Studio/cloud: no /tokenize
  assert.deepEqual(await logitBiasForBans(fakeLlm, ["re"]), {});
  // With a tokenizer, it hard-bans the leading token of each tell-tale string.
  const nativeLlm = { tokenize: async (s: string) => [s.length, 999] } as any;
  const bias = await logitBiasForBans(nativeLlm, ["re"]);
  assert.ok(Object.keys(bias).length > 0);
  assert.ok(Object.values(bias).every((v) => v === -100));
});
