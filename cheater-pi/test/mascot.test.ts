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
import { setMascot, configureMascot, getMascotState } from "../src/ui/mascotUi.js";
import { catFrame, CheaterMascotComponent } from "../src/ui/mascotComponent.js";
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
  const calls: { message: (string | undefined)[] } = { message: [] };
  const ctx = {
    ui: {
      setWorkingMessage: (m?: string) => calls.message.push(m),
      theme: { fg: (_c: string, t: string) => t }
    }
  };
  return { ctx, calls };
}

test("setMascot records the mood (for the big component) and sets the working message", () => {
  configureMascot({});
  const { ctx, calls } = fakeCtx();
  setMascot(ctx, "sampling", "best-of-N 1/3");
  assert.equal(getMascotState(), "sampling", "the big animated component reads this state");
  assert.deepEqual(calls.message, ["best-of-N 1/3"]);
  setMascot(ctx, "success");
  assert.equal(getMascotState(), "success");
});

test("setMascot is JSON/headless-safe: it never throws when ui methods are absent or throw", () => {
  configureMascot({});
  assert.doesNotThrow(() => setMascot(undefined, "working", "x"), "no ctx at all");
  assert.doesNotThrow(() => setMascot({ ui: {} }, "working", "x"), "ui with no methods (noOpUIContext shape)");
  const throwingCtx = { ui: { setWorkingMessage: () => { throw new Error("boom"); } } };
  assert.doesNotThrow(() => setMascot(throwingCtx, "working", "x"), "a throwing ui must not break the run");
});

// ---- the big animated component (catFrame) ----

test("catFrame renders a multi-line cat whose face tracks the state, and animates over ticks", () => {
  const ready = catFrame(1, "ready");
  assert.ok(ready.length >= 6, "the mascot is a big multi-line cat, not a one-char spinner");
  assert.match(ready.join("\n"), /\/\\_\/\\/, "it has cat ears");
  assert.match(catFrame(1, "success").join("\n"), /\^\s+\^/, "success shows happy eyes");
  assert.match(catFrame(1, "blocked").join("\n"), /x\s+x/, "blocked shows x eyes");
  assert.match(catFrame(1, "success").join("\n"), /✓/, "success shows a check aura");
  // Constant motion: the tail row differs across ticks (it slides).
  const tailA = catFrame(0, "working").at(-1);
  const tailB = catFrame(2, "working").at(-1);
  assert.notEqual(tailA, tailB, "the tail swishes between frames");
});

test("the animated component calls theme.fg BOUND (never detached) and never throws on a bad theme", () => {
  const tui = { requestRender: () => {} };
  // A theme whose fg is a METHOD that relies on `this` - exactly like pi's real Theme (this.fgColors).
  // The old code captured `const fg = this.theme.fg` and called it detached, losing `this` -> the live
  // "Cannot read properties of undefined (reading 'fgColors')" crash that killed the whole TUI.
  const realish = {
    palette: new Map([["muted", "<m>"], ["success", "<s>"]]),
    fg(color: string, text: string): string {
      const p = this.palette.get(color);
      if (!p) throw new Error(`Unknown theme color: ${color}`);
      return `${p}${text}`;
    }
  };
  const comp = new CheaterMascotComponent(tui, realish, () => "ready");
  try {
    const lines = comp.render(40);
    assert.ok(lines.length >= 6, "renders the multi-line cat");
    assert.ok(lines.join("").includes("<m>"), "themed via a BOUND this (muted color applied), not crashed");
  } finally {
    comp.dispose();
  }
  // A theme that THROWS (unknown color / any quirk) must NOT crash render - the cat shows uncolored.
  const throwing = { fg(): string { throw new Error("Unknown theme color: boom"); } };
  const comp2 = new CheaterMascotComponent(tui, throwing, () => "success");
  try {
    assert.doesNotThrow(() => comp2.render(40), "a throwing theme is swallowed; the mascot never breaks the TUI");
  } finally {
    comp2.dispose();
  }
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
