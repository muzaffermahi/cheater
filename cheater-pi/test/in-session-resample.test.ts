import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import {
  buildDirectCompletionPrompt,
  extractFileContent,
  runInSessionResample,
  shouldResampleInSession,
  singleTargetFile,
  type InSessionSampler
} from "../src/commitlet/inSessionResample.js";
import type { Commitlet, CommitletPlan } from "../src/commitlet/types.js";

// Same execution selector as the fresh-worker resampling test: verification passes iff target.txt
// contains "good". The in-session loop scores every candidate through this real guard->health->verify.
const CHECK = `node -e "process.exit(require('fs').readFileSync('target.txt','utf8').includes('good')?0:1)"`;

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-insession-"));
  writeFileSync(join(cwd, "target.txt"), "original\n", "utf8");
  return cwd;
}

function makeCommitlet(cwd: string, allowedFiles: string[] = ["target.txt"]): Commitlet {
  const commitlet: Commitlet = {
    id: "c1", title: "edit target", purpose: "make target good", status: "running", scope: "edit",
    allowedFiles, forbiddenFiles: [], allowedActions: ["edit"], forbiddenActions: [],
    maxFilesTouched: 2, maxDiffLines: 200, maxToolCalls: 5, maxModelCalls: 1,
    expectedFilesTouched: allowedFiles,
    focusedVerification: [{ command: CHECK, purpose: "content check", required: true }],
    broaderVerification: [],
    healthBudget: { maxComplexityIncrease: 5, maxDuplicationIncrease: 5, maxFunctionLengthIncrease: 5, allowNewLargeFunction: false, allowTestEdits: false, allowDependencyEdits: false, allowLockfileEdits: false },
    spec: {
      behaviorMustHold: ["target.txt must contain the word good"],
      behaviorMustNotChange: [], edgeCases: ["empty input"], acceptanceCriteria: ["the check passes"],
      temporaryTestsAllowed: false, permanentTestsAllowed: false, nonGoals: ["do not add extra files"]
    },
    risk: "low"
  };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  return commitlet;
}

function makePlan(cwd: string, commitlet: Commitlet): CommitletPlan {
  return {
    id: "plan1", createdAt: new Date().toISOString(), repoRoot: cwd, userGoal: "make target good",
    summary: "test plan", status: "running", currentIndex: 0, commitlets: [commitlet], globalConstraints: []
  } as unknown as CommitletPlan;
}

/** Fake sampler: returns the next scripted completion text. No model, no filesystem side effects -
 *  the LOOP does the extract+write, exactly as in production. */
function scriptedSampler(samples: Array<{ ok: boolean; text?: string; error?: string }>): InSessionSampler {
  let call = 0;
  return async () => {
    const s = samples[Math.min(call, samples.length - 1)];
    call += 1;
    return s;
  };
}

const fence = (body: string, lang = ""): string => "```" + lang + "\n" + body + "\n```";

// ---- the loop ----

test("first verified sample is kept immediately with no further sampling", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  const sampler = scriptedSampler([{ ok: true, text: fence("good v1") }]);
  const outcome = await runInSessionResample(plan, commitlet, {}, sampler, 3);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.attemptsRun, 1, "early exit after the first verified pass");
  assert.equal(outcome.appliedAttempt, 1);
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /good v1/);
});

test("a failing sample is reverted and a later fresh sample wins (best-of-N)", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  const sampler = scriptedSampler([
    { ok: true, text: fence("bad attempt") },
    { ok: true, text: fence("good v2") }
  ]);
  const outcome = await runInSessionResample(plan, commitlet, {}, sampler, 3);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.attemptsRun, 2);
  assert.equal(outcome.appliedAttempt, 2);
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /good v2/);
});

test("when nothing passes, the best-ranked candidate stays on disk; a no-op sample is reverted first", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  // Sample 1: a real (failing) edit. Sample 2: prose with no code block -> no write; the loop must
  // have reverted sample 1 first, so sample 2 scores as a no-op, and sample 1 (an actual edit)
  // outranks it and is re-applied.
  const sampler = scriptedSampler([
    { ok: true, text: fence("close but wrong") },
    { ok: true, text: "I am not able to write this file." }
  ]);
  const outcome = await runInSessionResample(plan, commitlet, {}, sampler, 2);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.attemptsRun, 2);
  assert.equal(outcome.appliedAttempt, 1, "an actual failing edit outranks a no-op sample");
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /close but wrong/, "best candidate re-applied");
  assert.match(outcome.note, /kept best/);
});

test("a completion error scores as a no-edit and resampling continues", async () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd);
  const plan = makePlan(cwd, commitlet);
  const sampler = scriptedSampler([
    { ok: false, error: "sidecar timed out" },
    { ok: true, text: fence("good after error") }
  ]);
  const outcome = await runInSessionResample(plan, commitlet, {}, sampler, 3);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.appliedAttempt, 2);
  assert.match(readFileSync(join(cwd, "target.txt"), "utf8"), /good after error/);
});

test("a multi-file commitlet is not applicable and no-ops cleanly (falls back to the handoff)", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "other.txt"), "x\n", "utf8");
  const commitlet = makeCommitlet(cwd, ["target.txt", "other.txt"]);
  const plan = makePlan(cwd, commitlet);
  let called = false;
  const sampler: InSessionSampler = async () => { called = true; return { ok: true, text: fence("good") }; };
  const outcome = await runInSessionResample(plan, commitlet, {}, sampler, 3);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.attemptsRun, 0);
  assert.equal(called, false, "no sampling for a non-single-file commitlet");
  assert.match(outcome.note, /not applicable/);
});

// ---- gating helpers ----

test("singleTargetFile returns the one editable file, else null", () => {
  const cwd = makeRepo();
  assert.equal(singleTargetFile(makeCommitlet(cwd, ["src/glob.py"])), "src/glob.py");
  assert.equal(singleTargetFile(makeCommitlet(cwd, ["a.ts", "b.ts"])), null, "multi-file -> null");
  assert.equal(singleTargetFile(makeCommitlet(cwd, ["(inspect)", "src/x/"])), null, "placeholders/dirs are not editable files");
});

test("shouldResampleInSession requires samples>1, a rollback snapshot, and a single file", () => {
  const cwd = makeRepo();
  const single = makeCommitlet(cwd, ["target.txt"]);
  assert.equal(shouldResampleInSession(single, 3), true);
  assert.equal(shouldResampleInSession(single, 1), false, "k=1 -> classic single attempt");
  const noRollback = { ...single, rollbackPoint: undefined } as Commitlet;
  assert.equal(shouldResampleInSession(noRollback, 3), false, "no snapshot -> cannot revert between samples");
  assert.equal(shouldResampleInSession(makeCommitlet(cwd, ["a.ts", "b.ts"]), 3), false, "multi-file -> not applicable");
});

// ---- extraction ----

test("extractFileContent pulls a fenced block and strips REPL prompts", () => {
  assert.equal(extractFileContent(fence("def f():\n    return 1", "python"), "f.py"), "def f():\n    return 1");
  assert.equal(
    extractFileContent(fence(">>> def f():\n...     return 1\n>>> f()", "python"), "f.py"),
    "def f():\n    return 1\nf()",
    "REPL prompt lines are stripped to the entered source (every >>>/... line is kept)"
  );
});

test("extractFileContent prefers the block whose language matches the target extension", () => {
  const text = [fence("console.log('js')", "javascript"), fence("print('py')", "python")].join("\n\n");
  assert.equal(extractFileContent(text, "script.py"), "print('py')", "picks the python block for a .py target");
  assert.equal(extractFileContent(text, "script.js"), "console.log('js')", "picks the js block for a .js target");
});

test("extractFileContent prefers the longest matching block (the file, not a snippet)", () => {
  const text = [fence("x = 1", "python"), fence("def big():\n    return 42\n\nbig()", "python")].join("\n\n");
  assert.match(extractFileContent(text, "m.py") ?? "", /def big/, "the full-file block beats a one-liner snippet");
});

test("extractFileContent falls back to raw code-looking text, else null", () => {
  assert.match(extractFileContent("import os\n\ndef f():\n    return os", "f.py") ?? "", /def f/, "no fence but clearly source");
  assert.equal(extractFileContent("Sure, here is how you might approach it.", "f.py"), null, "prose -> null");
  assert.equal(extractFileContent("", "f.py"), null, "empty -> null");
});

// ---- prompt ----

test("buildDirectCompletionPrompt carries goal, target, spec, stance, and the output rule", () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd, ["src/glob.py"]);
  const plan = makePlan(cwd, commitlet);
  const { system, prompt } = buildDirectCompletionPrompt(plan, commitlet, "src/glob.py", null, "STANCE-XYZ");
  assert.match(system, /one fenced code block/);
  assert.match(prompt, /make target good/, "the user goal");
  assert.match(prompt, /src\/glob\.py/, "the target file");
  assert.match(prompt, /must contain the word good/, "a spec requirement");
  assert.match(prompt, /empty input/, "an edge case");
  assert.match(prompt, /STANCE-XYZ/, "the per-attempt stance for diversity");
  assert.match(prompt, /Output ONLY the complete, final contents/, "the single-block output rule");
});

test("buildDirectCompletionPrompt includes current contents when the file already exists", () => {
  const cwd = makeRepo();
  const commitlet = makeCommitlet(cwd, ["target.txt"]);
  const plan = makePlan(cwd, commitlet);
  const withCurrent = buildDirectCompletionPrompt(plan, commitlet, "target.txt", "EXISTING-BODY", "");
  assert.match(withCurrent.prompt, /Current contents of target\.txt/);
  assert.match(withCurrent.prompt, /EXISTING-BODY/);
  const fromScratch = buildDirectCompletionPrompt(plan, commitlet, "target.txt", null, "");
  assert.doesNotMatch(fromScratch.prompt, /Current contents of/, "from-scratch: no current-contents block");
});
