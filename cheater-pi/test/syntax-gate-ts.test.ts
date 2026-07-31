import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { postEditSyntaxGate, typeScriptSyntaxDiagnostic } from "../src/core/reliable.js";
import { localTscBin } from "../src/reliability/typeCheckGate.js";
import type { ToolContext, ToolResult } from "../src/core/tools.js";

// The post-edit gate used to skip .ts/.tsx entirely ("no cheap standalone check without tsc"),
// leaving the repo's own primary language as the one hole in it. These cover the filter that makes
// running a single-file tsc per edit safe, and one real end-to-end run.

const ok: ToolResult = { output: "edited", isError: false };
function ctxAt(cwd: string): ToolContext {
  return { cwd, filesRead: new Set(), filesWritten: new Set() };
}

test("syntax diagnostic keeps TS1xxx grammar errors", () => {
  const out = "src/a.ts(4,1): error TS1005: '}' expected.";
  const message = typeScriptSyntaxDiagnostic("src/a.ts", out);
  assert.ok(message, "a grammar error must reach the model");
  assert.match(message!, /SYNTAX CHECK FAILED for src\/a\.ts/);
  assert.match(message!, /TS1005/);
});

test("syntax diagnostic drops TS2xxx semantic noise from single-file compilation", () => {
  // Compiling one file outside its project always produces these. They are an artifact of the
  // invocation, not a defect in the edit — reporting them would send the model chasing phantoms.
  const out = [
    "src/a.ts(1,20): error TS2307: Cannot find module './helper' or its corresponding type declarations.",
    "src/a.ts(9,3): error TS2554: Expected 2 arguments, but got 1.",
    "src/a.ts(12,7): error TS2339: Property 'x' does not exist on type 'Y'."
  ].join("\n");
  assert.equal(typeScriptSyntaxDiagnostic("src/a.ts", out), undefined, "semantic errors are the typecheck gate's job, not this one's");
});

test("syntax diagnostic returns undefined on clean output", () => {
  assert.equal(typeScriptSyntaxDiagnostic("src/a.ts", ""), undefined);
  assert.equal(typeScriptSyntaxDiagnostic("src/a.ts", "\n\n"), undefined);
});

test("syntax diagnostic bounds how much it reports", () => {
  const out = Array.from({ length: 20 }, (_, i) => `src/a.ts(${i + 1},1): error TS1005: '}' expected.`).join("\n");
  const message = typeScriptSyntaxDiagnostic("src/a.ts", out)!;
  assert.equal(message.split("\n").filter((l) => l.includes("TS1005")).length, 4, "a flood of errors must not blow the model's context");
});

test("gate is a no-op when the tool call failed or was not an edit", () => {
  const ctx = ctxAt(mkdtempSync(join(tmpdir(), "kt-sg-")));
  assert.equal(postEditSyntaxGate({ name: "edit", args: { path: "a.ts" } }, { output: "", isError: true }, ctx), undefined);
  assert.equal(postEditSyntaxGate({ name: "read", args: { path: "a.ts" } }, ok, ctx), undefined);
});

test("gate skips honestly when no tsc is installed in the project", () => {
  // A tmpdir has no node_modules/.bin/tsc. A missing checker must never block or throw.
  const cwd = mkdtempSync(join(tmpdir(), "kt-sg-"));
  writeFileSync(join(cwd, "a.ts"), "export function f(a: string) { return a;\n");
  assert.equal(localTscBin(cwd), null, "precondition: no local tsc in a bare tmpdir");
  assert.equal(postEditSyntaxGate({ name: "edit", args: { path: "a.ts" } }, ok, ctx(cwd)), undefined);
  function ctx(dir: string): ToolContext { return ctxAt(dir); }
});

// The end-to-end run needs the real tsc, which only exists once this repo's devDependencies are
// installed. Skip rather than fail when it is absent, so the suite still runs in a bare checkout.
const repoRoot = resolve(import.meta.dirname, "..", "..");
const haveTsc = existsSync(repoRoot) && localTscBin(repoRoot) !== null;

/**
 * Run the gate the way a real edit reaches it: a project-relative path inside a project that has
 * tsc installed. The scratch dir therefore has to live under the repo root.
 */
function gateOnRepoFile(name: string, source: string): string | undefined {
  const dir = mkdtempSync(join(repoRoot, ".kt-syntax-gate-"));
  try {
    writeFileSync(join(dir, name), source);
    const relative = `${basename(dir)}/${name}`;
    return postEditSyntaxGate({ name: "edit", args: { path: relative } }, ok, ctxAt(repoRoot));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gate catches a real unbalanced brace in a .ts file", { skip: haveTsc ? false : "no local tsc" }, () => {
  const message = gateOnRepoFile("broken.ts", "export function f(a: string) { return a;\n");
  assert.ok(message, "an unbalanced brace must be reported");
  assert.match(message!, /SYNTAX CHECK FAILED/);
  assert.match(message!, /TS1\d{3}/);
});

test("gate passes a valid .ts file that imports an unresolvable module", { skip: haveTsc ? false : "no local tsc" }, () => {
  // Syntactically perfect, but the import cannot resolve from here. That is TS2307 noise and must
  // NOT be reported — this is the false-positive case that would make the gate harmful.
  const message = gateOnRepoFile("fine.ts", "import { thing } from './nowhere.js';\nexport const value: number = thing ? 1 : 2;\n");
  assert.equal(message, undefined, "unresolved imports are not a syntax defect");
});

test("gate accepts valid TypeScript that plain node --check would reject", { skip: haveTsc ? false : "no local tsc" }, () => {
  // `node --check` was the cheaper candidate for this gate and was rejected precisely here: it
  // treats `enum` as a reserved word and fails valid TypeScript.
  const message = gateOnRepoFile("enums.ts", "enum Color { Red, Green }\nexport const c: Color = Color.Red;\n");
  assert.equal(message, undefined, "a false syntax failure is worse than no gate at all");
});
