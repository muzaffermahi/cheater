import test from "node:test";
// (bakeoff regression) An interactive command must hit EOF instead of hanging on an open stdin.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bashTool, interactiveCommandRefusal, editTool, readTool, writeTool, globTool, grepTool, globToRegExp, type ToolContext } from "../src/core/tools.js";

function ctxAt(): ToolContext {
  return { cwd: mkdtempSync(join(tmpdir(), "kt-tools-")), filesRead: new Set(), filesWritten: new Set() };
}

test("edit applies an exact match and shows the changed region (editor feedback)", async () => {
  const ctx = ctxAt();
  writeFileSync(join(ctx.cwd, "m.py"), "def f():\n    return 1\n\ndef g():\n    return 2\n");
  const r = await editTool.execute({ path: "m.py", search: "return 1", replace: "return 42" }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.output, /edited m\.py/);
  assert.match(r.output, /now reads:/, "must echo the applied result so the model trusts the edit");
  assert.match(r.output, /return 42/, "the window shows the new text");
  assert.equal(readFileSync(join(ctx.cwd, "m.py"), "utf8").includes("return 42"), true);
});

test("edit matches leniently when whitespace differs", async () => {
  const ctx = ctxAt();
  writeFileSync(join(ctx.cwd, "m.py"), "def f():\n        return 1\n"); // 8-space indent
  const r = await editTool.execute({ path: "m.py", search: "    return 1", replace: "    return 2" }, ctx); // 4-space
  assert.equal(r.isError, false, "lenient whitespace match should still apply");
  assert.match(readFileSync(join(ctx.cwd, "m.py"), "utf8"), /return 2/);
});

test("edit matches leniently on a CRLF file (Windows line endings)", async () => {
  // Regression: findLenient rejoined lines with "\n" and indexOf'd that against the raw text, so on a
  // \r\n file it never matched â€” the lenient rescue was dead on the primary platform.
  const ctx = ctxAt();
  writeFileSync(join(ctx.cwd, "m.py"), "def f():\r\n        return 1\r\n"); // CRLF, 8-space indent
  const r = await editTool.execute({ path: "m.py", search: "    return 1", replace: "    return 2" }, ctx); // 4-space
  assert.equal(r.isError, false, "lenient match must work on CRLF files, not just LF");
  assert.match(readFileSync(join(ctx.cwd, "m.py"), "utf8"), /return 2/);
});

test("edit refuses an ambiguous lenient match (2+ normalized regions) instead of guessing", async () => {
  // Regression: findLenient applied the FIRST normalized match, unlike the exact path which errors on
  // multiple matches â€” so it could silently edit the wrong one of two similar blocks.
  const ctx = ctxAt();
  writeFileSync(join(ctx.cwd, "m.py"), "if a:\n    x = 1\n    return x\nif b:\n        x = 1\n        return x\n");
  const before = readFileSync(join(ctx.cwd, "m.py"), "utf8");
  const r = await editTool.execute({ path: "m.py", search: "  x = 1\n  return x", replace: "  x = 2\n  return x" }, ctx);
  assert.equal(r.isError, true, "an ambiguous lenient match must error, not edit");
  assert.match(r.output, /matched 2 places|add more surrounding context/);
  assert.equal(readFileSync(join(ctx.cwd, "m.py"), "utf8"), before, "file is unchanged on an ambiguous match");
});

test("edit on a missing snippet returns a repair-ready error, not a silent write", async () => {
  const ctx = ctxAt();
  writeFileSync(join(ctx.cwd, "m.py"), "def f():\n    return 1\n");
  const r = await editTool.execute({ path: "m.py", search: "return 999", replace: "return 2" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /not found/);
});

test("edit refuses a non-existent file (points at write)", async () => {
  const ctx = ctxAt();
  const r = await editTool.execute({ path: "nope.py", search: "x", replace: "y" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /use write to create/);
});

test("read returns line-numbered content", async () => {
  const ctx = ctxAt();
  writeFileSync(join(ctx.cwd, "m.py"), "alpha\nbeta\ngamma\n");
  const r = await readTool.execute({ path: "m.py" }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.output, /1\s+alpha/);
  assert.match(r.output, /2\s+beta/);
});

test("write reports the file and line count", async () => {
  const ctx = ctxAt();
  const r = await writeTool.execute({ path: "new.py", content: "a\nb\nc\n" }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.output, /wrote new\.py/);
});

// --- glob / grep ------------------------------------------------------------------------------

function seedTree(cwd: string): void {
  mkdirSync(join(cwd, "src", "core"), { recursive: true });
  mkdirSync(join(cwd, "test"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, "root.ts"), "export const root = 1;\n");
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "src", "core", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(cwd, "src", "core", "b.js"), "module.exports = 1;\n");
  writeFileSync(join(cwd, "test", "a.test.ts"), "test('a', () => {});\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.ts"), "export const skipped = 1;\n");
}

test("glob finds files by bare basename pattern at any depth", async () => {
  const ctx = ctxAt();
  seedTree(ctx.cwd);
  const r = await globTool.execute({ pattern: "*.ts" }, ctx);
  assert.equal(r.isError, false);
  const lines = r.output.split("\n");
  assert.ok(lines.includes("root.ts"), "a bare pattern must match at the root");
  assert.ok(lines.includes("src/core/b.ts"), "a bare pattern must match at depth, not just the root");
  assert.ok(!lines.some((l) => l.endsWith(".js")), "must not match a different extension");
});

test("glob skips node_modules and other build dirs", async () => {
  const ctx = ctxAt();
  seedTree(ctx.cwd);
  const r = await globTool.execute({ pattern: "**/*.ts" }, ctx);
  assert.ok(!r.output.includes("node_modules"), "vendored trees would drown a small model's context");
});

test("glob ** matches zero directories so **/*.ts finds a root-level file", async () => {
  const ctx = ctxAt();
  seedTree(ctx.cwd);
  const r = await globTool.execute({ pattern: "**/*.ts" }, ctx);
  assert.ok(r.output.split("\n").includes("root.ts"));
});

test("glob honours a path-shaped pattern against the full relative path", async () => {
  const ctx = ctxAt();
  seedTree(ctx.cwd);
  const r = await globTool.execute({ pattern: "src/core/*.ts" }, ctx);
  const lines = r.output.split("\n");
  assert.deepEqual(lines, ["src/core/b.ts"], "a pattern with a slash must anchor to the path, not the basename");
});

test("glob reports no match without erroring", async () => {
  const ctx = ctxAt();
  seedTree(ctx.cwd);
  const r = await globTool.execute({ pattern: "*.rs" }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.output, /no files match/);
});

test("glob refuses a search root outside the project", async () => {
  const ctx = ctxAt();
  seedTree(ctx.cwd);
  const r = await globTool.execute({ pattern: "*.ts", path: "../.." }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /scope denied/);
});

test("grep says when it truncated instead of implying it saw everything", async () => {
  const ctx = ctxAt();
  // 500 matching lines in one file, above the 400 ceiling.
  writeFileSync(join(ctx.cwd, "many.txt"), Array.from({ length: 500 }, (_, i) => `needle ${i}`).join("\n"));
  const r = await grepTool.execute({ pattern: "needle" }, ctx);
  assert.equal(r.isError, false);
  assert.equal((r.meta as { truncated: boolean }).truncated, true);
  assert.match(r.output, /truncated at 400 matches/, "silent truncation teaches the model the repo is smaller than it is");
});

test("grep does not claim truncation when it found everything", async () => {
  const ctx = ctxAt();
  writeFileSync(join(ctx.cwd, "few.txt"), "needle a\nneedle b\n");
  const r = await grepTool.execute({ pattern: "needle" }, ctx);
  assert.equal((r.meta as { truncated: boolean }).truncated, false);
  assert.doesNotMatch(r.output, /truncated/);
});

test("grep's glob filter accepts a path-shaped pattern", async () => {
  const ctx = ctxAt();
  seedTree(ctx.cwd);
  const r = await grepTool.execute({ pattern: "export const", glob: "src/core/*.ts" }, ctx);
  assert.match(r.output, /src\/core\/b\.ts/);
  assert.doesNotMatch(r.output, /src\/a\.ts/, "the filter must anchor to the path when it contains a slash");
});

test("globToRegExp keeps * inside one segment", () => {
  assert.equal(globToRegExp("*.ts").test("a.ts"), true);
  assert.equal(globToRegExp("*.ts").test("dir/a.ts"), false, "* must not cross a directory separator");
  assert.equal(globToRegExp("**/*.ts").test("dir/deep/a.ts"), true);
  assert.equal(globToRegExp("a?.ts").test("ab.ts"), true);
  assert.equal(globToRegExp("a?.ts").test("abc.ts"), false);
});


test("a bare interactive command is refused instantly with the fix, not left to hang", async () => {
  // Live bakeoff finding: the model ran bare `python`. With no terminal attached it blocks until the
  // timeout — and on Python 3.14 it hangs even with stdin redirected from NUL — so three of them ate
  // six minutes of one task. Refusing costs milliseconds and tells the model exactly what to do.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-stdin-"));
  const c: ToolContext = { cwd, filesRead: new Set(), filesWritten: new Set() };
  const started = Date.now();
  const res = await bashTool.execute({ command: "python", timeout_seconds: 30 }, c);
  assert.ok(Date.now() - started < 3000, "must refuse immediately, not wait for the timeout");
  assert.equal(res.isError, true);
  assert.match(res.output, /interactive session/);
  assert.match(res.output, /python -c/, "the refusal must carry the correction");
  for (const bare of ["node", "  vim  ", "sqlite3", "cat", "C:\\Python314\\python.exe"]) {
    assert.ok(interactiveCommandRefusal(bare), `${bare} should be refused`);
  }
  // Real commands must be untouched — including the piped/redirected/argument forms.
  for (const real of ['python -c "print(1)"', "python script.py", "echo hi | python", "cat file.txt",
                      "node -e \"console.log(1)\"", "npm test", "python < input.txt", "pytest -q"]) {
    assert.equal(interactiveCommandRefusal(real), null, `${real} must NOT be refused`);
  }
  const good = await bashTool.execute({ command: 'python -c "print(6*7)"', timeout_seconds: 60 }, c);
  assert.equal(good.isError, false, `a normal python -c must still run: ${good.output.slice(0, 200)}`);
  assert.match(good.output, /42/);
});

