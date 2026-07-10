import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractFeatures, FEATURE_NAMES, trainLogReg, scoreLogReg, FeatureOrm,
  loadFeatureOrm, rankAuc, sigmoid
} from "../src/core/ormFeatures.js";

const SOLVED = "edit(impl.py)\nran pytest -q\n3 passed\nall tests pass, exit 0\nfinish: fixed the bug";
const UNSOLVED = "edit(impl.py)\nran pytest -q\nTraceback (most recent call last)\nAssertionError: expected 4 got 5\nFAILED";

test("extractFeatures returns a fixed-length grounded vector", () => {
  const f = extractFeatures(SOLVED);
  assert.equal(f.length, FEATURE_NAMES.length);
  assert.equal(f[FEATURE_NAMES.indexOf("hasPassingRun")], 1);
  assert.equal(f[FEATURE_NAMES.indexOf("finished")], 1);
  const g = extractFeatures(UNSOLVED);
  assert.equal(g[FEATURE_NAMES.indexOf("hasFailingRun")], 1);
  assert.ok(g[FEATURE_NAMES.indexOf("errorDensity")] > 0);
});

test("trainLogReg learns to separate solved from unsolved trajectories", () => {
  const examples = [
    ...Array.from({ length: 8 }, () => ({ features: extractFeatures(SOLVED), label: 1 })),
    ...Array.from({ length: 8 }, () => ({ features: extractFeatures(UNSOLVED), label: 0 }))
  ];
  const ckpt = trainLogReg(examples);
  const pSolved = scoreLogReg(extractFeatures(SOLVED), ckpt);
  const pUnsolved = scoreLogReg(extractFeatures(UNSOLVED), ckpt);
  assert.ok(pSolved > 0.6, `solved should score high, got ${pSolved.toFixed(2)}`);
  assert.ok(pUnsolved < 0.4, `unsolved should score low, got ${pUnsolved.toFixed(2)}`);
  assert.ok(pSolved > pUnsolved);
});

test("FeatureOrm scores via a checkpoint and loads from disk", async () => {
  const examples = [
    ...Array.from({ length: 10 }, () => ({ features: extractFeatures(SOLVED), label: 1 })),
    ...Array.from({ length: 10 }, () => ({ features: extractFeatures(UNSOLVED), label: 0 }))
  ];
  const ckpt = trainLogReg(examples);
  const dir = mkdtempSync(join(tmpdir(), "orm-"));
  const path = join(dir, "ckpt.json");
  writeFileSync(path, JSON.stringify(ckpt));
  const orm = loadFeatureOrm(path);
  assert.ok(orm instanceof FeatureOrm);
  assert.ok((await orm!.score(SOLVED)) > (await orm!.score(UNSOLVED)));
  assert.equal(loadFeatureOrm(join(dir, "missing.json")), null);
});

test("rankAuc measures the verifier's discriminating power", () => {
  const perfect = rankAuc([{ score: 0.9, label: 1 }, { score: 0.8, label: 1 }, { score: 0.2, label: 0 }, { score: 0.1, label: 0 }]);
  assert.equal(perfect, 1);
  const chance = rankAuc([{ score: 0.5, label: 1 }, { score: 0.5, label: 0 }]);
  assert.equal(chance, 0.5);
});

test("sigmoid is monotone and centered", () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(sigmoid(3) > 0.9 && sigmoid(-3) < 0.1);
});
