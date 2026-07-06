// "Sly", the big animated cheater mascot: a chunky solid-@ cat HEAD (Cline-robot vibe - a detailed,
// centered, constantly-alive face rather than a one-char spinner). Modeled on pi's ArminComponent
// (interval -> requestRender -> render(width)): it idle-animates forever (blink, wink, ear-twitch) and
// its face tracks the work (thinking/working/sampling/verifying/success/blocked/sleeping). Interactive
// TUI only - the factory is mounted just for ctx.mode === "tui", so it never runs in --print/--mode json.
//
// Pure frame production (catFrame) is separated from the ticking component so the art is unit-testable.
// All rows are pure ASCII @ (matches the user's reference + is safe on any code page, incl. cp1254).

import type { MascotState } from "./mascot.js";

// Minimal shapes of the pi TUI/Theme the factory receives - typed loosely to avoid deep type imports.
type TuiLike = { requestRender: () => void };
type ThemeLike = { fg?: (color: string, text: string) => string };

interface FaceParts {
  eye: string; // single-char eye glyph (blink/wink override it)
  mouth: string; // mouth key -> mouthStr()
  color: string; // theme color name for the whole cat
}

function facePartsFor(state: MascotState): FaceParts {
  switch (state) {
    case "thinking": return { eye: "o", mouth: "neutral", color: "accent" };
    case "working": return { eye: "O", mouth: "neutral", color: "text" };
    case "sampling": return { eye: "O", mouth: "open", color: "accent" };
    case "verifying": return { eye: "-", mouth: "neutral", color: "warning" };
    case "success": return { eye: "^", mouth: "happy", color: "success" };
    case "blocked": return { eye: "x", mouth: "frown", color: "error" };
    case "sleeping": return { eye: "-", mouth: "sleep", color: "muted" };
    case "ready":
    default: return { eye: "O", mouth: "neutral", color: "muted" };
  }
}

// Every mouth is EXACTLY 12 chars so the mouth row never shifts width across states.
function mouthStr(key: string): string {
  switch (key) {
    case "happy": return "\\___vvvv___/";
    case "frown": return "/^^^^^^^^^^\\";
    case "sleep": return "\\___ZZZZ___/";
    case "open": return "\\___OOOO___/";
    default: return "\\__________/";
  }
}

/**
 * Produce the cat's lines for an animation tick + mood. Pure + deterministic (given tick), so it is
 * unit-testable. `tick` increments every frame; blink, wink and ear-twitch derive from it. The face
 * itself (eyes + mouth) tracks the mood; expressive moods (success/blocked/sleeping) hold their look
 * instead of blinking. Rows are left-aligned as a block; the component centers the whole block.
 */
export function catFrame(tick: number, state: MascotState): string[] {
  const parts = facePartsFor(state);
  // Expressive moods hold their face; neutral moods blink (both eyes) then wink (one eye) each cycle.
  const expressive = state === "success" || state === "blocked" || state === "sleeping";
  const blink = !expressive && tick % 16 === 0;
  const wink = !expressive && tick % 16 === 8;
  const le = blink || wink ? "-" : parts.eye;
  const re = blink ? "-" : parts.eye;
  // Ears flick outward every ~2s.
  const ear = tick % 12 === 6 ? "/@ \\" : "/@@\\";
  const m = mouthStr(parts.mouth);
  return [
    `     ${ear}              ${ear}`,
    `     @@@@@@          @@@@@@`,
    `    @@@@@@@@@@@@@@@@@@@@@@@@`,
    `   @@@@@@@@@@@@@@@@@@@@@@@@@@`,
    `   @@@@@@  @@@@@@@@@@  @@@@@@`,
    ` ==@@@@@ (${le}) @@@@ (${re}) @@@@@==`,
    `   @@@@@@@@@@@@@@@@@@@@@@@@@@`,
    `   @@@@@@@@@@@ vv @@@@@@@@@@@`,
    ` ==@@@@@ ${m} @@@@@==`,
    `    @@@@@@@@@@@@@@@@@@@@@@@@`,
    `     @@@@@@@@@@@@@@@@@@@@@@`,
    `       @@@@@@@@@@@@@@@@@@`
  ];
}

/**
 * The live animated component. Mount via:
 *   ctx.ui.setWidget("cheater-mascot", (tui, theme) => new CheaterMascotComponent(tui, theme, getState),
 *                    { placement: "aboveEditor" })
 * only when ctx.mode === "tui". `getState` lets the cat's face follow the work.
 */
export class CheaterMascotComponent {
  private interval: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private cachedWidth = -1;
  private cachedTick = -1;
  private cachedLines: string[] = [];

  constructor(
    private readonly tui: TuiLike,
    private readonly theme: ThemeLike,
    private readonly getState: () => MascotState = () => "ready",
    fps = 6
  ) {
    this.interval = setInterval(() => {
      this.tick += 1;
      try { this.tui.requestRender(); } catch { /* never break the TUI */ }
    }, Math.max(60, Math.round(1000 / fps)));
    // Node timers keep the process alive; a mascot must not. unref if available.
    (this.interval as { unref?: () => void }).unref?.();
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedTick === this.tick) return this.cachedLines;
    const state = safeState(this.getState);
    const color = facePartsFor(state).color;
    const frame = catFrame(this.tick, state);
    // Center the whole cat block: pad every row by the same lead so internal alignment is preserved.
    const artWidth = Math.max(...frame.map((l) => l.length));
    const lead = " ".repeat(Math.max(0, Math.floor((width - artWidth) / 2)));
    this.cachedLines = frame.map((line) => {
      const centered = (lead + line).slice(0, Math.max(0, width));
      // pi's theme.fg is a METHOD that reads this.fgColors and THROWS on an unknown color, so it must
      // be called ON the theme (never captured as a bare fn, which loses `this`) and wrapped: a
      // decorative mascot must NEVER throw in render or it kills pi's whole TUI loop.
      let painted = centered;
      try {
        if (this.theme?.fg) painted = this.theme.fg(color, centered);
      } catch { /* themeless render, unknown color, or detached call - show the cat uncolored */ }
      return painted;
    });
    this.cachedWidth = width;
    this.cachedTick = this.tick;
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
