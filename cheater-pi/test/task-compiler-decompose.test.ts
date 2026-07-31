// Deterministic decomposition of a compiled contract into a subagent DAG.
//
// The value here is as much in the REFUSALS as the splits: decomposition only pays when the pieces
// are genuinely low-coupling, and a needless DAG costs several bounded workers at ~20 tok/s each.
// These also assert the plan is actually executable by the existing TaskGraph validator, since a
// plan the controller rejects is worse than no plan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileTask, decomposeCompiledTask, wouldDecompose } from "../src/core/taskCompiler/index.js";
import { validateTaskPlan } from "../src/core/taskGraph.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "kitten-decomp-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fx", scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
  mkdirSync(join(root, "src"), { recursive: true });
  for (const name of ["tokenizer.js", "parser.js", "evaluator.js"]) writeFileSync(join(root, "src", name), "//\n");
  return root;
}

const compile = (request: string, cwd: string) => compileTask({ taskId: "run_1", request, cwd });

test("a genuinely multi-surface task splits into bounded workers plus integration", () => {
  const root = repo();
  try {
    const task = compile("Update src/tokenizer.js, src/parser.js and src/evaluator.js so the evaluator supports unary minus. Do not change the public API.", root).task;
    const { nodes, reason } = decomposeCompiledTask(task);
    assert.ok(nodes.length >= 3, `expected a split, got ${nodes.length}: ${reason}`);

    const workers = nodes.filter((node) => node.id !== "tc-integrate");
    const integrate = nodes.find((node) => node.id === "tc-integrate");
    assert.ok(integrate, "an integration node reconciles the pieces");
    assert.deepEqual(integrate!.dependencies.sort(), workers.map((w) => w.id).sort(), "integration waits for every worker");

    // Each worker owns exactly one surface and is FORBIDDEN the others — two isolated workers editing
    // the same file is how a parallel plan produces a silent conflict.
    for (const worker of workers) {
      assert.equal(worker.allowedFiles.length, 1, `${worker.id} must own exactly one surface`);
      assert.ok(!worker.forbiddenFiles.includes(worker.allowedFiles[0]));
      for (const other of workers) {
        if (other === worker) continue;
        assert.ok(worker.forbiddenFiles.includes(other.allowedFiles[0]), `${worker.id} may not touch ${other.allowedFiles[0]}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every worker inherits the binding contract, not just its own slice", () => {
  const root = repo();
  try {
    const task = compile("Update src/tokenizer.js and src/parser.js to support unary minus. Do not change the public API. Verify with `npm test`.", root).task;
    const { nodes } = decomposeCompiledTask(task);
    const workers = nodes.filter((node) => node.id !== "tc-integrate");
    assert.ok(workers.length >= 2);
    for (const worker of workers) {
      const criteria = worker.acceptanceCriteria.join(" ").toLowerCase();
      assert.match(criteria, /must not/, `${worker.id} never saw the prohibition and would happily violate it`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the derived plan is accepted by the existing TaskGraph validator", () => {
  // A plan the controller rejects at runtime is worse than no plan at all.
  const root = repo();
  try {
    const task = compile("Update src/tokenizer.js, src/parser.js and src/evaluator.js to support unary minus.", root).task;
    const { nodes } = decomposeCompiledTask(task);
    assert.ok(nodes.length > 0);
    validateTaskPlan({ conversationId: "conv_1", nodes });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("decomposition declines when a single trajectory is cheaper", () => {
  const root = repo();
  try {
    for (const [request, why] of [
      ["Fix the off-by-one in src/parser.js.", "one surface"],
      ["Where is the tokenizer defined?", "investigation"],
      ["You must add an endpoint. Do not add an endpoint.", "clarify"],
    ] as const) {
      const task = compile(request, root).task;
      const { nodes, reason } = decomposeCompiledTask(task);
      assert.deepEqual(nodes, [], `"${request}" (${why}) should decline, got ${nodes.length} nodes: ${reason}`);
      assert.match(reason, /^declined:/);
      assert.equal(wouldDecompose(task), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a read-only contract is never granted write scope", () => {
  const root = repo();
  try {
    const task = compile("Where is the retry budget enforced?", root).task;
    assert.equal(task.executionPolicy.mutationAllowed, false);
    assert.deepEqual(decomposeCompiledTask(task).nodes, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the split is bounded — a long file list does not fan out unboundedly", () => {
  const root = repo();
  try {
    const many = Array.from({ length: 12 }, (_, i) => `src/mod${i}.js`).join(", ");
    const task = compile(`Update ${many} to use the new logger.`, root).task;
    const { nodes } = decomposeCompiledTask(task);
    const workers = nodes.filter((node) => node.id !== "tc-integrate");
    assert.ok(workers.length <= 4, `fan-out must stay bounded on serialized local inference, got ${workers.length}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("decomposition is deterministic and needs no model", () => {
  const root = repo();
  try {
    const task = compile("Update src/tokenizer.js and src/parser.js for unary minus.", root).task;
    assert.deepEqual(decomposeCompiledTask(task), decomposeCompiledTask(task));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
