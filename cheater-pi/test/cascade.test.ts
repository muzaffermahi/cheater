import test from "node:test";
import assert from "node:assert/strict";
import { runCascade, cascadeReceiptLines, type CascadeCandidate } from "../src/core/cascade.js";
import type { OrmScorer } from "../src/core/orm.js";

const cands = (n: number): CascadeCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ index: i + 1, workspace: `/ws/${i + 1}`, codeFiles: ["impl.py"], trajectory: i < 2 ? "good passing run" : "bad crash FAILED" }));

const goodBadOrm: OrmScorer = { kind: "fake", score: async (t) => (t.includes("good") ? 0.9 : 0.02) };
const okSyntax = () => ({ ok: true as const });

test("ORM pre-filter cuts near-zero candidates", async () => {
  const res = await runCascade(cands(6), { orm: goodBadOrm, ormFloor: 0.1, syntaxCheck: okSyntax });
  const orm = res.stages.find((s) => s.stage === "orm-prefilter")!;
  assert.deepEqual(orm.survived, [1, 2], "only the two good-scoring candidates survive");
  assert.equal(orm.cut.length, 4);
  assert.deepEqual(res.survivors, [1, 2]);
});

test("static gates cut a candidate whose changed file does not parse", async () => {
  const syntax = (_ws: string, _f: string) => (_ws.endsWith("/2") ? { ok: false, diag: "SyntaxError" } : { ok: true });
  // No ORM so only the static stage runs; candidate 2 has a broken file.
  const res = await runCascade(cands(4).map((c) => ({ ...c, trajectory: "good" })), { syntaxCheck: syntax });
  assert.equal(res.stages.find((s) => s.stage === "orm-prefilter"), undefined, "no ORM => no pre-filter stage");
  assert.ok(!res.survivors.includes(2), "the candidate with a syntax error is cut");
  assert.ok(res.survivors.includes(1));
});

test("cascade never cuts the whole field (minSurvivors floor)", async () => {
  // Every candidate scores near-zero; the floor still keeps the best one.
  const allBad: OrmScorer = { kind: "fake", score: async () => 0.01 };
  const res = await runCascade(cands(5).map((c) => ({ ...c, trajectory: "bad" })), { orm: allBad, minSurvivors: 1, syntaxCheck: okSyntax });
  assert.ok(res.survivors.length >= 1, "the cascade must not eliminate every candidate");
});

test("cascadeReceiptLines reports each stage's cuts (no silent truncation)", async () => {
  const res = await runCascade(cands(6), { orm: goodBadOrm, syntaxCheck: okSyntax });
  const lines = cascadeReceiptLines(res);
  assert.match(lines[0], /cascade: 2 survivor/);
  assert.ok(lines.some((l) => /orm-prefilter/.test(l)));
});
