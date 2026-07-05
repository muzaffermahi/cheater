import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCheatSheet,
  classifyCheatTrigger,
  corpusHitRelevant,
  localDocEvidence,
  renderCheatSheet,
  usableBugCorpus
} from "../src/reliability/cheatSheet.js";
import { saveVerifiedFix, pruneForRetention } from "../src/reliability/experience.js";
import { CompletionLedger, ledgerAllowsFinish } from "../src/reliability/lifecycle.js";
import { createRepairCommitlet } from "../src/commitlet/planner.js";
import { registerCommitletTools } from "../src/commitlet/tools.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { BugMemorySearchHit } from "../src/bug-memory.js";

// The Cheat Layer / bug-memory feature is OFF by default now (bugMemoryEnabled). This suite tests
// the feature itself, so it opts in; the master-gate default-off behavior is covered separately.
const CHEAT_ON = { ...DEFAULT_CONFIG, bugMemoryEnabled: true };

// The Cheat Layer contract: the HARNESS observes a failure, classifies it, retrieves compact
// evidence, and injects at most three hypothesis cards where the failure is handed to a
// model. The model never calls a search tool; unrelated failures get no noise; the verifier
// remains the only source of truth.

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-cheat-"));
}

// P3 disciplined SKILL memory: the verified experience store runs under skillMemoryEnabled, decoupled
// from the disabled cross-repo bug-corpus (the analogy search that confused the small local model).
test("P3: skillMemoryEnabled recalls a verified fix (experience card) and NEVER the bug-corpus", async () => {
  const cwd = tmpRepo();
  saveVerifiedFix(cwd, {
    failureText: "TypeError: cannot read properties of missing reading getjson in widgetthing.py",
    diffText: "+    if resp is None:\n+        return None\n-    return resp.getjson()",
    files: ["widgetthing.py"], goal: "guard the missing response"
  });
  const sheet = await buildCheatSheet(cwd, "TypeError: cannot read properties of missing reading getjson in widgetthing.py", { skillMemoryEnabled: true });
  assert.ok(sheet, "skillMemoryEnabled must produce a sheet from a matching verified fix");
  assert.ok(sheet!.cards.some((c) => c.source === "experience"), "the recalled card is the verified experience");
  assert.ok(!sheet!.cards.some((c) => c.source === "bug_corpus"), "skill memory never pulls the cross-repo bug-corpus");
});

test("P3: with neither skillMemoryEnabled nor bugMemoryEnabled the cheat sheet stays silent", async () => {
  const cwd = tmpRepo();
  saveVerifiedFix(cwd, { failureText: "TypeError: missing widgetthing attribute", diffText: "+guard here now", files: ["a.py"], goal: "g" });
  assert.equal(await buildCheatSheet(cwd, "TypeError: missing widgetthing attribute", {}), null, "both master flags off -> no evidence injected");
});

test("P3: pruneForRetention keeps proven high-hit cards over fresh single-hit ones (not pure FIFO)", () => {
  const mk = (fp: string, createdAt: string, hits: number) => ({ fingerprint: fp, errorType: "x", tokens: [], failureText: "", fixSummary: "f", files: [], goal: "", createdAt, hits });
  const cards = [mk("old-proven-1", "2020-01-01T00:00:00Z", 50), mk("old-proven-2", "2020-01-02T00:00:00Z", 40)];
  for (let i = 0; i < 300; i++) cards.push(mk(`fresh-${i}`, `2025-01-01T00:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}Z`, 1));
  const kept = pruneForRetention(cards);
  assert.equal(kept.length, 300, "bounded to MAX_CARDS");
  assert.ok(kept.some((c) => c.fingerprint === "old-proven-1") && kept.some((c) => c.fingerprint === "old-proven-2"),
    "proven high-hit cards survive despite being the oldest (pure FIFO would have evicted them)");
});

function fakeCorpus(cwd: string, cards: Array<Record<string, unknown>>): string {
  const path = join(cwd, "corpus.jsonl");
  writeFileSync(path, cards.map((card) => JSON.stringify(card)).join("\n") + "\n", "utf8");
  return path;
}

const RELEVANT_CORPUS_CARD = {
  id: "bug-1",
  repo: "flask-app",
  language: "python",
  bug_type: "attribute_error",
  symptom: "AttributeError: 'Response' object has no attribute 'get_json' when calling response helpers",
  root_cause: "old werkzeug Response API renamed get_json in newer versions",
  fix_pattern: "call response.json instead of response.get_json() on werkzeug >= 2.1",
  failed_approaches: [],
  key_files: ["app.py"],
  search_keywords: ["attributeerror", "response", "get_json", "werkzeug"],
  test_signal: "pytest tests/test_routes.py",
  embedding_text: "AttributeError Response get_json werkzeug"
};

const IRRELEVANT_CORPUS_CARD = {
  id: "bug-2",
  repo: "css-project",
  language: "css",
  bug_type: "layout_bug",
  symptom: "flexbox children overflow the container on narrow viewports",
  root_cause: "missing min-width: 0 on flex children",
  fix_pattern: "add min-width: 0 to the flex child",
  failed_approaches: [],
  key_files: ["style.css"],
  search_keywords: ["flexbox", "overflow", "layout"],
  test_signal: "visual check",
  embedding_text: "flexbox overflow layout css"
};

test("trigger classifier maps common failure shapes and extracts package/symbol hints", () => {
  assert.deepEqual(
    classifyCheatTrigger("ModuleNotFoundError: No module named 'requests'"),
    { trigger: "import_error", packageHint: "requests" }
  );
  assert.deepEqual(
    classifyCheatTrigger("Error: Cannot find module 'left-pad'"),
    { trigger: "import_error", packageHint: "left-pad" }
  );
  const attr = classifyCheatTrigger("AttributeError: 'Response' object has no attribute 'get_json'");
  assert.equal(attr.trigger, "library_api_error");
  assert.equal(attr.symbolHint, "get_json");
  const kw = classifyCheatTrigger("TypeError: __init__() got an unexpected keyword argument 'timeout'");
  assert.equal(kw.trigger, "library_api_error");
  assert.equal(kw.symbolHint, "timeout");
  assert.equal(classifyCheatTrigger("AssertionError: expected 15 got 10").trigger, "assertion_failure");
  assert.equal(classifyCheatTrigger("src/a.ts(3,1): error TS1005: ',' expected.").trigger, "syntax_error");
  assert.equal(classifyCheatTrigger("everything is fine but slow").trigger, "unknown");
});

test("no noise: an unclassifiable failure with no verified experience produces NO sheet", async () => {
  const cwd = tmpRepo();
  const sheet = await buildCheatSheet(cwd, "something vague happened", CHEAT_ON);
  assert.equal(sheet, null);
});

test("cheatSheetEnabled=false disables the layer entirely", async () => {
  const cwd = tmpRepo();
  saveVerifiedFix(cwd, { failureText: "TypeError: x.split is not a function", diffText: "-a\n+b", files: ["x.ts"] });
  const sheet = await buildCheatSheet(cwd, "TypeError: x.split is not a function", { ...CHEAT_ON, cheatSheetEnabled: false });
  assert.equal(sheet, null);
});

test("bug memory is OFF by default: no cheat sheet is recalled even with a matching verified fix", async () => {
  const cwd = tmpRepo();
  saveVerifiedFix(cwd, { failureText: "TypeError: x.split is not a function", diffText: "-a\n+b", files: ["x.ts"] });
  // DEFAULT_CONFIG leaves bugMemoryEnabled unset (off), so the model is never handed recalled evidence.
  assert.equal(await buildCheatSheet(cwd, "TypeError: x.split is not a function", DEFAULT_CONFIG), null, "master gate off by default");
});

test("verified experience becomes the first, high-confidence card - no tool call involved", async () => {
  const cwd = tmpRepo();
  saveVerifiedFix(cwd, {
    failureText: "AssertionError: expected sum_range(1, 5) to equal 15 but got 10",
    diffText: "-    return sum(range(a, b))\n+    return sum(range(a, b + 1))",
    files: ["src/mathutils.py"],
    goal: "fix off-by-one"
  });
  const sheet = await buildCheatSheet(cwd, "AssertionError: expected sum_range(2, 4) to equal 9 but got 5", CHEAT_ON);
  assert.ok(sheet);
  assert.equal(sheet!.cards[0].source, "experience");
  assert.equal(sheet!.cards[0].confidence, "high");
  assert.match(sheet!.cards[0].fix, /range\(a, b \+ 1\)/);
});

test("bug corpus contributes a medium-confidence analogy card when relevant", async () => {
  const cwd = tmpRepo();
  const corpus = fakeCorpus(cwd, [RELEVANT_CORPUS_CARD, IRRELEVANT_CORPUS_CARD]);
  const sheet = await buildCheatSheet(
    cwd,
    "AttributeError: 'Response' object has no attribute 'get_json' in tests/test_routes.py",
    CHEAT_ON,
    { memoryPath: corpus }
  );
  assert.ok(sheet, "a classified library_api_error with a matching corpus card must produce a sheet");
  const corpusCard = sheet!.cards.find((card) => card.source === "bug_corpus");
  assert.ok(corpusCard, "the relevant corpus card must be included");
  assert.equal(corpusCard!.confidence, "medium");
  assert.match(corpusCard!.fix, /response\.json/);
  assert.match(corpusCard!.verify ?? "", /pytest/);
  // The css layout card matches nothing about this failure and must not appear.
  assert.ok(!sheet!.cards.some((card) => /flexbox|min-width/.test(card.fix)), "irrelevant corpus hits are gated out");
});

test("corpus relevance gate rejects hits that share no package, symbol, error type, or tokens", () => {
  const hit: BugMemorySearchHit = {
    rank: 1, score: 9.9, id: "x", repo: "css-project", language: "css", bugType: "layout_bug",
    symptom: "flexbox children overflow", rootCause: "missing min-width", fixPattern: "add min-width: 0",
    keyFiles: [], searchKeywords: ["flexbox", "overflow"], testSignal: "visual check"
  };
  const classification = { trigger: "library_api_error" as const, packageHint: "werkzeug", symbolHint: "get_json" };
  assert.equal(corpusHitRelevant(hit, classification, "attributeerror", ["response", "attribute", "get_json"]), false);
});

test("cards are bounded: at most 3, each field compact, total render capped", async () => {
  const cwd = tmpRepo();
  // Seed all three local sources at once.
  saveVerifiedFix(cwd, {
    failureText: "AttributeError: 'Response' object has no attribute 'get_json'",
    diffText: `-${"x".repeat(400)}\n+${"y".repeat(400)}`,
    files: ["app.py"]
  });
  const corpus = fakeCorpus(cwd, [RELEVANT_CORPUS_CARD, { ...RELEVANT_CORPUS_CARD, id: "bug-3", repo: "other-flask-app", key_files: ["b.py"] }]);
  writeFileSync(join(cwd, "README.md"), "This service wraps werkzeug Response objects; use response.json.\n", "utf8");
  const sheet = await buildCheatSheet(
    cwd,
    "AttributeError: 'werkzeug' object has no attribute 'get_json'",
    CHEAT_ON,
    { memoryPath: corpus }
  );
  assert.ok(sheet);
  assert.ok(sheet!.cards.length <= 3, "never more than 3 evidence cards");
  const rendered = renderCheatSheet(sheet!);
  assert.ok(rendered.length <= 1300, `rendered sheet must stay tiny, got ${rendered.length}`);
});

test("render marks evidence as hypothesis and defers to the verifier", () => {
  const rendered = renderCheatSheet({
    trigger: "import_error",
    packageHint: "left-pad",
    cards: [{ source: "bug_corpus", confidence: "medium", title: "t", cause: "c", fix: "f" }]
  }, "npm test");
  assert.match(rendered, /hypotheses, not truth/);
  assert.match(rendered, /the verifier decides, not this sheet/i);
  assert.match(rendered, /verify with: npm test/);
});

test("local project docs contribute a low-confidence card keyed by the failing name", () => {
  const cwd = tmpRepo();
  writeFileSync(join(cwd, "README.md"), "Responses use werkzeug; always read bodies via response.json.\n", "utf8");
  const card = localDocEvidence(cwd, ["werkzeug"]);
  assert.ok(card);
  assert.equal(card!.source, "local_docs");
  assert.equal(card!.confidence, "low");
  assert.match(card!.fix, /response\.json/);
  assert.equal(localDocEvidence(cwd, ["nonexistent-package-name"]), null);
});

test("web/docs disabled (default): the cascade still works from local sources only", async () => {
  const cwd = tmpRepo();
  const corpus = fakeCorpus(cwd, [RELEVANT_CORPUS_CARD]);
  // DEFAULT_CONFIG has blueprintOfficialDocsSearchEnabled: false - nothing may reach the network.
  const sheet = await buildCheatSheet(cwd, "AttributeError: 'Response' object has no attribute 'get_json'", CHEAT_ON, { memoryPath: corpus });
  assert.ok(sheet);
  assert.ok(sheet!.cards.every((card) => card.source !== "official_docs"), "no official-docs card without explicit opt-in");
});

test("usableBugCorpus skips a huge unindexed corpus instead of stalling a grade", () => {
  const cwd = tmpRepo();
  const path = join(cwd, "big.jsonl");
  writeFileSync(path, "x".repeat(17 * 1024 * 1024), "utf8");
  assert.equal(usableBugCorpus(cwd, path), null, "a 17MB unindexed corpus must be skipped");
  const small = fakeCorpus(cwd, [RELEVANT_CORPUS_CARD]);
  assert.equal(usableBugCorpus(cwd, small), small);
});

test("repair commitlets carry the cheat sheet into their spec (and thus into every worker/resample packet)", async () => {
  const cwd = tmpRepo();
  writeFileSync(join(cwd, "calc.py"), "def totals():\n    return 10\n", "utf8");
  // Seed a verified fix that matches the failure the verification command will produce.
  saveVerifiedFix(cwd, {
    failureText: "AssertionError: expected totals() to equal 15 but got 10",
    diffText: "-    return 10\n+    return 15",
    files: ["calc.py"],
    goal: "fix totals"
  });

  const tools = new Map<string, any>();
  registerCommitletTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, { config: CHEAT_ON });
  const commitlet: any = {
    id: "c1-single", title: "fix totals", purpose: "fix totals", status: "running", scope: "bug_fix",
    allowedFiles: ["calc.py"], forbiddenFiles: [], allowedActions: ["edit"], forbiddenActions: [],
    maxFilesTouched: 1, maxDiffLines: 180, maxToolCalls: 10, maxModelCalls: 1,
    expectedFilesTouched: ["calc.py"],
    focusedVerification: [{ command: "node -e \"console.error('AssertionError: expected totals() to equal 15 but got 10'); process.exit(1)\"", purpose: "focused", required: true }],
    broaderVerification: [],
    healthBudget: { maxComplexityIncrease: 12, maxDuplicationIncrease: 2, maxFunctionLengthIncrease: 60, allowNewLargeFunction: false, allowTestEdits: false, allowDependencyEdits: false, allowLockfileEdits: false },
    risk: "low"
  };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  // Give the grader an actual diff to accept: edit the allowed file after the snapshot.
  writeFileSync(join(cwd, "calc.py"), "def totals():\n    return 12\n", "utf8");
  defaultCommitletState.setPlan({
    id: "plan-cheat", createdAt: new Date().toISOString(), repoRoot: cwd, userGoal: "fix totals",
    summary: "1 commitlet", commitlets: [commitlet], currentIndex: 0, status: "running",
    globalConstraints: [], finalVerification: [],
    finalReview: { accepted: false, summary: "", commitlets: [], finalVerification: [], health: { score: 0, passed: false, warnings: [], blockingIssues: [], metrics: { diffLines: 0, filesTouched: 0, duplicationDelta: 0, complexityDelta: 0, largeFunctionDelta: 0, assertionDelta: 0 } }, blockingIssues: [], warnings: [], suggestedFollowups: [] },
    risk: "low"
  } as any);
  liveSessionState.reset("fix totals");

  const result = await tools.get("cheater_commitlet_next").execute("next", {}, undefined, undefined, { cwd });
  assert.match(result.content[0].text, /CHEAT SHEET/, "the grade message must carry the sheet in-band");
  const plan = defaultCommitletState.get().currentPlan!;
  const repair = plan.commitlets.find((item: any) => /-repair$/.test(item.id));
  assert.ok(repair, "a bounded repair commitlet must exist");
  assert.match(repair!.spec?.observedFailure ?? "", /CHEAT SHEET/, "the repair packet's observedFailure must carry the sheet");
  assert.match(repair!.spec?.observedFailure ?? "", /return 15/, "the verified prior fix must be inside the sheet");
  defaultCommitletState.clear();
});

test("verifier authority is preserved: a cheat sheet never satisfies the finish gate", async () => {
  const cwd = tmpRepo();
  saveVerifiedFix(cwd, { failureText: "TypeError: boom in x", diffText: "-a\n+b", files: ["x.ts"] });
  const sheet = await buildCheatSheet(cwd, "TypeError: boom in x", CHEAT_ON);
  assert.ok(sheet, "sheet exists");
  const ledger = new CompletionLedger("goal");
  ledger.recordFileChange("x.ts");
  // Evidence in hand, but no verification ran: finishing must still be blocked.
  const verdict = ledgerAllowsFinish(ledger);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /no verification/);
});

test("repair commitlet observedFailure has room for failure card + sheet (2600 chars)", () => {
  const failed: any = {
    id: "c1", title: "t", purpose: "p", status: "failed", scope: "bug_fix",
    allowedFiles: ["a.py"], forbiddenFiles: [], allowedActions: [], forbiddenActions: [],
    maxFilesTouched: 1, maxDiffLines: 180, maxToolCalls: 10, maxModelCalls: 1,
    expectedFilesTouched: ["a.py"], focusedVerification: [], broaderVerification: [],
    healthBudget: { maxComplexityIncrease: 12, maxDuplicationIncrease: 2, maxFunctionLengthIncrease: 60, allowNewLargeFunction: false, allowTestEdits: false, allowDependencyEdits: false, allowLockfileEdits: false },
    risk: "low"
  };
  const longSummary = "x".repeat(3000);
  const repair = createRepairCommitlet(failed, longSummary);
  assert.equal(repair.spec?.observedFailure?.length, 2600);
});
