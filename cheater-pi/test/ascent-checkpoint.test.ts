import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointCandidates, clearCheckpoints, CHECKPOINT_DIR, type BurstAttempt } from "../src/core/cloudBurst.js";

/** A BurstAttempt is large; these tests only touch workspace/index/result.finished. */
function attempt(workspace: string, index: number, finished: boolean): BurstAttempt {
  return { index, workspace, result: { finished } } as unknown as BurstAttempt;
}

function candidateWorkspace(files: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), "kitten-cand-"));
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(ws, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body);
  }
  return ws;
}

test("an interrupted ascent run leaves its finished candidates on disk", () => {
  // The bakeoff's json_patch ran ascent k=2 for fifteen minutes, was killed before the winner was
  // adopted, and left a workspace containing only `.cheater/` — so the oracle reported
  // ModuleNotFoundError, indistinguishable from an agent that never tried. The candidates existed;
  // nothing put them anywhere the user could find.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-cwd-"));
  const a = candidateWorkspace({ "patch.py": "def apply_patch(doc, ops):\n    return doc\n" });
  const b = candidateWorkspace({ "patch.py": "def apply_patch(doc, ops):\n    raise NotImplementedError\n" });

  const saved = checkpointCandidates(cwd, [attempt(a, 1, true), attempt(b, 2, true)], 1);

  assert.equal(saved.length, 2);
  const root = join(cwd, CHECKPOINT_DIR);
  assert.ok(existsSync(root), "the checkpoint directory must exist for the user to find");
  assert.deepEqual(readdirSync(root).sort(), ["round1-candidate1", "round1-candidate2"]);
  assert.match(readFileSync(join(root, "round1-candidate1", "patch.py"), "utf8"), /def apply_patch/);
  assert.match(readFileSync(join(root, "round1-candidate2", "patch.py"), "utf8"), /NotImplementedError/);
});

test("checkpointing never destroys what is already in the workspace", () => {
  // The reason this is a copy beside the work rather than a provisional adoption: adoptWorkspace
  // CLEARS cwd before copying, so adopting early would mean an interrupt leaves the user holding an
  // unverified loser's edits instead of their own files. Losing the agent's work is bad; quietly
  // replacing someone's repository with a candidate that never won is worse.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-cwd-"));
  writeFileSync(join(cwd, "my_precious.py"), "# the user's own file\n");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "app.py"), "original\n");

  checkpointCandidates(cwd, [attempt(candidateWorkspace({ "app.py": "candidate rewrite\n" }), 1, true)], 1);

  assert.equal(readFileSync(join(cwd, "my_precious.py"), "utf8"), "# the user's own file\n");
  assert.equal(readFileSync(join(cwd, "src", "app.py"), "utf8"), "original\n",
    "the user's tree must be untouched by a checkpoint");
});

test("only finished candidates are checkpointed, and tooling noise is not copied", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-cwd-"));
  const done = candidateWorkspace({ "ok.py": "x = 1\n", "node_modules/dep/index.js": "junk\n", "__pycache__/ok.pyc": "junk\n" });
  const unfinished = candidateWorkspace({ "half.py": "def f(\n" });

  const saved = checkpointCandidates(cwd, [attempt(done, 1, true), attempt(unfinished, 2, false)], 2);

  assert.equal(saved.length, 1, "an unfinished candidate is not worth the copy");
  const dir = join(cwd, CHECKPOINT_DIR, "round2-candidate1");
  assert.ok(existsSync(join(dir, "ok.py")));
  assert.ok(!existsSync(join(dir, "node_modules")), "node_modules must not be copied");
  assert.ok(!existsSync(join(dir, "__pycache__")), "caches must not be copied");
  assert.ok(!existsSync(join(cwd, CHECKPOINT_DIR, "round2-candidate2")));
});

test("a run that finishes cleanly leaves no checkpoint litter", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-cwd-"));
  checkpointCandidates(cwd, [attempt(candidateWorkspace({ "a.py": "1\n" }), 1, true)], 1);
  assert.ok(existsSync(join(cwd, CHECKPOINT_DIR)));

  clearCheckpoints(cwd);

  assert.ok(!existsSync(join(cwd, CHECKPOINT_DIR)), "the winner is adopted for real; the copies go");
  clearCheckpoints(cwd);   // idempotent: clearing twice must not throw
});

test("a broken candidate workspace cannot fail the run", () => {
  // Checkpointing is best-effort by construction. A vanished or unreadable workspace must degrade to
  // "no checkpoint", never to an exception that takes down a run which is otherwise going fine.
  const cwd = mkdtempSync(join(tmpdir(), "kitten-cwd-"));
  const saved = checkpointCandidates(cwd, [attempt(join(tmpdir(), "kitten-does-not-exist-9f3a"), 1, true)], 1);
  assert.deepEqual(saved, []);
});
