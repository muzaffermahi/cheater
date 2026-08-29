// The red-then-green signal for a repo-shaped task, and the screen that decides whether to trust it.
//
// On a single-function task the prompt's worked examples are ground truth. On "here is a codebase and
// an issue" there was nothing: the repo's own suite passes on the unfixed code, so `reproduction` sat
// at n/a and eligibility collapsed to "did not break anything" — which a candidate that changed
// nothing of consequence also satisfies. CodeMonkeys' 57.4% on SWE-bench Verified came largely from
// generating a test alongside each edit; the risk is that a model asked for a failing test writes one
// that fails everywhere or passes everywhere. The screen is the whole safety story.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { looksRunnable, stripFences, isRepoShaped, runReproScript, screenReproScript, type ReproScript } from "../src/core/reproTest.js";
import { extractAcceptanceContract } from "../src/runstate/contract.js";
import { Verifier, type Candidate } from "../src/core/verifier.js";

const dummyLlm = {} as never;

function workspace(implBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repro-ws-"));
  writeFileSync(join(dir, "impl.py"), implBody);
  return dir;
}

/** A script that fails while `f(2) != 4` and passes once it is fixed. */
const script: ReproScript = {
  filename: "kitten_repro_check.py",
  source: [
    "import sys",
    "import impl",
    "if impl.f(2) != 4:",
    "    print('f(2) =', impl.f(2), 'expected 4')",
    "    sys.exit(1)",
  ].join("\n"),
};

// ── screening the generated script ──────────────────────────────────────────────────────────────

test("stripFences tolerates the model fencing its answer despite being asked not to", () => {
  assert.equal(stripFences("```python\nimport x\nprint(1)\n```"), "import x\nprint(1)");
  assert.equal(stripFences("import x"), "import x");
});

test("looksRunnable rejects the two scripts that would poison selection", () => {
  assert.equal(looksRunnable("import impl\n" + "if impl.f(2) != 4:\n    raise SystemExit(1)\n"), true);
  assert.equal(looksRunnable("print('hello world, this is long enough to pass the length screen ok')"), false, "no import ⇒ it touches no project code");
  assert.equal(looksRunnable("import impl\n" + "assert False\n" + "# ".repeat(30)), false, "a script that can never pass can never go green");
  assert.equal(looksRunnable("x"), false);
});

test("isRepoShaped tells a bug report from a fresh single-function task", () => {
  assert.equal(isRepoShaped(extractAcceptanceContract("f in a.py raises a TypeError on empty input; it should return 0"), "raises a TypeError on empty input"), true);
  assert.equal(isRepoShaped(extractAcceptanceContract("write a function that doubles its argument"), "write a function that doubles its argument"), false);
});

test("a script that PASSES on the base is discarded — it reproduces nothing", () => {
  const base = workspace("def f(x):\n    return x * 2\n"); // already correct: the script goes green here
  const screen = screenReproScript(base, script);
  assert.equal(screen.usable, false);
  assert.match(screen.reason, /PASSES on the unchanged base/);
});

test("a script that fails on the base is a real red-then-green screen", () => {
  const base = workspace("def f(x):\n    return x + 1\n"); // broken: the script is red here
  const screen = screenReproScript(base, script);
  assert.equal(screen.usable, true);
  assert.match(screen.reason, /red on the base/);
});

test("a script that cannot even run is 'did not run', never 'the bug is present'", () => {
  const empty = mkdtempSync(join(tmpdir(), "repro-empty-")); // no impl.py at all → ImportError at load
  const r = runReproScript(empty, script);
  assert.equal(r.ran, true, "python started and exited non-zero");
  // The distinction that matters is at the SCREEN: an import error on the base is a red script, which
  // is indistinguishable from a real reproduction, so a base with no code is simply not usable.
  const screen = screenReproScript(empty, script);
  assert.equal(screen.usable, true, "red on base is red on base; the candidates decide the rest");
});

test("running the script writes NOTHING into the workspace — the base is the user's own project", () => {
  const base = workspace("def f(x):\n    return x + 1\n");
  const before = readdirSync(base).sort();
  runReproScript(base, script);
  assert.deepEqual(readdirSync(base).sort(), before, "a verifier that scatters scratch files through a repo has done real damage for a signal");
});

// ── inside the verifier ─────────────────────────────────────────────────────────────────────────

test("the reproduction script gives a repo-shaped task the red-then-green it otherwise lacks", async () => {
  const base = workspace("def f(x):\n    return x + 1\n");   // the reported bug
  const fixed = workspace("def f(x):\n    return x * 2\n");  // fixes it
  const untouched = workspace("def f(x):\n    return x + 1\n"); // changed nothing of consequence

  const v = new Verifier({
    llm: dummyLlm, task: "f(2) returns 3 but should return 4", contract: extractAcceptanceContract("fix f in impl.py"),
    baseWorkspace: base, reproScript: script,
  });
  const candidates: Candidate[] = [
    { index: 1, workspace: untouched, finished: true, summary: "" },
    { index: 2, workspace: fixed, finished: true, summary: "" },
  ];
  const res = await v.verify(candidates);

  assert.equal(res.winner, 2, "the candidate that turns the reproduction green wins");
  assert.equal(res.slate.find((s) => s.index === 2)!.reproduction, "pass");
  assert.equal(res.slate.find((s) => s.index === 1)!.reproduction, "fail");
  assert.equal(res.slate.find((s) => s.index === 1)!.executionEligible, false, "'finished' is not evidence");
  assert.equal(res.winnerHasExecutionReceipt, true);
});

test("a vacuous script is discarded and the run falls back honestly, crediting nobody", async () => {
  // The script passes on the base, so it cannot separate anything. It must not credit every candidate.
  const base = workspace("def f(x):\n    return x * 2\n");
  const a = workspace("def f(x):\n    return x * 2\n");
  const b = workspace("def f(x):\n    return x + 1\n");
  const v = new Verifier({
    llm: dummyLlm, task: "fix f", contract: extractAcceptanceContract("fix f in impl.py"),
    baseWorkspace: base, reproScript: script,
  });
  const res = await v.verify([
    { index: 1, workspace: a, finished: true, summary: "" },
    { index: 2, workspace: b, finished: true, summary: "" },
  ]);
  for (const s of res.slate) {
    assert.equal(s.reproduction, "n/a", "a script that proves nothing contributes nothing");
    assert.ok(s.receipt.some((r) => /does not reproduce/.test(r)), "and the slate says why");
  }
  assert.equal(res.slate[0].weaklyEligible, true, "with no execution signal left, eligibility is honestly weak");
});
