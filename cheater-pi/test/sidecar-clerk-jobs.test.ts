import test from "node:test";
import assert from "node:assert/strict";
import { nullSidecarClient } from "../src/sidecar/client.js";
import type { SidecarClient, SidecarCompletion } from "../src/sidecar/types.js";
import {
  deterministicFailureCard,
  renderFailureCard,
  parseFailureSidecar,
  rerankBriefsSidecar,
  triageHintSidecar,
  driftNoteSidecar
} from "../src/sidecar/jobs.js";

function fakeClient(text: string): SidecarClient {
  return { available: () => true, async complete(): Promise<SidecarCompletion> { return { ok: true, text, elapsedMs: 1 }; } };
}
const brokenClient: SidecarClient = { available: () => true, async complete(): Promise<SidecarCompletion> { return { ok: false, error: "timeout", elapsedMs: 1 }; } };

// --- parse_failure ---------------------------------------------------------------------------

test("deterministicFailureCard extracts file/test/assertion from a python traceback", () => {
  const failure = [
    "============ FAILURES ============",
    "FAILED tests/test_math.py::test_add",
    'File "src/calc.py", line 12, in add',
    "    return a - b",
    "AssertionError: assert 5 == 3"
  ].join("\n");
  const card = deterministicFailureCard(failure);
  assert.equal(card.file, "src/calc.py");
  assert.match(card.test ?? "", /test_add|test_math/);
  assert.match(card.assertion ?? "", /assert|AssertionError/i);
  assert.ok(card.salientLines.length >= 1);
});

test("parseFailureSidecar falls back to a deterministic card when the sidecar is unavailable", async () => {
  const outcome = await parseFailureSidecar(nullSidecarClient, 'File "a.py", line 3\nTypeError: bad');
  assert.equal(outcome.source, "deterministic");
  assert.equal(outcome.value.file, "a.py");
  assert.match(outcome.note, /unavailable/);
});

test("parseFailureSidecar uses a well-formed sidecar card and clamps it", async () => {
  const client = fakeClient('{"file":"src/x.ts","test":"handles empty","assertion":"expected 0 got 1","salientLines":["line a","line b"]}');
  const outcome = await parseFailureSidecar(client, "some noisy failure output");
  assert.equal(outcome.source, "sidecar");
  assert.equal(outcome.value.file, "src/x.ts");
  assert.deepEqual(outcome.value.salientLines, ["line a", "line b"]);
});

test("parseFailureSidecar falls back when the sidecar errors", async () => {
  const outcome = await parseFailureSidecar(brokenClient, 'File "z.js", line 1\nError: boom');
  assert.equal(outcome.source, "deterministic");
  assert.equal(outcome.value.file, "z.js");
});

test("renderFailureCard is a compact readable block", () => {
  const text = renderFailureCard({ file: "a.py", test: "t", assertion: "x==y", salientLines: ["boom"] });
  assert.match(text, /Failure card:/);
  assert.match(text, /file: a\.py/);
  assert.match(text, /assertion: x==y/);
});

// --- rerank_briefs ---------------------------------------------------------------------------

test("rerankBriefsSidecar falls back to input order when unavailable", async () => {
  const briefs = [{ path: "a.ts", reason: "x" }, { path: "b.ts", reason: "y" }];
  const outcome = await rerankBriefsSidecar(nullSidecarClient, "goal", briefs);
  assert.equal(outcome.source, "deterministic");
  assert.deepEqual(outcome.value.order, ["a.ts", "b.ts"]);
});

test("rerankBriefsSidecar reorders but never widens beyond the candidate set", async () => {
  const briefs = [{ path: "a.ts", reason: "x" }, { path: "b.ts", reason: "y" }];
  // The sidecar tries to sneak in an invented path; it must be dropped.
  const client = fakeClient('{"order":["b.ts","INVENTED.ts","a.ts"]}');
  const outcome = await rerankBriefsSidecar(client, "goal", briefs);
  assert.equal(outcome.source, "sidecar");
  assert.deepEqual(outcome.value.order, ["b.ts", "a.ts"], "invented path dropped, real ones reordered");
});

// --- triage_hint -----------------------------------------------------------------------------

test("triageHintSidecar is a neutral no-op when unavailable", async () => {
  const outcome = await triageHintSidecar(nullSidecarClient, "goal", { hardness: 2 });
  assert.equal(outcome.source, "deterministic");
  assert.equal(outcome.value.extraHardness, 0);
});

test("triageHintSidecar clamps the nudge to the small advisory range", async () => {
  const client = fakeClient('{"extraHardness": 9, "reason": "hidden concurrency"}');
  const outcome = await triageHintSidecar(client, "goal", { hardness: 1 });
  assert.equal(outcome.source, "sidecar");
  assert.equal(outcome.value.extraHardness, 2, "clamped to the max advisory delta");
});

// --- drift_note ------------------------------------------------------------------------------

test("driftNoteSidecar reports no drift when unavailable", async () => {
  const outcome = await driftNoteSidecar(nullSidecarClient, "goal", "worker did the thing");
  assert.equal(outcome.source, "deterministic");
  assert.equal(outcome.value.offGoal, false);
});

test("driftNoteSidecar flags off-goal output", async () => {
  const client = fakeClient('{"offGoal": true, "note": "refactored unrelated module"}');
  const outcome = await driftNoteSidecar(client, "fix the parser", "I rewrote the whole build system");
  assert.equal(outcome.value.offGoal, true);
  assert.match(outcome.value.note, /unrelated/);
});

test("driftNoteSidecar returns an empty note when the sidecar sees no drift", async () => {
  const client = fakeClient('{"offGoal": false, "note": ""}');
  const outcome = await driftNoteSidecar(client, "goal", "on task output");
  assert.equal(outcome.value.offGoal, false);
  assert.equal(outcome.value.note, "");
});
