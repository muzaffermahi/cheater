// Kitten Core — transactional undo via a pre-run git snapshot. NO Pi.
//
// Before a run mutates the working tree, we capture a commit-ish that holds the pre-run content of the
// project's tracked files INCLUDING the user's current dirty edits (`git stash create` — which records
// a stash commit WITHOUT touching the tree or index). `/undo` then restores ONLY the files that run
// changed to that snapshot, and deletes files the run newly created. Every other change in the tree —
// crucially, the user's pre-existing dirty work in files the run didn't touch — is left exactly alone.
// This is lane-agnostic (it works the same for reliable/direct/bon/ascent) because it operates at the
// filesystem/git layer, not inside any engine. We never run a destructive whole-tree reset/checkout.
//
// When the project is not a git repository, undo is unavailable and says so honestly (Goal §10: "not a
// git repo is allowed but changes rollback capabilities").

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

export interface RunSnapshot {
  /** true when the project is a git repo and a snapshot was captured. */
  git: boolean;
  /** commit-ish holding pre-run tracked content (a `stash create` sha, or HEAD when the tree was clean). */
  ref: string | null;
}

export interface UndoResult {
  ok: boolean;
  restored: string[];
  deleted: string[];
  skipped: string[];
  reason?: string;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (r.error) return { ok: false, out: "" };
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
  } catch {
    // e.g. cwd does not exist, or git is not installed.
    return { ok: false, out: "" };
  }
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

/** Files that changed since `ref`: modified-tracked (`git diff`) ∪ new-untracked (`ls-files --others`).
 *  Used to derive the authoritative changed-file set for lanes (Ascent) that don't self-report files. */
export function changedFilesSince(cwd: string, ref: string): string[] {
  const modified = git(cwd, ["diff", "--name-only", ref]).out.split("\n").map((s) => s.trim()).filter(Boolean);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).out.split("\n").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...modified, ...untracked])];
}

/** Capture a snapshot of the pre-run tracked state (with dirty edits). Cheap; never mutates the tree. */
export function captureSnapshot(cwd: string): RunSnapshot {
  if (!isGitRepo(cwd)) return { git: false, ref: null };
  const stash = git(cwd, ["stash", "create", "kitten pre-run snapshot"]);
  if (stash.ok && stash.out) return { git: true, ref: stash.out };
  // Clean tree ⇒ `stash create` prints nothing; fall back to HEAD (tracked files' committed state).
  const head = git(cwd, ["rev-parse", "HEAD"]);
  return { git: true, ref: head.ok ? head.out : null };
}

/**
 * Restore `files` to their state in `snap`, deleting any that did not exist then. Touches only `files`.
 */
export function restoreSnapshot(cwd: string, snap: RunSnapshot, files: string[]): UndoResult {
  const restored: string[] = [], deleted: string[] = [], skipped: string[] = [];
  if (!snap.git) return { ok: false, restored, deleted, skipped: files, reason: "not a git repository — undo needs git" };
  if (!snap.ref) return { ok: false, restored, deleted, skipped: files, reason: "no snapshot was captured for this run" };
  for (const f of files) {
    const inRef = git(cwd, ["cat-file", "-e", `${snap.ref}:${f}`]).ok;
    if (inRef) {
      const r = git(cwd, ["checkout", snap.ref, "--", f]);
      (r.ok ? restored : skipped).push(f);
    } else {
      // The run created this file (absent from the snapshot) → remove it.
      try { rmSync(resolve(cwd, f), { force: true }); deleted.push(f); } catch { skipped.push(f); }
    }
  }
  return { ok: restored.length > 0 || deleted.length > 0, restored, deleted, skipped };
}
