import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ExperienceStore, summarizeApproach, cosine, primeFromRetrieved,
  localizationPriorFromRetrieved, type ExperienceEntry
} from "../src/core/experience.js";
import { EvalRegistry, DisjointnessError } from "../src/core/disjointness.js";

function reg(): EvalRegistry {
  const r = new EvalRegistry();
  r.register("tb2", ["regex-chess", "crack-7z-hash"]);
  return r;
}

const entry = (over: Partial<ExperienceEntry>): ExperienceEntry => ({
  id: "my-run-1", taskText: "reverse a singly linked list in python", family: "algorithm",
  approachShape: "iterative pointer swap — touched 1 file", filesTouched: ["list.py"], verified: true, ...over
});

test("cosine similarity: identical=1, orthogonal=0", () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], [1]), 0);
});

test("summarizeApproach extracts files + hunk count, never the code body", () => {
  const diff = [
    "diff --git a/list.py b/list.py",
    "--- a/list.py",
    "+++ b/list.py",
    "@@ -1,3 +1,4 @@",
    "-    return None",
    "+    return reversed_head  # SECRET SOLUTION LINE",
  ].join("\n");
  const { shape, files } = summarizeApproach(diff, "reverse the list iteratively");
  assert.deepEqual(files, ["list.py"]);
  assert.match(shape, /reverse the list iteratively/);
  assert.match(shape, /1 file/);
  assert.ok(!/SECRET SOLUTION LINE/.test(shape), "verbatim solution code must never enter the shape");
});

test("admit + retrieve: a similar task retrieves the past solve (fingerprint fallback, no llm)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exp-"));
  const store = new ExperienceStore({ dir, registry: reg(), minScore: 0.2 });
  await store.admit(entry({}));
  await store.admit(entry({ id: "my-run-2", taskText: "compute fibonacci numbers with memoization", family: "algorithm", filesTouched: ["fib.py"] }));
  const hits = await store.retrieve("python function to reverse a singly linked list");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].entry.id, "my-run-1", "the linked-list solve is the closest match, not fibonacci");
});

test("admit REFUSES an unverified solve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exp-"));
  const store = new ExperienceStore({ dir, registry: reg() });
  await assert.rejects(() => store.admit(entry({ verified: false })), /unverified/);
});

test("admit HARD-FAILS on an eval task id (Law 4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exp-"));
  const store = new ExperienceStore({ dir, registry: reg() });
  await assert.rejects(() => store.admit(entry({ id: "regex-chess" })), DisjointnessError);
});

test("load HARD-FAILS when the store file already contains an eval id", () => {
  const dir = mkdtempSync(join(tmpdir(), "exp-"));
  // A poisoned store on disk (e.g. someone dropped a benchmark solve in).
  writeFileSync(join(dir, "store.jsonl"), JSON.stringify(entry({ id: "crack-7z-hash" })) + "\n");
  const store = new ExperienceStore({ dir, registry: reg() });
  assert.throws(() => store.load(), DisjointnessError);
});

test("primeFromRetrieved renders shape-only and is bounded; localization prior unions files", () => {
  const retrieved = [
    { entry: entry({ filesTouched: ["a.py", "b.py"] }), score: 0.8 },
    { entry: entry({ id: "r2", family: "parser", approachShape: "recursive descent", filesTouched: ["b.py", "c.py"] }), score: 0.5 }
  ];
  const prime = primeFromRetrieved(retrieved, 500);
  assert.match(prime, /adapt the SHAPE, do not copy/);
  assert.match(prime, /algorithm/);
  assert.match(prime, /parser/);
  assert.ok(prime.length <= 502);
  assert.deepEqual(localizationPriorFromRetrieved(retrieved), ["a.py", "b.py", "c.py"]);
});

test("empty store retrieves nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exp-"));
  const store = new ExperienceStore({ dir, registry: reg() });
  assert.deepEqual(await store.retrieve("anything"), []);
  assert.equal(store.size(), 0);
});
