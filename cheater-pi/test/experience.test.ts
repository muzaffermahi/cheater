import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffSkeleton,
  extractErrorType,
  failureSimilarity,
  failureTokens,
  fingerprintFailure,
  loadExperience,
  recallExperience,
  saveVerifiedFix
} from "../src/reliability/experience.js";
import { runFocusedVerification } from "../src/commitlet/verification.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-experience-"));
}

test("fingerprint is stable across line numbers, paths, and quoted values", () => {
  const a = fingerprintFailure('TypeError: cannot read properties of undefined (reading "port") at C:\\repo\\src\\server.ts:42');
  const b = fingerprintFailure("TypeError: cannot read properties of undefined (reading 'port') at /home/x/src/server.ts:97");
  assert.equal(a, b);
  assert.match(a, /^typeerror\|/);
});

test("error type extraction covers python, js, tsc, and pytest shapes", () => {
  assert.equal(extractErrorType("AssertionError: expected 3 got 4"), "assertionerror");
  assert.equal(extractErrorType("src/a.ts(3,1): error TS2345: bad arg"), "ts2345");
  assert.equal(extractErrorType("FAILED tests/test_x.py::test_y - boom"), "test_failure");
  assert.equal(extractErrorType("Cannot find module 'left-pad'"), "import_error");
});

test("diff skeleton keeps only the changed lines, bounded", () => {
  const diff = [
    "--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@",
    " context line",
    "-const port = 8080;",
    "+const port = Number(process.env.PORT ?? 8080);",
    " more context"
  ].join("\n");
  const skeleton = diffSkeleton(diff);
  assert.match(skeleton, /-const port = 8080;/);
  assert.match(skeleton, /\+const port = Number/);
  assert.doesNotMatch(skeleton, /context line/);
  assert.doesNotMatch(skeleton, /\+\+\+/);
});

test("saveVerifiedFix persists, dedupes by fingerprint, and increments hits", () => {
  const cwd = tmpRepo();
  const failure = "TypeError: x.split is not a function at src/parse.ts:10";
  const first = saveVerifiedFix(cwd, { failureText: failure, diffText: "-bad()\n+good()", files: ["src/parse.ts"], goal: "fix parser" });
  assert.ok(first);
  assert.equal(first!.hits, 1);
  const again = saveVerifiedFix(cwd, { failureText: "TypeError: x.split is not a function at src/parse.ts:99", diffText: "-worse()\n+best()", files: ["src/parse.ts"] });
  assert.equal(again!.hits, 2, "same fingerprint must update the card, not duplicate it");
  const cards = loadExperience(cwd);
  assert.equal(cards.length, 1);
  assert.match(cards[0].fixSummary, /\+best\(\)/, "latest verified fix wins");
});

test("recall matches a similar failure and renders an actionable in-band hint", () => {
  const cwd = tmpRepo();
  saveVerifiedFix(cwd, {
    failureText: "AssertionError: expected sum_range(1, 5) to equal 15 but got 10 in tests/test_sum.py",
    diffText: "-    return sum(range(a, b))\n+    return sum(range(a, b + 1))",
    files: ["src/sum_range.py"],
    goal: "fix off-by-one"
  });
  const hint = recallExperience(cwd, "AssertionError: expected sum_range(2, 4) to equal 9 but got 5 in tests/test_sum.py line 33");
  assert.ok(hint, "similar assertion failure must recall the verified fix");
  assert.match(hint!, /CHEATER EXPERIENCE/);
  assert.match(hint!, /range\(a, b \+ 1\)/);
  assert.match(hint!, /otherwise ignore this hint/);
});

test("recall stays silent for unrelated failures and empty stores", () => {
  const cwd = tmpRepo();
  assert.equal(recallExperience(cwd, "TypeError: boom"), null, "empty store recalls nothing");
  saveVerifiedFix(cwd, { failureText: "ImportError: No module named requests", diffText: "-import request\n+import requests", files: ["src/api.py"] });
  assert.equal(recallExperience(cwd, "AssertionError: totals mismatch expected 4 got 7"), null, "unrelated failure must not match");
});

test("similarity blends error type and token overlap", () => {
  const cwd = tmpRepo();
  const card = saveVerifiedFix(cwd, { failureText: "KeyError: 'session_token' in auth middleware handler", diffText: "-x\n+y", files: ["a.py"] })!;
  assert.ok(failureSimilarity(card, "KeyError: 'session_token' raised by auth middleware handler again") >= 0.55);
  assert.ok(failureSimilarity(card, "ValueError: bad padding") < 0.55);
  assert.ok(failureTokens("KeyError session_token auth middleware").includes("middleware"));
});

test("focused verification stays lean; evidence recall is owned by the Cheat Layer, not the per-attempt scorer", () => {
  const cwd = tmpRepo();
  // Even with a matching verified fix on disk, runFocusedVerification must NOT inject it:
  // this function also scores every resampling candidate, and evidence retrieval runs
  // exactly once per graded failure (buildCheatSheet in gradeCommitlet), not once per
  // attempt. The recall itself is covered by cheat-sheet tests.
  saveVerifiedFix(cwd, {
    failureText: "ReferenceError: totals is not defined at calc.js",
    diffText: "-  return totals;\n+  return total;",
    files: ["calc.js"]
  });
  writeFileSync(join(cwd, "calc.js"), "throw new ReferenceError('totals is not defined');\n", "utf8");
  const commitlet: any = {
    id: "c1", title: "t", purpose: "p", status: "running", scope: "edit",
    allowedFiles: ["calc.js"], forbiddenFiles: [], allowedActions: ["edit"], forbiddenActions: [],
    maxFilesTouched: 1, maxDiffLines: 100, maxToolCalls: 5, maxModelCalls: 1,
    expectedFilesTouched: ["calc.js"],
    focusedVerification: [{ command: "node calc.js", purpose: "run", required: true }],
    broaderVerification: [],
    healthBudget: { maxComplexityIncrease: 5, maxDuplicationIncrease: 5, maxFunctionLengthIncrease: 5, allowNewLargeFunction: false, allowTestEdits: false, allowDependencyEdits: false, allowLockfileEdits: false },
    risk: "low"
  };
  const result = runFocusedVerification(cwd, commitlet);
  assert.equal(result.passed, false);
  assert.match(result.summary, /ReferenceError/);
  assert.doesNotMatch(result.summary, /CHEATER EXPERIENCE|CHEAT SHEET/);
});
