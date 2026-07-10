import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalId, fingerprint, jaccard, EvalRegistry, DisjointnessError,
  defaultRegistry, TB2_HARD_TASKS, LOCAL_BATTERY_TASKS
} from "../src/core/disjointness.js";

test("canonicalId collapses cosmetic renames to one key", () => {
  const a = canonicalId("astropy__astropy-12345");
  assert.equal(a, "astropyastropy12345");
  assert.equal(canonicalId("astropy/astropy#12345"), a);
  assert.equal(canonicalId("Astropy Astropy 12345"), a);
});

test("jaccard is 1 for identical fingerprints, lower as texts diverge", () => {
  const a = fingerprint("build a python function that reverses a linked list in place");
  const b = fingerprint("build a python function that reverses a linked list in place");
  assert.equal(jaccard(a, b), 1);
  const c = fingerprint("write a rust program to compute prime factors of an integer");
  assert.ok(jaccard(a, c) < 0.2, "unrelated tasks share few shingles");
});

test("isEvalId matches across id forms", () => {
  const reg = new EvalRegistry();
  reg.register("swe", ["django__django-11099"]);
  assert.equal(reg.isEvalId("django__django-11099"), true);
  assert.equal(reg.isEvalId("django/django#11099"), true);
  assert.equal(reg.isEvalId("django__django-99999"), false);
});

test("assertDisjoint HARD-FAILS on an eval id in a store", () => {
  const reg = new EvalRegistry();
  reg.register("tb2", TB2_HARD_TASKS);
  // A clean store loads fine.
  reg.assertDisjoint(["my-own-repo-fix-1", "scraped-github-issue-42"], "experience");
  // A store that contains an eval task throws.
  assert.throws(
    () => reg.assertDisjoint(["ok-task", "regex-chess"], "experience"),
    (e: unknown) => e instanceof DisjointnessError && (e as DisjointnessError).overlap.includes("regex-chess")
  );
});

test("guardAdmit throws on an eval id and flags a near-duplicate by text", () => {
  const reg = new EvalRegistry();
  const text = "implement a metacircular evaluator for a scheme-like language with lambda and let";
  reg.register("tb2", ["schemelike-metacircular-eval"], { "schemelike-metacircular-eval": text });
  // Direct id collision => throw.
  assert.throws(() => reg.guardAdmit("schemelike-metacircular-eval"), DisjointnessError);
  // A different id but near-identical text => flagged as nearDup (soft), not admitted silently.
  const res = reg.guardAdmit("totally-different-id", text + " extra");
  assert.ok(res.nearDup, "near-identical text must be flagged");
  assert.ok(res.nearDup!.score > 0.8);
  // hardNearDup escalates the near-dup to a throw.
  assert.throws(() => reg.guardAdmit("totally-different-id", text, { hardNearDup: true }), DisjointnessError);
});

test("registerFromManifest loads an id array and an {id:text} object", () => {
  const dir = mkdtempSync(join(tmpdir(), "disj-"));
  const arrPath = join(dir, "ids.json");
  writeFileSync(arrPath, JSON.stringify(["astropy__astropy-1", "flask__flask-2"]));
  const reg = new EvalRegistry();
  assert.equal(reg.registerFromManifest("swe", arrPath), true);
  assert.equal(reg.isEvalId("astropy__astropy-1"), true);

  const objPath = join(dir, "map.json");
  writeFileSync(objPath, JSON.stringify({ "pytest__pytest-9": "fix the fixture teardown ordering bug" }));
  const reg2 = new EvalRegistry();
  reg2.registerFromManifest("swe", objPath);
  assert.equal(reg2.isEvalId("pytest__pytest-9"), true);
  assert.ok(reg2.nearestEval("fix the fixture teardown ordering bug")!.score > 0.8);

  // Missing manifest => graceful no-op, not a throw.
  assert.equal(new EvalRegistry().registerFromManifest("swe", join(dir, "nope.json")), false);
});

test("defaultRegistry seeds the in-repo eval sets", () => {
  const reg = defaultRegistry();
  assert.equal(reg.isEvalId("crack-7z-hash"), true);
  assert.equal(reg.isEvalId("json_query"), true);
  assert.deepEqual(new Set(reg.names()), new Set(["tb2-hard", "local-battery"]));
  assert.equal(reg.allIds().size, TB2_HARD_TASKS.length + LOCAL_BATTERY_TASKS.length);
});
