#!/usr/bin/env node
// Kitten Ascent B3 — train the ORM.
//
// Proof-of-life: trains a logistic-regression outcome reward model over EXECUTION-GROUNDED trajectory
// features (ormFeatures.ts) — a real, dependency-free P(solved | trajectory) the verifier loads today
// via KITTEN_ORM_CHECKPOINT. The scaled version (a fine-tuned 2B, YES/NO logprobs) is documented in
// README.md; it consumes the SAME {trajectory, solved} JSONL this script reads, so the data pipeline is
// identical either way.
//
// Usage: node train.mjs --data data.jsonl --out ckpt.json [--epochs 400] [--lr 0.3]

import { readFileSync, writeFileSync } from "node:fs";
import { extractFeatures, trainLogReg } from "../../dist/src/core/ormFeatures.js";

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

const dataPath = arg("--data", "data.jsonl");
const out = arg("--out", "ckpt.json");
const epochs = Number(arg("--epochs", "400"));
const lr = Number(arg("--lr", "0.3"));

const records = readFileSync(dataPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const examples = records.map((r) => ({ features: extractFeatures(r.trajectory), label: r.solved ? 1 : 0 }));
if (!examples.length) { console.error("train: no examples"); process.exit(2); }

const ckpt = trainLogReg(examples, { epochs, lr });
ckpt.meta = {
  n: examples.length,
  solved: examples.filter((e) => e.label === 1).length,
  corpus: "disjoint (asserted at gen_data)",
  trainedAt: new Date().toISOString(),
  note: "proof-of-life logistic-regression ORM over execution-grounded features; scale = fine-tuned 2B (see README)."
};
writeFileSync(out, JSON.stringify(ckpt, null, 2) + "\n");
console.error(`[train] trained ORM on ${examples.length} examples (${epochs} epochs) → ${out}`);
console.error(`[train] weights: ${ckpt.featureNames.map((n, i) => `${n}=${ckpt.weights[i].toFixed(2)}`).join("  ")}`);
