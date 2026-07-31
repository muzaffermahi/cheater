import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_PROFILES, profileSummary, recommendModelProfiles } from "../src/core/modelProfiles.js";

test("model profile guidance ranks a 35B main with a small sidecar on consumer hardware", () => {
  const recommendations = recommendModelProfiles({ platform: "win32", arch: "x64", cpuCores: 16, ramBytes: 32 * 1024 ** 3, gpus: [{ name: "fixture", vendor: "NVIDIA", backend: "cuda", vramBytes: 24 * 1024 ** 3 }] });
  const main = recommendations.find((profile) => profile.id === "main-35b");
  const sidecar = recommendations.find((profile) => profile.id === "sidecar-2b");
  assert.ok(main && main.fit === "good");
  assert.ok(sidecar && sidecar.fit === "good");
  assert.match(profileSummary(recommendations), /35B/);
});

test("profile catalog covers the requested main and sidecar size bands", () => {
  assert.ok(MODEL_PROFILES.some((profile) => profile.role === "main" && profile.parameterClass.startsWith("180B")));
  assert.ok(MODEL_PROFILES.some((profile) => profile.role === "sidecar" && profile.parameterClass.includes("2B")));
});
