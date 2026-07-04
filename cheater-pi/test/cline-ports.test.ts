import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editRescueNotice, findEditMatch } from "../src/reliability/editMatch.js";
import { canonicalCallSignature, liveSessionState } from "../src/reliability/sessionState.js";
import { formatPlanChecklist } from "../src/commitlet/ui.js";
import { projectRules } from "../src/extension.js";
import { runResampledWorker } from "../src/commitlet/resampling.js";
import { createRollbackPoint } from "../src/commitlet/rollback.js";
import type { Commitlet, CommitletPlan } from "../src/commitlet/types.js";
import type { FreshAgentPacketRunner } from "../src/blueprint/worker.js";

// Ports from Cline (the harness currently beating opencode on most benchmarks), adapted for
// small/mid local models: edit fallback matching, the focus-chain checklist, the
// identical-consecutive-call guard, .clinerules, and stray-file checkpoint hygiene.

// --- edit fallback matching -----------------------------------------------------------------

const FILE = [
  "function greet(name) {",
  "    const msg = `hi ${name}`;",
  "    return msg;",
  "}",
  "",
  "function farewell(name) {",
  "    return `bye ${name}`;",
  "}"
].join("\n");

test("exact match wins and needs no rescue", () => {
  const match = findEditMatch(FILE, "    return msg;");
  assert.equal(match?.method, "exact");
  assert.equal(editRescueNotice(FILE, "    return msg;"), null, "no rescue needed when exact matching succeeds");
});

test("line-trimmed match survives the indentation drift small models produce", () => {
  // Model reproduced the block with 2-space indent instead of 4.
  const drifted = "function greet(name) {\n  const msg = `hi ${name}`;\n  return msg;\n}";
  const match = findEditMatch(FILE, drifted);
  assert.equal(match?.method, "line-trimmed");
  assert.equal(match?.startLine, 1);
  assert.equal(match?.endLine, 4);
  assert.equal(match?.actualText, FILE.split("\n").slice(0, 4).join("\n"), "actualText is the exact on-disk region");
});

test("block-anchor match localizes a block whose middle the model mis-remembered", () => {
  const hazyMiddle = "function greet(name) {\n    const msg = `hello there ${name}`;\n    return msg;\n}";
  const match = findEditMatch(FILE, hazyMiddle);
  assert.equal(match?.method, "block-anchor");
  assert.equal(match?.startLine, 1);
  assert.equal(match?.endLine, 4);
});

test("no plausible match returns null - the rescue never invents a location", () => {
  assert.equal(findEditMatch(FILE, "class Widget {\n  render() {}\n}"), null);
  assert.equal(editRescueNotice(FILE, "class Widget {\n  render() {}\n}"), null);
});

test("the rescue notice hands back the EXACT on-disk text to retry with", () => {
  const drifted = "function greet(name) {\n  const msg = `hi ${name}`;\n  return msg;\n}";
  const rescue = editRescueNotice(FILE, drifted);
  assert.ok(rescue);
  assert.match(rescue!, /line-trimmed match exists at lines 1-4/);
  assert.match(rescue!, /copy it verbatim/);
  assert.ok(rescue!.includes("    const msg = `hi ${name}`;"), "must contain the true on-disk indentation");
});

// --- focus chain checklist ------------------------------------------------------------------

test("the plan checklist renders every item with status marks and the current pointer", () => {
  const plan = {
    commitlets: [
      { title: "scaffold project", status: "passed" },
      { title: "types + storage", status: "repaired" },
      { title: "dashboard", status: "running" },
      { title: "task board", status: "pending" },
      { title: "broken thing", status: "failed" }
    ]
  } as unknown as CommitletPlan;
  const checklist = formatPlanChecklist(plan);
  assert.match(checklist, /Task progress \(2\/5\):/);
  assert.match(checklist, /\[x\] scaffold project/);
  assert.match(checklist, /\[x\] types \+ storage/);
  assert.match(checklist, /\[>\] dashboard {2}<- current/);
  assert.match(checklist, /\[ \] task board/);
  assert.match(checklist, /\[!\] broken thing/);
  assert.equal(formatPlanChecklist(null), "");
});

// --- identical-consecutive-call guard --------------------------------------------------------

test("canonical signature ignores key order but not values", () => {
  assert.equal(
    canonicalCallSignature("read", { path: "a.ts", offset: 1 }),
    canonicalCallSignature("read", { offset: 1, path: "a.ts" })
  );
  assert.notEqual(
    canonicalCallSignature("read", { path: "a.ts" }),
    canonicalCallSignature("read", { path: "b.ts" })
  );
});

test("three identical consecutive calls warn in-band; changing args resets the streak", () => {
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
  const call = (input: Record<string, unknown>, id: string) =>
    liveSessionState.observeToolCall({ toolCallId: id, toolName: "cheater_bug_memory_search", input }, { loopGovernorEnabled: true });
  assert.equal(call({ query: "same" }, "c1").length, 0);
  assert.equal(call({ query: "same" }, "c2").length, 0);
  const third = call({ query: "same" }, "c3");
  assert.ok(third.some((e) => /3 consecutive identical calls to cheater_bug_memory_search/.test(e.message)));
  assert.ok(third.every((e) => !e.terminal), "third identical call warns, does not block");
  // A different query breaks the streak.
  assert.equal(call({ query: "different" }, "c4").filter((e) => /identical calls/.test(e.message)).length, 0);
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
});

test("six identical consecutive calls become a terminal block with preserved-state semantics", () => {
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
  let lastEvents: ReturnType<typeof liveSessionState.observeToolCall> = [];
  for (let i = 0; i < 6; i += 1) {
    lastEvents = liveSessionState.observeToolCall({ toolCallId: `t${i}`, toolName: "grep", input: { pattern: "foo" } }, { loopGovernorEnabled: true });
  }
  assert.ok(lastEvents.some((e) => e.terminal && /6 consecutive identical calls/.test(e.message)));
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
});

test("driver tools (cheater_commitlet_next) are exempt from the identical-call and non-progress detectors", () => {
  // Repeatedly calling cheater_commitlet_next IS the intended chain driver - each call advances the
  // plan. It must NOT trip the "you're stuck" detectors that fired falsely in the FounderOS run.
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
  const all: ReturnType<typeof liveSessionState.observeToolCall> = [];
  for (let i = 0; i < 6; i += 1) {
    all.push(...liveSessionState.observeToolCall({ toolCallId: `d${i}`, toolName: "cheater_commitlet_next", input: {} }, { loopGovernorEnabled: true }));
    all.push(...liveSessionState.observeToolResult({ toolCallId: `d${i}`, toolName: "cheater_commitlet_next", ok: true }, { loopGovernorEnabled: true }));
  }
  assert.equal(all.filter((e) => /identical calls/.test(e.message)).length, 0, "no identical-call warning for the driver loop");
  assert.equal(all.filter((e) => e.kind === "non_progress").length, 0, "no non-progress stall for the driver loop");
  assert.equal(all.filter((e) => e.terminal).length, 0, "no terminal block for the driver loop");
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
});

// --- project rules (.clinerules) --------------------------------------------------------------

test("project rules load from .cheater/rules.md or .clinerules, bounded, and are optional", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-rules-"));
  assert.equal(projectRules(cwd), "", "no rules file means no block");
  writeFileSync(join(cwd, ".clinerules"), "Always use tabs.\nNever touch generated/.\n", "utf8");
  const rules = projectRules(cwd);
  assert.match(rules, /## Project rules \(.clinerules\)/);
  assert.match(rules, /Always use tabs/);
  // .cheater/rules.md takes precedence over .clinerules.
  mkdirSync(join(cwd, ".cheater"), { recursive: true });
  writeFileSync(join(cwd, ".cheater", "rules.md"), `${"x".repeat(2000)}\n`, "utf8");
  const own = projectRules(cwd);
  assert.match(own, /\.cheater\/rules\.md/);
  assert.match(own, /\[rules truncated\]/, "rules are bounded, not documentation dumps");
});

// --- stray-file checkpoint hygiene ------------------------------------------------------------

test("stray out-of-scope files created by a failing attempt are removed (git repos)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cheater-strays-"));
  execSync("git init -q", { cwd });
  writeFileSync(join(cwd, "target.txt"), "original\n", "utf8");
  execSync("git add -A", { cwd });
  execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd });

  const CHECK = `node -e "process.exit(require('fs').readFileSync('target.txt','utf8').includes('good')?0:1)"`;
  const commitlet: Commitlet = {
    id: "c1", title: "edit target", purpose: "p", status: "running", scope: "edit",
    allowedFiles: ["target.txt"], forbiddenFiles: [], allowedActions: ["edit"], forbiddenActions: [],
    maxFilesTouched: 1, maxDiffLines: 200, maxToolCalls: 5, maxModelCalls: 1,
    expectedFilesTouched: ["target.txt"],
    focusedVerification: [{ command: CHECK, purpose: "content", required: true }],
    broaderVerification: [],
    healthBudget: { maxComplexityIncrease: 5, maxDuplicationIncrease: 5, maxFunctionLengthIncrease: 5, allowNewLargeFunction: false, allowTestEdits: false, allowDependencyEdits: false, allowLockfileEdits: false },
    risk: "low"
  };
  commitlet.rollbackPoint = createRollbackPoint(cwd, commitlet);
  const plan = {
    id: "p", createdAt: new Date().toISOString(), repoRoot: cwd, userGoal: "g", summary: "s",
    status: "running", currentIndex: 0, commitlets: [commitlet], globalConstraints: []
  } as unknown as CommitletPlan;

  let call = 0;
  const runner: FreshAgentPacketRunner = {
    async runPacket() {
      call += 1;
      if (call === 1) {
        // Failing attempt leaves a debug script OUTSIDE its allowed files.
        writeFileSync(join(cwd, "debug_helper.js"), "console.log('scratch');\n", "utf8");
        writeFileSync(join(cwd, "target.txt"), "wrong\n", "utf8");
      } else {
        writeFileSync(join(cwd, "target.txt"), "good\n", "utf8");
      }
      return { ok: true, summary: `attempt ${call}` };
    }
  };
  const outcome = await runResampledWorker(plan, commitlet, { commitletCandidateSamples: 2 }, runner);
  assert.equal(outcome.passed, true);
  assert.equal(existsSync(join(cwd, "debug_helper.js")), false, "the failed attempt's stray file must not survive");
});

// --- loop governor: content-based patch key (iterating on one file is not a loop) -----------

test("editing one file several times with DIFFERENT content does not trip 'same patch'; a byte-identical repeat does", () => {
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
  const write = (i: number, content: string) =>
    liveSessionState.observeToolCall(
      { toolCallId: `w${i}`, toolName: "write", path: "src/App.tsx", input: { path: "src/App.tsx", content } },
      { loopGovernorEnabled: true }
    );
  // 5 genuinely different edits to the same file - the normal "fix build errors one by one" pattern.
  const distinct = [1, 2, 3, 4, 5].flatMap((i) => write(i, `version ${i}`));
  assert.equal(distinct.filter((e) => /same patch/.test(e.message)).length, 0, "different edits to one file are normal iteration, not a loop");

  // Byte-identical repeats (a fix that never lands) still trip the governor.
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
  const same = [1, 2, 3, 4, 5].flatMap((i) => write(i + 10, "IDENTICAL"));
  assert.ok(same.some((e) => /same patch/.test(e.message)), "a byte-identical repeated patch is still caught");
  liveSessionState.beginInteractiveTurn({ loopGovernorEnabled: true });
});
