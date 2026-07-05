// The mascot WIRING layer: drives "Sly" through pi's ctx.ui. Everything here is a no-op in
// JSON/headless mode (pi's noOpUIContext makes every ui.* method a no-op), so the mascot can NEVER
// corrupt `--print --mode json` output - no mode/hasUI guard is needed. Every call is wrapped so the
// mascot can never break a run. Keeping all ctx-touching code in this one file keeps mascot.ts pure
// (string-only) and testable.

import { mascotSpinnerFrames, type MascotState, type MascotStyle } from "./mascot.js";
import type { CheaterConfig } from "../types.js";

type UILike = {
  setWorkingIndicator?: (options?: { frames?: string[]; intervalMs?: number }) => void;
  setWorkingMessage?: (message?: string) => void;
  theme?: { fg?: (color: string, text: string) => string };
} | undefined;
type CtxLike = { ui?: UILike } | undefined;

// Set once at session start so callbacks (worker progress/heartbeat) that lack a config handle still
// respect mascotEnabled/mascotStyle without threading config through every signature.
let sessionConfig: CheaterConfig | undefined;
export function configureMascot(config?: CheaterConfig): void {
  sessionConfig = config;
}

function effectiveConfig(config?: CheaterConfig): CheaterConfig | undefined {
  return config ?? sessionConfig;
}

function mascotOff(config?: CheaterConfig): boolean {
  return config?.mascotEnabled === false || config?.mascotStyle === "off";
}

function mascotStyle(config?: CheaterConfig): MascotStyle {
  return (config?.mascotStyle as MascotStyle) ?? "cat";
}

// Theme color per mood, so the cat's eyes go green on success, red when stuck, accent while thinking.
function colorFor(state: MascotState): string {
  if (state === "success") return "success";
  if (state === "blocked") return "error";
  if (state === "verifying") return "warning";
  if (state === "thinking" || state === "sampling") return "accent";
  return "muted";
}

/**
 * Set the mascot's expression to `state` via the working spinner (an animated cat face) and,
 * optionally, the working message. The cat's EXPRESSION follows the WORK - thinking, sampling,
 * verifying, done, stuck. Safe in every mode; never throws.
 */
export function setMascot(ctx: CtxLike, state: MascotState, message?: string, config?: CheaterConfig): void {
  const cfg = effectiveConfig(config);
  if (mascotOff(cfg)) {
    if (message !== undefined) {
      try { ctx?.ui?.setWorkingMessage?.(message); } catch { /* best-effort */ }
    }
    return;
  }
  try {
    const frames = mascotSpinnerFrames(state, mascotStyle(cfg));
    const fg = ctx?.ui?.theme?.fg;
    const painted = fg ? frames.map((frame) => fg(colorFor(state), frame)) : frames;
    ctx?.ui?.setWorkingIndicator?.({ frames: painted, intervalMs: 480 });
    if (message !== undefined) ctx?.ui?.setWorkingMessage?.(message);
  } catch {
    /* the mascot must never break a run */
  }
}

/** Reset the spinner to pi's default braille (call when the mascot's animated work is done). */
export function clearMascot(ctx: CtxLike): void {
  try { ctx?.ui?.setWorkingIndicator?.(); } catch { /* best-effort */ }
}
