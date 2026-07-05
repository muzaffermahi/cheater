import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { containsSecret, redactSecrets } from "../src/reliability/redact.js";
import { devLog } from "../src/dev/devLog.js";

test("redactSecrets scrubs high-confidence secret shapes and leaves ordinary code alone", () => {
  assert.match(redactSecrets("token sk-abcdefghijklmnop1234567"), /\[REDACTED:openai_key\]/);
  assert.match(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz012345"), /\[REDACTED:github_token\]/);
  assert.match(redactSecrets("AKIAIOSFODNN7EXAMPLE"), /\[REDACTED:aws_access_key\]/);
  assert.match(redactSecrets("Authorization: Bearer abcdefghij1234567890abcXYZ"), /\[REDACTED:bearer_token\]/);
  assert.match(redactSecrets("-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----"), /\[REDACTED:private_key\]/);
  // Assignment shape is preserved; only the value is scrubbed.
  assert.equal(redactSecrets('API_KEY="supersecretvalue12345"'), 'API_KEY="[REDACTED:assigned_secret]"');
  // No false positives on ordinary code.
  assert.equal(redactSecrets("const total = add(count, 2);"), "const total = add(count, 2);");
  assert.equal(redactSecrets("const timeoutMs = 120000;"), "const timeoutMs = 120000;");
  assert.equal(containsSecret("nothing sensitive here"), false);
  assert.equal(containsSecret("key: sk-abcdefghijklmnop1234567"), true);
});

test("the dev trace redacts secrets before writing to disk", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-redact-trace-"));
  devLog.disable(cwd);
  devLog.enable(cwd);
  devLog.userInput("deploy with token sk-abcdefghijklmnop1234567 please");
  const content = readFileSync(devLog.currentFile()!, "utf8");
  assert.match(content, /\[REDACTED:openai_key\]/);
  assert.doesNotMatch(content, /sk-abcdefghijklmnop1234567/, "the raw key must never hit the trace file");
  devLog.disable(cwd);
});
