import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editTool, readTool, writeTool, type ToolContext } from "../src/core/tools.js";

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
