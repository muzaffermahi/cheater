import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isWorkspacePath,
  isPathLike,
  extractCommandPaths,
  classifyPathTokens,
  editDistance,
  nearestExistingPaths,
  nounGateVerdict,
  resetNounGate
} from "../src/reliability/nounGate.js";

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "ng-"));
  mkdirSync(join(cwd, "ssl"), { recursive: true });
  writeFileSync(join(cwd, "ssl", "server.crt"), "cert\n", "utf8");
  writeFileSync(join(cwd, "app.py"), "print('hi')\n", "utf8");
  return cwd;
}

// --- scope guard -----------------------------------------------------------------------------

test("isWorkspacePath gates workspace paths and skips system/URL/home paths", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ng-scope-"));
  assert.equal(isWorkspacePath("src/x.ts", cwd), true, "relative -> workspace");
  assert.equal(isWorkspacePath(join(cwd, "a", "b"), cwd), true, "absolute under cwd -> workspace");
  assert.equal(isWorkspacePath("../escape.ts", cwd), false, "escaping relative -> out of scope");
  assert.equal(isWorkspacePath("https://example.com/x", cwd), false, "URL -> out of scope");
  assert.equal(isWorkspacePath("~/secrets", cwd), false, "home -> out of scope");
  assert.equal(isWorkspacePath("$HOME/x", cwd), false, "shell var -> out of scope");
});

// --- path-like recognition -------------------------------------------------------------------

test("isPathLike recognizes paths and rejects flags/globs/bare words", () => {
  assert.equal(isPathLike("src/index.ts"), true);
  assert.equal(isPathLike("./config.yaml"), true);
  assert.equal(isPathLike("server.crt"), true, "bare filename with extension");
  assert.equal(isPathLike("build"), false, "bare word");
  assert.equal(isPathLike("-v"), false, "flag");
  assert.equal(isPathLike("src/*.ts"), false, "glob");
  assert.equal(isPathLike("$FILE"), false, "variable");
  assert.equal(isPathLike("3.14"), false, "number literal");
});

// --- command path extraction -----------------------------------------------------------------

test("extractCommandPaths classifies cd/exec as must-exist and redirects correctly", () => {
  assert.deepEqual(extractCommandPaths("cd /app/ssl && openssl x509").mustExist, ["/app/ssl"]);
  assert.deepEqual(extractCommandPaths("python app.py").mustExist, ["app.py"]);
  assert.deepEqual(extractCommandPaths("openssl x509 -in ssl/server.crt").mustExist, ["ssl/server.crt"]);
  assert.deepEqual(extractCommandPaths("echo hi > out/result.json").mayBeNew, ["out/result.json"]);
  assert.deepEqual(extractCommandPaths("sort < data/in.txt").mustExist, ["data/in.txt"]);
});

test("extractCommandPaths does not gate pure reads, unknown verbs, or flag args (fail-open)", () => {
  assert.deepEqual(extractCommandPaths("npm run build"), { mustExist: [], mayBeNew: [] });
  assert.deepEqual(extractCommandPaths("git status"), { mustExist: [], mayBeNew: [] });
  assert.deepEqual(extractCommandPaths("cat notes/x.txt"), { mustExist: [], mayBeNew: [] }, "pure read verb -> not gated (clean error, probing)");
  assert.deepEqual(extractCommandPaths("some_tool foo/bar"), { mustExist: [], mayBeNew: [] }, "unknown verb -> not gated");
});

test("classifyPathTokens: edit target must exist; read and write are not gated", () => {
  assert.deepEqual(classifyPathTokens("cheater_line_edit", { path: "a/b.ts" }).mustExist, ["a/b.ts"]);
  assert.deepEqual(classifyPathTokens("read", { path: "a/b.ts" }), { mustExist: [], mayBeNew: [] }, "read is not gated (clean error + probing)");
  assert.deepEqual(classifyPathTokens("write", { path: "a/b.ts" }), { mustExist: [], mayBeNew: [] }, "write is never gated (scaffold safety)");
});

// --- suggestions -----------------------------------------------------------------------------

test("editDistance basics", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("server.crt", "server.crt"), 0);
  assert.equal(editDistance("ssl", "sslx"), 1);
});

test("nearestExistingPaths finds the same file in a sibling directory", () => {
  const cwd = fixture();
  const near = nearestExistingPaths("tls/server.crt", cwd);
  assert.ok(near.includes("ssl/server.crt"), `expected ssl/server.crt in ${JSON.stringify(near)}`);
});

// --- the gate --------------------------------------------------------------------------------

test("phantom exec path is blocked with a nearest-existing suggestion", () => {
  resetNounGate();
  const cwd = fixture();
  const verdict = nounGateVerdict({ toolName: "bash", input: { command: "openssl x509 -in tls/server.crt" }, cwd });
  assert.equal(verdict.action, "block");
  if (verdict.action === "block") {
    assert.match(verdict.reason, /Path not found: tls\/server\.crt/);
    assert.ok(verdict.suggestions.includes("ssl/server.crt"), "suggests the real path");
  }
});

test("an existing exec path is allowed; reads are never gated", () => {
  resetNounGate();
  const cwd = fixture();
  assert.equal(nounGateVerdict({ toolName: "bash", input: { command: "openssl x509 -in ssl/server.crt" }, cwd }).action, "allow");
  assert.equal(nounGateVerdict({ toolName: "read", input: { path: "does-not-exist.py" }, cwd }).action, "allow", "read of a phantom is a clean-error probe, not gated");
});

test("write to a new nested file is allowed (never gated)", () => {
  resetNounGate();
  const cwd = fixture();
  assert.equal(nounGateVerdict({ toolName: "write", input: { path: "src/components/New.tsx", content: "x" }, cwd }).action, "allow");
});

test("a shell redirect into a missing parent directory is caught", () => {
  resetNounGate();
  const cwd = fixture();
  const verdict = nounGateVerdict({ toolName: "bash", input: { command: "echo hi > nope/out.txt" }, cwd });
  assert.equal(verdict.action, "block");
  if (verdict.action === "block") assert.match(verdict.reason, /parent directory/);
});

test("a system path is out of scope and allowed", () => {
  resetNounGate();
  const cwd = fixture();
  assert.equal(nounGateVerdict({ toolName: "bash", input: { command: "cat /definitely/not/here.txt" }, cwd }).action, "allow");
});

test("ambiguous / non-path commands fail open", () => {
  resetNounGate();
  const cwd = fixture();
  assert.equal(nounGateVerdict({ toolName: "bash", input: { command: "npm run build" }, cwd }).action, "allow");
  assert.equal(nounGateVerdict({ toolName: "bash", input: { command: "echo hello world" }, cwd }).action, "allow");
});

test("governor accounting: repeated blocks on the same phantom eventually open (no self-loop)", () => {
  resetNounGate();
  const cwd = fixture();
  const call = () => nounGateVerdict({ toolName: "bash", input: { command: "python tls/missing.py" }, cwd });
  assert.equal(call().action, "block", "1st: block");
  assert.equal(call().action, "block", "2nd: block");
  assert.equal(call().action, "allow", "3rd: fail open so the real error + loop machinery take over");
  resetNounGate();
  assert.equal(call().action, "block", "reset restores the gate");
});
