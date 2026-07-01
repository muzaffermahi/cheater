import test from "node:test";
import assert from "node:assert/strict";
import { defaultGymConfig, applyGymConfigDefaults } from "../src/gym/report.js";
import type { CheaterConfig } from "../src/types.js";

test("default config has safe values", () => {
  const cfg = defaultGymConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.defaultLimit, 5);
  assert.equal(cfg.defaultConcurrency, 1);
  assert.equal(cfg.keepWorkspaces, false);
  assert.equal(cfg.autoLearn, false);
  assert.equal(cfg.deltaModeEnabled, false);
  assert.equal(cfg.runFullTests, "if_cheap");
});

test("applyGymConfigDefaults respects overrides", () => {
  const merged = applyGymConfigDefaults({ defaultLimit: 12, keepWorkspaces: true });
  assert.equal(merged.defaultLimit, 12);
  assert.equal(merged.keepWorkspaces, true);
  assert.equal(merged.defaultConcurrency, 1);
});

test("CheaterConfig accepts gym keys", () => {
  const cfg: CheaterConfig = { gymEnabled: true, gymDefaultLimit: 3 };
  assert.equal(cfg.gymDefaultLimit, 3);
});
