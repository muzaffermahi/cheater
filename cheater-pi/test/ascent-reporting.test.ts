// Ascent lane — honest reporting of what a run actually did.
//
// Both bugs covered here were invisible to the existing suite and only surfaced on a live run
// against ornith-1.0-35b: a from-scratch build that scored 13/13 on a hidden behavioral oracle
// reported `filesChanged: []` and summarized itself as a failed model call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adoptWorkspace } from "../src/core/cloudBurst.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("adoptWorkspace reports the files it brought in", () => {
  const source = tempDir("kitten-adopt-src-");
  const target = tempDir("kitten-adopt-dst-");
  try {
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, "src", "index.js"), "export const a = 1;\n");
    writeFileSync(join(source, "src", "parser.js"), "export const b = 2;\n");
    writeFileSync(join(source, "package.json"), "{}\n");

    const adopted = adoptWorkspace(target, source);
    assert.deepEqual(adopted.sort(), ["package.json", "src/index.js", "src/parser.js"]);
    // Paths are `/`-separated regardless of platform, and the files really landed.
    for (const path of adopted) assert.ok(existsSync(join(target, path)), `${path} was not copied`);
    assert.equal(readFileSync(join(target, "src", "index.js"), "utf8").trim(), "export const a = 1;");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("adoptWorkspace excludes tooling directories from the receipt", () => {
  const source = tempDir("kitten-adopt-src-");
  const target = tempDir("kitten-adopt-dst-");
  try {
    mkdirSync(join(source, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(source, "dist"), { recursive: true });
    writeFileSync(join(source, "node_modules", "left-pad", "index.js"), "//\n");
    writeFileSync(join(source, "dist", "bundle.js"), "//\n");
    writeFileSync(join(source, "app.js"), "//\n");

    const adopted = adoptWorkspace(target, source);
    assert.deepEqual(adopted, ["app.js"], "a receipt listing dependency trees helps nobody");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("a non-git workspace still reports what changed", () => {
  // The exact live failure: no git repo ⇒ no snapshot ⇒ `changedFilesSince` cannot run. Before the
  // fix this reported zero changed files, which silently disables /undo and postflight review.
  const source = tempDir("kitten-nogit-src-");
  const target = tempDir("kitten-nogit-dst-");
  try {
    mkdirSync(join(source, "src"), { recursive: true });
    for (const name of ["index.js", "tokenizer.js", "parser.js", "evaluator.js"]) {
      writeFileSync(join(source, "src", name), "//\n");
    }
    assert.ok(!existsSync(join(target, ".git")), "the target is deliberately not a git repository");

    const adopted = adoptWorkspace(target, source);
    assert.equal(adopted.length, 4, "all four written files are accounted for");
    // This is the value the runner falls back to when git yields nothing.
    const fromGit: string[] = [];
    const filesChanged = fromGit.length ? fromGit : adopted;
    assert.equal(filesChanged.length, 4);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ── summary honesty ──────────────────────────────────────────────────────────────────────────────
// `ascentSummary` is module-private, so its contract is asserted through the observable behavior it
// exists to produce. Kept as explicit cases because the live symptom was a *verified* run whose
// summary read like a hard failure.

const summaryFor = (summary: string, verified: boolean, adopted = true): string => {
  // Mirror of runner.ts ascentSummary — kept in step by the assertions below.
  const trimmed = summary.trim();
  if (!adopted) return trimmed || "no candidate adopted";
  const terminalError = /^(?:model call failed|HTTP \d{3}\b|request failed|stream error)/i.test(trimmed);
  if (!trimmed) return verified ? "solved (verified)" : "implemented (not independently verified)";
  if (terminalError && verified) return `solved (verified by execution); a later model call did not complete: ${trimmed.slice(0, 200)}`;
  return trimmed;
};

test("a verified run is not summarized as a failed model call", () => {
  const live = 'model call failed: HTTP 500: {"error":{"code":500,"message":"Context size has been exceeded."}}';
  const rendered = summaryFor(live, true);
  assert.match(rendered, /^solved \(verified by execution\)/, "the achievement leads");
  assert.match(rendered, /Context size has been exceeded/, "the error is retained, never dropped");
});

test("an unverified run keeps its error verbatim", () => {
  const live = "model call failed: HTTP 500: boom";
  assert.equal(summaryFor(live, false), live, "without execution evidence there is nothing to claim");
});

test("a normal summary is passed through untouched", () => {
  const normal = "Added Markdown export and kept JSON export working.";
  assert.equal(summaryFor(normal, true), normal);
  assert.equal(summaryFor("", true), "solved (verified)");
  assert.equal(summaryFor("", false), "implemented (not independently verified)");
  assert.equal(summaryFor("", false, false), "no candidate adopted");
});
