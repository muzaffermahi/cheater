import test from "node:test";
import assert from "node:assert/strict";
import { routeMessage } from "../src/core/router.js";

test("explanation/orientation → answer lane (no write tools)", () => {
  for (const q of ["explain how the tokenizer works", "what does route_message do?", "walk me through the run lifecycle"]) {
    const d = routeMessage(q);
    assert.equal(d.lane, "answer", q);
    assert.equal(d.k, 1);
  }
});

test("high-risk / ambiguous / complex change → Ascent", () => {
  // A high-risk destructive change escalates even without a large build.
  const risky = routeMessage("drop the users table and delete all migration history");
  assert.equal(risky.lane, "ascent", `risky → ${risky.lane}`);
});

test("ordinary bug fix → reliable k=1 (no best-of-N latency)", () => {
  const d = routeMessage("fix the off-by-one in parser.py so it keeps the last token");
  assert.equal(d.lane, "reliable");
  assert.equal(d.k, 1);
  assert.ok(d.reasons.some((r) => /reliable/.test(r)));
});

test("from-scratch multi-part build → Ascent k>=2", () => {
  const d = routeMessage("build a complete todo web app from scratch with a flask backend and a react frontend");
  assert.equal(d.lane, "ascent");
  assert.ok(d.k >= 2);
  assert.ok(d.hardness >= 3, `hardness ${d.hardness}`);
});

test("a single generic complexity signal does NOT over-escalate an ordinary task to Ascent", () => {
  // Regression: escalating on >=1 signal sent "test failure" / "config" tasks through best-of-N,
  // contradicting the documented "ordinary bug fix / test failure → reliable k=1" policy. Only >=2
  // signals (the codebase-wide high-complexity threshold) escalate.
  const testFix = routeMessage("fix the failing test in parser.py");
  assert.equal(testFix.lane, "reliable", `single-signal task should be reliable, got ${testFix.lane}`);
  assert.equal(testFix.k, 1);
  // Two+ complexity signals still escalate to Ascent.
  const complex = routeMessage("refactor the auth module to add caching, retries, and rate limiting across the api and the worker");
  assert.equal(complex.lane, "ascent");
  assert.ok(complex.reasons.some((r) => /multiple complexity signals/.test(r)));
});

test("explicit lane override is obeyed and recorded", () => {
  const d = routeMessage("do whatever", { lane: "bon", k: 4 });
  assert.equal(d.lane, "bon");
  assert.equal(d.k, 4);
  assert.ok(d.reasons.some((r) => /override/.test(r)));
});

test("every decision carries inspectable reasons", () => {
  for (const msg of ["explain x", "fix y", "build a full app from scratch"]) {
    const d = routeMessage(msg);
    assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0, msg);
  }
});
