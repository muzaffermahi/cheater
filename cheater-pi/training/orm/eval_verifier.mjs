#!/usr/bin/env node
// Kitten Ascent B3/D — the verifier's report card.
//
// SWE-Gym's whole thesis: a mediocre verifier leaves ~10.8 points on the table (Best@k 32 vs pass@k 42.8).
// This measures how much of that gap the ORM closes: it holds out a split of the labeled data, scores it,
// and reports (1) AUC — does the ORM rank solved above unsolved; (2) accuracy at 0.5; and (3) the Best@1
// LIFT — group candidates into synthetic tasks and compare "pick the ORM's top" vs "pick at random" vs
// "oracle (pass@k)". The Best@1→pass@k gap here is the verifier's report card in miniature.
//
// Usage: node eval_verifier.mjs --data data.jsonl --ckpt ckpt.json [--split 0.3] [--group 8]

import { readFileSync } from "node:fs";
import { extractFeatures, scoreLogReg, rankAuc } from "../../dist/src/core/ormFeatures.js";

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

const dataPath = arg("--data", "data.jsonl");
const ckptPath = arg("--ckpt", "ckpt.json");
const split = Number(arg("--split", "0.3"));
const group = Number(arg("--group", "8"));

const records = readFileSync(dataPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const ckpt = JSON.parse(readFileSync(ckptPath, "utf8"));

// Deterministic held-out split + shuffle (no Math.random → reproducible), so synthetic k-candidate
// "tasks" are a realistic MIX of solved/unsolved rather than an artifact of the interleaved order.
function rng(seed) { let x = (seed * 2654435761) % 2 ** 31; return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }
const rand = rng(1234567);
const shuffled = [...records];
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const cut = Math.floor(shuffled.length * (1 - split));
const heldOut = shuffled.slice(cut);
const scored = heldOut.map((r) => ({ score: scoreLogReg(extractFeatures(r.trajectory), ckpt), label: r.solved ? 1 : 0 }));

const auc = rankAuc(scored);
const acc = scored.filter((s) => (s.score >= 0.5 ? 1 : 0) === s.label).length / Math.max(1, scored.length);

// Best@1 lift: chunk the held-out set into synthetic k-candidate "tasks"; within each, ORM picks the
// highest-scored (Best@1), a random pick's EXPECTED solve rate is the group mean, oracle = any solved
// (pass@k). This is the verifier's report card: ORM should sit between random and the oracle ceiling.
let ormSolved = 0, randExpected = 0, oracleSolved = 0, groups = 0;
for (let i = 0; i + group <= scored.length; i += group) {
  const chunk = scored.slice(i, i + group);
  groups++;
  const ormPick = chunk.reduce((a, b) => (b.score > a.score ? b : a));
  ormSolved += ormPick.label;
  randExpected += chunk.reduce((s, c) => s + c.label, 0) / chunk.length; // E[pick uniformly at random]
  oracleSolved += chunk.some((c) => c.label === 1) ? 1 : 0;
}
const randSolved = randExpected;

const pct = (x) => (100 * x).toFixed(1);
console.log("── ORM verifier report card ──────────────────────────────");
console.log(`held-out examples : ${scored.length}  (split ${split})`);
console.log(`AUC (rank solved>unsolved) : ${auc.toFixed(3)}   [0.5 = chance, 1.0 = perfect]`);
console.log(`accuracy @0.5              : ${pct(acc)}%`);
if (groups) {
  console.log(`Best@1 (ORM picks)        : ${pct(ormSolved / groups)}%   over ${groups} synthetic ${group}-candidate tasks`);
  console.log(`Best@1 (random picks)     : ${pct(randSolved / groups)}%`);
  console.log(`pass@k (oracle ceiling)   : ${pct(oracleSolved / groups)}%`);
  console.log(`ORM lift over random      : +${pct(ormSolved / groups - randSolved / groups)} pts   (gap to oracle: ${pct(oracleSolved / groups - ormSolved / groups)} pts)`);
}
console.log("──────────────────────────────────────────────────────────");
