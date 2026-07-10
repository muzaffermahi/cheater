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
import { CheaterMascotComponent } from "../src/ui/mascotComponent.js";
import { cheaterCat, composeCat, renderCatRow, CAT_BASE } from "../src/ui/catPixels.js";
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

test("mascotBanner names kitten and its tagline; lean form is one line", () => {
  assert.match(mascotBanner(), /kitten/i);
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
  assert.doesNotThrow(() => setMascot({ ui: {} }, "working", "x"), "ui with no methods (no-op UI context shape)");
  const throwingCtx = { ui: { setWorkingMessage: () => { throw new Error("boom"); } } };
  assert.doesNotThrow(() => setMascot(throwingCtx, "working", "x"), "a throwing ui must not break the run");
});

// ---- the pixel-art cat (catPixels) ----

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderCatRow paints colored two-column blocks and spaces for background", () => {
  assert.equal(renderCatRow("."), "  ", "background is two spaces, no color");
  assert.match(renderCatRow("p"), /\x1b\[38;2;\d+;\d+;\d+m██\x1b\[0m/, "a pixel is a colored ██ block");
  assert.equal(stripAnsi(renderCatRow("pp..p")).length, 10, "5 pixels -> 10 visible columns");
});

test("CAT_BASE is a rectangular, hand-editable symbol grid", () => {
  const w = CAT_BASE[0].length;
  assert.ok(CAT_BASE.length >= 18, "a detailed multi-row cat");
  assert.ok(CAT_BASE.every((r) => r.length === w), "every row is the same width");
  assert.ok(CAT_BASE.every((r) => /^[.ofFkpPqgdwy]+$/.test(r)), "only the documented palette symbols are used");
});

test("CAT_BASE (the shared body) is left-right symmetric", () => {
  const w = CAT_BASE[0].length;
  CAT_BASE.forEach((row, r) => {
    for (let c = 0; c < Math.floor(w / 2); c++) {
      assert.equal(row[c], row[w - 1 - c], `row ${r} not symmetric at col ${c}`);
    }
  });
});

test("cheaterCat renders a big colored front-facing cat", () => {
  const cat = cheaterCat("ready");
  assert.equal(cat.length, CAT_BASE.length, "one terminal row per pixel row");
  assert.ok(cat.every((l) => stripAnsi(l).length === CAT_BASE[0].length * 2), "two visible columns per pixel");
  const joined = cat.join("\n");
  assert.ok(joined.includes("██"), "solid pixel blocks");
  assert.ok(joined.includes("\x1b[38;2;231;116;142m"), "pink ears/nose");
  assert.ok(joined.includes("\x1b[38;2;66;172;82m"), "green eyes");
  assert.ok(joined.includes("\x1b[38;2;246;246;248m"), "white catchlights");
});

test("each work-state wears the right face (idle / building / error)", () => {
  const idle = composeCat("ready").join("\n");
  const building = composeCat("working").join("\n");
  const error = composeCat("blocked").join("\n");
  assert.notEqual(idle, building, "building differs from idle");
  assert.notEqual(idle, error, "error differs from idle");
  assert.notEqual(building, error, "building differs from error");
  assert.equal(composeCat("sleeping").join("\n"), idle, "sleeping shares the idle face");
  assert.equal(composeCat("sampling").join("\n"), building, "sampling shares the building face");
  assert.equal(composeCat("success").join("\n"), idle, "success rests on the idle face");
});

test("the mascot component centers the colored cat and never throws (any width/theme)", () => {
  const tui = { requestRender: () => {} };
  const comp = new CheaterMascotComponent(tui, { any: "theme" }, () => "ready");
  try {
    const lines = comp.render(80);
    assert.equal(lines.length, CAT_BASE.length, "renders the multi-line cat");
    assert.ok(lines.every((l) => stripAnsi(l).length <= 80), "never wider than the terminal");
    assert.ok(lines.some((l) => l.startsWith("  ")), "centered with a left margin at width 80");
    assert.ok(lines.join("").includes("██"), "the colored pixels are present");
    assert.doesNotThrow(() => comp.render(20), "a narrow terminal clips instead of crashing");
    assert.ok(comp.render(20).every((l) => stripAnsi(l).length <= 20), "clipped to the narrow width");
  } finally {
    comp.dispose();
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
