import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceIndex } from "../src/core/workspaceIndex.js";

test("workspace index discovers symbols, tests, imports, and ranked context", async () => {
  const root = mkdtempSync(join(tmpdir(), "kitten-index-"));
  writeFileSync(join(root, "parser.py"), "from pathlib import Path\n\ndef parse_config(text):\n    return text.strip()\n");
  writeFileSync(join(root, "test_parser.py"), "from parser import parse_config\ndef test_parse_config():\n    assert parse_config(' x ') == 'x'\n");
  const index = new WorkspaceIndex();
  const overview = await index.refresh(root);
  assert.equal(overview.files, 2);
  assert.equal(overview.tests, 1);
  assert.equal(index.get("parser.py")?.symbols.includes("parse_config"), true);
  assert.deepEqual(index.get("parser.py")?.imports, ["pathlib"]);
  const hits = index.search("parse_config");
  assert.equal(hits[0].path, "parser.py");
  assert.match(index.buildContext("parse_config", 4000), /FILE parser.py/);
});

test("workspace index persists and incrementally refreshes changed files", async () => {
  const root = mkdtempSync(join(tmpdir(), "kitten-index-persist-"));
  const file = join(root, "main.ts");
  writeFileSync(file, "export function oldName() {}\n");
  const index = new WorkspaceIndex(); await index.refresh(root);
  const saved = join(root, ".kitten-index.json"); index.save(saved);
  const restored = new WorkspaceIndex(); assert.equal(restored.load(saved), true);
  assert.equal(restored.get("main.ts")?.symbols.includes("oldName"), true);
  writeFileSync(file, "export function newName() {}\n");
  await restored.refresh(root, { changedPaths: ["main.ts"] });
  assert.equal(restored.get("main.ts")?.symbols.includes("newName"), true);
  assert.equal(restored.get("main.ts")?.symbols.includes("oldName"), false);
});

