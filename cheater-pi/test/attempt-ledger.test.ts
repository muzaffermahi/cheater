// A memory of what already failed.
//
// TB2's taxonomy names re-proposing an already-failed action as the long-horizon failure mode, and
// Kitten's own frictions call the same thing "loop lockout". The hard part is not detecting the
// repeat — it is not caging the legitimate edit→test→edit→test loop, where running the same command
// twice is exactly right because the world changed in between.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttemptLedger, attemptSignature, normalizeCommand, failureSignal } from "../src/core/attemptLedger.js";
import { runAgent } from "../src/core/agent.js";

// ── signatures ──────────────────────────────────────────────────────────────────────────────────

test("two spellings of one command share a signature", () => {
  assert.equal(normalizeCommand("  npm   test  "), normalizeCommand("npm test"));
  assert.equal(normalizeCommand("sudo make install"), normalizeCommand("make install"));
  assert.equal(normalizeCommand("npm test 2>&1"), normalizeCommand("npm test"));
});

test("commands that differ in intent do NOT share a signature", () => {
  assert.notEqual(attemptSignature("bash", { command: "npm test" }), attemptSignature("bash", { command: "npm run build" }));
});

test("an edit is signed by its file and what it searched for", () => {
  const a = attemptSignature("edit", { path: "src/a.ts", search: "const x = 1" });
  const b = attemptSignature("edit", { path: "src/a.ts", search: "const   x = 1" });
  assert.equal(a, b, "whitespace inside the search string is not a different attempt");
  assert.notEqual(a, attemptSignature("edit", { path: "src/b.ts", search: "const x = 1" }));
});

test("write is deliberately unsigned — repeating it is not the failure mode", () => {
  assert.equal(attemptSignature("write", { path: "a.ts", content: "x" }), null);
});

test("failureSignal keeps the line that names the failure, not the banner around it", () => {
  const out = "$ npm test\n> project@1.0.0 test\nrunning 12 tests\nAssertionError: expected 3 got 4\n[exit 1]";
  assert.match(failureSignal(out), /AssertionError/);
});

// ── the policy ──────────────────────────────────────────────────────────────────────────────────

test("the first repeat is a warning that still runs; the second is answered instead", () => {
  const ledger = new AttemptLedger();
  const call = { command: "docker build ." };

  assert.equal(ledger.consider("bash", call).blocked, false, "a first attempt is unencumbered");
  assert.equal(ledger.consider("bash", call).feedback, undefined);

  ledger.recordFailure("bash", call, "docker: command not found");
  const first = ledger.consider("bash", call);
  assert.equal(first.blocked, false, "one repeat is a warning, not a wall — the model may be about to notice");
  assert.match(first.feedback!, /already failed/);

  ledger.recordFailure("bash", call, "docker: command not found");
  const second = ledger.consider("bash", call);
  assert.equal(second.blocked, true, "a second repeat of an unchanged world is answered, not executed");
  assert.match(second.feedback!, /command not found/, "the answer carries WHY it failed");
  assert.match(second.feedback!, /change the approach/);
});

test("an edit clears the ledger: the same test command after a change is a NEW question", () => {
  // This is the test that matters. edit → test → edit → test is the correct loop; a ledger that
  // blocked the second `npm test` would break the only workflow that reliably works.
  const ledger = new AttemptLedger();
  const call = { command: "npm test" };
  ledger.recordFailure("bash", call, "1 failing");
  ledger.recordFailure("bash", call, "1 failing");
  assert.equal(ledger.consider("bash", call).blocked, true);

  ledger.noteMutation();
  assert.equal(ledger.consider("bash", call).blocked, false, "the world changed — re-running the check is right");
  assert.equal(ledger.consider("bash", call).feedback, undefined, "and it is not even warned about");
});

test("a success is not recorded — only failures are what get uselessly repeated", () => {
  const ledger = new AttemptLedger();
  assert.deepEqual(ledger.current(), []);
  ledger.recordFailure("bash", { command: "ls /nope" }, "No such file or directory");
  assert.equal(ledger.current().length, 1);
});

// ── through the real agent loop ─────────────────────────────────────────────────────────────────

function scriptedLlm(steps: Array<{ tool: string; args: Record<string, unknown> } | { finish: string }>): unknown {
  let i = 0;
  const ok = { ok: true as const, content: "", reasoning: "", finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, elapsedMs: 1 };
  return {
    chat: async () => {
      const s = steps[Math.min(i, steps.length - 1)]; i++;
      if ("finish" in s) return { ...ok, toolCalls: [{ id: `f${i}`, name: "finish", args: { summary: s.finish }, raw: "{}" }] };
      return { ...ok, toolCalls: [{ id: `t${i}`, name: s.tool, args: s.args, raw: JSON.stringify(s.args) }] };
    },
    sidecar: async () => ({ ok: false }),
    embed: async () => [],
  };
}

test("the agent loop stops paying for a command it has already failed twice", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-ledger-"));
  const bad = { tool: "bash", args: { command: "kitten-not-a-real-binary-abc" } };
  const llm = scriptedLlm([bad, bad, bad, bad, { finish: "done" }]) as never;

  const res = await runAgent({ task: "x", cwd, llm, maxTurns: 8 });

  const ran = res.events.filter((e) => e.kind === "tool" && /bash/.test(e.detail)).length;
  const blocked = res.events.filter((e) => e.kind === "gate_block" && /repeat of a failed attempt/.test(e.detail)).length;
  assert.equal(ran, 2, "it pays for the failure twice — once to learn it, once because a model may self-correct");
  assert.ok(blocked >= 1, "and then answers from the ledger instead of paying again");
});

test("the agent loop does NOT block a re-run after a successful edit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-ledger-edit-"));
  const check = { tool: "bash", args: { command: "kitten-not-a-real-binary-abc" } };
  const llm = scriptedLlm([
    check,
    check,
    { tool: "write", args: { path: "a.txt", content: "hello" } },
    check, // the world changed: this must run
    { finish: "done" },
  ]) as never;

  const res = await runAgent({ task: "x", cwd, llm, maxTurns: 10 });
  const ran = res.events.filter((e) => e.kind === "tool" && /bash/.test(e.detail)).length;
  assert.equal(ran, 3, "the check after the write is a new question and runs");
});
