#!/usr/bin/env node
// Kitten Ascent B3 — ORM training-data generation.
//
// The real recipe: run the coverage engine (best-of-N) over a corpus DISJOINT from every eval set
// (SWE-Gym train split, scraped GitHub issues, the user's own past kitten runs), and label each
// trajectory by the REAL oracle (did the tests pass in a clean env?). That produces {trajectory ->
// solved} pairs — genuine supervision for "what a solved trajectory looks like".
//
// Two modes:
//   --runs DIR / --manifest FILE : REAL mode. Read trajectory+label records and HARD-FAIL if any id is
//                                  in the eval registry (Law 4). This is what you run to scale.
//   --synthetic N                : PROOF-OF-LIFE mode. Deterministically fabricate N labeled
//                                  trajectories so train.mjs + eval_verifier.mjs are provable end-to-end
//                                  without hours of generation. Clearly tagged synthetic; never an eval id.
//
// Usage:
//   node gen_data.mjs --out data.jsonl --synthetic 200
//   node gen_data.mjs --out data.jsonl --manifest corpus.json   # [{id, trajectory, solved}]

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { defaultRegistry } from "../../dist/src/core/disjointness.js";

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

const out = arg("--out", "data.jsonl");
const synthetic = Number(arg("--synthetic", "0"));
const manifest = arg("--manifest", null);
const sweManifest = arg("--swe-manifest", null);
const registry = defaultRegistry(sweManifest);

/** Deterministic pseudo-random in [0,1) from an integer seed (no Math.random → reproducible data). */
function rng(seed) { let x = (seed * 2654435761) % 2 ** 31; return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }

function syntheticTrajectory(seed, solved) {
  const r = rng(seed);
  const files = ["impl.py", "parser.py", "server.py", "vm.py"][Math.floor(r() * 4)];
  const hunks = 1 + Math.floor(r() * 4);
  const lines = [`edit(${files})`];
  for (let h = 0; h < hunks; h++) lines.push(`@@ hunk ${h}`, `+    ${["return x*2", "value = compute()", "self.env[name] = v"][Math.floor(r() * 3)]}`);
  lines.push(`ran: python -m pytest -q`);
  // ~22% of examples are AMBIGUOUS — realistic overlap so the ORM isn't a trivial string match and the
  // report card shows a genuine (imperfect) verifier, not a fake AUC 1.0.
  const ambiguous = r() < 0.22;
  if (solved) {
    if (ambiguous) {
      // Weak-but-solved: it passed, but the trajectory looks risky (an error word, no verified marker).
      lines.push("earlier: AssertionError: off by one", `then ${1 + Math.floor(r() * 3)} passed`, "exit 0");
    } else {
      lines.push(`${1 + Math.floor(r() * 5)} passed`, "all tests pass, exit 0", "green execution receipt; finish: implemented and verified");
    }
  } else {
    if (ambiguous) {
      // Deceptive-unsolved: the subtly-wrong-but-self-verified attempt — mostly-green prose, ultimately failed.
      lines.push("2 passed", "finish: looks done", "…but 1 hidden case FAILED: expected 4 got 5");
    } else {
      const mode = r();
      if (mode < 0.5) lines.push("Traceback (most recent call last):", "AssertionError: expected 4 got 5", "FAILED");
      else if (mode < 0.8) lines.push("ImportError: cannot import name f", "exit 1");
      else lines.push("timeout after 120s", "process killed");
    }
  }
  return lines.join("\n");
}

const records = [];
if (synthetic > 0) {
  for (let i = 0; i < synthetic; i++) {
    const solved = i % 2 === 0;
    // ~8% irreducible noise: the trajectory "lies" relative to the true label (a flaky-but-solved run,
    // or a self-verified-but-hidden-wrong attempt). This is the error a real ORM cannot escape, so the
    // report card shows an HONEST sub-perfect verifier (AUC < 1.0, a nonzero gap to oracle), not a fake 1.0.
    const lies = rng(9000 + i)() < 0.08;
    records.push({ id: `synthetic-orm-${String(i).padStart(4, "0")}`, trajectory: syntheticTrajectory(i + 1, lies ? !solved : solved), solved });
  }
  console.error(`[gen_data] synthetic proof-of-life: ${records.length} labeled trajectories (~8% irreducible noise)`);
} else if (manifest && existsSync(manifest)) {
  const arr = JSON.parse(readFileSync(manifest, "utf8"));
  for (const rec of arr) records.push({ id: String(rec.id), trajectory: String(rec.trajectory ?? ""), solved: !!rec.solved });
  console.error(`[gen_data] real manifest: ${records.length} records`);
} else {
  console.error("gen_data: give --synthetic N or --manifest FILE");
  process.exit(2);
}

// LAW 4 — HARD-FAIL if any training id is an eval task. The store/corpus must be disjoint from evals.
const overlap = records.map((r) => r.id).filter((id) => registry.isEvalId(id));
if (overlap.length) {
  console.error(`[gen_data] DISJOINTNESS VIOLATION: ${overlap.length} training ids are eval tasks (${overlap.slice(0, 5).join(", ")}). Refusing.`);
  process.exit(3);
}

writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
const nSolved = records.filter((r) => r.solved).length;
console.error(`[gen_data] wrote ${records.length} records (${nSolved} solved / ${records.length - nSolved} unsolved) → ${out}  [disjointness OK]`);
