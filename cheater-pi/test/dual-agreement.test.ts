// Choosing among candidates when nothing can tell you the right answer.
//
// The 30B-class literature says selection, not coverage, is what moves the number (R2E-Gym 34.4→51,
// DeepSWE 42.2→59 on unchanged samples). These tests pin the two selection signals that read the
// executions Kitten already paid for: CodeT dual agreement, and the S* question a tie implies.

import test from "node:test";
import assert from "node:assert/strict";
import { dualAgreement, firstDisagreement, renderDisagreement, readVerdict, outcomeKey } from "../src/core/dualAgreement.js";
import type { ProbeOutcome } from "../src/core/synthtest.js";

/** A candidate that returned `vals` across the probes; `null` entries mean it crashed there. */
function outcome(vals: Array<unknown | Error>): ProbeOutcome {
  return { results: vals.map((v) => (v instanceof Error ? { ok: false as const, err: v.message } : { ok: true as const, val: v })) };
}

test("outcomeKey treats a raised exception as an outcome candidates can agree on", () => {
  assert.equal(outcomeKey({ ok: false, err: "ValueError" }), "e:ValueError");
  assert.equal(outcomeKey({ ok: true, val: 7 }), outcomeKey({ ok: true, val: 7.0 }), "7 and 7.0 are one answer");
});

test("with fewer than two opinions there is no agreement to measure, and it abstains", () => {
  const r = dualAgreement([outcome([1, 2]), null]);
  assert.equal(r.winner, null);
  assert.equal(r.discriminating, false);
});

test("identical candidates form one cluster and the earliest represents it", () => {
  const r = dualAgreement([outcome([1, 2, 3]), outcome([1, 2, 3]), outcome([1, 2, 3])]);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].members.length, 3);
  assert.equal(r.winner, 0, "within a cluster every member behaves identically; the lowest-temperature one stands for it");
  assert.equal(r.discriminating, false, "the probes did not separate anything");
});

test("a coherent pair beats an incoherent majority", () => {
  // This is the whole point of scoring both dimensions. Six candidates who each behave differently
  // agree with nobody, and per-probe plurality can still crown one of them; clustering cannot.
  const deep = Array.from({ length: 12 }, (_, i) => i);
  const outcomes: (ProbeOutcome | null)[] = [
    outcome(deep), outcome(deep),                                    // 2 candidates × 12 probes → √24
    ...Array.from({ length: 6 }, () => outcome([0, ...Array.from({ length: 11 }, (_, i) => `x${i}`)])), // 6 × 12 but a DIFFERENT behaviour
  ];
  const r = dualAgreement(outcomes);
  // Both clusters answer 12 probes cleanly, so the six win on breadth — that is correct here.
  assert.equal(r.clusters[0].members.length, 6);

  // Now make the majority incoherent: each of the six behaves differently, so they cluster alone.
  const scattered: (ProbeOutcome | null)[] = [
    outcome(deep), outcome(deep),
    ...Array.from({ length: 6 }, (_, k) => outcome(deep.map((v, i) => (i === k ? `wrong${k}` : v)))),
  ];
  const r2 = dualAgreement(scattered);
  assert.deepEqual(r2.clusters[0].members, [0, 1], "the coherent pair beats six candidates who agree with nobody");
  assert.equal(r2.winner, 0);
});

test("a cluster that only crashes scores nothing — agreeing on failure is not agreeing on an answer", () => {
  const crashers = [outcome([new Error("ValueError"), new Error("ValueError")]), outcome([new Error("ValueError"), new Error("ValueError")])];
  const workers = [outcome([1, 2])];
  const r = dualAgreement([...crashers, ...workers]);
  const crashCluster = r.clusters.find((c) => c.members.includes(0))!;
  assert.equal(crashCluster.cleanProbes, 0);
  assert.equal(crashCluster.score, 0, "two candidates raising the same exception everywhere have proved nothing");
});

test("a real split is reported as a tie only when the scores actually match", () => {
  const even = dualAgreement([outcome([1, 1]), outcome([1, 1]), outcome([2, 2]), outcome([2, 2])]);
  assert.equal(even.tied, true, "2v2 on the same probes is a genuine tie");

  const uneven = dualAgreement([outcome([1, 1]), outcome([1, 1]), outcome([1, 1]), outcome([2, 2])]);
  assert.equal(uneven.tied, false);
  assert.equal(uneven.winner, 0);
});

// ── the question a tie implies ──────────────────────────────────────────────────────────────────

test("firstDisagreement finds the probe the two leading behaviours differ on", () => {
  const r = dualAgreement([outcome([1, 5, 3]), outcome([1, 5, 3]), outcome([1, 9, 3]), outcome([1, 9, 3])]);
  const d = firstDisagreement(r)!;
  assert.equal(d.probeIndex, 1, "probes 0 and 2 agree; probe 1 is the question");
  assert.equal(d.a.outcome, "v:5");
  assert.equal(d.b.outcome, "v:9");
});

test("clusters that never disagree on an answered probe produce no question to ask", () => {
  const r = dualAgreement([outcome([1]), outcome([1])]);
  assert.equal(firstDisagreement(r), null, "no disagreement means no model call — a tie that cannot be phrased is not paid for");
});

test("the rendered question names one input and demands one character", () => {
  const r = dualAgreement([outcome([1, 5]), outcome([1, 5]), outcome([1, 9]), outcome([1, 9])]);
  const q = renderDisagreement("return the median", [[3, 1, 2]], firstDisagreement(r)!);
  assert.match(q, /\[\[3,1,2\]\]/);
  assert.match(q, /A returned 5/);
  assert.match(q, /B returned 9/);
  assert.match(q, /exactly one character/);
});

test("a raised exception is rendered as raising, not as a value", () => {
  const r = dualAgreement([outcome([new Error("ValueError")]), outcome([new Error("ValueError")]), outcome([0]), outcome([0])]);
  const q = renderDisagreement("spec", [[]], firstDisagreement(r)!);
  assert.match(q, /raised ValueError/);
});

test("only a clean verdict counts; a hedge is undecided, never a coin flip", () => {
  assert.equal(readVerdict("A"), "a");
  assert.equal(readVerdict(" B "), "b");
  assert.equal(readVerdict("U"), "undecided");
  assert.equal(readVerdict("It depends; A or B could both be right"), "undecided", "naming both is not a verdict");
  assert.equal(readVerdict(""), "undecided");
});
