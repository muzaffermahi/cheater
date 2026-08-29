// `kitten run`'s flag surface. It had no tests at all, which is how a flag can be advertised in the
// help text and parsed into nothing — the exact failure the --deadline-ms work was fixing on the
// benchmark side (a harness setting KITTEN_CEILING_MS that the engine had stopped reading).

import test from "node:test";
import assert from "node:assert/strict";
import { parseRunFlags } from "../src/core/runFlags.js";

const base = "/base";

test("a bare task is the whole task, with no flags set", () => {
  const f = parseRunFlags(["fix", "the", "parser"], base);
  assert.equal(f.task, "fix the parser");
  assert.equal(f.deadlineMs, 0, "no automatic wall clock unless the caller asks for one");
  assert.equal(f.json, false);
  assert.equal(f.dangerous, false);
  assert.equal(f.lane, undefined);
  assert.equal(f.cwd, base);
});

test("flags are recognised and everything else stays task text", () => {
  const f = parseRunFlags(
    ["--lane", "ascent", "--k", "5", "--effort", "careful", "--json", "--dangerous", "make", "it", "green"],
    base,
  );
  assert.equal(f.lane, "ascent");
  assert.equal(f.k, 5);
  assert.equal(f.effort, "careful");
  assert.equal(f.json, true);
  assert.equal(f.dangerous, true);
  assert.equal(f.task, "make it green");
});

test("--deadline-ms is read as a positive millisecond count", () => {
  assert.equal(parseRunFlags(["--deadline-ms", "780000", "t"], base).deadlineMs, 780000);
});

test("a malformed or negative deadline means NO deadline, never a zero-length one", () => {
  // A deadline of 0ms would cancel the run before it started — silently scoring every trial zero.
  for (const bad of ["abc", "-5", "0", ""]) {
    assert.equal(parseRunFlags(["--deadline-ms", bad, "t"], base).deadlineMs, 0, `"${bad}" must disarm, not fire`);
  }
});

test("an unknown lane is ignored rather than run as something else", () => {
  assert.equal(parseRunFlags(["--lane", "turbo", "t"], base).lane, undefined);
});

test("--yes is an alias for --dangerous, and -c for --conversation", () => {
  assert.equal(parseRunFlags(["--yes", "t"], base).dangerous, true);
  assert.equal(parseRunFlags(["-c", "conv7", "t"], base).continueId, "conv7");
});

test("--k below 1 is clamped to 1 (k=0 would run nothing)", () => {
  assert.equal(parseRunFlags(["--k", "0", "t"], base).k, 1);
  assert.equal(parseRunFlags(["--k", "-3", "t"], base).k, 1);
});
