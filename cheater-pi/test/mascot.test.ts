import test from "node:test";
import assert from "node:assert/strict";
import {
  mascotFace,
  mascotLine,
  mascotBanner,
  mascotVisible,
  mascotSpinnerFrames,
  mascotStateForPhase
} from "../src/ui/mascot.js";
import { setMascot, clearMascot, configureMascot } from "../src/ui/mascotUi.js";
import { renderRunConsole } from "../src/reliability/runConsole.js";

// ---- pure mascot strings ----

test("mascotFace returns a three-line cat whose eyes carry the expression", () => {
  const face = mascotFace("success");
  assert.equal(face.length, 3);
  assert.match(face[1], /\^/, "success face smiles");
  assert.notEqual(mascotFace("blocked")[1], mascotFace("success")[1], "different states differ");
});

test("mascotLine formats emoji vs ascii and appends the message", () => {
  assert.match(mascotLine("thinking", "routing your goal", "cat"), /thinking · routing your goal/);
  assert.match(mascotLine("thinking", "x", "ascii"), /^;\) thinking/, "ascii style uses a plain marker");
  assert.doesNotMatch(mascotLine("ready", undefined), /·/, "no separator when there is no message");
});

test("mascotBanner names cheater and its tagline; lean form is one line", () => {
  assert.match(mascotBanner(), /cheater/i);
  assert.match(mascotBanner(), /reliable local coding/);
  assert.equal(mascotBanner({ lean: true }).split("\n").length, 1, "lean banner is a single line");
});

test("mascotSpinnerFrames animate for cat/ascii and are empty for off", () => {
  assert.ok(mascotSpinnerFrames("thinking", "cat").length >= 1);
  assert.ok(mascotSpinnerFrames("sampling", "cat").length >= 2, "sampling animates");
  assert.deepEqual(mascotSpinnerFrames("thinking", "off"), [], "off style yields no frames");
  assert.notDeepEqual(mascotSpinnerFrames("working", "ascii"), mascotSpinnerFrames("working", "cat"));
});

test("mascotStateForPhase maps harness phases to expressions", () => {
  assert.equal(mascotStateForPhase("routing your goal"), "thinking");
  assert.equal(mascotStateForPhase("best-of-N sampling 3x"), "sampling");
  assert.equal(mascotStateForPhase("running focused verification"), "verifying");
  assert.equal(mascotStateForPhase("finish gate ALLOWED"), "success");
  assert.equal(mascotStateForPhase("blocked by guard"), "blocked");
  assert.equal(mascotStateForPhase("writing app.ts"), "working");
});

test("mascotVisible hides the mascot for JSON/headless/non-TTY, shows it interactively", () => {
  assert.equal(mascotVisible({ jsonMode: true, isTTY: true }), false, "never in JSON mode");
  assert.equal(mascotVisible({ isTTY: false }), false, "never on a non-TTY stream");
  assert.equal(mascotVisible({ enabled: false, isTTY: true }), false, "respects an explicit disable");
  assert.equal(mascotVisible({ isTTY: true }), true, "shows in an interactive TTY");
});

// ---- ctx wiring (mascotUi) ----

function fakeCtx() {
  const calls: { indicator: unknown[]; message: (string | undefined)[] } = { indicator: [], message: [] };
  const ctx = {
    ui: {
      setWorkingIndicator: (o?: unknown) => calls.indicator.push(o),
      setWorkingMessage: (m?: string) => calls.message.push(m),
      theme: { fg: (_c: string, t: string) => t }
    }
  };
  return { ctx, calls };
}

test("setMascot drives the spinner frames and the message via ctx.ui", () => {
  configureMascot({});
  const { ctx, calls } = fakeCtx();
  setMascot(ctx, "sampling", "best-of-N 1/3");
  assert.equal(calls.indicator.length, 1, "an animated indicator was set");
  assert.ok((calls.indicator[0] as { frames?: string[] }).frames!.length >= 1);
  assert.deepEqual(calls.message, ["best-of-N 1/3"]);
});

test("setMascot respects mascotStyle:off (no cat frames) but still shows the message", () => {
  const { ctx, calls } = fakeCtx();
  setMascot(ctx, "working", "still coding", { mascotStyle: "off" });
  assert.equal(calls.indicator.length, 0, "no mascot indicator when off");
  assert.deepEqual(calls.message, ["still coding"], "the message still shows");
});

test("setMascot is JSON/headless-safe: it never throws when ui methods are absent or throw", () => {
  configureMascot({});
  assert.doesNotThrow(() => setMascot(undefined, "working", "x"), "no ctx at all");
  assert.doesNotThrow(() => setMascot({ ui: {} }, "working", "x"), "ui with no methods (noOpUIContext shape)");
  const throwingCtx = { ui: { setWorkingIndicator: () => { throw new Error("boom"); }, setWorkingMessage: () => { throw new Error("boom"); } } };
  assert.doesNotThrow(() => setMascot(throwingCtx, "working", "x"), "a throwing ui must not break the run");
  assert.doesNotThrow(() => clearMascot(throwingCtx));
});

// ---- run console face ----

test("renderRunConsole prefixes a reactive cat face keyed to the run state", () => {
  const base = { status: "running (running)", changedFiles: 1, unresolvedFailures: 0 };
  assert.match(renderRunConsole(base)[0], /Cheater - running/);
  assert.match(renderRunConsole(base)[0], /=.*= Cheater/, "a cat face leads the status line");
  const stuck = renderRunConsole({ ...base, unresolvedFailures: 2 })[0];
  assert.match(stuck, /=x\.x=/, "an unresolved failure shows the stuck face");
  const done = renderRunConsole({ ...base, status: "complete" })[0];
  assert.match(done, /=\^\.\^=/, "a complete run shows the happy face");
  assert.doesNotMatch(renderRunConsole(base, { mascot: false })[0], /=.*=/, "mascot:false drops the face");
});
