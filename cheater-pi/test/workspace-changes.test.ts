import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorkspaceChanges, isGeneratedChangePath } from "../src/core/workspaceChanges.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("change review lists the user's edits and not Kitten's own state or toolchain caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-changes-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "test");
    await writeFile(join(root, "stats.py"), "def median(values):\n    return sorted(values)[len(values) // 2]\n", "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "initial");

    // A real edit, plus the noise a run leaves behind.
    await writeFile(join(root, "stats.py"), "def median(values):\n    s = sorted(values)\n    return s[len(s) // 2]\n", "utf8");
    await writeFile(join(root, "notes.md"), "new file\n", "utf8");
    await mkdir(join(root, ".cheater"), { recursive: true });
    await writeFile(join(root, ".cheater", "workspace-index.json"), "{}", "utf8");
    await mkdir(join(root, "__pycache__"), { recursive: true });
    await writeFile(join(root, "__pycache__", "stats.cpython-313.pyc"), "binary", "utf8");
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");

    const changes = inspectWorkspaceChanges(root);
    const paths = changes.files.map((file) => file.path);
    assert.equal(changes.isGit, true);
    assert.ok(paths.includes("stats.py"), `expected the edit to be listed, saw: ${paths.join(", ")}`);
    assert.ok(paths.includes("notes.md"), "a new user file is a change");
    for (const noise of paths) {
      assert.ok(!noise.startsWith(".cheater/"), "Kitten's own cache is not a user change");
      assert.ok(!noise.includes("__pycache__"), "a bytecode cache is not a user change");
      assert.ok(!noise.includes("node_modules"), "installed dependencies are not a user change");
    }
    assert.match(changes.diff, /^\+\s+s = sorted\(values\)$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated-path detection covers the usual suspects without eating real files", () => {
  for (const generated of [".cheater/workspace-index.json", "src/__pycache__/x.pyc", "node_modules/a/b.js", "dist/main.js", "coverage/lcov.info", ".venv/pyvenv.cfg", "run.log", "a/b/Thumbs.db"]) {
    assert.equal(isGeneratedChangePath(generated), true, `${generated} should be treated as generated`);
  }
  for (const real of ["stats.py", "src/dist-helper.ts", "docs/build-guide.md", "buildings.py", "src/target_selector.rs", "distributed.py"]) {
    assert.equal(isGeneratedChangePath(real), false, `${real} is a real source file`);
  }
});
