import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cheaterExtension from "../src/extension.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { defaultCommitletState } from "../src/commitlet/state.js";
import { defaultBlueprintState } from "../src/blueprint/state.js";
import { liveSessionState } from "../src/reliability/sessionState.js";

// Pi 0.80.2's real ExtensionAPI.on() event names (@earendil-works/pi-coding-agent
// dist/core/extensions/types.d.ts). "before_user_message" - which the live path was
// built against - is not on this list, which is exactly why it never fired.
const KNOWN_PI_EVENTS = new Set([
  "project_trust", "resources_discover", "session_start", "session_before_switch", "session_before_fork",
  "session_before_compact", "session_compact", "session_shutdown", "session_before_tree", "session_tree",
  "context", "before_provider_request", "after_provider_response", "before_agent_start", "agent_start",
  "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "model_select", "thinking_level_select",
  "tool_call", "tool_result", "user_bash", "input"
]);

function makePi() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const userMessages: string[] = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const pi = {
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerTool(def: any) { tools.set(def.name, def); },
    on(name: string, handler: any) { events.set(name, handler); },
    sendUserMessage(text: string) { userMessages.push(text); },
    sendMessage(message: any, options?: any) { customMessages.push({ message, options }); },
    getAllTools() { return [...tools.values()]; },
    getCommands() { return [...commands.keys()].map((name) => ({ name })); }
  };
  return { pi, commands, tools, events, userMessages, customMessages };
}

function ctx(cwd: string) {
  const widgets = new Map<string, unknown>();
  return {
    cwd,
    model: { id: "test" },
    ui: {
      notify() {},
      setTitle() {},
      setStatus() {},
      setWidget(key: string, value: unknown) { widgets.set(key, value); }
    },
    hasPendingMessages: () => false,
    widgets
  };
}

test("every event name the extension registers is a real Pi event", () => {
  const { pi, events } = makePi();
  cheaterExtension(pi);
  for (const name of events.keys()) {
    assert.ok(KNOWN_PI_EVENTS.has(name), `"${name}" is not a real Pi extension event - this is exactly the before_user_message bug`);
  }
  assert.ok(events.has("input"), "routing must hang off the real input event");
  assert.ok(events.has("agent_end"), "the finish gate must be enforced at agent_end");
});

test("input event routes interactive messages and resets per-turn reliability state", async () => {
  const { pi, events } = makePi();
  cheaterExtension(pi);
  const cwd = mkdtempSync(join(tmpdir(), "cheater-live-input-"));
  const result = await events.get("input")({ type: "input", text: "change one typo in README", source: "interactive" }, ctx(cwd));
  assert.equal(result.action, "transform");
  assert.match(result.text, /cheater_reliability_start/);
  assert.match(result.text, /User request: change one typo in README/);
});

test("one-shot chain: reliability_start -> scoped edit -> commitlet_next auto-grades -> finish gate allowed", async () => {
  const { pi, tools, events } = makePi();
  defaultCommitletState.clear();
  defaultBlueprintState.clear();
  liveSessionState.reset();
  cheaterExtension(pi);

  const cwd = mkdtempSync(join(tmpdir(), "cheater-live-oneshot-"));
  writeFileSync(join(cwd, "README.md"), "old docs\n", "utf8");
  const context = ctx(cwd);

  const start = await tools.get("cheater_reliability_start").execute(
    "start", { userGoal: "change one typo in README" }, undefined, undefined, context
  );
  const commitlet = start.details.commitlet;
  assert.equal(commitlet.allowedFiles[0], "README.md");
  assert.equal(start.details.freshWorkerMode, "simulated");

  // Swap in a fast, deterministic verification command instead of the plan's
  // default "npm test" so this test does not depend on the host's npm/toolchain.
  const plan = defaultCommitletState.get().currentPlan!;
  defaultCommitletState.setPlan({
    ...plan,
    commitlets: plan.commitlets.map((c) => c.id === commitlet.id
      ? { ...c, focusedVerification: [{ command: "node -e \"process.exit(0)\"", purpose: "fast pass", required: true }] }
      : c)
  });

  const blocked = await events.get("tool_call")({ type: "tool_call", toolCallId: "bad-1", toolName: "edit", input: { path: "src/other.ts" } }, context);
  assert.equal(blocked.block, true, "scope guard must block an edit outside the running commitlet's allowed files");
  assert.match(blocked.reason, /outside allowed files/);

  const allowedCall = await events.get("tool_call")({ type: "tool_call", toolCallId: "edit-1", toolName: "edit", input: { path: "README.md" } }, context);
  assert.ok(!allowedCall?.block, "an edit within the running commitlet's allowed files must not be blocked");

  writeFileSync(join(cwd, "README.md"), "new docs\n", "utf8");
  const resultAfterEdit = await events.get("tool_result")({
    type: "tool_result", toolCallId: "edit-1", toolName: "edit",
    input: { path: "README.md" }, content: [], isError: false, details: { diff: "-old docs\n+new docs\n" }
  }, context);
  assert.ok(resultAfterEdit === undefined || !resultAfterEdit.content, "a clean edit should not need a reliability notice appended");

  const ledgerAfterEdit = liveSessionState.getLedger();
  assert.ok(ledgerAfterEdit, "the ledger must exist after reliability_start");
  assert.deepEqual(ledgerAfterEdit!.get().changedFiles, ["README.md"], "the tool_result hook must record the edit without the model calling any ledger tool");

  const next = await tools.get("cheater_commitlet_next").execute("next", {}, undefined, undefined, context);
  assert.match(next.content[0].text, /No pending commitlets|final review/i);

  const ledger = liveSessionState.getLedger()!.get();
  assert.ok(ledger.verification.some((v) => v.stage === "focused_tests" && v.status === "ok"), "commitlet_next must feed its own focused verification into the live ledger");
  assert.ok(ledger.commandsRun.includes("node -e \"process.exit(0)\""), "the verification command must be recorded in the live ledger");

  const gate = await tools.get("cheater_finish_gate").execute("gate", {}, undefined, undefined, context);
  assert.equal(gate.details.allowed, true, `finish gate should allow after auto-verification; got: ${gate.details.reason}`);
});

test("agent_end nudges toward verification, is bounded per turn, skips aborts, and never fires once verified", async () => {
  const { pi, tools, events, customMessages } = makePi();
  defaultCommitletState.clear();
  defaultBlueprintState.clear();
  liveSessionState.reset();
  cheaterExtension(pi);
  const cwd = mkdtempSync(join(tmpdir(), "cheater-live-agentend-"));
  writeFileSync(join(cwd, "README.md"), "docs\n", "utf8");
  const context = ctx(cwd);

  await tools.get("cheater_reliability_start").execute("start", { userGoal: "change one typo in README" }, undefined, undefined, context);
  liveSessionState.getLedger()!.recordFileChange("README.md");
  liveSessionState.getLedger()!.recordCommand("node -e \"process.exit(0)\"");

  const normalMessage = { messages: [{ stopReason: "stop" }] };
  await events.get("agent_end")(normalMessage, context);
  assert.equal(customMessages.length, 1, "unverified work with a real ledger must trigger exactly one nudge");
  assert.match(customMessages[0].message.content, /Cheater Finish Gate/);
  assert.equal(customMessages[0].options.deliverAs, "followUp");

  await events.get("agent_end")(normalMessage, context);
  assert.equal(customMessages.length, 2, "a second consecutive unverified agent_end may nudge again");

  await events.get("agent_end")(normalMessage, context);
  assert.equal(customMessages.length, 2, "nudges must be bounded per interactive turn");

  await events.get("input")({ type: "input", text: "continue", source: "interactive" }, context);
  await events.get("agent_end")({ messages: [{ stopReason: "aborted" }] }, context);
  assert.equal(customMessages.length, 2, "an aborted run must never be nudged, even with a fresh per-turn budget");

  await events.get("agent_end")(normalMessage, context);
  assert.equal(customMessages.length, 3, "a normal call after the reset uses the fresh per-turn budget");

  liveSessionState.getLedger()!.recordVerificationStage({ stage: "focused_tests", status: "ok", summary: "ok", failureClass: "unknown", artifacts: [], signals: {} });
  await events.get("agent_end")(normalMessage, context);
  assert.equal(customMessages.length, 3, "a verified ledger must never be nudged, even with budget remaining");
});
