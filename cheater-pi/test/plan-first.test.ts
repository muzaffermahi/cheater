import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePlans, selectPlan, parseChoice, planDirective } from "../src/core/planFirst.js";
import { runAscent, ALL_LEVERS } from "../src/core/ascent.js";
import type { KittenLLM, ChatParams, ChatResult } from "../src/core/llm.js";
import type { RunOne } from "../src/core/cloudBurst.js";

const reply = (content: string): ChatResult => ({
  content, reasoning: "", toolCalls: [], finishReason: "stop",
  usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, ok: true, elapsedMs: 1,
});

test("generatePlans asks k times, each from a different angle", async () => {
  const prompts: string[] = [];
  const llm = {
    models: { main: "fake" },
    chat: async (p: ChatParams): Promise<ChatResult> => {
      prompts.push(String(p.messages[0].content));
      return reply(`step 1\nstep 2 (${prompts.length})`);
    },
  } as unknown as KittenLLM;
  const plans = await generatePlans(llm, "build a thing", 3);
  assert.equal(plans.length, 3);
  assert.equal(new Set(prompts).size, 3, "each plan request used a distinct approach");
  for (const p of prompts) assert.match(p, /NOT writing code/, "the planner is told not to implement");
});

test("a plan that fails to generate is simply not a candidate", async () => {
  let n = 0;
  const llm = {
    models: { main: "fake" },
    chat: async (): Promise<ChatResult> => {
      n++;
      if (n === 2) throw new Error("endpoint blew up");
      return reply("a plan");
    },
  } as unknown as KittenLLM;
  const plans = await generatePlans(llm, "t", 3);
  assert.equal(plans.length, 2, "the run continues with the plans that did generate");
});

test("parseChoice reads a judge's answer and rejects an out-of-range one", () => {
  assert.equal(parseChoice("2", 3), 2);
  assert.equal(parseChoice("Plan 3", 3), 3);
  assert.equal(parseChoice("#1", 3), 1);
  assert.equal(parseChoice("7", 3), null, "out of range is not a choice");
  assert.equal(parseChoice("none of them", 3), null);
});

test("selectPlan uses the judge, and falls back to the baseline when the judge fails", async () => {
  const plans = [
    { index: 1, text: "conventional", label: "plan1" },
    { index: 2, text: "structural", label: "plan2" },
  ];
  const judge = { models: { main: "f" }, chat: async (): Promise<ChatResult> => reply("2") } as unknown as KittenLLM;
  const picked = await selectPlan(judge, "t", plans);
  assert.equal(picked.chosen?.index, 2);

  const broken = { models: { main: "f" }, chat: async (): Promise<ChatResult> => { throw new Error("down"); } } as unknown as KittenLLM;
  const fell = await selectPlan(broken, "t", plans);
  assert.equal(fell.chosen?.index, 1, "a dead judge costs quality, never the run");
  assert.match(fell.reason, /judge unavailable/);
});

test("selectPlan needs no judge for a single plan", async () => {
  let called = 0;
  const llm = { models: { main: "f" }, chat: async (): Promise<ChatResult> => { called++; return reply("1"); } } as unknown as KittenLLM;
  const only = await selectPlan(llm, "t", [{ index: 1, text: "x", label: "plan1" }]);
  assert.equal(only.chosen?.index, 1);
  assert.equal(called, 0, "no wasted call");
});

test("planDirective holds the implementer to the chosen plan", () => {
  const d = planDirective({ index: 2, text: "1. do a\n2. do b", label: "plan2" });
  assert.match(d, /1\. do a/);
  assert.match(d, /do not restart from a different design/i);
});

// ── The point of the whole thing ─────────────────────────────────────────────────────────────────
//
// Observed live: `balanced` (k=2, 2 rounds) on a single-file game produced FOUR complete
// implementations inside a 10-minute ceiling and finished none of them, because a local single-slot
// runtime runs candidates SERIALLY. k now buys plans; the expensive part happens once.

test("serial runtime: k candidates become k plans and ONE implementation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-planfirst-"));
  let planCalls = 0;
  let implementations = 0;
  const seenPrimes: string[] = [];
  const llm = {
    models: { main: "fake" },
    chat: async (p: ChatParams): Promise<ChatResult> => {
      const text = String(p.messages[0]?.content ?? "");
      if (/NOT writing code/.test(text)) { planCalls++; return reply(`1. write impl.py\n2. handle the edge case`); }
      if (/competing plans/.test(text)) return reply("2");
      return reply("{}");
    },
  } as unknown as KittenLLM;
  const runOne: RunOne = async (p) => {
    implementations++;
    seenPrimes.push(String(p.experiencePrime ?? ""));
    writeFileSync(join(p.cwd, "impl.py"), "def f(x):\n    return x * 2\n");
    return { finished: true, summary: "ok", turns: 1, toolCalls: 1, filesWritten: ["impl.py"], events: [], usage: { prompt: 1, completion: 1, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  const res = await runAscent(
    { task: "Implement `f` in impl.py. Examples: `f(2)` -> `4`; `f(3)` -> `6`.", cwd, forceSamples: 2, hardness: {} },
    { llm, runOne, levers: { ...ALL_LEVERS } }
  );
  assert.ok(planCalls >= 2, `k was spent on plans, got ${planCalls}`);
  assert.equal(implementations, 1, `the expensive part ran once, not k times (got ${implementations})`);
  assert.ok(seenPrimes[0].includes("do not restart"), "the implementer received the chosen plan");
  assert.ok(res.receipts.some((l) => /plan-first:/.test(l)), `the trade is on the receipt: ${JSON.stringify(res.receipts.slice(0, 6))}`);
});

test("a cloud burst keeps implementation-diversity — plans do not replace parallel candidates", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-planfirst-cloud-"));
  let planCalls = 0;
  let implementations = 0;
  const llm = {
    models: { main: "fake" },
    chat: async (p: ChatParams): Promise<ChatResult> => {
      if (/NOT writing code/.test(String(p.messages[0]?.content ?? ""))) planCalls++;
      return reply("{}");
    },
  } as unknown as KittenLLM;
  const runOne: RunOne = async (p) => {
    implementations++;
    writeFileSync(join(p.cwd, "impl.py"), "def f(x):\n    return x * 2\n");
    return { finished: true, summary: "ok", turns: 1, toolCalls: 1, filesWritten: ["impl.py"], events: [], usage: { prompt: 1, completion: 1, reasoning: 0 }, wallMs: 1, stopReason: "finish", contractTargets: [] };
  };
  await runAscent(
    { task: "Implement `f` in impl.py. Examples: `f(2)` -> `4`; `f(3)` -> `6`.", cwd, forceSamples: 2, hardness: {} },
    {
      llm, runOne, levers: { ...ALL_LEVERS, cloudBurst: true },
      cloudBurst: { baseUrl: "https://cloud.example/v1", apiKey: "k", model: "m", concurrency: 6 },
    }
  );
  assert.equal(planCalls, 0, "no planning phase when candidates genuinely run in parallel");
  assert.equal(implementations, 2, "the cloud path still generates k implementations");
});
