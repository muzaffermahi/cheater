// The live mascot widget: mounts "Sly" (the front-facing pixel-art cat) into the interactive TUI and
// keeps it in sync with the work. The art + colors live in catPixels.ts (pure, unit-testable); this
// file is only the thin widget shell that centers and re-renders it.
//
// The cat is STATIC per work-state - calm, no idle animation. A light poll watches the shared mascot
// mood and asks the host TUI to re-render only when it changes (awake vs sleeping), so an idle session
// is still and costs nothing. Interactive TUI only: the factory is mounted just for ctx.mode === "tui",
// so it never constructs a timer in --print/--mode json.
//
// Centering is done in PIXEL space (before color escapes are added) so the SGR color codes never skew
// the layout math, and a row is never emitted wider than the terminal.

import type { MascotState } from "./mascot.js";
import { composeCat, renderCatRow } from "./catPixels.js";

type TuiLike = { requestRender: () => void };

/**
 * The live mascot component. Mount via the host TUI's widget API:
 *   ctx.ui.setWidget("cheater-mascot", (tui, theme) => new CheaterMascotComponent(tui, theme, getState),
 *                    { placement: "aboveEditor" })
 * only when ctx.mode === "tui". `getState` lets the cat doze when the session goes idle.
 */
export class CheaterMascotComponent {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastState: MascotState;
  private cachedWidth = -1;
  private cachedState: MascotState | null = null;
  private cachedLines: string[] = [];

  constructor(
    private readonly tui: TuiLike,
    _theme: unknown,   // accepted for API compatibility; the cat owns its own colors
    private readonly getState: () => MascotState = () => "ready",
    pollMs = 300
  ) {
    this.lastState = safeState(this.getState);
    // Watch the mascot's mood; re-render only when it changes (no per-frame animation loop).
    this.interval = setInterval(() => {
      const state = safeState(this.getState);
      if (state === this.lastState) return;
      this.lastState = state;
      try { this.tui.requestRender(); } catch { /* never break the TUI */ }
    }, Math.max(120, pollMs));
    // Node timers keep the process alive; a mascot must not. unref if available.
    (this.interval as { unref?: () => void }).unref?.();
  }

  render(width: number): string[] {
    const state = safeState(this.getState);
    if (width === this.cachedWidth && state === this.cachedState) return this.cachedLines;
    const rows = composeCat(state);
    const pxW = rows[0]?.length ?? 0;   // logical pixels per row
    const visW = pxW * 2;               // terminal columns the cat occupies
    const lead = " ".repeat(Math.max(0, Math.floor((width - visW) / 2)));
    // If the terminal is narrower than the cat, clip whole pixels so we never emit an over-wide line.
    const keep = width >= visW ? pxW : Math.max(0, Math.floor(width / 2));
    this.cachedLines = rows.map((row) => {
      // A decorative mascot must NEVER throw in render or it kills the whole TUI loop.
      try { return lead + renderCatRow(row.slice(0, keep)); }
      catch { return ""; }
    });
    this.cachedWidth = width;
    this.cachedState = state;
    return this.cachedLines;
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

function safeState(getState: () => MascotState): MascotState {
  try { return getState(); } catch { return "ready"; }
}
