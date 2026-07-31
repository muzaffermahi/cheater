// Ascent attempt distillation (Parallel-Distill-Refine).
//
// The value of this layer is entirely in WHAT IT KEEPS and WHAT IT DROPS, so that is what these
// assert: every candidate's distinct failure survives, a stuck retry loop does not crowd them out,
// and nothing is invented about what an attempt was trying to do.

import { test } from "node:test";
import assert from "node:assert/strict";

import { distillAttempt, renderDigests, digestsAreInformative, digestReceiptLine, type AttemptDigest } from "../src/core/distill.js";
import type { BurstAttempt } from "../src/core/cloudBurst.js";

type ToolEvent = { kind: "tool"; turn: number; detail: string; data?: { error?: boolean; output?: string } };

function attempt(over: {
  index: number; stance?: string; finished?: boolean; stopReason?: string;
  filesWritten?: string[]; events?: ToolEvent[];
}): BurstAttempt {
  return {
    index: over.index,
    workspace: `/ws/${over.index}`,
    plan: { stance: over.stance ?? "root-cause" },
    result: {
      finished: over.finished ?? false,
      stopReason: over.stopReason ?? "turn budget",
      summary: "",
      filesWritten: over.filesWritten ?? [],
      events: over.events ?? [],
      usage: { prompt: 0, completion: 0, reasoning: 0 },
      wallMs: 1,
      turns: 1,
    },
  } as unknown as BurstAttempt;
}

const toolFail = (detail: string, output: string): ToolEvent => ({ kind: "tool", turn: 1, detail, data: { error: true, output } });
const toolOk = (detail: string, output = "ok"): ToolEvent => ({ kind: "tool", turn: 1, detail, data: { output } });

test("a digest records what the attempt actually did, and nothing more", () => {
  const digest = distillAttempt(attempt({
    index: 1, stance: "minimal", finished: true, stopReason: "finish gate",
    filesWritten: ["src/parser.js"],
    events: [toolOk("read(src/parser.js)"), toolFail("bash(npm test)", "AssertionError: expected 5 got 4")],
  }));

  assert.equal(digest.index, 1);
  assert.equal(digest.stance, "minimal");
  assert.equal(digest.finished, true);
  assert.deepEqual(digest.filesWritten, ["src/parser.js"]);
  assert.equal(digest.errorSignature, "AssertionError: expected 5 got 4");
  assert.equal(digest.failures.length, 1);
  assert.match(digest.failures[0], /npm test/);
  // Nothing about intent, quality, or difficulty is inferred.
  const serialized = JSON.stringify(digest).toLowerCase();
  for (const invented of ["probably", "intended", "difficult", "confidence", "score", "should have"]) {
    assert.ok(!serialized.includes(invented), `digest speculates: "${invented}"`);
  }
});

test("a stuck retry loop cannot crowd out the other candidate's failure", () => {
  // The exact reason dedup exists: an agent that runs the same broken command six times produces six
  // identical failures, and six copies of one fact would fill the budget that another attempt's
  // distinct failure needs.
  const spinning = distillAttempt(attempt({
    index: 1,
    events: Array.from({ length: 6 }, (_, i) => toolFail("bash(npm test)", `AssertionError: expected 5 got ${i}`)),
  }));
  assert.equal(spinning.failures.length, 1, "identical-shaped failures collapse to one");

  const varied = distillAttempt(attempt({
    index: 2,
    events: [
      toolFail("bash(npm test)", "AssertionError: expected 5 got 4"),
      toolFail("read(src/missing.js)", "ENOENT: no such file"),
      toolFail("bash(npm run build)", "TypeError: x is not a function"),
    ],
  }));
  assert.equal(varied.failures.length, 3, "distinct failures are all kept");
});

test("every candidate's distinct failure survives into the rendered block", () => {
  // The bug this layer fixes: the repair round used ONE failure and discarded the rest, so a second
  // candidate's different failure was never seen and could be walked straight back into.
  const digests = [
    distillAttempt(attempt({ index: 1, stance: "root-cause", events: [toolFail("bash(npm test)", "AssertionError: expected 5 got 4")] })),
    distillAttempt(attempt({ index: 2, stance: "defensive", events: [toolFail("bash(node app.js)", "ENOENT: config.json not found")] })),
  ];
  const rendered = renderDigests(digests);
  assert.match(rendered, /Attempt 1/);
  assert.match(rendered, /Attempt 2/);
  assert.match(rendered, /AssertionError/, "candidate 1's failure survives");
  assert.match(rendered, /config\.json not found/, "candidate 2's DIFFERENT failure survives");
});

test("ground-truth failure outranks tool noise for the attempt it belongs to", () => {
  const digest = distillAttempt(
    attempt({ index: 1, finished: true, events: [toolFail("bash(ls)", "warning: something")] }),
    "slugify('A B') -> got 'A B', expected 'a-b'",
  );
  const rendered = renderDigests([digest]);
  assert.match(rendered, /failed the task's own examples/);
  assert.match(rendered, /expected 'a-b'/);
  assert.ok(!rendered.includes("warning: something"), "the concrete example failure replaces weaker signal");
});

test("the block is framed as evidence, never as instructions to copy", () => {
  // A local model reads every rendered line as something to do — the Task Compiler learned this when
  // an adversarial probe in the implementer's contract made the model build defenses nobody asked for.
  const rendered = renderDigests([distillAttempt(attempt({ index: 1, events: [toolFail("bash(npm test)", "Error: boom")] }))]);
  assert.match(rendered, /evidence about the problem, not as a plan to copy/i);
  assert.ok(!/^\s*(?:do|use|implement|add|write) /im.test(rendered.replace(/Do not repeat.*/g, "")), "no bare imperatives that read as build steps");
});

test("an all-clean round produces nothing worth spending tokens on", () => {
  const clean = [distillAttempt(attempt({ index: 1, finished: true, stopReason: "finish gate", events: [toolOk("bash(npm test)")] }))];
  assert.equal(digestsAreInformative(clean), false, "a clean round teaches the next one nothing");

  const informative = [distillAttempt(attempt({ index: 1, finished: false }))];
  assert.equal(digestsAreInformative(informative), true, "an unfinished attempt is itself signal");
  assert.equal(renderDigests([]), "", "no digests renders nothing");
});

test("the rendered block stays bounded even with many noisy attempts", () => {
  const digests: AttemptDigest[] = Array.from({ length: 8 }, (_, i) => distillAttempt(attempt({
    index: i + 1,
    filesWritten: Array.from({ length: 20 }, (_, j) => `src/file${j}.js`),
    events: Array.from({ length: 10 }, (_, j) => toolFail(`bash(cmd${j})`, `Error ${j}: ${"x".repeat(500)}`)),
  })));
  const rendered = renderDigests(digests);
  assert.ok(rendered.length < 3200, `rendered block was ${rendered.length} chars`);
  for (const digest of digests) assert.ok(digest.filesWritten.length <= 8, "file lists are capped per attempt");
});

test("the receipt line says what the repair round was told", () => {
  const line = digestReceiptLine([
    distillAttempt(attempt({ index: 1, events: [toolFail("bash(npm test)", "Error: boom")] })),
    distillAttempt(attempt({ index: 2, finished: true, events: [toolOk("bash(npm test)")] }), "got 1, expected 2"),
  ]);
  assert.match(line, /distilled 2 prior attempt/);
  assert.match(line, /#1:/);
  assert.match(line, /#2:example-fail/);
});
