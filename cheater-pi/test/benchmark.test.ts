import test from "node:test";
import assert from "node:assert/strict";
import { configurationHash, resolveBenchmarkProfile, rotateExecutionOrder, stableJson, validateCampaignManifest } from "../src/core/benchmark.js";

test("benchmark canonicalization is reproducible", () => {
  assert.equal(stableJson({ z: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"z":1}');
  assert.equal(configurationHash({ b: 2, a: 1 }), configurationHash({ a: 1, b: 2 }));
  assert.deepEqual(rotateExecutionOrder(["a", "b", "c"], 2), ["c", "a", "b"]);
});

test("benchmark profile is opt-in", () => {
  assert.equal(resolveBenchmarkProfile({}), "full");
  assert.equal(resolveBenchmarkProfile({ KITTEN_BENCH_PROFILE: "minimal" }), "minimal");
  assert.equal(resolveBenchmarkProfile({ KITTEN_BENCH_PROFILE: "garbage" }), "full");
});

test("campaign validation rejects missing image digests and unsafe budgets", () => {
  const base = {
    schemaVersion: 1 as const, campaignId: "x", frozenAt: "2026-01-01T00:00:00Z",
    dataset: { name: "tb2", revision: "r", sha256: "x" }, model: { name: "m", endpointId: "p" },
    budgets: { ceilingSeconds: 900, maxModalUsd: 20, maxTransferBytes: 250 * 1024 * 1024 },
    executionOrder: { kitten: ["a"], opencode: ["a"], omp: ["a"] },
    tasks: [{ id: "a", image: "x", imageDigest: "sha256:x" }],
    agents: {
      kitten: { version: "x", bundleSha256: "x", adapter: "x", configurationSha256: "x" },
      opencode: { version: "x", bundleSha256: "x", adapter: "x", configurationSha256: "x" },
      omp: { version: "x", bundleSha256: "x", adapter: "x", configurationSha256: "x" },
    },
    resultSchema: "trial-record-v1" as const,
  };
  assert.doesNotThrow(() => validateCampaignManifest(base));
  assert.throws(() => validateCampaignManifest({ ...base, budgets: { ...base.budgets, maxModalUsd: 20.01 } }));
  assert.throws(() => validateCampaignManifest({ ...base, tasks: [{ ...base.tasks[0], imageDigest: "" }] }));
});

