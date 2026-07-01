import test from "node:test";
import assert from "node:assert/strict";
import { gatherEvidence, formatEvidencePacket } from "../src/mission/evidence.js";
import { scanOrientation } from "../src/mission/orientation.js";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function writeBugCorpus(dir: string): string {
  const path = join(dir, "compacted.jsonl");
  const cards = [
    {
      id: "pagination",
      repo: "example/sql",
      language: "TypeScript",
      bug_type: "pagination off by one",
      symptom: "page two skips first row",
      root_cause: "cursor uses >= instead of >",
      fix_pattern: "use strict comparison and add focused pagination tests",
      failed_approaches: [],
      key_files: ["src/pagination.ts"],
      search_keywords: ["pagination", "cursor", "off by one"],
      test_signal: "pagination page two",
      embedding_text: "pagination cursor off by one",
      quality_score: 0.9,
      quality_tier: "high"
    }
  ];
  writeFileSync(path, cards.map((card) => JSON.stringify(card)).join("\n") + "\n");
  return path;
}

test("uses memory hits when repro reproduced", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-evidence-"));
  const memoryPath = writeBugCorpus(cwd);
  const orientation = scanOrientation(cwd);
  const packet = await gatherEvidence({
    cwd,
    query: "pagination cursor off by one",
    repro: { reproduced: true, alreadyPassing: false, environmentFailure: false, command: "pytest -q", exitCode: 1, failureKind: "test_assertion_error", failingTests: ["t"], errorType: "AssertionError", topStackFiles: ["src/pagination.ts"], summary: "1 failed" },
    orientation,
    memoryPath
  });
  assert.ok(packet.memoryHits.length > 0, "expected memory hits");
  assert.ok(packet.memoryHits[0].id === "pagination");
  assert.ok(packet.confidence > 0.4);
  rmSync(cwd, { recursive: true, force: true });
});

test("skips memory lookup when repro is alreadyPassing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-evidence-"));
  const memoryPath = writeBugCorpus(cwd);
  const orientation = scanOrientation(cwd);
  const packet = await gatherEvidence({
    cwd,
    query: "pagination cursor off by one",
    repro: { reproduced: false, alreadyPassing: true, environmentFailure: false, command: "pytest -q", exitCode: 0, failureKind: "none", failingTests: [], errorType: "", topStackFiles: [], summary: "passed" },
    orientation,
    memoryPath
  });
  assert.equal(packet.memoryHits.length, 0);
  assert.equal(packet.failureKind, "none");
  assert.match(packet.recommendedStrategy, /no_change_needed/);
  rmSync(cwd, { recursive: true, force: true });
});

test("uses orientation facts and marks weak evidence if nothing else", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-evidence-"));
  const orientation = scanOrientation(cwd);
  const packet = await gatherEvidence({
    cwd,
    query: "mystery failure",
    repro: { reproduced: false, alreadyPassing: false, environmentFailure: true, command: "pytest -q", exitCode: 127, failureKind: "environment", failingTests: [], errorType: "command not found", topStackFiles: [], summary: "env failure" },
    orientation
  });
  assert.ok(packet.projectFacts);
  assert.equal(packet.failureKind, "environment");
  assert.ok(packet.confidence < 0.3);
  rmSync(cwd, { recursive: true, force: true });
});

test("orders sources correctly: strategy references memory before orientation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-evidence-"));
  const memoryPath = writeBugCorpus(cwd);
  const orientation = scanOrientation(cwd);
  const packet = await gatherEvidence({
    cwd,
    query: "pagination cursor off by one",
    repro: { reproduced: true, alreadyPassing: false, environmentFailure: false, command: "pytest -q", exitCode: 1, failureKind: "test_assertion_error", failingTests: ["t"], errorType: "AssertionError", topStackFiles: ["src/pagination.ts"], summary: "1 failed" },
    orientation,
    memoryPath
  });
  assert.match(packet.recommendedStrategy, /memory/);
  const text = formatEvidencePacket(packet);
  assert.match(text, /Cheater evidence/);
  assert.match(text, /memory hits: 1/);
  rmSync(cwd, { recursive: true, force: true });
});
