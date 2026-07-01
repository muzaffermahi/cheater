import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBugMemoryHits, searchBugMemories, tokenize } from "../src/bug-memory.js";

function writeCorpus(dir: string): string {
  const path = join(dir, "compacted.jsonl");
  const cards = [
    {
      id: "lexicon-memset",
      repo: "AnalogJ/lexicon",
      language: "Python",
      bug_type: "TypeError in memset provider output",
      symptom: "TypeError: string indices must be integers in handle_output when memset create returns a raw record id string.",
      root_cause: "create_record in lexicon/providers/memset.py returns a string, while table formatting expects a list of dictionaries.",
      fix_pattern: "Wrap the returned record id in a list containing a dict with id, type, name, content, and ttl.",
      failed_approaches: [],
      key_files: ["lexicon/providers/memset.py"],
      search_keywords: ["memset", "string indices must be integers", "create_record", "provider output"],
      test_signal: "TypeError: string indices must be integers",
      embedding_text: "Memset provider returns raw string id instead of list of record dicts.",
      quality_score: 1,
      quality_tier: "high"
    },
    {
      id: "sql-pagination",
      repo: "example/sql",
      language: "TypeScript",
      bug_type: "pagination off by one",
      symptom: "The next page cursor skips the first result on page two.",
      root_cause: "Cursor comparison uses greater than or equal instead of greater than.",
      fix_pattern: "Use a strict comparison and add focused pagination tests.",
      failed_approaches: [],
      key_files: ["src/pagination.ts"],
      search_keywords: ["pagination", "cursor", "off by one"],
      test_signal: "pagination page two",
      embedding_text: "Pagination cursor off by one skips records.",
      quality_score: 0.9,
      quality_tier: "high"
    }
  ];
  writeFileSync(path, cards.map((card) => JSON.stringify(card)).join("\n") + "\n");
  return path;
}

test("tokenize extracts useful code and error terms", () => {
  const terms = tokenize("TypeError: string indices must be integers in create_record");
  assert.ok(terms.includes("typeerror"));
  assert.ok(terms.includes("create_record"));
  assert.ok(terms.includes("record"));
});

test("searchBugMemories builds an on-disk index and ranks the relevant compacted bug", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-memory-"));
  const memoryPath = writeCorpus(dir);
  const result = await searchBugMemories({
    cwd: dir,
    memoryPath,
    query: "TypeError string indices must be integers memset create_record",
    topK: 2
  });
  assert.equal(result.built, true);
  assert.equal(result.docCount, 2);
  assert.equal(result.hits[0].id, "lexicon-memset");
  assert.match(formatBugMemoryHits(result), /fix pattern/);
  assert.ok(existsSync(join(result.indexDir, "metadata.json")));
  assert.ok(readdirSync(join(result.indexDir, "shards")).length > 0);

  const second = await searchBugMemories({
    cwd: dir,
    memoryPath,
    query: "pagination cursor page two",
    topK: 1
  });
  assert.equal(second.built, false);
  assert.equal(second.hits[0].id, "sql-pagination");
});
