import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerificationCommand, runWorkspaceVerification } from "../src/core/workspaceVerification.js";

test("native verification allow-list accepts only known project checks", () => {
  assert.ok(parseVerificationCommand("npm test"));
  assert.ok(parseVerificationCommand("npm run typecheck"));
  assert.ok(parseVerificationCommand("python -m pytest"));
  assert.ok(parseVerificationCommand("cargo test"));
  assert.equal(parseVerificationCommand("npm test && del important"), null);
  assert.equal(parseVerificationCommand("powershell -Command whoami"), null);
});

test("workspace verification rejects unsafe commands without spawning them", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-verification-"));
  try {
    const result = await runWorkspaceVerification(root, ["powershell -Command whoami"]);
    assert.equal(result.passed, false);
    assert.equal(result.results[0].allowed, false);
    assert.match(result.results[0].output, /allow-list/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace verification cancellation terminates a running allow-listed check", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-verification-cancel-"));
  const controller = new AbortController();
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node -e \"setTimeout(() => {}, 30000)\"" } }), "utf8");
    setTimeout(() => controller.abort("test-cancel"), 100);
    const result = await runWorkspaceVerification(root, ["npm test"], { timeoutMs: 30_000, signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.equal(result.passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
