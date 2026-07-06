// "Sly" — cheater's terminal mascot. A clever cat whose EXPRESSION follows the WORK (routing,
// sampling, verifying, success, blocked) rather than the mouse: mouse-following is impossible in a
// pure terminal, and a mascot that reacts to what the harness is actually doing is both cuter and
// genuinely informative. This module is PURE string production - it never writes to any stream. The
// call sites decide whether to show it (mascotVisible) and which channel to use, so it can never
// corrupt `--print --mode json` output.
//
// Design goals: clean, lean, safe. One banner at startup; during a run the mascot rides the existing
// spinner/working-message as a one-line "<emoji> <word> · <message>" - no extra lines, no animation
// loop, expression changes are event-driven.

export type MascotState =
  | "ready"
  | "thinking"
  | "working"
  | "sampling"
  | "verifying"
  | "success"
  | "blocked"
  | "sleeping";

export type MascotStyle = "cat" | "ascii" | "off";

interface Frame {
  /** Pure-ASCII face line (the eyes/mouth carry the expression) - safe in every terminal. */
  face: string;
  /** Emoji shorthand for the one-line spinner form (modern terminals). */
  emoji: string;
  /** State word shown next to the mascot. */
  word: string;
}

// The eyes carry the emotion; kept pure-ASCII so alignment never breaks in a raw terminal.
const FRAMES: Record<MascotState, Frame> = {
  ready: { face: "( ^.^ )", emoji: "😺", word: "ready" },
  thinking: { face: "( o.- )", emoji: "😼", word: "thinking" },
  working: { face: "( >_< )", emoji: "🐈", word: "coding" },
  sampling: { face: "( o.o )", emoji: "🐈", word: "sampling" },
  verifying: { face: "( -.- )", emoji: "😾", word: "verifying" },
  success: { face: "( ^‿^ )", emoji: "😸", word: "done" },
  blocked: { face: "( ;_; )", emoji: "🙀", word: "stuck" },
  sleeping: { face: "( u.u )", emoji: "😴", word: "idle" }
};

const ASCII_MARK: Record<MascotState, string> = {
  ready: ":)",
  thinking: ";)",
  working: ">>",
  sampling: "::",
  verifying: "??",
  success: "^^",
  blocked: "!!",
  sleeping: "zZ"
};

/** The three-line cat face for a state (pure ASCII). Used in the startup banner and status cards. */
export function mascotFace(state: MascotState): string[] {
  const frame = FRAMES[state] ?? FRAMES.ready;
  return [" /\\_/\\", frame.face, " > ^ <"];
}

// Compact animated frames for the spinner position (replaces the braille spinner). The cat blinks /
// glances / dozes depending on the work; a single-frame array is a static pose (success/blocked).
// Kept short (~5 chars) so it sits neatly before the working message. `=` are the ears.
const SPINNER_FRAMES: Record<MascotState, string[]> = {
  ready: ["=^.^="],
  thinking: ["=o.o=", "=o.-="],
  working: ["=>.>=", "=<.<="],
  sampling: ["=o.o=", "=-.-=", "=o.o="],
  verifying: ["=·.·=", "=-.-="],
  success: ["=^.^="],
  blocked: ["=x.x="],
  sleeping: ["=-.-=", "=-.-z"]
};

const SPINNER_ASCII: Record<MascotState, string[]> = {
  ready: [":3"],
  thinking: [":3", ";3"],
  working: [">3", "<3"],
  sampling: [":3", ".3", ":3"],
  verifying: ["?3", ".3"],
  success: ["^3"],
  blocked: ["x3"],
  sleeping: ["-3", "z3"]
};

/** Animated spinner frames for a state (for ctx.ui.setWorkingIndicator). Rendered verbatim, so the
 *  caller adds color. `ascii` style uses a plainer glyph for terminals that render kaomoji poorly. */
export function mascotSpinnerFrames(state: MascotState, style: MascotStyle = "cat"): string[] {
  if (style === "off") return [];
  return (style === "ascii" ? SPINNER_ASCII : SPINNER_FRAMES)[state] ?? SPINNER_FRAMES.ready;
}

/**
 * One-line, spinner-friendly mascot: `😼 thinking · routing your goal`. In `ascii` style it uses a
 * pure-ASCII marker (`;) thinking · ...`) for terminals that render emoji poorly. `message` is the
 * live detail (already-truncated by the caller if needed).
 */
export function mascotLine(state: MascotState, message?: string, style: MascotStyle = "cat"): string {
  const frame = FRAMES[state] ?? FRAMES.ready;
  const head = style === "ascii" ? `${ASCII_MARK[state] ?? ":)"} ${frame.word}` : `${frame.emoji} ${frame.word}`;
  return message ? `${head} · ${message}` : head;
}

/**
 * The startup banner. Multi-line + boxed by default; a lean single line for narrow terminals or when
 * the caller wants minimal noise. Never printed in JSON/headless mode (the caller gates on
 * mascotVisible).
 */
export function mascotBanner(opts: { subtitle?: string; lean?: boolean; style?: MascotStyle } = {}): string {
  const subtitle = opts.subtitle ?? "reliable local coding, by any means";
  if (opts.lean) {
    const tag = opts.style === "ascii" ? ";)" : "😼";
    return `${tag} cheater — ${subtitle}`;
  }
  const tag = opts.style === "ascii" ? "" : " 😼";
  return [
    `   /\\_/\\    cheater${tag}`,
    `  ( o.o )   ${subtitle}`,
    "   > ^ <"
  ].join("\n");
}

/**
 * Whether the mascot may be shown. It is HIDDEN whenever output could be machine-read or the terminal
 * isn't interactive: JSON/headless mode, a non-TTY stream, NO_COLOR-style opt-outs handled by the
 * caller, or an explicit disable. This is the single guard that keeps the mascot from ever corrupting
 * `--print --mode json`.
 */
export function mascotVisible(opts: { isTTY?: boolean; jsonMode?: boolean; enabled?: boolean }): boolean {
  if (opts.enabled === false) return false;
  if (opts.jsonMode === true) return false;
  return opts.isTTY !== false;
}

/** Map a cheater flow phase/progress message to a mascot expression, so the face tracks what the
 *  harness is doing. Order matters: a terminal OUTCOME (passed/blocked) wins over the activity word
 *  it mentions (e.g. "blocked by guard" is blocked, not verifying). */
export function mascotStateForPhase(phase: string): MascotState {
  const p = phase.toLowerCase();
  if (/verified|passed|complete|done|finish.*allow|success/.test(p)) return "success";
  if (/block|fail|lock|revert|stuck|\berror\b/.test(p)) return "blocked";
  if (/sampl|best-of-n|resampl|candidate/.test(p)) return "sampling";
  if (/rout|plan|think|classif|decid/.test(p)) return "thinking";
  if (/verif|grade|guard|health|lint|typecheck|\bcheck|\btest/.test(p)) return "verifying";
  if (/idle|sleep|wait/.test(p)) return "sleeping";
  return "working";
}
