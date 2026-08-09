// `kitten run`'s command line, as a pure function.
//
// It lives here rather than in kitten.ts because that module runs main() on import — so anything
// that wants to check the flag surface has to spawn a process, and in practice nothing ever did.
// A flag can therefore be advertised in the help text and parsed into nothing without a single
// test noticing, which is exactly how a benchmark harness came to set a deadline the engine had
// stopped reading.

import { resolve } from "node:path";
import type { Lane } from "./events.js";

export function isLane(s: string | undefined): s is Lane {
  return s === "answer" || s === "direct" || s === "reliable" || s === "bon" || s === "ascent";
}

export interface RunFlags {
  cwd: string;
  model?: string;
  lane?: Lane;
  k?: number;
  effort?: string;
  json: boolean;
  dangerous: boolean;
  continueId?: string;
  /** 0 = no deadline, which is the default: Kitten has no automatic wall clock. */
  deadlineMs: number;
  task: string;
}

/** Parse the flags. Anything unrecognised is task text, so a bare `kitten run "…"` still works. */
export function parseRunFlags(rest: string[], baseCwd: string = process.cwd()): RunFlags {
  let cwd = baseCwd;
  let model: string | undefined;
  let lane: Lane | undefined;
  let k: number | undefined;
  let effort: string | undefined;
  let json = false;
  let dangerous = false;
  let continueId: string | undefined;
  let deadlineMs = 0;
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--cwd") cwd = resolve(rest[++i] ?? ".");
    else if (a === "--model") model = rest[++i];
    else if (a === "--lane") { const l = rest[++i]; if (isLane(l)) lane = l; }
    else if (a === "--k") k = Math.max(1, Number(rest[++i]) || 1);
    else if (a === "--effort") effort = rest[++i];
    else if (a === "--json") json = true;
    else if (a === "--dangerous" || a === "--yes") dangerous = true;
    else if (a === "--conversation" || a === "-c") continueId = rest[++i];
    // A malformed or non-positive value must DISARM the deadline, never arm a zero-length one: a
    // 0 ms deadline would cancel every run before it started and score a whole sweep zero.
    else if (a === "--deadline-ms") deadlineMs = Math.max(0, Number(rest[++i]) || 0);
    else words.push(a);
  }
  return { cwd, model, lane, k, effort, json, dangerous, continueId, deadlineMs, task: words.join(" ").trim() };
}
