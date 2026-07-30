// Kitten Core — transactional undo via a pre-run git snapshot. NO Pi.
//
// Before a run mutates the working tree, we capture a commit-ish that holds the pre-run content of the
// project's tracked files INCLUDING the user's current dirty edits (`git stash create` — which records
// a stash commit WITHOUT touching the tree or index). Because `stash create` records only TRACKED
// content, we ALSO snapshot the pre-run untracked (non-generated) files' content, so an untracked file
// the run touches is restored — not mistaken for a run-created file and deleted. `/undo` then restores
// ONLY the files that run changed to that snapshot, and deletes files the run newly created. Every other
// change in the tree — crucially, the user's pre-existing dirty work in files the run didn't touch — is
// left exactly alone.
// This is lane-agnostic (it works the same for reliable/direct/bon/ascent) because it operates at the
// filesystem/git layer, not inside any engine. We never run a destructive whole-tree reset/checkout.
//
// When the project is not a git repository, undo is unavailable and says so honestly (Goal §10: "not a
// git repo is allowed but changes rollback capabilities").

import { spawnSync } from "node:child_process";
import { rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// `stash create` records only TRACKED content, so untracked files are absent from the snapshot ref.
// We separately capture the pre-run untracked (model-artifact) files' content, bounded per file, so
// /undo can restore them instead of deleting them as if the run had created them. Beyond this size a
// file's path is still recorded (so it is never deleted) but its content is not reverted.
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export interface RunSnapshot {
  /** true when the project is a git repo and a snapshot was captured. */
  git: boolean;
  /** commit-ish holding pre-run tracked content (a `stash create` sha, or HEAD when the tree was clean). */
  ref: string | null;
  /** Untracked (non-generated) files that EXISTED before the run — so /undo restores/keeps them instead
   *  of deleting them as run-created. Captured before the run mutates the tree, so run-created files are
   *  correctly absent. Optional for back-compat with snapshots persisted before this field existed. */
  preexisting?: string[];
  /** base64 pre-run content for the `preexisting` files small enough to snapshot (path → base64). */
  saved?: Record<string, string>;
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

// Generated/tooling artifacts that are NOT the model's work and must never appear in a diff or /undo:
// Kitten's own .cheater cache, VCS internals, dependency/build dirs, and compiled bytecode/caches.
const GENERATED_PATH = /(^|\/)(\.cheater|\.kitten|\.git|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.next|dist|build|out|coverage|target|\.venv|venv)(\/|$)/;
const GENERATED_FILE = /\.(pyc|pyo|class|o|obj)$|(^|\/)\.DS_Store$/;

function isModelArtifact(path: string): boolean {
  return !GENERATED_PATH.test(path) && !GENERATED_FILE.test(path);
}

/** Files that changed since `ref`: modified-tracked (`git diff`) ∪ new-untracked (`ls-files --others`),
 *  excluding generated/tooling artifacts. Derives the authoritative changed-file set for lanes (Ascent)
 *  that don't self-report files — so the diff view and /undo see the model's edits, not its side effects. */
export function changedFilesSince(cwd: string, ref: string): string[] {
  const modified = git(cwd, ["diff", "--name-only", ref]).out.split("\n").map((s) => s.trim()).filter(Boolean);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).out.split("\n").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...modified, ...untracked])].filter(isModelArtifact);
}

/** Capture a snapshot of the pre-run tracked state (with dirty edits). Cheap; never mutates the tree. */
export function captureSnapshot(cwd: string): RunSnapshot {
  if (!isGitRepo(cwd)) return { git: false, ref: null };
  const stash = git(cwd, ["stash", "create", "kitten pre-run snapshot"]);
  // Clean tree ⇒ `stash create` prints nothing; fall back to HEAD (tracked files' committed state).
  const ref = stash.ok && stash.out ? stash.out : (git(cwd, ["rev-parse", "HEAD"]).out || null);
  // Record the pre-run untracked files (excluding generated/tooling artifacts). `--exclude-standard`
  // keeps this fast (skips gitignored node_modules/dist/…) and matches changedFilesSince, so any
  // untracked file a lane can report as "changed" is captured here — and thus restored, never deleted.
  const preexisting: string[] = [];
  const saved: Record<string, string> = {};
  const others = git(cwd, ["ls-files", "--others", "--exclude-standard"]).out
    .split("\n").map((s) => s.trim()).filter(Boolean).filter(isModelArtifact);
  for (const f of others) {
    preexisting.push(f);
    try {
      const abs = resolve(cwd, f);
      if (statSync(abs).size <= MAX_SNAPSHOT_BYTES) saved[f] = readFileSync(abs).toString("base64");
    } catch { /* unreadable → still recorded in preexisting so /undo never deletes it */ }
  }
  return { git: true, ref, preexisting, saved };
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
    } else if (snap.saved && Object.prototype.hasOwnProperty.call(snap.saved, f)) {
      // Pre-existing untracked file the run modified/deleted → write back its captured pre-run content.
      try {
        const abs = resolve(cwd, f);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(snap.saved[f], "base64"));
        restored.push(f);
      } catch { skipped.push(f); }
    } else if (snap.preexisting?.includes(f)) {
      // Existed before the run but content wasn't snapshot (too large/unreadable) → never delete it.
      skipped.push(f);
    } else {
      // Truly absent before the run → the run created it → remove it.
      try { rmSync(resolve(cwd, f), { force: true }); deleted.push(f); } catch { skipped.push(f); }
    }
  }
  return { ok: restored.length > 0 || deleted.length > 0, restored, deleted, skipped };
}

export function captureSnapshotAfter(cwd: string): RunSnapshot {
  return captureSnapshot(cwd);
}

export function applySnapshot(cwd: string, snap: RunSnapshot, files: string[]): UndoResult {
  const restored: string[] = [], deleted: string[] = [], skipped: string[] = [];
  if (!snap.git) return { ok: false, restored, deleted, skipped: files, reason: "not a git repository — undo needs git" };
  if (!snap.ref) return { ok: false, restored, deleted, skipped: files, reason: "no snapshot was captured for this run" };
  for (const f of files) {
    const inRef = git(cwd, ["cat-file", "-e", `${snap.ref}:${f}`]).ok;
    if (inRef) {
      const r = git(cwd, ["checkout", snap.ref, "--", f]);
      (r.ok ? restored : skipped).push(f);
    } else if (snap.saved && Object.prototype.hasOwnProperty.call(snap.saved, f)) {
      try {
        const abs = resolve(cwd, f);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(snap.saved[f], "base64"));
        restored.push(f);
      } catch { skipped.push(f); }
    } else {
      try { rmSync(resolve(cwd, f), { force: true }); deleted.push(f); } catch { skipped.push(f); }
    }
  }
  return { ok: restored.length > 0 || deleted.length > 0, restored, deleted, skipped };
}

function currentMatchesSnapshot(cwd: string, snap: RunSnapshot, f: string): boolean {
  if (snap.ref) {
    const inRef = git(cwd, ["cat-file", "-e", `${snap.ref}:${f}`]).ok;
    if (inRef) return git(cwd, ["diff", "--quiet", snap.ref, "--", f]).ok;
  }
  if (snap.saved && Object.prototype.hasOwnProperty.call(snap.saved, f)) {
    try {
      const cur = readFileSync(resolve(cwd, f)).toString("base64");
      return cur === snap.saved[f];
    } catch { return false; }
  }
  try { statSync(resolve(cwd, f)); return false; } catch { return true; }
}

export function redoSnapshot(cwd: string, preSnap: RunSnapshot, postSnap: RunSnapshot, files: string[]): UndoResult {
  const restored: string[] = [], deleted: string[] = [], skipped: string[] = [];
  for (const f of files) {
    const matchesPre = currentMatchesSnapshot(cwd, preSnap, f);
    const matchesPost = currentMatchesSnapshot(cwd, postSnap, f);
    if (matchesPre && !matchesPost) {
      const r = applySnapshot(cwd, postSnap, [f]);
      (r.restored.length || r.deleted.length ? restored : skipped).push(f);
    } else if (matchesPost) {
      skipped.push(f);
    } else {
      return { ok: false, restored, deleted, skipped: [...skipped, f], reason: `file "${f}" has drifted — redo refused` };
    }
  }
  return { ok: restored.length > 0, restored, deleted, skipped };
}
