import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureSnapshot, restoreSnapshot } from "../src/core/undo.js";
import { KittenApp, type Runner } from "../src/core/app.js";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";

function gitInit(dir: string): void {
  const opt = { cwd: dir, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opt);
  execFileSync("git", ["config", "user.email", "t@t"], opt);
  execFileSync("git", ["config", "user.name", "t"], opt);
  execFileSync("git", ["config", "commit.gpgsign", "false"], opt);
  execFileSync("git", ["config", "core.autocrlf", "false"], opt); // byte-exact checkout on Windows
}
function gitCommitAll(dir: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", msg], { cwd: dir, stdio: "ignore" });
}

test("restoreSnapshot: reverts a modified file, deletes a created file, keeps unrelated dirty work", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-undo-"));
  gitInit(dir);
  writeFileSync(join(dir, "tracked.py"), "original\n");
  writeFileSync(join(dir, "other.py"), "other original\n");
  gitCommitAll(dir, "init");

  // The user has pre-existing dirty work in other.py that the run does NOT touch.
  writeFileSync(join(dir, "other.py"), "user dirty edit\n");

  // Snapshot (captures the dirty state), then a "run" modifies tracked.py and creates new.py.
  const snap = captureSnapshot(dir);
  assert.equal(snap.git, true);
  writeFileSync(join(dir, "tracked.py"), "changed by run\n");
  writeFileSync(join(dir, "new.py"), "created by run\n");

  const res = restoreSnapshot(dir, snap, ["tracked.py", "new.py"]);
  assert.ok(res.ok);
  assert.deepEqual(res.restored, ["tracked.py"]);
  assert.deepEqual(res.deleted, ["new.py"]);
  // tracked.py reverted, new.py gone, and the user's untouched dirty edit is preserved.
  assert.equal(readFileSync(join(dir, "tracked.py"), "utf8"), "original\n");
  assert.equal(existsSync(join(dir, "new.py")), false);
  assert.equal(readFileSync(join(dir, "other.py"), "utf8"), "user dirty edit\n");
});

test("restoreSnapshot: restores a pre-existing UNTRACKED file the run modified (never deletes it)", () => {
  // Regression for a data-loss bug: `git stash create` captures only tracked content, so an untracked
  // file was absent from the snapshot ref and /undo deleted it as if the run had created it.
  const dir = mkdtempSync(join(tmpdir(), "kitten-undo-untracked-"));
  gitInit(dir);
  writeFileSync(join(dir, "tracked.py"), "x\n");
  gitCommitAll(dir, "init");

  // A pre-existing untracked file the user cares about (never committed).
  writeFileSync(join(dir, "notes.md"), "MY IMPORTANT NOTES\n");

  const snap = captureSnapshot(dir);
  assert.ok(snap.preexisting?.includes("notes.md"), "untracked file recorded at capture");

  // The run modifies the untracked file and creates a brand-new file.
  writeFileSync(join(dir, "notes.md"), "clobbered by the run\n");
  writeFileSync(join(dir, "new.py"), "created by run\n");

  const res = restoreSnapshot(dir, snap, ["notes.md", "new.py"]);
  assert.deepEqual(res.restored, ["notes.md"]); // pre-run content written back
  assert.deepEqual(res.deleted, ["new.py"]);    // truly run-created → removed
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "MY IMPORTANT NOTES\n"); // NOT deleted, reverted
  assert.equal(existsSync(join(dir, "new.py")), false);
});

test("restoreSnapshot: restores a pre-existing UNTRACKED file the run deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-undo-untracked-del-"));
  gitInit(dir);
  writeFileSync(join(dir, "tracked.py"), "x\n");
  gitCommitAll(dir, "init");
  writeFileSync(join(dir, "data.json"), '{"keep":true}\n');

  const snap = captureSnapshot(dir);
  rmSync(join(dir, "data.json")); // the run deletes the untracked file

  const res = restoreSnapshot(dir, snap, ["data.json"]);
  assert.deepEqual(res.restored, ["data.json"]);
  assert.equal(readFileSync(join(dir, "data.json"), "utf8"), '{"keep":true}\n'); // recreated with pre-run content
});

test("restoreSnapshot: honest failure outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-undo-nogit-"));
  const snap = captureSnapshot(dir);
  assert.equal(snap.git, false);
  const res = restoreSnapshot(dir, snap, ["a.py"]);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /git/);
});

test("app.undoLast: rolls back the last file-changing run and records run.undone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-undo-app-"));
  gitInit(dir);
  writeFileSync(join(dir, "impl.py"), "def f():\n    return 1\n");
  gitCommitAll(dir, "init");

  // A runner that actually edits a file in the project (like the reliable lane would).
  const editing: Runner = async (ctx) => {
    writeFileSync(join(ctx.cwd, "impl.py"), "def f():\n    return 2\n");
    ctx.emit({ type: "file.changed", runId: ctx.runId, path: "impl.py", added: 1, removed: 1 });
    return { finished: true, summary: "changed impl", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: ["impl.py"], verified: true };
  };
  const app = new KittenApp({ store: new ConversationStore(openSqlite(":memory:")), runner: editing, projectRoot: dir });
  const conv = app.createConversation({ projectRoot: dir });
  await app.submitMessage(conv.id, "make f return 2");
  assert.equal(readFileSync(join(dir, "impl.py"), "utf8"), "def f():\n    return 2\n");

  const res = app.undoLast(conv.id);
  assert.ok(res.ok);
  assert.deepEqual(res.restored, ["impl.py"]);
  assert.equal(readFileSync(join(dir, "impl.py"), "utf8"), "def f():\n    return 1\n"); // reverted
  assert.ok(app.getEvents(conv.id).some((e) => e.type === "run.undone"));
});
