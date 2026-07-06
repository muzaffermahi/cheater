import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  goalDemandsAction,
  assistantMadeToolCall,
  assistantProducedText,
  firstUserGoal,
  shouldNudgeToAct
} from "../src/reliability/actGuard.js";
import { ensureCheaterDirIgnored } from "../src/runstate/runDir.js";

// Finding #5: a model that ANSWERS an actionable task in chat with zero tool calls leaves the task
// unfinished (nothing written). These pin the detector that nudges it to actually act.

test("goalDemandsAction: true for an explicit write-to-file task (the regex-log case)", () => {
  assert.equal(goalDemandsAction("Write a regex expression that matches dates. Save your regex in /app/regex.txt"), true);
  assert.equal(goalDemandsAction("Create a self-signed TLS certificate and save it as /app/ssl/server.crt"), true);
  assert.equal(goalDemandsAction("write the integer answer to /app/answer.txt"), true);
});

test("goalDemandsAction: true for an imperative build/fix task", () => {
  assert.equal(goalDemandsAction("Build pMARS from source and install the binary"), true);
  assert.equal(goalDemandsAction("Fix the failing test in the parser"), true);
  assert.equal(goalDemandsAction("Implement a MIPS interpreter"), true);
});

test("goalDemandsAction: false for a genuine question", () => {
  assert.equal(goalDemandsAction("What does this repository do?"), false);
  assert.equal(goalDemandsAction("How does the caching layer work?"), false);
  assert.equal(goalDemandsAction("Explain the authentication flow"), false);
  assert.equal(goalDemandsAction("which files import the logger?"), false);
});

test("assistantMadeToolCall / assistantProducedText read the transcript shape", () => {
  const textOnly = [
    { role: "user", content: [{ type: "text", text: "do it" }] },
    { role: "assistant", content: [{ type: "text", text: "Here is the answer: ..." }] }
  ];
  assert.equal(assistantMadeToolCall(textOnly), false);
  assert.equal(assistantProducedText(textOnly), true);

  const withTool = [
    { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "toolCall", name: "write", arguments: {} }] }
  ];
  assert.equal(assistantMadeToolCall(withTool), true);

  const frozen = [{ role: "assistant", content: [] }];
  assert.equal(assistantProducedText(frozen), false);
});

test("firstUserGoal extracts the first user text message", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "Save your regex in /app/regex.txt" }] },
    { role: "assistant", content: [{ type: "text", text: "sure" }] }
  ];
  assert.match(firstUserGoal(msgs), /regex\.txt/);
});

test("shouldNudgeToAct: fires on answered-actionable-with-no-tools, not otherwise", () => {
  const goal = "Write a regex and save it in /app/regex.txt";
  const answeredNoTools = [
    { role: "user", content: [{ type: "text", text: goal }] },
    { role: "assistant", content: [{ type: "text", text: "The regex is: \\d{4}-\\d{2}-\\d{2}" }] }
  ];
  // the exact failure mode -> nudge
  assert.equal(shouldNudgeToAct({ enabled: true, messages: answeredNoTools, goal }), true);
  // disabled -> never
  assert.equal(shouldNudgeToAct({ enabled: false, messages: answeredNoTools, goal }), false);
  // the model DID use a tool -> not this case
  const acted = [
    { role: "user", content: [{ type: "text", text: goal }] },
    { role: "assistant", content: [{ type: "toolCall", name: "write" }] }
  ];
  assert.equal(shouldNudgeToAct({ enabled: true, messages: acted, goal }), false);
  // a genuine question answered in chat -> not nudged
  const q = "What does this regex do?";
  const answeredQuestion = [
    { role: "user", content: [{ type: "text", text: q }] },
    { role: "assistant", content: [{ type: "text", text: "It matches dates." }] }
  ];
  assert.equal(shouldNudgeToAct({ enabled: true, messages: answeredQuestion, goal: q }), false);
});

// Finding #6: cheater's own .cheater/ dir must not show up in `git status` as untracked content.
test("ensureCheaterDirIgnored writes a self-ignoring .cheater/.gitignore", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-gi-"));
  ensureCheaterDirIgnored(root);
  const gi = join(root, ".cheater", ".gitignore");
  assert.equal(existsSync(gi), true);
  assert.equal(readFileSync(gi, "utf8").trim(), "*");
});

test("ensureCheaterDirIgnored does not clobber an existing .cheater/.gitignore", () => {
  const root = mkdtempSync(join(tmpdir(), "cheater-gi2-"));
  ensureCheaterDirIgnored(root);
  writeFileSync(join(root, ".cheater", ".gitignore"), "custom\n", "utf8");
  ensureCheaterDirIgnored(root); // idempotent, must not overwrite
  assert.equal(readFileSync(join(root, ".cheater", ".gitignore"), "utf8").trim(), "custom");
});
