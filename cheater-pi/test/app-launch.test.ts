import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDesktopExecutable } from "../src/core/app-launch.js";

test("native app launcher resolves only an installed desktop executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-app-"));
  const executable = join(root, "Kitten.Desktop.exe");
  try {
    assert.equal(resolveDesktopExecutable(join(root, "missing.exe")), null);
    await writeFile(executable, "fixture");
    assert.equal(resolveDesktopExecutable(executable), executable);
  } finally { await rm(root, { recursive: true, force: true }); }
});
