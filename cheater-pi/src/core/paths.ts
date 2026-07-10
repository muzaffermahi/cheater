// Kitten Core — canonical local data paths. NO Pi.
//
// The future canonical home is `~/.kitten` (Goal §10), overridable with KITTEN_HOME (tests point it at
// a temp dir). Conversations live in ONE user-level store spanning projects, so the picker and
// `kitten resume` work across a whole machine; each conversation records its own project identity.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** The Kitten home directory (created if missing). */
export function kittenHome(): string {
  const dir = process.env.KITTEN_HOME || join(homedir(), ".kitten");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to the durable conversation store. */
export function storePath(): string {
  return join(kittenHome(), "kitten.db");
}
