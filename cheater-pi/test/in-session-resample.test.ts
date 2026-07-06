import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import {
  buildDirectCompletionPrompt,
  concreteSingleFileCommitlet,
  extractFileContent,
  extractGoalFilenames,
  resolveTargetFile,
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

test("shouldResampleInSession requires samples>1 and a resolvable single target", () => {
  const cwd = makeRepo();
  const single = makeCommitlet(cwd, ["src/app.ts"]);
  const plan = makePlan(cwd, single);
  assert.equal(shouldResampleInSession(plan, single, 3), true);
  assert.equal(shouldResampleInSession(plan, single, 1), false, "k=1 -> classic single attempt");
  assert.equal(shouldResampleInSession(plan, makeCommitlet(cwd, ["a.ts", "b.ts"]), 3), false, "multi-file -> not applicable");
});

// The exact bug the live A/B surfaced: the autopilot leaves a from-scratch "create X" commitlet with
// a "(select one target file after inspection)" placeholder, so a concrete-allowedFiles-only gate
// never engages. resolveTargetFile recovers the target from the goal.

test("resolveTargetFile recovers the goal-named file when allowedFiles is a placeholder", () => {
  const cwd = makeRepo();
  const placeholder = makeCommitlet(cwd, ["(select one target file after inspection)"]);
  const plan = { ...makePlan(cwd, placeholder), userGoal: "Create glob_match.py with match(pattern, s). Make python -m pytest pass." } as CommitletPlan;
  assert.equal(resolveTargetFile(plan, placeholder), "glob_match.py", "placeholder -> the one source file named in the goal");
  assert.equal(resolveTargetFile(plan, makeCommitlet(cwd, ["src/x.ts"])), "src/x.ts", "a concrete allowedFile wins over the goal");
  const ambiguous = { ...plan, userGoal: "Edit a.py and b.py" } as CommitletPlan;
  assert.equal(resolveTargetFile(ambiguous, placeholder), null, "two named files -> ambiguous -> no engage");
});

test("extractGoalFilenames finds source files, ignores test files and version numbers", () => {
  assert.deepEqual(extractGoalFilenames("Create glob_match.py so test_glob.py passes"), ["glob_match.py"], "the test file is excluded");
  assert.deepEqual(extractGoalFilenames("upgrade to qwen 3.5 and edit src/parser.ts"), ["src/parser.ts"], "3.5 is not a source file");
  assert.deepEqual(extractGoalFilenames("no files named here at all"), []);
});

test("concreteSingleFileCommitlet pins the goal target with a fresh rollback, then best-of-N builds it", async () => {
  const cwd = makeRepo();
  const CHECK_PY = `node -e "process.exit(require('fs').readFileSync('answer.py','utf8').includes('good')?0:1)"`;
  const placeholder = { ...makeCommitlet(cwd, ["(select one target file after inspection)"]), focusedVerification: [{ command: CHECK_PY, purpose: "content check", required: true }] };
  const plan = { ...makePlan(cwd, placeholder), userGoal: "Create answer.py that defines good output." } as CommitletPlan;
  const resolved = concreteSingleFileCommitlet(plan, placeholder, cwd);
  assert.ok(resolved, "a concrete commitlet is produced from the placeholder + goal");
  assert.deepEqual(resolved!.allowedFiles, ["answer.py"], "the goal-named file is pinned into allowedFiles");
  assert.ok(resolved!.rollbackPoint?.snapshotDir, "a fresh rollback snapshot was created for the pinned file");
  const outcome = await runInSessionResample(plan, resolved!, {}, scriptedSampler([{ ok: true, text: fence("x = 'good'", "python") }]), 2);
  assert.equal(outcome.passed, true, "best-of-N builds and verifies the pinned from-scratch file");
  assert.match(readFileSync(join(cwd, "answer.py"), "utf8"), /good/);
});

test("concreteSingleFileCommitlet returns null when no single target resolves", () => {
  const cwd = makeRepo();
  const placeholder = makeCommitlet(cwd, ["(select one target file after inspection)"]);
  const plan = { ...makePlan(cwd, placeholder), userGoal: "just refactor things generally" } as CommitletPlan;
  assert.equal(concreteSingleFileCommitlet(plan, placeholder, cwd), null, "no goal-named file + placeholder -> not applicable");
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
