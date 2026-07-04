import test from "node:test";
import assert from "node:assert/strict";
import { renderRunConsole } from "../src/reliability/runConsole.js";

test("renderRunConsole shows mode, a progress bar, current commitlet, verify, and sidecar", () => {
  const lines = renderRunConsole({
    status: "running (running)",
    goal: "add a --json flag to the export command",
    commitlet: "Add --json flag to src/export.ts",
    progress: { done: 1, total: 3 },
    lastVerification: { stage: "typecheck", status: "ok" },
    changedFiles: 2,
    unresolvedFailures: 0,
    sidecar: "sidecar scheduler: gap - 3 prefetched, 2 used, 1 ran-live, 0 wasted",
    backend: "available"
  });
  const text = lines.join("\n");
  assert.match(text, /Cheater - running/);
  assert.match(text, /goal: add a --json flag/);
  assert.match(text, /commitlets: \[#{5}-{11}\] 1\/3/, "progress bar reflects 1/3");
  assert.match(text, /current: Add --json flag/);
  assert.match(text, /verify: typecheck -> ok/);
  assert.match(text, /2 file\(s\) changed/);
  assert.match(text, /sidecar scheduler: gap/);
  assert.match(text, /backend: available/);
});

test("renderRunConsole stays minimal when there is little to show", () => {
  const lines = renderRunConsole({ status: "working", changedFiles: 0, unresolvedFailures: 0 });
  assert.deepEqual(lines, ["Cheater - working"]);
});

test("the progress bar fills fully at completion and is empty at the start", () => {
  assert.match(renderRunConsole({ status: "x", changedFiles: 0, unresolvedFailures: 0, progress: { done: 4, total: 4 } }).join("\n"), /\[#{16}\] 4\/4/);
  assert.match(renderRunConsole({ status: "x", changedFiles: 0, unresolvedFailures: 0, progress: { done: 0, total: 4 } }).join("\n"), /\[-{16}\] 0\/4/);
});
