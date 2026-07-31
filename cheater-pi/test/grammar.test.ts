import test from "node:test";
import assert from "node:assert/strict";
import { enumGrammar, jsonEnumGrammar, pathGrammar, isNewFilePath, newFilePathOf, parseEditScript, grammarAlternatives, EDIT_SCRIPT_GRAMMAR, MAX_GRAMMAR_PATHS } from "../src/core/grammar.js";
import { closedSetLabels } from "../src/core/sidecarJobs.js";

test("an enum grammar admits exactly its labels", () => {
  const grammar = enumGrammar(["question", "bug", "feature"]);
  assert.equal(grammar, 'root ::= "question" | "bug" | "feature"');
  // Duplicates and padding are the caller's accident, not the grammar's problem.
  assert.equal(enumGrammar([" bug ", "bug", "feature"]), 'root ::= "bug" | "feature"');
  assert.throws(() => enumGrammar([]), /at least one label/);
  // The JSON form escapes its quotes, so the key and labels arrive as GBNF string literals.
  const json = jsonEnumGrammar(["low", "high"], "risk");
  assert.ok(json.includes('\\"risk\\"'), json);
  assert.ok(json.includes('\\"low\\"') && json.includes('\\"high\\"'), json);
});

test("the classifier's grammar matches the validator that accepts its answer", () => {
  // A grammar that can emit a label the validator rejects would trade a parse failure for a silent
  // fallback — worse than no grammar at all.
  const labels = closedSetLabels("classify_task");
  assert.ok(labels, "classify_task is a closed set");
  const accepted = /^(question|bug|feature|refactor|general)$/;
  for (const label of labels!) assert.match(label, accepted, `${label} must satisfy the validator`);
  assert.equal(closedSetLabels("summarize_output"), null, "open-ended jobs stay unconstrained");
});

test("a path grammar always keeps an arm for files that do not exist yet", () => {
  const grammar = pathGrammar(["src/parser.ts", "src/index.ts"]);
  assert.match(grammar, /"src\/parser\.ts"/);
  // The whole point: constraining to indexed files alone would make creating a file impossible, so the
  // model would be forced to name the wrong existing file — the failure the guard exists to prevent.
  assert.match(grammar, /new ::= "NEW_FILE:"/);
  assert.ok(isNewFilePath("NEW_FILE: src/added.ts"));
  assert.equal(newFilePathOf("NEW_FILE: src/added.ts"), "src/added.ts");
  assert.equal(isNewFilePath("src/parser.ts"), false);

  // Windows separators are normalised so a path is representable however the index spelled it.
  assert.match(pathGrammar(["src\\win\\file.ts"]), /"src\/win\/file\.ts"/);
  // An empty index still produces a loadable grammar rather than a syntax error.
  assert.match(pathGrammar([]), /root ::= existing \| new/);
});

test("a path grammar stays cheap enough to sample against", () => {
  const many = Array.from({ length: 5000 }, (_, index) => `src/file-${index}.ts`);
  const grammar = pathGrammar(many);
  // Grammar cost tracks alternatives, and an unbounded repo would put thousands into one rule.
  assert.ok(grammarAlternatives(grammar) <= MAX_GRAMMAR_PATHS, `alternatives ${grammarAlternatives(grammar)} exceeded the cap`);
  assert.ok(!grammar.includes("src/file-4999.ts"), "the tail is dropped, not sampled against");
});

test("an edit script round-trips through its parser", () => {
  const script = [
    "<<<< FILE src/stats.py",
    "<<<< FIND",
    "    return s[len(s) // 2]",
    ">>>> REPLACE",
    "    if n % 2 == 0:",
    "        return (s[mid - 1] + s[mid]) / 2",
    ">>>> END",
    "<<<< FILE src/other.py",
    "<<<< FIND",
    "x = 1",
    ">>>> REPLACE",
    "x = 2",
    ">>>> END",
    "",
  ].join("\n");
  const hunks = parseEditScript(script);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].path, "src/stats.py");
  assert.equal(hunks[0].find, "    return s[len(s) // 2]");
  assert.match(hunks[0].replace, /return \(s\[mid - 1\] \+ s\[mid\]\) \/ 2/);
  assert.equal(hunks[1].path, "src/other.py");
  assert.equal(hunks[1].replace, "x = 2");

  // Prose around the script is ignored rather than corrupting a hunk: the grammar guarantees the shape
  // only on endpoints that support grammars, and this format must survive a proxy that does not.
  assert.equal(parseEditScript("here is my plan\nno hunks at all").length, 0);
  assert.match(EDIT_SCRIPT_GRAMMAR, /root ::= hunk\+/);
});
