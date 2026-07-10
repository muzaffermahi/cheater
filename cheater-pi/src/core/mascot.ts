// Kitten Core — runtime-independent mascot presentation. NO Pi, NO stream, NO ANSI-only assumption.
//
// This is the single presentation module the new TUI and the web UI both consume. It re-exports the
// pure pixel-cat primitives — the symbol grid + the fixed palette, plus the mascot's face/word map —
// from ../ui/catPixels.js and ../ui/mascot.js (both Pi-free pure-data modules), and layers on the two
// renderers and one event mapping a UI needs:
//   • catAnsi(state)  → terminal rows (colored "██" blocks), for the TUI.
//   • catCells(state) → a 2D grid of "#rrggbb" (or "" transparent), for a web canvas/DOM painter.
//   • mascotStateForRunEvent(type) → the expression a canonical app event (core/events.ts) implies,
//     or null when the event should leave the face unchanged.
// Both UIs drive the same face from the same event stream, so the mascot can never disagree with the
// one state machine that lives in core/events.ts.
//
// NOTE on the re-export set: catPixels' `faceFor` and mascot's `FRAMES` are module-private in their
// source files. Exposing them by name would mean editing those modules; this module deliberately
// keeps the only existing-file change to a single additive `export` on catPixels' PALETTE, and
// derives everything else it needs from the public `composeCat` + `PALETTE`. If a UI later needs
// `faceFor`/`FRAMES` directly, promote them to `export` at their source and re-export them here.

import { composeCat, renderCatRow, PALETTE } from "../ui/catPixels.js";
import { mascotBanner, mascotStateForPhase } from "../ui/mascot.js";
import type { MascotState } from "../ui/mascot.js";

// The Pi-free primitives both UIs build on — re-exported, never duplicated.
export { composeCat, renderCatRow, PALETTE, mascotBanner, mascotStateForPhase };
export type { MascotState };

// Which mascot expression a canonical app event type (see core/events.ts) implies. Only the event
// types that meaningfully move the face are listed; anything else falls through to `null` below, which
// tells the UI to leave the current expression as-is.
const RUN_EVENT_MASCOT: Readonly<Record<string, MascotState>> = {
  "user.message": "ready",
  "run.started": "thinking",
  "route.selected": "thinking",
  "tool.started": "working",
  "tool.completed": "working",
  "assistant.delta": "working",
  "candidate.started": "sampling",
  "verification.started": "verifying",
  "verification.evidence": "verifying",
  "verification.failed": "blocked",
  "repair.started": "blocked",
  "run.completed": "success",
  "run.failed": "blocked",
  "run.cancelled": "blocked",
  "run.interrupted": "blocked"
};

/**
 * Map a canonical app event type (see core/events.ts) to the mascot expression it implies, or `null`
 * when the event should leave the current expression unchanged. UI code feeds each event through this
 * to keep the cat's face in lockstep with the run's state machine.
 */
export function mascotStateForRunEvent(eventType: string): MascotState | null {
  return RUN_EVENT_MASCOT[eventType] ?? null;
}

/** A logical pixel's 24-bit color as a CSS hex string (`#rrggbb`, lowercase). */
function toHex(rgb: readonly [number, number, number]): string {
  const part = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/**
 * The cat as a 2D grid of CSS hex colors for a state: each logical pixel is `"#rrggbb"`, or `""` for a
 * transparent/background cell (palette `null`, or a symbol the palette doesn't define). Derived from
 * composeCat + PALETTE so a web renderer can paint a canvas/DOM grid with no ANSI. Rows run top → down,
 * columns left → right.
 */
export function catCells(state: MascotState): string[][] {
  return composeCat(state).map((row) =>
    Array.from(row, (ch): string => {
      const rgb = PALETTE[ch];
      return rgb ? toHex(rgb) : "";
    })
  );
}

/**
 * The cat rendered for a terminal: one ANSI string per row (runs of a color become "██" blocks,
 * transparent cells become spaces). The TUI's entry point; it reuses renderCatRow so the terminal
 * rendering stays defined in exactly one place.
 */
export function catAnsi(state: MascotState): string[] {
  return composeCat(state).map(renderCatRow);
}
