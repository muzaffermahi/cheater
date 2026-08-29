// Staying inside the context window without a model call.
//
// The failure being fixed was observed live: a from-scratch build that scored 13/13 on a hidden
// oracle reported itself as "model call failed: HTTP 500: Context size has been exceeded". Nothing
// in the agent loop ever removed anything from `messages`. These tests pin the three invariants that
// make masking safe — the system message and task survive, tool/assistant pairing survives, and the
// recent turns survive.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { maskOldObservations, estimateTokens, isMasked } from "../src/core/observationMask.js";
import type { ChatMessage } from "../src/core/llm.js";
import { runAgent } from "../src/core/agent.js";

/** A transcript of `pairs` assistant/tool exchanges, each tool result `size` chars long. */
function transcript(pairs: number, size: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "SYSTEM RULES" },
    { role: "user", content: "THE TASK" },
  ];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, name: "bash", content: `line-${i}\n` + "x".repeat(size) });
  }
  return messages;
}

test("a transcript that fits is left completely alone", () => {
  const messages = transcript(3, 500);
  const before = JSON.stringify(messages);
  const r = maskOldObservations(messages, { contextWindowTokens: 100_000 });
  assert.equal(r.masked, 0);
  assert.equal(JSON.stringify(messages), before, "no window pressure, no rewriting");
});

test("masking is off entirely when no window is known", () => {
  const messages = transcript(40, 4000);
  assert.equal(maskOldObservations(messages, {}).masked, 0, "an unknown window must not trigger guesswork");
});

test("an oversized transcript sheds oldest tool output first, and only tool output", () => {
  const messages = transcript(20, 4000);
  const before = estimateTokens(messages);
  const r = maskOldObservations(messages, { contextWindowTokens: 4096 });

  assert.ok(r.masked > 0, "something was elided");
  assert.ok(estimateTokens(messages) < before, "the prompt actually got smaller");
  assert.equal(messages[0].content, "SYSTEM RULES", "the system message is untouchable — it is the cache prefix");
  assert.equal(messages[1].content, "THE TASK", "the task is the only thing the run is about");
  assert.ok(isMasked(messages[3]), "the OLDEST tool result went first");
  for (const m of messages) {
    if (m.role === "assistant") assert.ok(m.tool_calls?.length, "no assistant tool-call turn was rewritten");
  }
});

test("message COUNT never changes — an orphaned tool result is a template error, not a smaller prompt", () => {
  const messages = transcript(20, 4000);
  const n = messages.length;
  maskOldObservations(messages, { contextWindowTokens: 4096 });
  assert.equal(messages.length, n);
  // Every tool message still answers an assistant tool call, in order.
  for (let i = 2; i < messages.length; i += 2) {
    assert.equal(messages[i].role, "assistant");
    assert.equal(messages[i + 1].role, "tool");
    assert.equal(messages[i + 1].tool_call_id, messages[i].tool_calls![0].id);
  }
});

test("the recent turns survive while the budget allows — masking the live window is amnesia", () => {
  // Mild pressure: eliding the old half is enough, so the recent window is never touched.
  const messages = transcript(40, 2000);
  maskOldObservations(messages, { contextWindowTokens: 32768, keepRecent: 8 });
  for (let i = messages.length - 8; i < messages.length; i++) {
    assert.ok(!isMasked(messages[i]), `message ${i} is inside the live window and must survive`);
  }
});

test("under extreme pressure it walks the boundary in, but never touches the final exchange", () => {
  // Four 4 KB outputs against a 4k window is bigger than the whole context on its own. Keeping the
  // recent past is a preference, not a guarantee — a run that cannot fit its last exchanges still
  // has to make the call. What is guaranteed is that the LAST one survives.
  const messages = transcript(20, 4000);
  maskOldObservations(messages, { contextWindowTokens: 4096, keepRecent: 8 });
  assert.ok(!isMasked(messages[messages.length - 1]), "the newest tool result is what the model is working from");
  assert.ok(messages.filter(isMasked).length > 8, "and it did shed enough to be worth doing");
});

test("a stub remembers what it replaced, so the model can decide to re-read", () => {
  const messages = transcript(20, 4000);
  maskOldObservations(messages, { contextWindowTokens: 4096 });
  const stub = messages.find(isMasked)!;
  assert.match(stub.content, /\d+ chars/, "how much was there");
  assert.match(stub.content, /line-0/, "what it began with");
  assert.match(stub.content, /Re-run the command or re-read the file/, "and what to do about it");
});

test("masking is idempotent — a second pass does not re-stub a stub", () => {
  const messages = transcript(20, 4000);
  maskOldObservations(messages, { contextWindowTokens: 4096 });
  const after = JSON.stringify(messages);
  const second = maskOldObservations(messages, { contextWindowTokens: 4096 });
  assert.equal(second.masked, 0, "nothing left that is worth eliding");
  assert.equal(JSON.stringify(messages), after);
});

test("small tool results are left alone — the stub would cost more than the output", () => {
  const messages = transcript(60, 80);
  maskOldObservations(messages, { contextWindowTokens: 4096, minMaskableChars: 400 });
  assert.equal(messages.filter(isMasked).length, 0);
});

// ── through the real agent loop ─────────────────────────────────────────────────────────────────

function chattyLlm(steps: number): unknown {
  let i = 0;
  const ok = { ok: true as const, content: "", reasoning: "", finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, elapsedMs: 1 };
  return {
    chat: async (p: { messages: ChatMessage[] }) => {
      // Record the largest prompt the loop ever built, so the test can assert it stayed bounded.
      seen.push(estimateTokens(p.messages));
      if (i++ >= steps) return { ...ok, toolCalls: [{ id: "f", name: "finish", args: { summary: "done" }, raw: "{}" }] };
      return {
        ...ok,
        toolCalls: [{ id: `t${i}`, name: "bash", args: { command: `node -e "console.log('y'.repeat(9000))"` }, raw: "{}" }],
      };
    },
    sidecar: async () => ({ ok: false }),
    embed: async () => [],
  };
}
const seen: number[] = [];

test("a chatty run stays inside its window instead of growing until the engine refuses", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-mask-loop-"));
  seen.length = 0;
  await runAgent({ task: "x", cwd, llm: chattyLlm(12) as never, maxTurns: 14, contextWindowTokens: 8192 });
  const peak = Math.max(...seen);
  assert.ok(peak < 8192, `the prompt never reached the window (peak ${peak} of 8192)`);

  // Control: the same run with no declared window grows unchecked. This is what used to happen.
  seen.length = 0;
  await runAgent({ task: "x", cwd, llm: chattyLlm(12) as never, maxTurns: 14 });
  assert.ok(Math.max(...seen) > 8192, "without a window there is nothing to mask against, and it grows");
});
