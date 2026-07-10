// Cheater's startup header. Registered via ctx.ui.setHeader() to REPLACE Pi's built-in header
// (its logo + keybinding cheat-sheet + onboarding block), so the top of the screen reads as a
// standalone Cheater product instead of "the pi frontend." Once piConfig.name is set, Pi's own
// logo already says "Cheater" - this additionally drops the keybinding/onboarding clutter and
// gives Cheater a distinct wordmark.
//
// Fixed-height and defensive: a header that throws would take down the whole TUI render loop, so
// render() never throws and always returns at least one line. Its line count does not change with
// state, so it never triggers a relayout (which would scroll the viewport).

import { mascotBanner, type MascotStyle } from "./mascot.js";

type ThemeLike = { fg?: (role: string, s: string) => string } | undefined;

export interface CheaterHeaderOptions {
  /** "cat" (kaomoji wordmark) | "ascii" (plain glyphs) | "off" (plain text, no art). */
  style?: MascotStyle;
  /** Tagline under the wordmark. */
  subtitle?: string;
}

const DEFAULT_SUBTITLE = "reliable local coding, by any means";

export class CheaterHeaderComponent {
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(
    _tui: unknown,
    private readonly theme: ThemeLike,
    private readonly opts: CheaterHeaderOptions = {}
  ) {}

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedLines.length) return this.cachedLines;
    let lines: string[];
    try {
      const style = this.opts.style ?? "cat";
      const subtitle = this.opts.subtitle ?? DEFAULT_SUBTITLE;
      if (style === "off") {
        // Mascot disabled: still hide Pi's banner, but show a plain wordmark instead of cat art.
        lines = [`kitten — ${subtitle}`];
      } else {
        // One-line banner on a narrow terminal; the small boxed cat banner otherwise. Both are a
        // fixed number of lines, so the header height is stable across renders.
        lines = mascotBanner({ lean: width < 54, style, subtitle }).split("\n");
      }
      const fg = this.theme?.fg;
      if (fg) {
        // Tint just the wordmark line with the accent color, matching the status pill.
        lines = lines.map((line) => (line.includes("kitten") ? safeColor(fg, "accent", line) : line));
      }
    } catch {
      lines = ["kitten"];
    }
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  // Host calls this on theme change / forced re-render; just drop the width cache.
  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }

  dispose(): void { /* no timers or listeners to clean up */ }
}

function safeColor(fg: (role: string, s: string) => string, role: string, s: string): string {
  try { return fg(role, s); } catch { return s; }
}
