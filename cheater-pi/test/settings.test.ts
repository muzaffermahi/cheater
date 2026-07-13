import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKittenSettings } from "../src/core/settings.js";

function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "kitten-cfg-"));
  mkdirSync(join(dir, ".kitten"), { recursive: true });
  writeFileSync(join(dir, ".kitten", "config.json"), JSON.stringify(config));
  return dir;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("project config sets the model; env overrides it", () => {
  const dir = projectWith({ mainModel: "from-file", baseUrl: "http://file/v1" });
  withEnv({ KITTEN_MAIN_MODEL: undefined, KITTEN_BASE_URL: undefined }, () => {
    const s = loadKittenSettings(dir);
    assert.equal(s.models.main, "from-file");
    assert.equal(s.models.baseUrl, "http://file/v1");
    assert.ok(s.sources.some((p) => p.includes(".kitten")));
  });
  withEnv({ KITTEN_MAIN_MODEL: "from-env" }, () => {
    const s = loadKittenSettings(dir);
    assert.equal(s.models.main, "from-env"); // env wins over the file
  });
});

test("unknown keys and invalid approvalPolicy produce warnings (no silent wrong fallback)", () => {
  const dir = projectWith({ mainModel: "m", notARealKey: 5, approvalPolicy: "yolo" });
  withEnv({ KITTEN_MAIN_MODEL: undefined, KITTEN_APPROVAL_POLICY: undefined }, () => {
    const s = loadKittenSettings(dir);
    assert.ok(s.warnings.some((w) => /unknown key "notARealKey"/.test(w)));
    assert.ok(s.warnings.some((w) => /approvalPolicy "yolo"/.test(w)));
    assert.equal(s.approvalPolicy, "ask"); // safe default
  });
});

test("an empty env var is ignored (falls through to the file), not applied as a blank override", () => {
  // Regression: `KITTEN_BASE_URL=""` short-circuited `?? file ?? default` on the empty string, yielding
  // an unusable empty base URL. An unset shell var expands to "", so empty must mean "not provided".
  const dir = projectWith({ baseUrl: "http://file/v1" });
  withEnv({ KITTEN_BASE_URL: "" }, () => {
    const s = loadKittenSettings(dir);
    assert.equal(s.models.baseUrl, "http://file/v1", "empty env must not blank the file value");
    assert.ok(s.warnings.some((w) => /KITTEN_BASE_URL is set but empty/.test(w)));
  });
});

test("an invalid KITTEN_CONTEXT_TOKENS warns and falls through to the file value (no silent default)", () => {
  // Regression: `Number("oops")` = NaN, and `NaN ?? file` returns NaN (not nullish), so the file's valid
  // value was silently discarded to the hardcoded 16384 with no warning.
  const dir = projectWith({ contextWindowTokens: 32768 });
  withEnv({ KITTEN_CONTEXT_TOKENS: "oops" }, () => {
    const s = loadKittenSettings(dir);
    assert.equal(s.contextWindowTokens, 32768, "invalid env must not discard the file's valid value");
    assert.ok(s.warnings.some((w) => /KITTEN_CONTEXT_TOKENS "oops" is not a positive number/.test(w)));
  });
  withEnv({ KITTEN_CONTEXT_TOKENS: "8000" }, () => {
    assert.equal(loadKittenSettings(dir).contextWindowTokens, 8000, "a valid env value still overrides the file");
  });
});

test("invalid JSON is a warning, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-cfg-"));
  mkdirSync(join(dir, ".kitten"), { recursive: true });
  writeFileSync(join(dir, ".kitten", "config.json"), "{ not json ");
  const s = loadKittenSettings(dir);
  assert.ok(s.warnings.some((w) => /not valid JSON/.test(w)));
});
