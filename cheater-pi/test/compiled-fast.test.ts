import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastEligibility } from "../src/core/compiledFast.js";

test("compiled Fast accepts one safe HTML artifact and does not confuse transition wording with migration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-fast-"));
  const result = fastEligibility("Create a self-contained HTML file driving_scene.html with a smooth transition and wheel rotation", cwd, "fast");
  assert.equal(result.eligible, true);
  assert.equal(result.target, "driving_scene.html");
  assert.equal(result.newArtifact, true);
});

test("compiled Fast rejects multi-file, high-risk, and unchecked targets", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-fast-"));
  writeFileSync(join(cwd, "app.py"), "print('ok')");
  assert.equal(fastEligibility("Install a dependency and update app.py", cwd, "fast").eligible, false);
  assert.equal(fastEligibility("Edit app.py and index.html", cwd, "fast").eligible, false);
  assert.equal(fastEligibility("Create README.md", cwd, "fast").eligible, false);
});
