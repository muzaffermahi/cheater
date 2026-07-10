// "Sly", cheater's front-facing terminal-cell pixel-art cat: a black cat with pink inner ears, big
// green eyes with white catchlights, a pink nose, gray whiskers, and eyebrows. Drawn on a logical
// pixel grid and painted with a small fixed palette (24-bit color), not loose ASCII art.
//
// The cat has THREE expressions that track the work; the body (CAT_BASE) is shared and only the face
// (eyebrows + eyes + mouth) is stamped per state:
//   - idle     : flat brows, calm eyes, neutral mouth        (ready / waiting / done)
//   - building : raised brows, wide eyes, open mouth         (thinking / working / sampling / verifying)
//   - error    : furrowed brows, half-lidded eyes, a frown   (blocked / a bad tool call)
//
// Hand-editable: every character in CAT_BASE (and the FACES sprites) is ONE logical pixel mapped to a
// color in PALETTE:
//   "." background  "o" darkest fur  "f" fur  "F" fur highlight  "k" black (eyes)
//   "p" bright pink  "P" mid pink  "q" plum (cool ear gradient)  "g" green  "d" dark green
//   "w" white  "y" gray (brows/whiskers/mouth)
// Each pixel renders as TWO terminal columns ("██" in its color, or two spaces for the transparent
// background) so pixels look square-ish on the terminal's own dark backdrop.
//
// This module is PURE - it returns strings and never touches a stream, so it can't corrupt --print
// output. The color escapes are standard SGR, which the host TUI measures ANSI-aware, so they never
// disturb layout.

import type { MascotState } from "./mascot.js";

type Rgb = [number, number, number];

// The mascot's own fixed palette (not the app theme - this cat owns its colors). `null` = transparent.
export const PALETTE: Record<string, Rgb | null> = {
  ".": null,
  o: [17, 17, 21],    // darkest fur / soft edge
  f: [31, 31, 37],    // fur (dark charcoal -> reads as a black cat)
  F: [44, 44, 52],    // fur highlight (muzzle)
  k: [10, 10, 13],    // black (eye interior)
  p: [231, 116, 142], // bright pink (ear core + nose)
  P: [178, 90, 134],  // cooler mid pink (ear transition)
  q: [100, 55, 92],   // dark cool plum (ear edge fading to black)
  g: [66, 172, 82],   // green (eyes)
  d: [38, 120, 56],   // dark green (lower eye)
  w: [246, 246, 248], // white catchlight
  y: [102, 102, 114]  // gray (eyebrows / whiskers / mouth)
};

const WIDTH = 30;

// The cat body: ears, head, nose, whiskers. The face (rows 9-22, center) is fur here and gets stamped
// per state. 30 logical pixels wide x 24 tall.
export const CAT_BASE: string[] = [
  "......ooo............ooo......",
  ".....offfo..........offfo.....",
  "....oqPPqo..........oqPPqo....",
  "....oqPpPqo........oqPpPqo....",
  "...oqPppPqo........oqPppPqo...",
  "...oqPpppPqo......oqPpppPqo...",
  "...oqPpppPqo......oqPpppPqo...",
  "..oqPpppppPqo....oqPpppppPqo..",
  "..oqPpppppPqo....oqPpppppPqo..",
  "..offffffffffo..offffffffffo..",
  "..offfffffffffoofffffffffffo..",
  ".offffffffffffffffffffffffffo.",
  ".offffffffffffffffffffffffffo.",
  ".offffffffffffffffffffffffffo.",
  "yyyyffffffffffffffffffffffyyyy",
  ".offffffffffffffffffffffffffo.",
  "yyyyffffffffffffffffffffffyyyy",
  "..offfffffffFppppFfffffffffo..",
  ".yyyffffffffFFppFFffffffffyyy.",
  "....ooffffffFFFFFFffffffoo....",
  "......ooffffffffffffffoo......",
  "........oooffffffffooo........",
  "...........ooffffoo...........",
  ".............oooo............."
];

// Where the face parts sit on CAT_BASE. Eyes are a 6x6 sprite stamped at both sockets (same sprite -
// the catchlight sits upper-left on both, as if lit from the upper left). Brows are given for the LEFT
// side and mirrored. Mouth pixels are absolute (already symmetric).
const EYE_ROW = 12;
const EYE_COLS = [6, 18];

type Face = { brows: Array<[number, number]>; eye: string[]; mouth: Array<[number, number]> };

const FACES: Record<"idle" | "building" | "error", Face> = {
  idle: {
    brows: [[10, 7], [10, 8], [10, 9], [10, 10]],
    eye: [".wwkk.", "wwwkk.", "wkkwkk", "gkkkkg", "ggkkgg", ".dggd."],
    mouth: [[19, 14], [19, 15], [20, 13], [20, 16]] // philtrum + level corners (neutral)
  },
  building: {
    brows: [[9, 7], [9, 8], [10, 9]],
    eye: [".wwwk.", "wwwwk.", "wwkwkk", "gkkkkg", "gkkkkg", ".dggd."],
    mouth: [[19, 14], [19, 15], [20, 13], [20, 16], [21, 14], [21, 15]] // philtrum + open oval
  },
  error: {
    brows: [[10, 7], [10, 8], [10, 9], [11, 10]],
    eye: ["oooooo", "kkkkkk", "wkkwkk", "gkkkkg", "ggkkgg", ".dggd."],
    mouth: [[19, 14], [19, 15], [20, 13], [20, 16], [21, 12], [21, 17]] // philtrum + corners pulled down (frown)
  }
};

/** Map a work-state to one of the three faces. */
function faceFor(state: MascotState): Face {
  switch (state) {
    case "blocked": return FACES.error;
    case "thinking":
    case "working":
    case "sampling":
    case "verifying": return FACES.building;
    default: return FACES.idle; // ready, sleeping, success
  }
}

const RESET = "\x1b[0m";
const fg = (c: Rgb): string => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;

function stampSprite(g: string[][], r0: number, c0: number, sprite: string[]): void {
  sprite.forEach((row, dr) => {
    for (let dc = 0; dc < row.length; dc++) {
      const ch = row[dc];
      if (ch !== ".") g[r0 + dr][c0 + dc] = ch;
    }
  });
}

/** The cat's symbol grid for a work-state (pre-render): body + the state's stamped face. */
export function composeCat(state: MascotState): string[] {
  const face = faceFor(state);
  const g = CAT_BASE.map((r) => Array.from(r));
  for (const [r, c] of face.brows) { g[r][c] = "y"; g[r][WIDTH - 1 - c] = "y"; } // brows (mirrored)
  for (const c of EYE_COLS) stampSprite(g, EYE_ROW, c, face.eye);                  // eyes (both sockets)
  for (const [r, c] of face.mouth) g[r][c] = "y";                                  // mouth
  return g.map((r) => r.join(""));
}

/** Render one symbol row to a terminal string: runs of a color become "██" blocks; "." becomes spaces. */
export function renderCatRow(symbols: string): string {
  let out = "";
  let i = 0;
  while (i < symbols.length) {
    const ch = symbols[i];
    let j = i;
    while (j < symbols.length && symbols[j] === ch) j++;
    const n = j - i;
    const rgb = PALETTE[ch];
    out += rgb ? fg(rgb) + "██".repeat(n) + RESET : "  ".repeat(n);
    i = j;
  }
  return out;
}

/** Render a whole symbol grid to terminal rows (each logical pixel -> two colored columns). */
export function renderCatPixels(grid: string[]): string[] {
  return grid.map(renderCatRow);
}

/** The finished, colored cat for a work-state: the primary entry point used by the TUI component. */
export function cheaterCat(state: MascotState): string[] {
  return renderCatPixels(composeCat(state));
}

/** Dev/inspection helper: the colored cat for a state as one printable string. */
export function catPreview(state: MascotState = "ready"): string {
  return cheaterCat(state).join("\n");
}
