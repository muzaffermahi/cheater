// The BIG animated mascot: "Sly", a chunky terminal cat that moves CONSTANTLY (tail swish, blink,
// ear twitch, breathing) - the Cline-robot vibe, a real pi TUI Component instead of the one-char
// spinner glyph. Modeled on pi's ArminComponent (interval -> requestRender -> render(width)), but the
// loop never stops: it idle-animates forever, and its face tracks the work (thinking/coding/verifying/
// done/stuck). Interactive TUI only - the factory is mounted just for ctx.mode === "tui", so it never
// runs in --print/--mode json.
//
// Pure frame production (catFrame) is separated from the ticking component so the art is unit-testable.

import type { MascotState } from "./mascot.js";

// Minimal shapes of the pi TUI/Theme the factory receives - typed loosely to avoid deep type imports.
type TuiLike = { requestRender: () => void };
type ThemeLike = { fg?: (color: string, text: string) => string };

interface FaceParts {
  eyes: [string, string]; // left, right eye glyphs (blink overrides these)
  mouth: string;
  color: string; // theme color name for the whole cat
  aura: string; // a small tag rendered beside the cat (e.g. "zzZ", "✓", "!", "×3")
}

function facePartsFor(state: MascotState): FaceParts {
  switch (state) {
    case "thinking": return { eyes: ["o", "-"], mouth: "~", color: "accent", aura: "?" };
    case "working": return { eyes: [">", "<"], mouth: "w", color: "text", aura: "" };
    case "sampling": return { eyes: ["o", "o"], mouth: "o", color: "accent", aura: "×" };
    case "verifying": return { eyes: ["-", "-"], mouth: "~", color: "warning", aura: "?" };
    case "success": return { eyes: ["^", "^"], mouth: "‿", color: "success", aura: "✓" };
    case "blocked": return { eyes: ["x", "x"], mouth: "n", color: "error", aura: "!" };
    case "sleeping": return { eyes: ["-", "-"], mouth: "‿", color: "muted", aura: "zzZ" };
    case "ready":
    default: return { eyes: ["o", "o"], mouth: "ᵕ", color: "muted", aura: "" };
  }
}

// A swishing tail: a curl that slides left<->right below the cat over a 10-tick ping-pong, so it
// reads clearly as a tail sweeping the floor rather than scattered glyphs on the body.
const TAIL_FRAMES = [
  "  ╰──╮     ",
  "   ╰──╮    ",
  "    ╰──╮   ",
  "     ╰──╮  ",
  "    ╰──╮   ",
  "   ╰──╮    ",
  "  ╰──╮     ",
  " ╰──╮      "
];

/**
 * Produce the cat's lines for an animation tick + mood. Pure + deterministic (given tick), so it is
 * unit-testable. `tick` increments every frame; blink, ear-twitch, breathing and tail-swish derive
 * from it. Rows are a consistent width and centered so the cat never looks ragged.
 */
export function catFrame(tick: number, state: MascotState): string[] {
  const parts = facePartsFor(state);
  // Blink: eyes shut for one frame roughly every ~2.3s at 6fps, unless the mood already squints.
  const blinking = tick % 14 === 0 && state !== "sleeping" && state !== "verifying";
  const [le, re] = blinking ? ["-", "-"] : parts.eyes;
  // Ear twitch: the ears flick every ~11 frames.
  const ears = tick % 11 === 5 ? " /\\   /\\ " : " /\\_/\\  ";
  // Breathing: a subtle one-space bob every other half-cycle.
  const bob = Math.floor(tick / 5) % 2 === 0 ? "" : " ";
  const tail = TAIL_FRAMES[tick % TAIL_FRAMES.length];
  const aura = parts.aura ? ` ${parts.aura}` : "";
  // Front paws do a slow "make biscuits" shuffle so the chonky body feels alive.
  const paws = tick % 8 < 4 ? "( |   | )" : "(|   | )";
  return [
    `${bob}   ${ears}`,
    `${bob}  /  V  \\`,
    `${bob} ( ${le}   ${re} )${aura}`,
    `${bob} (  =^=  )`,
    `${bob}  ) ${parts.mouth} (`,
    `${bob}  /~   ~\\`,
    `${bob} /|     |\\`,
    `${bob} ${paws}`,
    `${bob} \\|_ _|/`,
    `${bob}${tail}`
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
    const fg = this.theme?.fg;
    this.cachedLines = catFrame(this.tick, state).map((line) => {
      const clipped = line.slice(0, Math.max(0, width - 1));
      return ` ${fg ? fg(color, clipped) : clipped}`;
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
