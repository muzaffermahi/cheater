// Durable run directory: the "context reincarnation" root.
//
// Every reliability run gets .cheater/runs/<taskId>/ holding the controller file, the
// acceptance contract, the workspace digest, both ledgers, per-worker plans/capsules/reports,
// and an append-only event log. A controller (or a human) can be killed and respawned and
// reconstruct the whole plot from these files alone - no chat scrollback required. Small
// local models need state truth on disk, not a long conversation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RunEvent {
  at: string;
  kind: string;
  [key: string]: unknown;
}

const RUN_SUBDIRS = ["workers", "reports", "capsules", "guards"];

export function runsRoot(repoRoot: string): string {
  return join(repoRoot, ".cheater", "runs");
}

export function runDirFor(repoRoot: string, taskId: string): string {
  return join(runsRoot(repoRoot), sanitizeTaskId(taskId));
}

export function mintTaskId(prefix = "run"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Task ids become directory names; strip anything that is not path-safe. */
export function sanitizeTaskId(taskId: string): string {
  const safe = (taskId ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return safe || "run";
}

/** Create the run directory tree. Idempotent. Returns the run dir path. */
export function ensureRunDir(repoRoot: string, taskId: string): string {
  const dir = runDirFor(repoRoot, taskId);
  mkdirSync(dir, { recursive: true });
  for (const sub of RUN_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

export function writeRunFile(runDir: string, relPath: string, content: string): string {
  const file = join(runDir, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

export function readRunFile(runDir: string, relPath: string): string | null {
  const file = join(runDir, relPath);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Append one structured event to events.jsonl. Best-effort; never throws into the run. */
export function appendRunEvent(runDir: string, kind: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(runDir, { recursive: true });
    const event: RunEvent = { at: new Date().toISOString(), kind, ...data };
    appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the run.
  }
}

export function readRunEvents(runDir: string): RunEvent[] {
  const raw = readRunFile(runDir, "events.jsonl");
  if (!raw) return [];
  const events: RunEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // skip corrupt lines
    }
  }
  return events;
}

export function listRuns(repoRoot: string): string[] {
  const root = runsRoot(repoRoot);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
