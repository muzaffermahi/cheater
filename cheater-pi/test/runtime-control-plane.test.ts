import test from "node:test";
import assert from "node:assert/strict";
import { mainCallGovernor } from "../src/runtime/mainCallGovernor.js";
import { sidecarUsage, sidecarKeepAlive } from "../src/runtime/sidecarUsage.js";
import { analyzePromptShape, recordWorkerPromptShape, getWorkerPromptShape, resetWorkerPromptShape, promptShapeLine } from "../src/runtime/promptShape.js";
import { normalizeToolError } from "../src/runtime/toolErrorNormalize.js";
import { buildPromptCapsule, estimateCapsuleTokens } from "../src/runstate/promptCapsule.js";
import { buildCompletionReceipt } from "../src/commitlet/kernel.js";
import { liveSessionState } from "../src/reliability/sessionState.js";
import type { SidecarClient, SidecarCompletion } from "../src/sidecar/types.js";

function fakeClient(available: boolean, complete: () => Promise<SidecarCompletion>): SidecarClient {
  return { available: () => available, complete };
}

// --- Part A: the Main LLM Call Governor -----------------------------------------------------------

test("governor: a clerical role prefers sidecar/deterministic and is never a main call", () => {
  mainCallGovernor.configure({ mainCallGovernorEnabled: true });
  mainCallGovernor.reset();
  const d = mainCallGovernor.decide("route");
  assert.equal(d.target, "sidecar", "route is clerical -> sidecar/deterministic, not main");
  assert.equal(d.allowedOnMain, false);
  // Simulate the wiring: route handled by the sidecar => a main call avoided.
  mainCallGovernor.recordAvoided("route", "sidecar", "sidecar refined a low-confidence route");
  const s = mainCallGovernor.snapshot();
  assert.equal(s.totalMain, 0);
  assert.equal(s.avoidedByRole.route, 1);
  mainCallGovernor.configure({}); // reset to off so later tests / files are unaffected
});

test("governor: clerical roles do not escalate to main unless configured", () => {
  mainCallGovernor.configure({ mainCallGovernorEnabled: true });
  assert.equal(mainCallGovernor.decide("failure_distill").canEscalate, false, "no escalation by default");
  mainCallGovernor.configure({ mainCallGovernorEnabled: true, mainFallbackAllowedRoles: ["failure_distill"] });
  assert.equal(mainCallGovernor.decide("failure_distill").canEscalate, true, "escalation only for the configured role");
  assert.equal(mainCallGovernor.decide("route").canEscalate, false, "a non-configured clerical role still cannot escalate");
  mainCallGovernor.configure({});
});

test("governor: creation/repair roles go to main and are counted with est tokens", () => {
  mainCallGovernor.configure({ mainCallGovernorEnabled: true });
  mainCallGovernor.reset();
  assert.equal(mainCallGovernor.decide("code_worker").target, "main");
  assert.equal(mainCallGovernor.decide("repair_worker").target, "main");
  mainCallGovernor.recordMain("code_worker", { calls: 2, estTokens: 1500 });
  mainCallGovernor.recordMain("repair_worker", { calls: 1, estTokens: 900 });
  const s = mainCallGovernor.snapshot();
  assert.equal(s.totalMain, 3);
  assert.equal(s.mainByRole.code_worker, 2);
  assert.equal(s.estMainTokens, 2 * 1500 + 900);
  assert.match(mainCallGovernor.receiptLines().join("\n"), /main model calls: 3 total/);
  mainCallGovernor.configure({});
});

test("governor receipt section is gated on the enabled flag", () => {
  mainCallGovernor.configure({}); // off
  mainCallGovernor.reset();
  mainCallGovernor.recordMain("code_worker", { calls: 1 });
  assert.deepEqual(mainCallGovernor.receiptLines(), [], "off -> no receipt lines, behaviour unchanged");
  mainCallGovernor.reset();
});

// --- Part C: prompt shape -------------------------------------------------------------------------

test("promptShape flags dynamic-content-before-stable-prefix and duplicates", () => {
  const report = analyzePromptShape([
    { name: "goal", content: "Global goal: build the thing for the user right now", stable: false },
    { name: "rules", content: "Rules: always read before write; never use heredocs; stop after one file", stable: true },
    { name: "body", content: "the actual dynamic worker body with the file to edit and its snippet", stable: false }
  ]);
  assert.equal(report.cacheFriendly, false, "a fixed rules block after dynamic content is not cache-friendly");
  assert.match(report.reason, /after dynamic|no stable prefix/);
  assert.equal(report.stablePrefixEstimatedTokens, 0, "dynamic content leads -> zero reusable prefix");

  const dupes = analyzePromptShape([
    { name: "a", content: "the same substantial block of operating rules repeated verbatim here twice", stable: true },
    { name: "b", content: "the same substantial block of operating rules repeated verbatim here twice", stable: true }
  ]);
  assert.equal(dupes.duplicateSectionWarnings.length, 1, "the duplicated block is flagged");
});

test("promptShape: a stable-prefix-first prompt is cache-friendly and the store round-trips", () => {
  const report = analyzePromptShape([
    { name: "rules", content: "Fixed Cheater rules and the exact output contract that never change between calls", stable: true },
    { name: "dynamic", content: "Task: edit src/foo.ts to fix the off-by-one in nextIndex()", stable: false }
  ]);
  assert.equal(report.cacheFriendly, true);
  assert.ok(report.stablePrefixRatio > 0.4, "most of the prompt is a reusable stable prefix");
  resetWorkerPromptShape();
  assert.equal(getWorkerPromptShape(), undefined);
  recordWorkerPromptShape(report);
  assert.equal(getWorkerPromptShape(), report);
  assert.match(promptShapeLine(report), /prompt shape: ~\d+ tok/);
});

// --- Part D: sidecar liveness / usage -------------------------------------------------------------

test("sidecarUsage reports available-but-unused vs used, and nothing when unconfigured", () => {
  sidecarUsage.reset();
  assert.deepEqual(sidecarUsage.receiptLines(), [], "no sidecar configured -> no lines");

  sidecarUsage.reset();
  sidecarUsage.noteResolved(true, true); // configured + online
  sidecarUsage.record("failure_distill", "deterministic"); // attempted but fell back
  assert.match(sidecarUsage.snapshot().unusedReason ?? "", /available but unused/, "online but every attempt fell back");

  sidecarUsage.reset();
  sidecarUsage.noteResolved(true, true);
  sidecarUsage.record("failure_distill", "sidecar");
  const s = sidecarUsage.snapshot();
  assert.equal(s.succeeded, 1);
  assert.equal(s.unusedReason, undefined, "a real sidecar success is not 'unused'");
  assert.match(sidecarUsage.receiptLines().join("\n"), /attempted 1, succeeded 1/);
  sidecarUsage.reset();
});

test("sidecarKeepAlive sends a tiny bounded health check and is off unless configured", async () => {
  let calls = 0; let lastMaxTokens = 999;
  const client = fakeClient(true, async () => { calls += 1; return { ok: true, text: '{"ok":true}', elapsedMs: 1 }; });
  const capturing: SidecarClient = { available: () => true, complete: async (p) => { calls += 1; lastMaxTokens = p.maxOutputTokens ?? 999; return { ok: true, text: "{}", elapsedMs: 1 }; } };

  assert.equal(await sidecarKeepAlive(client, {}), false, "off unless a keepalive/warm flag is set");
  assert.equal(calls, 0, "must not touch the client when disabled");

  const ok = await sidecarKeepAlive(capturing, { sidecarKeepAliveEnabled: true });
  assert.equal(ok, true);
  assert.equal(calls, 1);
  assert.ok(lastMaxTokens <= 16, "the health check must be tiny (bounded output)");
});

// --- Part E: tool-error normalization -------------------------------------------------------------

test("toolErrorNormalize classifies common tool/command errors into bounded kinds", () => {
  assert.equal(normalizeToolError({ output: "bash: frobnicate: command not found" }).kind, "command_not_found");
  assert.equal(normalizeToolError({ output: "EACCES: permission denied, open '/etc/hosts'" }).kind, "permission_denied");
  assert.equal(normalizeToolError({ output: "src/a.ts(3,10): error TS2345: Argument of type 'x' is not assignable" }).kind, "typecheck_failed");
  assert.equal(normalizeToolError({ output: "1 failing\n  AssertionError: expected 2 got 1" }).kind, "test_failed");
  assert.equal(normalizeToolError({ output: "Error: operation timed out after 30000ms" }).kind, "timeout");
  const big = normalizeToolError({ output: "x".repeat(5000) + "\nError: boom" });
  assert.ok((big.summary?.length ?? 0) <= 200, "summary is bounded");
});

// --- Part F: the receipt actually shows the budget when the governor is on ------------------------

test("buildCompletionReceipt shows the main-call budget + sidecar liveness when the governor is on", () => {
  mainCallGovernor.configure({ mainCallGovernorEnabled: true });
  mainCallGovernor.reset();
  mainCallGovernor.recordMain("code_worker", { calls: 2, estTokens: 1200 });
  mainCallGovernor.recordAvoided("route", "deterministic", "confident deterministic route");
  mainCallGovernor.recordAvoided("failure_distill", "sidecar", "sidecar distilled");
  sidecarUsage.reset();
  sidecarUsage.noteResolved(true, true);
  sidecarUsage.record("failure_distill", "sidecar");

  liveSessionState.reset("optimize the hot path");
  const ledger = liveSessionState.getLedger()!;
  const receipt = buildCompletionReceipt(ledger);

  assert.match(receipt, /main model calls: 2 total/, "shows main-call budget");
  assert.match(receipt, /avoided by sidecar\/deterministic: 2/, "shows avoided calls");
  assert.match(receipt, /sidecar: attempted 1, succeeded 1/, "shows sidecar liveness");

  mainCallGovernor.configure({}); // back off
  mainCallGovernor.reset();
  sidecarUsage.reset();
  // With the governor off, the same ledger yields no budget lines (behaviour unchanged).
  assert.doesNotMatch(buildCompletionReceipt(ledger), /main model calls:/);
});
