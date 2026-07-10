import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bashTool, type ToolContext } from "../src/core/tools.js";

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd: mkdtempSync(join(tmpdir(), "kt-cancel-")), filesRead: new Set(), filesWritten: new Set(), signal };
}
// A command that would run for ~10s if not killed (node is always present).
const LONG = 'node -e "setTimeout(function(){}, 10000)"';

test("bash is cancelled promptly when the signal aborts (not after the full command)", async () => {
  const c = new AbortController();
  const t0 = Date.now();
  setTimeout(() => c.abort(), 150);
  const r = await bashTool.execute({ command: LONG }, ctx(c.signal));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 4000, `should stop promptly, took ${elapsed}ms`);
  assert.equal((r.meta as { cancelled?: boolean }).cancelled, true);
  assert.match(r.output, /cancelled/);
  assert.equal(r.isError, true);
});

test("bash enforces a timeout by killing the process tree", async () => {
  const t0 = Date.now();
  const r = await bashTool.execute({ command: LONG, timeout_seconds: 1 }, ctx());
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `timeout should fire, took ${elapsed}ms`);
  assert.equal((r.meta as { timedOut?: boolean }).timedOut, true);
  assert.match(r.output, /timed out/);
});

test("bash returns cancelled immediately if the signal is already aborted", async () => {
  const c = new AbortController();
  c.abort();
  const t0 = Date.now();
  const r = await bashTool.execute({ command: LONG }, ctx(c.signal));
  assert.ok(Date.now() - t0 < 500);
  assert.equal((r.meta as { cancelled?: boolean }).cancelled, true);
});

test("bash still returns a normal exit code + output when not cancelled", async () => {
  const r = await bashTool.execute({ command: 'node -e "console.log(6*7)"' }, ctx());
  assert.equal(r.isError, false);
  assert.match(r.output, /42/);
  assert.equal((r.meta as { exitCode?: number }).exitCode, 0);
  const bad = await bashTool.execute({ command: 'node -e "process.exit(3)"' }, ctx());
  assert.equal(bad.isError, true);
  assert.equal((bad.meta as { exitCode?: number }).exitCode, 3);
});
