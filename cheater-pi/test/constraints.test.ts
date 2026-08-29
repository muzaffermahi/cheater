import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveBans, forbiddenScan, renderBanViolation, logitBiasForBans, buildBanDecode } from "../src/core/constraints.js";
import { runAgent } from "../src/core/agent.js";
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

// ── the hard ban, end to end ────────────────────────────────────────────────────────────────────
// The decode-time ban has only ever been exercised at its two ends: deriveBans on one side and the
// finish-gate source scan on the other. The MIDDLE — does a native tokenizer's ban actually reach the
// wire as logit_bias on every turn — was verified by reading the code. This drives the real agent loop
// against a fake native engine, which is the part a live llama.cpp would otherwise have to prove.

test("a native engine's token ban reaches the wire on EVERY turn, not just the first", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-ban-e2e-"));
  const contract = extractAcceptanceContract("Implement matching yourself in solution.py. Do NOT use the `re` module.");

  // A native-shaped engine: /tokenize answers, so the hard ban is buildable.
  const tokenized: string[] = [];
  const sent: Array<Record<number, number> | undefined> = [];
  let turn = 0;
  const ok = { ok: true as const, content: "", reasoning: "", finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, elapsedMs: 1 };
  const nativeLlm = {
    inferenceCapabilities: { structuredOutput: true },
    tokenize: async (s: string) => { tokenized.push(s); return [s.charCodeAt(0), 42]; },
    chat: async (p: { logitBias?: Record<number, number> }) => {
      sent.push(p.logitBias);
      turn++;
      if (turn === 1) return { ...ok, toolCalls: [{ id: "t1", name: "bash", args: { command: "node -e \"console.log(1)\"" }, raw: "{}" }] };
      return { ...ok, toolCalls: [{ id: "f", name: "finish", args: { summary: "done" }, raw: "{}" }] };
    },
    sidecar: async () => ({ ok: false }),
    embed: async () => [],
  } as any;

  const ban = await buildBanDecode(nativeLlm, contract, "");
  assert.deepEqual(ban.bans, ["re"], "the ban is derived from the task's own prohibition");
  assert.ok(Object.keys(ban.logitBias).length > 0, "and a native tokenizer turns it into token ids");
  assert.ok(tokenized.some((s) => s.startsWith("import re")), "the tell-tale strings are what get tokenized");

  await runAgent({ task: "match without re", cwd, llm: nativeLlm, maxTurns: 4, decode: { logitBias: ban.logitBias } });

  assert.ok(sent.length >= 2, "more than one turn ran");
  for (const [i, bias] of sent.entries()) {
    assert.ok(bias && Object.keys(bias).length > 0, `turn ${i + 1} carried the ban`);
    assert.ok(Object.values(bias!).every((v) => v === -100), "a ban is a hard -100, not a nudge");
  }
});

test("the same task on a proxy engine falls back to the scan rather than sending a ban it cannot honour", async () => {
  const contract = extractAcceptanceContract("Implement matching yourself in solution.py. Do NOT use the `re` module.");
  const proxyLlm = { tokenize: async () => [] } as any; // no /tokenize
  const ban = await buildBanDecode(proxyLlm, contract, "");
  assert.deepEqual(ban.bans, ["re"], "the prohibition is still known");
  assert.deepEqual(ban.logitBias, {}, "but nothing is sent to an engine that cannot enforce it");
  // The scan is what carries it there, and it still catches the construct.
  assert.match(forbiddenScan("import re\n", ban.bans) ?? "", /import re/);
});
