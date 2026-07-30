import test from "node:test";
import assert from "node:assert/strict";
import { gatherSupportInfo } from "../src/core/support.js";

test("support bundles redact credentials embedded in model endpoints", async () => {
  const previous = process.env.KITTEN_BASE_URL;
  process.env.KITTEN_BASE_URL = "fixture://user:password@example.invalid/v1?api_key=sk-super-secret-token&token=another-secret";
  try {
    const bundle = await gatherSupportInfo(process.cwd());
    assert.doesNotMatch(bundle, /super-secret-token|another-secret|password@example/);
    assert.match(bundle, /Endpoint: fixture:\/\/example\.invalid\/v1/);
  } finally {
    if (previous === undefined) delete process.env.KITTEN_BASE_URL;
    else process.env.KITTEN_BASE_URL = previous;
  }
});
