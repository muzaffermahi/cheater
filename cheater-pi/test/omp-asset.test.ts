import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("OMP pinned asset and installer digest agree", () => {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "scripts", "tb2");
  const asset = JSON.parse(readFileSync(join(root, "omp-asset.json"), "utf8")) as { sha256: string; compressedSha256: string };
  const template = readFileSync(join(root, "install-omp.sh.j2"), "utf8");
  assert.match(template, new RegExp(asset.sha256));
  assert.equal(asset.sha256.length, 64);
  assert.equal(asset.compressedSha256.length, 64);
});
