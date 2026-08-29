import test from "node:test";
import assert from "node:assert/strict";
import {
  bestSample, calibrationFingerprint, calibrationLadder, fellOffCliff, planTuning, scoreSample,
  WORKING_CONTEXT_TOKENS,
} from "../src/core/autoTune.js";

/** The reference machine the sweep was run on: RTX 4060 8 GB, 40-layer 35B MoE at Q5_K_M. */
const REFERENCE = {
  modelBytes: 24.73e9,
  vramBytes: 8.586e9,
  ramBytes: 34e9,
  meta: { architecture: "qwen35moe", blockCount: 40, headCount: 40, headCountKv: 8, embeddingLength: 5120, contextLength: 262144, expertCount: 128 },
  kvBytesPerToken: 21504,
  mixtureOfExperts: true,
};

test("the plan stops taking context the experts need", () => {
  // The bug this encodes: the old plan asked for the largest window the card would hold (131072),
  // the KV cache ate the card, every expert was evicted, and decode fell to 10.9 tok/s.
  const plan = planTuning(REFERENCE);
  assert.equal(plan.contextTokens, WORKING_CONTEXT_TOKENS, "a working window, not the largest one that fits");
  assert.ok(plan.cpuMoeLayers !== null && plan.cpuMoeLayers > 0, "and a partial split rather than a blanket eviction");
  assert.equal(plan.blanketCpuMoe, false);
});

test("the split lands near the measured optimum, on the safe side of the cliff", () => {
  // Measured on the reference machine: 30 → 14.7 tok/s, 29 → 10.7. The cliff is one layer wide, so
  // the estimate must approach from above. Landing at 30-33 is right; below 30 is a collapse.
  const plan = planTuning(REFERENCE);
  assert.ok(plan.cpuMoeLayers !== null);
  assert.ok(plan.cpuMoeLayers! >= 30, `must not undercut the measured cliff at 30, got ${plan.cpuMoeLayers}`);
  assert.ok(plan.cpuMoeLayers! <= 34, `must stay close to the optimum, got ${plan.cpuMoeLayers}`);
});

test("batch geometry is left to llama.cpp, because forcing a big one measured 2.3x slower", () => {
  // The correction that cost the most to learn: a 4096 batch allocates a compute buffer that pushes
  // the expert split over the cliff. Same split, same window, one warm session: 14.27 tok/s forced
  // against 32.12 tok/s with the default — and the prefill it was meant to buy was worse as well.
  const plan = planTuning(REFERENCE);
  assert.equal(plan.batchSize, 0, "0 means: say nothing, let llama.cpp choose");
  assert.equal(plan.ubatchSize, 0);
});

test("a model that fits keeps every expert on the GPU and spends the slack on context", () => {
  // Same model, a card that can hold it. Nothing should be offloaded, and the window should grow
  // because the VRAM is genuinely free rather than taken from the experts.
  const plan = planTuning({ ...REFERENCE, vramBytes: 48e9 });
  assert.equal(plan.cpuMoeLayers, 0, "nothing is offloaded when nothing needs to be");
  assert.equal(plan.blanketCpuMoe, false);
  assert.ok(plan.contextTokens > WORKING_CONTEXT_TOKENS, `spare VRAM buys window, got ${plan.contextTokens}`);
  assert.ok(plan.reasons.some((r) => /room the experts do not need/.test(r)));
});

test("a model far too large for the card falls back to the blanket split", () => {
  const plan = planTuning({ ...REFERENCE, modelBytes: 400e9 });
  assert.equal(plan.blanketCpuMoe, true);
  assert.equal(plan.cpuMoeLayers, null);
  assert.ok(plan.reasons.some((r) => /every expert runs on the CPU/.test(r)));
});

test("a dense model gets a layer count instead of an expert split", () => {
  const dense = { ...REFERENCE, modelBytes: 30e9, mixtureOfExperts: false, meta: { ...REFERENCE.meta, architecture: "llama", expertCount: undefined } };
  const plan = planTuning(dense);
  assert.equal(plan.cpuMoeLayers, null, "there are no experts to move");
  assert.notEqual(plan.gpuLayers, "all", "and it cannot all live in 8.6 GB");
  assert.ok(typeof plan.gpuLayers === "number" && plan.gpuLayers > 0 && plan.gpuLayers < 40);
  // The same model on a card that fits it keeps every layer.
  assert.equal(planTuning({ ...dense, vramBytes: 48e9 }).gpuLayers, "all");
});

test("a pinned context is honoured and never grown behind the user's back", () => {
  const plan = planTuning({ ...REFERENCE, vramBytes: 48e9, contextTokens: 8192 });
  assert.equal(plan.contextTokens, 8192);
  assert.ok(plan.reasons.some((r) => /pinned/i.test(r)));
});

test("an unmeasurable machine takes the safe path rather than a confident guess", () => {
  const plan = planTuning({ modelBytes: 24.7e9, mixtureOfExperts: true });
  assert.equal(plan.blanketCpuMoe, true, "no VRAM reading at all: assume it does not fit");
  assert.ok(plan.reasons.some((r) => /could not be read|does not fit/.test(r)));

  // But "no layer count" is not the same as "no information". When the sizes are known and the model
  // comfortably fits the card, evicting every expert would be a self-inflicted slowdown.
  const fitsAnyway = planTuning({ modelBytes: 8e9, vramBytes: 24e9, mixtureOfExperts: true });
  assert.equal(fitsAnyway.blanketCpuMoe, false);
  assert.ok(fitsAnyway.reasons.some((r) => /fit .* comfortably/.test(r)));
});

test("the context never exceeds what the model was trained for", () => {
  const plan = planTuning({ ...REFERENCE, vramBytes: 80e9, meta: { ...REFERENCE.meta, contextLength: 8192 } });
  assert.ok(plan.contextTokens <= 16384, `trained for 8192, asked for ${plan.contextTokens}`);
});

// ── calibration ────────────────────────────────────────────────────────────────────────────────

test("the ladder walks toward the cliff from the safe side", () => {
  assert.deepEqual(calibrationLadder(32, 40, 4), [32, 31, 30, 29]);
  // It never proposes a value that is not a split at all.
  assert.deepEqual(calibrationLadder(2, 40, 4), [2, 1]);
  assert.deepEqual(calibrationLadder(41, 40, 3), []);
});

test("the winner is the configuration that finishes a turn soonest, not the fastest decoder", () => {
  // The real measurements: 30 decodes barely faster than 31 but prefills far better, and an agent
  // turn is mostly prefill. A scorer that only looked at decode would call these nearly equal.
  const at30 = { cpuMoeLayers: 30, contextTokens: 32768, decodeTokensPerSecond: 14.68, promptTokensPerSecond: 185.1 };
  const at31 = { cpuMoeLayers: 31, contextTokens: 32768, decodeTokensPerSecond: 13.54, promptTokensPerSecond: 175.9 };
  const at29 = { cpuMoeLayers: 29, contextTokens: 32768, decodeTokensPerSecond: 10.72, promptTokensPerSecond: 56.9 };
  assert.equal(bestSample([at31, at30, at29])?.cpuMoeLayers, 30);
  assert.ok(scoreSample(at30) < scoreSample(at31));
  assert.ok(scoreSample(at29) > scoreSample(at30) * 1.5, "the collapse is unmistakable in the score");
});

test("the cliff is recognised, and ordinary variance is not mistaken for it", () => {
  const best = { cpuMoeLayers: 30, contextTokens: 32768, decodeTokensPerSecond: 14.68, promptTokensPerSecond: 185.1 };
  const collapsed = { cpuMoeLayers: 29, contextTokens: 32768, decodeTokensPerSecond: 10.72, promptTokensPerSecond: 56.9 };
  const noisy = { cpuMoeLayers: 31, contextTokens: 32768, decodeTokensPerSecond: 13.54, promptTokensPerSecond: 175.9 };
  assert.equal(fellOffCliff(collapsed, best), true);
  assert.equal(fellOffCliff(noisy, best), false, "a 7% difference is measurement noise, not a cliff");
});

test("a measurement is only reused on the machine and model it was taken on", () => {
  const base = { modelPath: "C:/m/ornith.gguf", modelBytes: 24.73e9, gpuName: "RTX 4060", vramBytes: 8.586e9 };
  assert.equal(calibrationFingerprint(base), calibrationFingerprint({ ...base, modelPath: "c:/M/Ornith.gguf" }), "case is not identity");
  assert.notEqual(calibrationFingerprint(base), calibrationFingerprint({ ...base, gpuName: "RTX 3060" }));
  assert.notEqual(calibrationFingerprint(base), calibrationFingerprint({ ...base, vramBytes: 12e9 }));
  assert.notEqual(calibrationFingerprint(base), calibrationFingerprint({ ...base, modelBytes: 12e9 }));
});

test("weights are pinned in RAM when there is room, and never when there is not", () => {
  // With experts on the CPU, decode reads them from system memory every token, so whether those pages
  // are resident is not a detail. Measured back to back: 23.5 tok/s pinned vs 20.4 unpinned — and the
  // unpinned figure swung between 13.7 and 25.1 across sessions purely on page-cache luck.
  const roomy = planTuning({ ...REFERENCE, ramBytes: 64e9 });
  assert.equal(roomy.loadMode, "mmap+mlock", "64 GB against 24.7 GB of weights is not a close call");
  assert.ok(roomy.reasons.some((r) => /pinned in RAM/.test(r)));

  // The reference machine itself is NOT roomy enough, and this is the case that matters: at 34 GB the
  // first version of this pinned anyway and the launch died mid-load. A runtime that will not start is
  // infinitely worse than one that is 15% slower.
  assert.equal(planTuning(REFERENCE).loadMode, null, "34 GB for 24.7 GB of weights is too close to pin");
  assert.equal(planTuning({ ...REFERENCE, ramBytes: 16e9 }).loadMode, null, "less RAM than weights");
  assert.equal(planTuning({ ...REFERENCE, ramBytes: 0 }).loadMode, null, "unknown RAM is not an invitation");
});
