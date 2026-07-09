import test from "node:test";
import assert from "node:assert/strict";
import { selfCertainty, aggregateSelfCertainty } from "../src/core/selfCertainty.js";
import type { TokenLogprob } from "../src/core/llm.js";

// A near-deterministic token: top-1 dominates.
const peaked = (): TokenLogprob => ({ token: "x", logprob: -0.01, top: [{ token: "x", logprob: -0.01 }, { token: "y", logprob: -5 }, { token: "z", logprob: -6 }] });
// A hesitant token: the top-k are ~uniform.
const uniform = (): TokenLogprob => ({ token: "a", logprob: Math.log(1 / 3), top: [{ token: "a", logprob: Math.log(1 / 3) }, { token: "b", logprob: Math.log(1 / 3) }, { token: "c", logprob: Math.log(1 / 3) }] });

test("self-certainty is high for peaked distributions, low for uniform", () => {
  const hi = selfCertainty([peaked(), peaked(), peaked()]);
  const lo = selfCertainty([uniform(), uniform(), uniform()]);
  assert.ok(hi > 0.8, `peaked should be certain, got ${hi}`);
  assert.ok(lo < 0.1, `uniform should be uncertain, got ${lo}`);
  assert.ok(hi > lo);
});

test("self-certainty is length-invariant (a mean), not mean-logprob", () => {
  // Two peaked tokens vs twenty peaked tokens → same certainty (a mean), unlike a summed logprob.
  assert.ok(Math.abs(selfCertainty(Array(2).fill(0).map(peaked)) - selfCertainty(Array(20).fill(0).map(peaked))) < 1e-9);
});

test("empty / no-logprobs → neutral 0.5 (no signal)", () => {
  assert.equal(selfCertainty(undefined), 0.5);
  assert.equal(selfCertainty([]), 0.5);
});

test("aggregateSelfCertainty weights by token count across turns", () => {
  const r = aggregateSelfCertainty([Array(10).fill(0).map(peaked), Array(2).fill(0).map(uniform), undefined]);
  assert.equal(r.tokens, 12);
  // 10 peaked (~1) dominate 2 uniform (~0) → weighted mean near 10/12.
  assert.ok(r.selfCertainty > 0.7);
});
