import test from "node:test";
import assert from "node:assert/strict";

import {
  mascotStateForRunEvent,
  catCells,
  catAnsi,
  PALETTE,
  composeCat
} from "../src/core/mascot.js";

test("mascotStateForRunEvent maps canonical app event types to expressions", () => {
  assert.equal(mascotStateForRunEvent("run.started"), "thinking");
  assert.equal(mascotStateForRunEvent("route.selected"), "thinking");
  assert.equal(mascotStateForRunEvent("tool.started"), "working");
  assert.equal(mascotStateForRunEvent("tool.completed"), "working");
  assert.equal(mascotStateForRunEvent("assistant.delta"), "working");
  assert.equal(mascotStateForRunEvent("candidate.started"), "sampling");
  assert.equal(mascotStateForRunEvent("verification.started"), "verifying");
  assert.equal(mascotStateForRunEvent("verification.evidence"), "verifying");
  assert.equal(mascotStateForRunEvent("verification.failed"), "blocked");
  assert.equal(mascotStateForRunEvent("repair.started"), "blocked");
  assert.equal(mascotStateForRunEvent("run.completed"), "success");
  assert.equal(mascotStateForRunEvent("run.failed"), "blocked");
  assert.equal(mascotStateForRunEvent("run.cancelled"), "blocked");
  assert.equal(mascotStateForRunEvent("run.interrupted"), "blocked");
  assert.equal(mascotStateForRunEvent("user.message"), "ready");
});

test("mascotStateForRunEvent returns null for events that should not move the face", () => {
  // Real event types that carry no expression change, plus an unknown string.
  assert.equal(mascotStateForRunEvent("assistant.final"), null);
  assert.equal(mascotStateForRunEvent("tool.output"), null);
  assert.equal(mascotStateForRunEvent("conversation.created"), null);
  assert.equal(mascotStateForRunEvent("diff.updated"), null);
  assert.equal(mascotStateForRunEvent("verification.passed"), null);
  assert.equal(mascotStateForRunEvent("nope.not.an.event"), null);
  assert.equal(mascotStateForRunEvent(""), null);
});

test("catCells returns a non-empty grid of hex-or-empty cells", () => {
  const grid = catCells("working");
  assert.ok(Array.isArray(grid), "grid is an array");
  assert.ok(grid.length > 0, "grid has rows");
  assert.ok(grid.every((row) => Array.isArray(row) && row.length > 0), "every row has cells");

  const hex = /^#[0-9a-f]{6}$/;
  for (const row of grid) {
    for (const cell of row) {
      assert.ok(cell === "" || hex.test(cell), `cell ${JSON.stringify(cell)} is "" or #rrggbb`);
    }
  }
  // It's a cat, not a blank grid: at least one painted (non-transparent) pixel must exist.
  assert.ok(grid.some((row) => row.some((cell) => cell !== "")), "has at least one painted cell");
});

test("catCells is rectangular and mirrors the composeCat symbol grid", () => {
  const symbols = composeCat("ready");
  const grid = catCells("ready");
  assert.equal(grid.length, symbols.length, "same number of rows as the symbol grid");
  for (let r = 0; r < symbols.length; r++) {
    assert.equal(grid[r].length, symbols[r].length, `row ${r} has one cell per symbol`);
  }
});

test("catAnsi returns terminal rows carrying ANSI escape sequences", () => {
  const rows = catAnsi("verifying");
  assert.ok(Array.isArray(rows), "rows is an array");
  assert.ok(rows.length > 0, "has rows");
  assert.ok(rows.every((r) => typeof r === "string"), "rows are strings");
  // A colored pixel emits an SGR truecolor escape: \x1b[38;2;R;G;Bm ... \x1b[0m
  assert.ok(rows.some((r) => r.includes("\x1b[38;2;")), "an ANSI color escape is present");
  assert.ok(rows.some((r) => r.includes("\x1b[0m")), "an ANSI reset is present");
});

test("PALETTE is exported and non-empty, keyed by symbol char", () => {
  assert.equal(typeof PALETTE, "object");
  assert.notEqual(PALETTE, null);
  const keys = Object.keys(PALETTE);
  assert.ok(keys.length > 0, "palette has entries");
  // Spot-check a known symbol maps to its RGB triple, and the background is transparent (null).
  assert.deepEqual(PALETTE["g"], [66, 172, 82]);
  assert.equal(PALETTE["."], null);
});

test("the module re-exports composeCat and it still produces a symbol grid", () => {
  const grid = composeCat("success");
  assert.ok(Array.isArray(grid), "composeCat returns an array");
  assert.ok(grid.length > 0, "grid has rows");
  assert.ok(grid.every((r) => typeof r === "string" && r.length > 0), "rows are non-empty strings");
});
