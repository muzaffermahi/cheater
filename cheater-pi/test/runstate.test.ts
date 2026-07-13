import test from "node:test";
import assert from "node:assert/strict";
import { extractAcceptanceContract, summarizeContract } from "../src/runstate/contract.js";
import { MutationLedger, mutationsFromCommand } from "../src/runstate/mutationLedger.js";
import { ValidationLedger, mirrorsEvaluator } from "../src/runstate/validationLedger.js";
import { PhaseController } from "../src/runstate/phaseController.js";
import { PostSuccessGuard } from "../src/runstate/postSuccessGuard.js";
import { assessRisk } from "../src/runstate/riskMiddleware.js";
import {
  buildPromptCapsule,
  capsuleSizeReport,
  estimateCapsuleTokens,
  renderCapsulePrompt,
  CAPSULE_WARN_TOKENS
} from "../src/runstate/promptCapsule.js";
import { selectRulePacks, recallHarnessLessons, recordFailureAnalysis } from "../src/runstate/rulePacks.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The core harness principle under test: every active agent's context must be small,
// specific, and disposable. These tests pin the deterministic pieces - the literal
// acceptance contract, the ledgers that stale old proof, the phase machine that stops
// late-task refactors, the guard that stops post-success self-sabotage, and the capsule
// that is the ONLY path context can take into a spawned worker.

// ---------------------------------------------------------------------------
// Contract extraction (Phase 3): the literal terms survive, never a paraphrase.
// ---------------------------------------------------------------------------

test("contract extraction preserves exact paths, endpoints, ports, commands, and columns from a task description", () => {
  const goal = [
    "Build a small web service. It must expose GET /api/health on port 8080",
    "and write results to output.json. Run `npm test` to verify.",
    "Do not modify legacy/config.yaml. The CSV must have columns id,name,score."
  ].join(" ");
  const contract = extractAcceptanceContract(goal);
  assert.ok(contract.endpoints.includes("/api/health"), `endpoints must keep /api/health exactly; got ${contract.endpoints}`);
  assert.ok(contract.ports.includes(8080));
  assert.ok(contract.files.includes("output.json"));
  assert.ok(contract.outputPaths.includes("output.json"), "output.json follows a write verb and must be an output path");
  assert.ok(contract.files.includes("legacy/config.yaml"));
  assert.ok(contract.commands.includes("npm test"));
  assert.ok(contract.forbidden.some((f) => /legacy\/config\.yaml/.test(f)));
  assert.ok(contract.outputFormat.some((f) => /columns/i.test(f)));
  const checklist = contract.checklist.join("\n");
  assert.match(checklist, /output\.json/, "checklist must name the exact output artifact");
  assert.match(checklist, /\/api\/health/, "checklist must name the exact endpoint, not /");
  const summary = summarizeContract(contract);
  assert.match(summary, /output\.json/);
  assert.ok(summary.length <= 700);
});

test("contract extraction is calm on prose with no literal artifacts", () => {
  const contract = extractAcceptanceContract("Please make the app feel a bit snappier overall.");
  assert.equal(contract.files.length, 0);
  assert.equal(contract.endpoints.length, 0);
  assert.match(summarizeContract(contract), /no literal artifacts/);
});

// ---------------------------------------------------------------------------
// Mutation ledger (Phase 5): filesystem truth as state, with a compact summary.
// ---------------------------------------------------------------------------

test("mutation ledger records file changes and produces a compact summary", () => {
  const ledger = new MutationLedger();
  ledger.record({ actor: "worker-a", action: "file_created", paths: ["src/new.ts"], source: "write" });
  ledger.record({ actor: "worker-a", action: "file_modified", paths: ["src/app.ts"], source: "edit" });
  ledger.record({ actor: "main", action: "file_deleted", paths: ["tmp/scratch.txt"], source: "rm tmp/scratch.txt" });
  ledger.record({ actor: "main", action: "dependency_installed", paths: ["lodash"], source: "npm install lodash" });
  const summary = ledger.summary();
  assert.deepEqual(summary.createdFiles, ["src/new.ts"]);
  assert.deepEqual(summary.modifiedFiles, ["src/app.ts"]);
  assert.deepEqual(summary.deletedFiles, ["tmp/scratch.txt"]);
  assert.deepEqual(summary.dependenciesInstalled, ["lodash"]);
  assert.ok(summary.riskyMutations.length >= 1, "a deletion is a risky mutation");
  assert.ok(summary.unvalidatedPaths.includes("src/app.ts"), "an unvalidated edit must be visible");
  ledger.markValidated(["src/app.ts"]);
  assert.ok(!ledger.summary().unvalidatedPaths.includes("src/app.ts"));
  const lines = ledger.renderSummaryLines().join("\n");
  assert.match(lines, /created: src\/new\.ts/);
  assert.ok(lines.length < 600, "the prompt summary must stay compact - never raw logs");
});

test("mutationsFromCommand classifies installs, deletes, and git operations; read-only commands yield nothing", () => {
  assert.equal(mutationsFromCommand("ls -la", "m").length, 0);
  assert.equal(mutationsFromCommand("git status", "m").length, 0);
  const install = mutationsFromCommand("npm install lodash", "m");
  assert.equal(install[0]?.action, "dependency_installed");
  assert.deepEqual(install[0]?.paths, ["lodash"]);
  const rm = mutationsFromCommand("rm -rf dist", "m");
  assert.equal(rm[0]?.action, "file_deleted");
  const git = mutationsFromCommand("git reset --hard HEAD~1", "m");
  assert.ok(git.some((entry) => entry.action === "git_operation"));
});

test("mutationsFromCommand records BOTH truncating (>) and appending (>>) redirects as file_modified", () => {
  const trunc = mutationsFromCommand("echo hi > out.json", "m");
  assert.equal(trunc[0]?.action, "file_modified");
  assert.deepEqual(trunc[0]?.paths, ["out.json"]);
  // Regression: `>>` appends were silently missed, so an append after a passing check never marked the
  // earlier validation stale — a stale green could then be repeated as fresh.
  const append = mutationsFromCommand("cat extra >> out.json", "m");
  assert.equal(append[0]?.action, "file_modified", ">> append must be recorded as a mutation");
  assert.deepEqual(append[0]?.paths, ["out.json"]);
});

// ---------------------------------------------------------------------------
// Validation ledger (Phase 6): a pass is only proof until a dependency mutates.
// ---------------------------------------------------------------------------

test("validation ledger marks a pass stale after a dependent file mutates", () => {
  const ledger = new ValidationLedger();
  ledger.record({ name: "pytest", command: "pytest tests/", actor: "w", validates: ["src/parser.ts"], status: "pass", mirrorsEvaluator: false });
  assert.equal(ledger.freshPasses().length, 1);
  const stale = ledger.markStaleForPaths(["src/parser.ts"]);
  assert.equal(stale.length, 1, "the pytest pass depended on src/parser.ts and must go stale");
  assert.equal(ledger.freshPasses().length, 0);
  assert.equal(ledger.stalePasses().length, 1);
  assert.match(ledger.renderSummaryLines().join("\n"), /stale/i);
});

test("a whole-workspace validation (empty validates) is staled by ANY mutation; unrelated mutations do not stale a pinned pass", () => {
  const ledger = new ValidationLedger();
  ledger.record({ name: "full suite", command: "npm test", actor: "w", validates: [], status: "pass", mirrorsEvaluator: false });
  ledger.record({ name: "focused", command: "npm test -- app", actor: "w", validates: ["src/app.ts"], status: "pass", mirrorsEvaluator: false });
  ledger.markStaleForPaths(["src/other.ts"]);
  const fresh = ledger.freshPasses().map((entry) => entry.name);
  assert.deepEqual(fresh, ["focused"], "the whole-workspace pass must stale; the pinned unrelated pass must not");
});

test("mirrorsEvaluator is true only for checks that touch exact contract targets", () => {
  const contract = { outputPaths: ["output.json"], endpoints: ["/api/health"], commands: ["npm test"], files: [] };
  assert.equal(mirrorsEvaluator("cat output.json", contract), true);
  assert.equal(mirrorsEvaluator("curl localhost:8080/api/health", contract), true);
  assert.equal(mirrorsEvaluator("curl localhost:8080/", contract), false, "the root path is a proxy, not the contract endpoint");
  assert.equal(mirrorsEvaluator("ls -la", contract), false);
});

test("M4: an equivalent same-ACTION command satisfies the contract target; a different action does not", () => {
  const buildContract = { outputPaths: [], endpoints: [], commands: ["npm run build"], files: [] };
  assert.equal(mirrorsEvaluator("npx vite build", buildContract), true, "a proxy build validates a build contract target");
  assert.equal(mirrorsEvaluator("npm run build", buildContract), true, "the exact command still matches (substring)");
  assert.equal(mirrorsEvaluator("npm test", buildContract), false, "a TEST command does not satisfy a BUILD target");
  // A specific grader/command with no recognized action verb only matches on substring - never loosened.
  const gradeContract = { outputPaths: [], endpoints: [], commands: ["python grade.py"], files: [] };
  assert.equal(mirrorsEvaluator("npm run build", gradeContract), false, "a build never satisfies a required grade command");
});

// ---------------------------------------------------------------------------
// Phase controller (Phase 7): monotonic phases, reserve protects the result.
// ---------------------------------------------------------------------------

test("phase controller transitions explore -> implement -> validate -> reserve monotonically with the action budget", () => {
  const phase = new PhaseController({ actionBudget: 10 });
  assert.equal(phase.currentPhase(), "explore");
  phase.noteAction(3);
  assert.equal(phase.currentPhase(), "implement");
  phase.noteAction(3);
  assert.equal(phase.currentPhase(), "validate");
  phase.noteAction(3);
  assert.equal(phase.currentPhase(), "reserve");
});

test("phases never move backward without an explicit recorded override", () => {
  const phase = new PhaseController({ actionBudget: 100 });
  assert.equal(phase.advanceTo("validate").ok, true, "forward moves need no reason");
  assert.equal(phase.currentPhase(), "validate", "the explicit advance latches even though the budget fraction is low");
  const denied = phase.advanceTo("explore");
  assert.equal(denied.ok, false, "a backward move without a reason must be refused");
  assert.equal(phase.currentPhase(), "validate");
  const overridden = phase.advanceTo("explore", "final review found the wrong file was changed; must re-locate");
  assert.equal(overridden.ok, true);
  assert.equal(phase.snapshot().overrides.length, 1, "the override must be recorded, not silent");
});

test("reserve phase blocks DESTRUCTIVE actions but only WARNS on installs/refactors (H2)", () => {
  const phase = new PhaseController({ actionBudget: 10 });
  phase.noteAction(10);
  assert.equal(phase.currentPhase(), "reserve");
  // Truly destructive commands that could wipe the working result stay blocked.
  const destructive = phase.assessAction("state_changing", "rm -rf dist && git reset --hard");
  assert.equal(destructive.verdict, "block");
  assert.match(destructive.message ?? "", /RESERVE/);
  // Installs / refactors are often a legitimate LATE need of a real build (add a dep, finish a file);
  // blocking them was a top "never finishes" cause, so RESERVE only WARNS on them now.
  assert.equal(phase.assessAction("state_changing", "npm install axios").verdict, "warn", "an install warns, not blocks");
  assert.equal(phase.assessAction("state_changing", "refactor the whole module").verdict, "warn", "a refactor warns, not blocks");
  assert.equal(phase.assessAction("state_changing", "edit src/app.ts").verdict, "warn");
  assert.equal(phase.assessAction("read", "cat src/app.ts").verdict, "ok", "reading is always safe in reserve");
});

// ---------------------------------------------------------------------------
// Post-success guard (Phase 8): once verified output exists, preserve it.
// ---------------------------------------------------------------------------

test("post-success guard protects artifacts and blocks destructive commands over them", () => {
  const guard = new PostSuccessGuard();
  guard.protect(["output.json", "dist/"], "validated by focused verification");
  assert.equal(guard.isProtected("output.json"), true);
  assert.equal(guard.isProtected("dist/bundle.js"), true, "directory protection covers children");
  assert.equal(guard.isProtected("src/app.ts"), false);
  assert.equal(guard.assessCommand("rm -rf output.json").verdict, "block");
  assert.equal(guard.assessCommand("git reset --hard").verdict, "block", "broad destruction endangers every protected artifact");
  assert.equal(guard.assessCommand("cat output.json").verdict, "allow", "reading protected output is fine");
  assert.match(guard.warningLine() ?? "", /Protected artifacts exist/);
});

test("a failing validation over a protected path releases it for a targeted repair", () => {
  const guard = new PostSuccessGuard();
  guard.protect(["output.json"], "validated");
  assert.equal(guard.assessCommand("rm output.json").verdict, "block");
  guard.releaseForRepair(["output.json"]);
  assert.equal(guard.assessCommand("rm output.json").verdict, "allow", "a repair sanctioned by a failing validation must not be blocked");
  assert.equal(guard.assessFileMutation("output.json").verdict, "warn", "repairs stay visible as warnings, not silence");
});

test("regenerating over a protected artifact is blocked; unrelated commands pass", () => {
  const guard = new PostSuccessGuard();
  guard.protect(["submission.csv"], "validated");
  assert.equal(guard.assessCommand("python generate.py --overwrite submission.csv").verdict, "block");
  assert.equal(guard.assessCommand("python analyze.py stats.csv").verdict, "allow");
});

// ---------------------------------------------------------------------------
// Risk middleware (Phase 9): short situational hints, never sermons.
// ---------------------------------------------------------------------------

const FRESH_SUMMARY = { passes: 1, failures: 0, stalePasses: 0, freshPasses: 1, evaluatorMirroringFreshPasses: 0, freshExactPasses: 0 };

test("risk middleware flags shallow validation: claiming success without touching the exact contract target", () => {
  const contract = extractAcceptanceContract("Write the report to output.json and expose /api/health.");
  const hints = assessRisk({
    phase: "validate",
    budgetRemainingPercent: 30,
    claimingSuccess: true,
    contract,
    validationSummary: { ...FRESH_SUMMARY }
  });
  assert.ok(hints.some((hint) => /output\.json|\/api\/health/.test(hint)), `expected an exact-target hint; got ${hints}`);
});

test("risk middleware flags a root-endpoint probe when the contract names a deeper endpoint", () => {
  const contract = extractAcceptanceContract("The service must answer on /api/health.");
  const hints = assessRisk({
    phase: "validate",
    budgetRemainingPercent: 40,
    command: "curl -s http://localhost:8080/",
    contract
  });
  assert.ok(hints.some((hint) => /\/api\/health/.test(hint)), `expected the exact endpoint in the hint; got ${hints}`);
});

test("risk middleware flags stale validation when a success claim rests on it", () => {
  const hints = assessRisk({
    phase: "reserve",
    budgetRemainingPercent: 5,
    claimingSuccess: true,
    validationSummary: { passes: 1, failures: 0, stalePasses: 1, freshPasses: 0, evaluatorMirroringFreshPasses: 0, freshExactPasses: 0 }
  });
  assert.ok(hints.some((hint) => /stale/i.test(hint)), `expected a staleness hint; got ${hints}`);
});

test("risk middleware flags protected-artifact mutation and repeated failing commands", () => {
  const guard = new PostSuccessGuard();
  guard.protect(["output.json"], "validated");
  const protectedHints = assessRisk({ phase: "validate", budgetRemainingPercent: 30, files: ["output.json"], guard });
  assert.ok(protectedHints.some((hint) => /protected/i.test(hint)));
  const loopHints = assessRisk({ phase: "implement", budgetRemainingPercent: 60, command: "npm test", repeatedCallCount: 4 });
  assert.ok(loopHints.some((hint) => /4 times|same action/i.test(hint)));
});

test("risk middleware warns on reserve-phase installs/refactors and stays quiet on clean actions", () => {
  const reserveHints = assessRisk({ phase: "reserve", budgetRemainingPercent: 5, command: "npm install left-pad" });
  assert.ok(reserveHints.some((hint) => /RESERVE/i.test(hint)));
  const quiet = assessRisk({ phase: "implement", budgetRemainingPercent: 70, command: "cat src/app.ts" });
  assert.equal(quiet.length, 0, "no detection -> no hint; the middleware must not nag");
  assert.ok(reserveHints.length <= 3, "at most three short hints, never a sermon");
});

// ---------------------------------------------------------------------------
// Prompt capsule (Phase 1): the only door into a worker's context.
// ---------------------------------------------------------------------------

function sampleCapsuleInput() {
  return {
    taskId: "run-test",
    workerRole: "backend",
    workerGoal: "Add the /api/health endpoint returning {\"ok\":true}",
    nonGoals: ["do not touch the frontend"],
    acceptanceContract: ["GET /api/health returns 200", "response body is {\"ok\":true}"],
    relevantFiles: [{ path: "src/server.ts", reason: "route registration lives here", snippet: "app.get(\"/\", handler)" }],
    allowedFiles: ["src/server.ts"],
    forbiddenFiles: ["src/legacy.ts"],
    repoFacts: ["express app is created in src/server.ts"],
    constraints: ["keep the diff under 60 lines"],
    validationPlan: ["curl localhost:8080/api/health"],
    workspaceDigest: "# Workspace digest\nphase: IMPLEMENT\nno mutations yet",
    mutationSummary: ["no mutations recorded"],
    priorWorkerReports: ["frontend: done; changed src/ui.tsx; next: none"],
    phaseLines: ["phase: IMPLEMENT (70% budget remaining)"],
    rulePack: ["Validate the EXACT endpoint path from the task, not just `/`."]
  };
}

test("prompt capsule excludes any parent prompt/transcript by construction and the size report proves it", () => {
  const parentTranscript = "PARENT_SESSION_TRANSCRIPT_MARKER: user said X, assistant reasoned Y, tool logs Z...";
  const parentSystemPrompt = "PARENT_SYSTEM_PROMPT_MARKER: You are the Cheater controller with 40 tools...";
  // There is no capsule field for a transcript or system prompt; even smuggling them as
  // extra keys must not leak into the rendered worker prompt.
  const capsule = buildPromptCapsule({
    ...sampleCapsuleInput(),
    transcript: parentTranscript,
    systemPrompt: parentSystemPrompt
  } as never);
  const rendered = renderCapsulePrompt(capsule);
  assert.ok(!rendered.includes("PARENT_SESSION_TRANSCRIPT_MARKER"), "the parent transcript must never reach a worker");
  assert.ok(!rendered.includes("PARENT_SYSTEM_PROMPT_MARKER"), "the parent system prompt must never reach a worker");
  const report = capsuleSizeReport(capsule);
  assert.equal(report.fullLogsIncluded, false);
});

test("prompt capsule includes the acceptance contract, worker goal, relevant files, and digest summary", () => {
  const capsule = buildPromptCapsule(sampleCapsuleInput());
  const rendered = renderCapsulePrompt(capsule);
  assert.match(rendered, /focused backend worker/);
  assert.match(rendered, /\/api\/health/);
  assert.match(rendered, /Acceptance contract/);
  assert.match(rendered, /src\/server\.ts/);
  assert.match(rendered, /Workspace digest/);
  assert.match(rendered, /WorkerReport/);
  assert.match(rendered, /prior worker reports/i);
});

test("capsule size is estimated (chars/4), small capsules pass, and oversize capsules warn", () => {
  const small = buildPromptCapsule(sampleCapsuleInput());
  const smallReport = capsuleSizeReport(small);
  assert.ok(smallReport.estimatedTokens > 50 && smallReport.estimatedTokens < 4000, `a normal capsule is 1-4K tokens; got ${smallReport.estimatedTokens}`);
  assert.equal(smallReport.warning, undefined);
  const fat = buildPromptCapsule({
    ...sampleCapsuleInput(),
    relevantFiles: Array.from({ length: 6 }, (_, i) => ({
      path: `src/big${i}.ts`,
      reason: "big",
      snippet: "x".repeat(6000)
    })),
    workspaceDigest: "y".repeat(30000)
  });
  const fatReport = capsuleSizeReport(fat);
  assert.ok(estimateCapsuleTokens(fat) <= CAPSULE_WARN_TOKENS + 2000, "field clamps must bound even a stuffed capsule");
  assert.ok(fatReport.estimatedTokens > 2000, "the stuffed capsule is measurably bigger");
});

// ---------------------------------------------------------------------------
// Rule packs + scar tissue (Phases 12-13): retrieved, never dumped.
// ---------------------------------------------------------------------------

test("rule packs are selected by task family, capped at two, and irrelevant packs stay out", () => {
  const packs = selectRulePacks("Fix the failing pytest in the Flask API server", []);
  const names = packs.map((pack) => pack.name);
  assert.ok(names.length <= 2);
  assert.ok(names.includes("python"), `expected the python pack; got ${names}`);
  assert.ok(!names.includes("rust"));
  const none = selectRulePacks("qzx", []);
  assert.equal(none.length, 0, "no match -> no packs -> no wasted context");
});

test("harness lessons recall by context and the failure analysis log appends general lessons only", () => {
  const lessons = recallHarnessLessons("the model validated the wrong artifact and finished");
  assert.ok(lessons.some((lesson) => /exact artifact/i.test(lesson)));
  const repo = mkdtempSync(join(tmpdir(), "cheater-evolution-"));
  const file = recordFailureAnalysis(repo, {
    taskId: "run-x",
    symptom: "declared success but evaluator read a stale output.json",
    likelyRootCause: "validation ran before the final mutation",
    causeKind: "stale_validation",
    proposedHarnessFix: "stale-marking in the validation ledger (implemented)",
    expectedBenefit: "no stale success claims",
    regressionRisk: "low"
  });
  assert.ok(existsSync(file));
  const content = readFileSync(file, "utf8");
  assert.match(content, /stale_validation/);
  assert.match(content, /run-x/);
});
