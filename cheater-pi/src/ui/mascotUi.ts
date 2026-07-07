// The mascot WIRING layer: drives "Sly" through the host agent's ctx.ui. Everything here is a no-op in
// JSON/headless mode (the host's no-op UI context makes every ui.* method a no-op), so the mascot can
// NEVER corrupt `--print --mode json` output - no mode/hasUI guard is needed. Every call is wrapped so the
// mascot can never break a run. Keeping all ctx-touching code in this one file keeps mascot.ts pure
// (string-only) and testable.

import type { MascotState, MascotStyle } from "./mascot.js";
import type { CheaterConfig } from "../types.js";

type UILike = {
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

// The mascot's current mood, updated as the work progresses. The pixel-art mascot component
// (mascotComponent.ts) reads this and re-renders when it changes, so its face follows the work.
let currentState: MascotState = "ready";
export function getMascotState(): MascotState {
  return currentState;
}

function effectiveConfig(config?: CheaterConfig): CheaterConfig | undefined {
  return config ?? sessionConfig;
}

export function mascotOff(config?: CheaterConfig): boolean {
  const cfg = effectiveConfig(config);
  return cfg?.mascotEnabled === false || cfg?.mascotStyle === "off";
}

export function mascotStyle(config?: CheaterConfig): MascotStyle {
  return (effectiveConfig(config)?.mascotStyle as MascotStyle) ?? "cat";
}

/**
 * Point the mascot at `state` (the big animated component picks it up) and, optionally, set the
 * working message. The cat's EXPRESSION follows the WORK - thinking, sampling, verifying, done,
 * stuck. The animation itself lives in the big component; this just records the mood + message.
 * Safe in every mode; never throws.
 */
export function setMascot(ctx: CtxLike, state: MascotState, message?: string, config?: CheaterConfig): void {
  currentState = state;
  if (message !== undefined) {
    try { ctx?.ui?.setWorkingMessage?.(message); } catch { /* the mascot must never break a run */ }
  }
}
