import test from "node:test";
import assert from "node:assert/strict";
import { emptyTurnDetector } from "../src/reliability/emptyTurnDetector.js";
import { piIdleTimeoutMs } from "../src/blueprint/worker.js";

test("empty-turn detector warns once after two silent turns, and a productive turn clears it", () => {
  emptyTurnDetector.reset();
  assert.equal(emptyTurnDetector.observeTurn(false, false), null, "one empty turn is not enough");
  const warning = emptyTurnDetector.observeTurn(false, false);
  assert.ok(warning, "two empty turns in a row trigger the diagnostic");
  assert.match(warning!, /produced no output/);
  assert.match(warning!, /prefill|timed out|httpIdleTimeoutMs/i, "the diagnostic names the real cause");
  // Not repeated on the third empty turn (notify once).
  assert.equal(emptyTurnDetector.observeTurn(false, false), null);
  // A turn with tool calls clears the streak.
  assert.equal(emptyTurnDetector.observeTurn(false, true), null);
  assert.equal(emptyTurnDetector.observeTurn(false, false), null, "streak restarted after progress");
  assert.ok(emptyTurnDetector.observeTurn(false, false), "warns again after two more empties");
  emptyTurnDetector.reset();
});

test("a turn with assistant text is never counted as empty", () => {
  emptyTurnDetector.reset();
  assert.equal(emptyTurnDetector.observeTurn(true, false), null);
  assert.equal(emptyTurnDetector.observeTurn(true, false), null);
  assert.equal(emptyTurnDetector.observeTurn(false, false), null, "only one empty after text");
  emptyTurnDetector.reset();
});

test("piIdleTimeoutMs defaults to 30 minutes and honors config (incl. 0 = no timeout)", () => {
  assert.equal(piIdleTimeoutMs(), 1_800_000);
  assert.equal(piIdleTimeoutMs({}), 1_800_000);
  assert.equal(piIdleTimeoutMs({ httpIdleTimeoutMs: 600_000 }), 600_000);
  assert.equal(piIdleTimeoutMs({ httpIdleTimeoutMs: 0 }), 0, "0 means no timeout");
  assert.equal(piIdleTimeoutMs({ httpIdleTimeoutMs: -5 }), 1_800_000, "invalid negative falls back");
});
