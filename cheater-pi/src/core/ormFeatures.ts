// Kitten Ascent B3 — ORM features + a runnable trained verifier (the proof-of-life).
//
// The scaled ORM is a fine-tuned 2B predicting YES/NO from a trajectory (training/orm/ documents that
// job — it needs a GPU + hours). But an outcome reward model is just P(solved | trajectory), and we can
// train a REAL one in-session over cheap, EXECUTION-GROUNDED features so the whole data→train→eval loop
// is proven end-to-end and produces an actual checkpoint the verifier can load today. This module is the
// single source of truth for the features, shared by the training scripts (which import it from dist)
// and by the FeatureOrm inference class — so what we train on is exactly what we score with.
//
// The features are deliberately grounded in what a trajectory EXECUTED, not its prose confidence: did a
// check actually pass, did anything crash, did it finish, how big was the change. That is what makes the
// learned score track real solves rather than the model's self-report (Law 3).

import { existsSync, readFileSync } from "node:fs";
import type { OrmScorer } from "./orm.js";

export const FEATURE_NAMES = [
  "hasPassingRun", "hasFailingRun", "hasExecutionReceipt", "errorDensity",
  "diffSize", "finished", "reasoningLen", "editCount", "verifiedMarker", "crashMarker"
] as const;

const PASS_RE = /\b(tests? pass(ed)?|all pass|\bok\b|exit(ed)? 0|green|passed\b|100%|success)\b/i;
const FAIL_RE = /\b(fail(ed|ure)?|assertionerror|traceback|error:|exception|did not pass|red\b|exit(ed)? [1-9])\b/i;
const RUN_RE = /\b(pytest|unittest|python3?\s+\S|node\s+\S|npm\s+(run\s+)?test|go\s+test|cargo\s+test|\.\/\S|curl\s)/i;
const ERROR_TOKEN_RE = /\b([A-Za-z]*(Error|Exception)|traceback|undefined|not found|cannot|segfault)\b/gi;

/** Extract the fixed-length feature vector from a trajectory string. Order matches FEATURE_NAMES. */
export function extractFeatures(trajectory: string): number[] {
  const t = trajectory || "";
  const lines = t.split(/\r?\n/);
  const errorMatches = t.match(ERROR_TOKEN_RE) ?? [];
  const diffLines = lines.filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).length;
  const edits = (t.match(/\b(edit|write)\(/gi) ?? []).length + (t.match(/^diff --git/gm) ?? []).length;
  return [
    PASS_RE.test(t) ? 1 : 0,
    FAIL_RE.test(t) ? 1 : 0,
    RUN_RE.test(t) ? 1 : 0,
    Math.min(1, errorMatches.length / 10),                 // error density, capped
    Math.min(1, diffLines / 60),                           // change size, normalised
    /\bfinish(ed)?\b/i.test(t) ? 1 : 0,
    Math.min(1, t.length / 6000),                          // trajectory length proxy for reasoning depth
    Math.min(1, edits / 6),
    /\b(verified|receipt|green execution|red-then-green)\b/i.test(t) ? 1 : 0,
    /\b(crash|segfault|core dumped|killed|timeout)\b/i.test(t) ? 1 : 0
  ];
}

export function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

export interface LogRegCheckpoint {
  kind: "orm-logreg";
  featureNames: readonly string[];
  weights: number[];
  bias: number;
  /** Metadata for auditability: how many examples, what corpus, the disjointness guarantee. */
  meta?: Record<string, unknown>;
}

/** P(solved) from a logistic-regression checkpoint applied to a trajectory. */
export function scoreLogReg(features: number[], ckpt: LogRegCheckpoint): number {
  let z = ckpt.bias;
  for (let i = 0; i < features.length && i < ckpt.weights.length; i++) z += features[i] * ckpt.weights[i];
  return sigmoid(z);
}

/**
 * Train a logistic-regression ORM by full-batch gradient descent. Real, deterministic, dependency-free.
 * examples: [{ features, label }] where label ∈ {0,1}. Returns a checkpoint.
 */
export function trainLogReg(examples: Array<{ features: number[]; label: number }>, opts: { epochs?: number; lr?: number } = {}): LogRegCheckpoint {
  const dim = FEATURE_NAMES.length;
  const weights = new Array(dim).fill(0);
  let bias = 0;
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.3;
  const n = Math.max(1, examples.length);
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(dim).fill(0);
    let gb = 0;
    for (const ex of examples) {
      let z = bias;
      for (let i = 0; i < dim; i++) z += ex.features[i] * weights[i];
      const err = sigmoid(z) - ex.label;
      for (let i = 0; i < dim; i++) gw[i] += err * ex.features[i];
      gb += err;
    }
    for (let i = 0; i < dim; i++) weights[i] -= lr * (gw[i] / n);
    bias -= lr * (gb / n);
  }
  return { kind: "orm-logreg", featureNames: FEATURE_NAMES, weights, bias };
}

/** An ORM backed by a trained logistic-regression checkpoint over trajectory features. */
export class FeatureOrm implements OrmScorer {
  readonly kind = "trained-features";
  constructor(private ckpt: LogRegCheckpoint) {}
  async score(trajectory: string): Promise<number> {
    return scoreLogReg(extractFeatures(trajectory), this.ckpt);
  }
}

/** Load a FeatureOrm from a checkpoint file, or null if absent/invalid. */
export function loadFeatureOrm(checkpointPath: string): FeatureOrm | null {
  if (!existsSync(checkpointPath)) return null;
  try {
    const ckpt = JSON.parse(readFileSync(checkpointPath, "utf8")) as LogRegCheckpoint;
    if (ckpt.kind === "orm-logreg" && Array.isArray(ckpt.weights)) return new FeatureOrm(ckpt);
  } catch { /* ignore */ }
  return null;
}

/**
 * AUC (probability a random solved trajectory scores above a random unsolved one) — the verifier's
 * discriminating power. 0.5 = no better than chance; 1.0 = perfect ranking.
 */
export function rankAuc(scored: Array<{ score: number; label: number }>): number {
  const pos = scored.filter((s) => s.label === 1);
  const neg = scored.filter((s) => s.label === 0);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
