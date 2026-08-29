// Constraining decode exactly once, after the model's own arguments failed to parse.
//
// Two results point at the same narrow use. NVIDIA measured grammar-constrained RETRY lifting mean
// bash-task pass rate across thirteen models from 62.5% to 75.2%, largest gains on the smallest
// models. Kitten's own A/B pushed the other way: an ALWAYS-ON schema constraint cost content on the
// 2B and a prompt hint was the better fix. Retry-only is where both agree — so these tests are mostly
// about the constraint being armed for one turn and then getting out of the way.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolCallGrammar } from "../src/core/grammar.js";
import { parseTextToolCalls } from "../src/core/textToolCalls.js";
import { runAgent } from "../src/core/agent.js";
import type { ChatParams } from "../src/core/llm.js";

test("the grammar names every available tool and nothing else", () => {
  const g = toolCallGrammar(["read", "write", "bash"]);
  assert.match(g, /name ::= "read" \| "write" \| "bash"/);
  assert.match(g, /<tool_call>/);
  assert.throws(() => toolCallGrammar([]), /at least one tool name/);
});

test("the constrained format is the one the recovery parser already reads", () => {
  // The grammar is worthless if what it produces cannot be parsed back. This is the round trip.
  const emitted = [
    "<tool_call>",
    "<function=write>",
    "<parameter=path>",
    "src/a.py",
    "</parameter>",
    "<parameter=content>",
    'print("quotes \\" and \\n newlines pass through literally")',
    "</parameter>",
    "</function>",
    "</tool_call>",
  ].join("\n");
  const calls = parseTextToolCalls(emitted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write");
  assert.equal(calls[0].args.path, "src/a.py");
  assert.match(String(calls[0].args.content), /quotes/, "an unescaped payload survives — the point of the format");
});

// ── through the agent loop ──────────────────────────────────────────────────────────────────────

/** A model that emits one unparseable call, then a finish. Records the grammar seen per turn. */
function brokenArgsLlm(capabilities: Record<string, boolean>): { llm: unknown; grammars: Array<string | undefined> } {
  const grammars: Array<string | undefined> = [];
  let i = 0;
  const ok = { ok: true as const, content: "", reasoning: "", finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, elapsedMs: 1 };
  const llm = {
    inferenceCapabilities: capabilities,
    chat: async (p: ChatParams) => {
      grammars.push((p as { grammar?: string }).grammar);
      i++;
      if (i === 1) {
        return { ...ok, toolCalls: [{ id: "t1", name: "write", args: {}, raw: "{bad json", argError: "Unexpected token" }] };
      }
      return { ...ok, toolCalls: [{ id: "f", name: "finish", args: { summary: "done" }, raw: "{}" }] };
    },
    sidecar: async () => ({ ok: false }),
    embed: async () => [],
  };
  return { llm, grammars };
}

test("a parse failure on an owned engine arms a grammar for exactly the next turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-grammar-"));
  const { llm, grammars } = brokenArgsLlm({ structuredOutput: true });
  const res = await runAgent({ task: "x", cwd, llm: llm as never, maxTurns: 4 });

  assert.equal(grammars[0], undefined, "the first turn is unconstrained");
  assert.ok(grammars[1], "the turn after the parse failure is constrained");
  assert.match(grammars[1]!, /<tool_call>/);
  assert.ok(res.events.some((e) => e.kind === "nudge" && /tool-call grammar/.test(e.detail)), "and it is reported, not silent");
});

test("the constraint is disarmed immediately — it never rides along on later turns", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-grammar-off-"));
  // Three parse failures would arm it three times; the budget is two, and each arming lasts one turn.
  let i = 0;
  const grammars: Array<string | undefined> = [];
  const ok = { ok: true as const, content: "", reasoning: "", finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, elapsedMs: 1 };
  const llm = {
    inferenceCapabilities: { structuredOutput: true },
    chat: async (p: ChatParams) => {
      grammars.push((p as { grammar?: string }).grammar);
      i++;
      if (i <= 4) return { ...ok, toolCalls: [{ id: `t${i}`, name: "write", args: {}, raw: "{bad", argError: "Unexpected token" }] };
      return { ...ok, toolCalls: [{ id: "f", name: "finish", args: { summary: "done" }, raw: "{}" }] };
    },
    sidecar: async () => ({ ok: false }),
    embed: async () => [],
  } as never;

  await runAgent({ task: "x", cwd, llm, maxTurns: 8 });
  const constrained = grammars.filter(Boolean).length;
  assert.equal(constrained, 2, "the budget is two armings, and a constraint that has not helped twice will not on the third");
});

test("on an engine without grammar support the model gets advice instead, never a broken request", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-grammar-proxy-"));
  const { llm, grammars } = brokenArgsLlm({ structuredOutput: false });
  const res = await runAgent({ task: "x", cwd, llm: llm as never, maxTurns: 4 });

  assert.deepEqual(grammars.filter(Boolean), [], "a proxy is never sent a grammar it would 400 on");
  assert.ok(!res.events.some((e) => e.kind === "nudge" && /grammar/.test(e.detail)));
});
