import test from "node:test";
import assert from "node:assert/strict";
import { profileChatParams, resolveInferenceProfile } from "../src/core/inferenceProfiles.js";

test("role profiles provide deterministic defaults and effort ceilings", () => {
  const executor = resolveInferenceProfile("executor", "think-hard");
  assert.equal(executor.temperature, 0.15); assert.equal(executor.maxTokens, 16_384); assert.equal(executor.reasoningBudget, 16_384);
  const verifier = resolveInferenceProfile("verifier", "think-hard");
  assert.equal(verifier.temperature, 0); assert.equal(verifier.reasoningBudget, 512); assert.equal(verifier.maxTokens, 512);
});

test("overrides are clamped and unsupported capabilities are omitted", () => {
  const profile = resolveInferenceProfile("planner", "balanced", { temperature: 9, topP: -1, maxTokens: 999_999, logprobs: true }, { topK: false, minP: false });
  assert.equal(profile.temperature, 2); assert.equal(profile.topP, 0); assert.equal(profile.topK, undefined); assert.equal(profile.minP, undefined);
  assert.equal(profile.maxTokens, 131_072); assert.equal(profile.logprobs, false);
  const transport = profileChatParams(profile); assert.equal(transport.topK, undefined);
});

test("Qwen3.5/KAT models automatically use the model-card sampler recipes", () => {
  const instruct = resolveInferenceProfile("executor", "balanced", {}, {}, "KAT-coder-35B-A3B");
  assert.equal(instruct.samplingMode, "instruct");
  assert.deepEqual({ temperature: instruct.temperature, topP: instruct.topP, topK: instruct.topK, minP: instruct.minP, presencePenalty: instruct.presencePenalty, repeatPenalty: instruct.repeatPenalty, reasoningBudget: instruct.reasoningBudget },
    { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1, reasoningBudget: 0 });
  const thinking = resolveInferenceProfile("executor", "careful", {}, {}, "Qwen3.5-35B-A3B");
  assert.equal(thinking.samplingMode, "thinking"); assert.equal(thinking.temperature, 0.6); assert.equal(thinking.topP, 0.95); assert.equal(thinking.topK, 20); assert.equal(thinking.presencePenalty, 0); assert.equal(thinking.reasoningBudget, 8192);
});
