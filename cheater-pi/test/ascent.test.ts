import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAscent, ALL_LEVERS, NO_LEVERS, type AscentConfig } from "../src/core/ascent.js";
import type { RunOne } from "../src/core/cloudBurst.js";

// A fake LLM whose model calls all degrade gracefully (keyword classifier, no probe, no embed).
const fakeLlm = { sidecar: async () => ({ ok: false }), chat: async () => ({ ok: false }), embed: async () => [] } as any;

function baseWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ascent-"));
  // The behavioral check the contract will extract, copied into every isolated candidate workspace.
  writeFileSync(join(dir, "verify.py"), "from impl import f\nassert f(2) == 4\nassert f(3) == 6\nprint('ok')\n");
  writeFileSync(join(dir, "impl.py"), "def f(x):\n    return None\n"); // placeholder, overwritten per attempt
  return dir;
}

const TASK = "Implement f in impl.py so f doubles its input. Verify with `python verify.py`.";

// Injected generator: the deterministic baseline (temperature 0) writes the CORRECT impl; warmer
// attempts write a wrong one. So exactly one candidate turns the check green.
const runOne: RunOne = async (p) => {
  const correct = (p.temperature ?? 0) === 0;
  writeFileSync(join(p.cwd, "impl.py"), correct ? "def f(x):\n    return x * 2\n" : "def f(x):\n    return x + 1\n");
  return {
    finished: true, summary: correct ? "doubled f" : "off by construction",
    turns: 2, toolCalls: 2, filesWritten: ["impl.py"],
    events: [{ turn: 1, kind: "tool", detail: "bash(python verify.py)", data: { error: !correct, output: correct ? "ok" : "AssertionError" } }],
    usage: { prompt: 100, completion: 200, reasoning: 50 }, wallMs: 10, stopReason: "finish", contractTargets: []
  };
};

test("runAscent orchestrates prime→generate→cascade→verify→adopt and selects the correct candidate", async () => {
  const cwd = baseWorkspace();
  const config: AscentConfig = { llm: fakeLlm, runOne, levers: ALL_LEVERS };
  const res = await runAscent({ task: TASK, cwd, hardness: { taskKind: "bug_fix" } }, config);

  assert.equal(res.finished, true, "a candidate passed the behavioral check");
  assert.ok(res.samples >= 2, "a hard task gets a diverse batch");
  assert.equal(res.winnerHasExecutionReceipt, true, "Law 1: winner has a green execution receipt");
  // The correct impl was adopted back into the base workspace.
  assert.match(readFileSync(join(cwd, "impl.py"), "utf8"), /return x \* 2/);
  // Receipts include the family, budget, and verifier audit lines.
  assert.ok(res.receipts.some((l) => /^family:/.test(l)));
  assert.ok(res.receipts.some((l) => /^budget:/.test(l)));
  assert.ok(res.receipts.some((l) => /verifier: winner/.test(l)));
});

test("attempt indices are globally unique across repair rounds (no cascade/verifier/measure collision)", async () => {
  // Regression: cloudBurst assigns round-local indices 1..k; a repair round's indices collided with
  // round 1, collapsing the survivorsByIndex map and misattributing Best@1. A task with worked examples
  // that every candidate FAILS never breaks early, so both rounds run and their indices must stay unique.
  const cwd = baseWorkspace();
  const taskGT = "Implement `f` in impl.py so it doubles its input. Examples: `f(2) -> 4`, `f(3) -> 6`.";
  const runWrong: RunOne = async (p) => {
    writeFileSync(join(p.cwd, "impl.py"), "def f(x):\n    return x + 1\n"); // wrong: f(2)=3, fails the examples
    return { finished: true, summary: "wrong", turns: 1, toolCalls: 1, filesWritten: ["impl.py"], events: [], usage: { prompt: 1, completion: 1, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  let captured: number[] = [];
  const config: AscentConfig = { llm: fakeLlm, runOne: runWrong, levers: ALL_LEVERS, onVerified: ({ attempts }) => { captured = attempts.map((a) => a.index); } };
  await runAscent({ task: taskGT, cwd, hardness: { taskKind: "bug_fix" } }, config);
  assert.ok(captured.length >= 4, `expected two rounds of attempts, got ${captured.length}: [${captured}]`);
  assert.equal(new Set(captured).size, captured.length, `indices must be globally unique across rounds: [${captured}]`);
});

test("candidate lifecycle hooks expose durable started/completed/rejected cards", async () => {
  const cwd = baseWorkspace();
  const events: Array<{ phase: string; index: number }> = [];
  const runWrong: RunOne = async (p) => {
    writeFileSync(join(p.cwd, "impl.py"), "def f(x):\n    return x + 1\n");
    return { finished: true, summary: "wrong", turns: 1, toolCalls: 1, filesWritten: ["impl.py"], events: [], usage: { prompt: 1, completion: 1, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  await runAscent(
    { task: "Implement `f` in impl.py. Examples: `f(2)` -> `4`; `f(3)` -> `6`.", cwd, forceSamples: 2, hardness: {} },
    { llm: fakeLlm, runOne: runWrong, levers: { ...ALL_LEVERS }, onCandidate: ({ phase, attempt }) => { events.push({ phase, index: attempt.index }); } }
  );
  assert.ok(events.filter((e) => e.phase === "started").length >= 2, "each generated candidate starts a durable card");
  assert.ok(events.some((e) => e.phase === "completed"), "candidate completion is emitted after generation");
  assert.ok(events.some((e) => e.phase === "rejected"), "execution-ineligible candidates are explained as rejected");
});

test("diversity lever OFF ⇒ a single attempt (k=1), no diverse batch", async () => {
  const cwd = baseWorkspace();
  const res = await runAscent({ task: TASK, cwd, hardness: { taskKind: "bug_fix" } }, { llm: fakeLlm, runOne, levers: { ...NO_LEVERS } });
  assert.equal(res.samples, 1, "no diversity ⇒ exactly one sample");
});

test("skills lever toggles the family-priming receipt", async () => {
  const cwd = baseWorkspace();
  const withSkills = await runAscent({ task: TASK, cwd, hardness: {} }, { llm: fakeLlm, runOne, levers: { ...ALL_LEVERS } });
  assert.ok(withSkills.receipts.some((l) => /^family:/.test(l)), "skills on ⇒ a family receipt");
  const cwd2 = baseWorkspace();
  const noSkills = await runAscent({ task: TASK, cwd: cwd2, hardness: {} }, { llm: fakeLlm, runOne, levers: { ...ALL_LEVERS, skills: false } });
  assert.ok(!noSkills.receipts.some((l) => /^family:/.test(l)), "skills off ⇒ no family receipt");
});

test("the budget ceiling caps the sample count", async () => {
  const cwd = baseWorkspace();
  // A tiny token ceiling forces k down even on a hard task.
  const res = await runAscent(
    { task: TASK, cwd, hardness: { taskKind: "bug_fix", filesInScope: 3, risk: "high" } },
    { llm: fakeLlm, runOne, levers: ALL_LEVERS, ceiling: { maxTokens: 12000 }, estTokensPerSample: 8000 }
  );
  assert.ok(res.samples <= 2, `ceiling should cap k, got ${res.samples}`);
  assert.ok(res.receipts.some((l) => /budget:/.test(l)));
});

test("runAscent still finishes with NO levers (pure single-shot verify path)", async () => {
  const cwd = baseWorkspace();
  const res = await runAscent({ task: TASK, cwd }, { llm: fakeLlm, runOne, levers: NO_LEVERS });
  assert.equal(res.finished, true);
  assert.ok(existsSync(join(cwd, "impl.py")));
});

test("mid-loop ground truth: a finished-but-WRONG round triggers a repair round instead of shipping it", async () => {
  // Base workspace + a task carrying worked examples the extractor recognizes.
  const cwd = mkdtempSync(join(tmpdir(), "ascent-gt-"));
  writeFileSync(join(cwd, "solution.py"), "def f(x):\n    return None\n");
  const taskGT = "Implement `def f(x)` in solution.py so it doubles its input. Examples: `f(2)` -> `4`; `f(3)` -> `6`.";
  // Round 1 writes a WRONG impl (passes finish gate but fails the examples); round 2 (repair) writes the
  // correct one. Tracked by a call counter so the first batch is all wrong.
  let calls = 0;
  const runOneGT: RunOne = async (p) => {
    calls++;
    const correct = calls > 2; // forceSamples:2 ⇒ calls 1,2 are round 1 (wrong), 3,4 are the repair (right)
    writeFileSync(join(p.cwd, "solution.py"), correct ? "def f(x):\n    return x * 2\n" : "def f(x):\n    return x + 1\n");
    return {
      finished: true, summary: correct ? "doubled" : "wrong", turns: 1, toolCalls: 1, filesWritten: ["solution.py"],
      events: [], usage: { prompt: 10, completion: 10, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: []
    };
  };
  const res = await runAscent({ task: taskGT, cwd, forceSamples: 2, hardness: {} }, { llm: fakeLlm, runOne: runOneGT, levers: { ...ALL_LEVERS } });
  assert.ok(res.receipts.some((l) => /finished but none pass the worked examples → repair/.test(l)), "the finished-but-wrong round must trigger a repair");
  assert.equal(res.rounds >= 2, true, "a second (repair) round ran");
  assert.match(readFileSync(join(cwd, "solution.py"), "utf8"), /return x \* 2/, "the repaired, ground-truth-correct impl is adopted");
});
