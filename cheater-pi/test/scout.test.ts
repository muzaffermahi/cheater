import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scout, declaresSymbol, referencesSymbol, relativeImportSpecs } from "../src/blueprint/scout.js";

function repo(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "scout-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return cwd;
}

// --- pure helpers ----------------------------------------------------------------------------

test("declaresSymbol vs referencesSymbol", () => {
  assert.equal(declaresSymbol("export function parseExpr() {}", "parseExpr"), true);
  assert.equal(declaresSymbol("const parseExpr = () => {}", "parseExpr"), true);
  assert.equal(declaresSymbol("def parse_expr():\n    pass", "parse_expr"), true);
  assert.equal(declaresSymbol("  parseExpr();", "parseExpr"), false, "a call is not a declaration");
  assert.equal(referencesSymbol("  return parseExpr(x);", "parseExpr"), true);
  assert.equal(referencesSymbol("nothing here", "parseExpr"), false);
});

test("relativeImportSpecs finds JS and python relative imports", () => {
  const js = 'import { parseExpr } from "./parser.js";\nconst z = require("../util/z");';
  assert.deepEqual(relativeImportSpecs(js).sort(), ["../util/z", "./parser.js"]);
});

// --- noun -> brief extraction ----------------------------------------------------------------

test("deep scout finds the definition, a reference, and an import neighbor", () => {
  const cwd = repo({
    "src/parser.ts": "export function parseExpr(tokens: string[]) {\n  return tokens.map((t) => t.trim());\n}\n",
    "src/util/tok.ts": "export const tok = 1;\n",
    "src/main.ts": 'import { parseExpr } from "./parser.js";\nimport { tok } from "./util/tok.js";\nexport function run() { return parseExpr([tok as any]); }\n'
  });
  const out = scout({ cwd, symbols: ["parseExpr"], files: ["src/parser.ts"], depth: "deep" });
  const paths = out.briefs.map((b) => b.path);
  assert.ok(paths.includes("src/parser.ts"), "the contract/target file is briefed");
  assert.ok(paths.includes("src/main.ts"), "the file referencing parseExpr is briefed");
  // The parser brief carries the whole function body (function-boundary slice, not truncated).
  const parserBrief = out.briefs.find((b) => b.path === "src/parser.ts")!;
  assert.match(parserBrief.snippet ?? "", /function parseExpr/);
  assert.match(parserBrief.snippet ?? "", /tokens\.map/);
});

test("shallow scout returns only contract/target files (no symbol search)", () => {
  const cwd = repo({
    "src/parser.ts": "export function parseExpr() { return 1; }\n",
    "src/main.ts": 'import { parseExpr } from "./parser.js";\nparseExpr();\n'
  });
  const out = scout({ cwd, symbols: ["parseExpr"], files: ["src/parser.ts"], depth: "shallow" });
  const paths = out.briefs.map((b) => b.path);
  assert.deepEqual(paths, ["src/parser.ts"], "shallow lane briefs the target file only");
});

test("excludePaths are never re-briefed (no duplication of the executor's own slices)", () => {
  const cwd = repo({
    "src/parser.ts": "export function parseExpr() { return 1; }\n",
    "src/main.ts": 'import { parseExpr } from "./parser.js";\nexport function run() { return parseExpr(); }\n'
  });
  const out = scout({ cwd, symbols: ["parseExpr"], files: ["src/parser.ts"], depth: "deep", excludePaths: ["src/parser.ts"] });
  const paths = out.briefs.map((b) => b.path);
  assert.ok(!paths.includes("src/parser.ts"), "the excluded (already-briefed) file is dropped");
  assert.ok(paths.includes("src/main.ts"));
});

test("ambiguous symbol: two definition sites are both briefed and flagged", () => {
  const cwd = repo({
    "src/a.ts": "export function dup() { return 'a'; }\n",
    "src/b.ts": "export function dup() { return 'b'; }\n"
  });
  const out = scout({ cwd, symbols: ["dup"], files: [], depth: "deep" });
  assert.ok(out.ambiguous.includes("dup"), "the duplicated symbol is flagged ambiguous");
  const paths = out.briefs.map((b) => b.path).sort();
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"], "both definition sites are briefed");
});

test("byte budget evicts lowest-rank briefs first, keeping the highest-rank one", () => {
  const big = (name: string) => `export function ${name}() {\n${"  // filler line\n".repeat(60)}  return 1;\n}\n`;
  const cwd = repo({
    "src/target.ts": big("target"),        // in `files` -> RANK_FILE (highest)
    "src/other.ts": `import "./target.js";\n${big("other")}`.replace("other", "usesTarget") // references target -> lower rank
  });
  const out = scout({
    cwd,
    symbols: ["target"],
    files: ["src/target.ts"],
    depth: "deep",
    byteBudget: 200 // tiny: only the top-ranked brief fits
  });
  assert.equal(out.briefs.length, 1, "budget keeps only the highest-rank brief");
  assert.equal(out.briefs[0].path, "src/target.ts");
});

test("scout never throws on a missing/unreadable workspace", () => {
  const out = scout({ cwd: join(tmpdir(), "does-not-exist-xyz"), symbols: ["x"], files: ["a.ts"], depth: "deep" });
  assert.deepEqual(out, { briefs: [], ambiguous: [] });
});
