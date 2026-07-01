import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Commitlet, RollbackPoint } from "./types.js";

export function createRollbackPoint(repoRoot: string, commitlet: Commitlet): RollbackPoint {
  const id = `rollback-${commitlet.id}-${Date.now().toString(36)}`;
  const snapshotDir = join(repoRoot, ".cheater", "commitlets", "rollbacks", id);
  mkdirSync(snapshotDir, { recursive: true });
  const existedFiles: string[] = [];
  for (const rel of commitlet.allowedFiles.filter((file) => !isVirtualPath(file))) {
    const src = join(repoRoot, rel);
    const dest = join(snapshotDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // Copy raw bytes (no "utf8"), so binaries are snapshotted without corruption.
    if (existsSync(src)) {
      writeFileSync(dest, readFileSync(src));
      existedFiles.push(rel);
    }
  }
  const rollback: RollbackPoint = {
    id,
    createdAt: new Date().toISOString(),
    snapshotDir,
    description: `Snapshot of allowed files before commitlet ${commitlet.id}.`,
    // Files that existed at snapshot time; anything else in allowedFiles that exists on revert
    // was created during the commitlet and must be removed to truly restore the prior state.
    existedFiles
  };
  writeFileSync(join(snapshotDir, "rollback.json"), JSON.stringify(rollback, null, 2), "utf8");
  return rollback;
}

export function rollbackAvailable(point?: RollbackPoint): boolean {
  return Boolean(point?.snapshotDir && existsSync(point.snapshotDir));
}

export function revertRollbackPoint(repoRoot: string, commitlet: Commitlet): { ok: boolean; restoredFiles: string[]; reason: string } {
  const point = commitlet.rollbackPoint;
  if (!point?.snapshotDir || !existsSync(point.snapshotDir)) {
    return { ok: false, restoredFiles: [], reason: "Rollback snapshot is missing." };
  }
  const restoredFiles: string[] = [];
  const removedFiles: string[] = [];
  const existed = point.existedFiles ? new Set(point.existedFiles) : undefined;
  for (const rel of commitlet.allowedFiles.filter((file) => !isVirtualPath(file))) {
    const snapshot = join(point.snapshotDir, rel);
    const target = join(repoRoot, rel);
    if (existsSync(snapshot)) {
      mkdirSync(dirname(target), { recursive: true });
      // Restore raw bytes (no "utf8"), so binaries are restored intact.
      writeFileSync(target, readFileSync(snapshot));
      restoredFiles.push(rel);
    } else if (existed && !existed.has(rel) && existsSync(target)) {
      // Created during the commitlet (no snapshot, not pre-existing): delete to restore state.
      rmSync(target, { force: true });
      removedFiles.push(rel);
    }
  }
  const parts = [
    restoredFiles.length ? `restored ${restoredFiles.length}` : "",
    removedFiles.length ? `removed ${removedFiles.length} created file(s)` : ""
  ].filter(Boolean);
  return {
    ok: true,
    restoredFiles: [...restoredFiles, ...removedFiles.map((f) => `${f} (removed)`)],
    reason: parts.length ? `Rollback: ${parts.join(", ")}.` : "No snapshot files needed restoring."
  };
}

export function listRollbackSnapshotFiles(point?: RollbackPoint): string[] {
  if (!point?.snapshotDir || !existsSync(point.snapshotDir)) return [];
  return walk(point.snapshotDir)
    .filter((file) => !file.endsWith("rollback.json"))
    .map((file) => file.slice(point.snapshotDir!.length + 1).replace(/\\/g, "/"));
}

export function cleanupOldRollbackSnapshots(repoRoot: string, keepLatest = 20): { removed: string[]; kept: string[] } {
  const root = join(repoRoot, ".cheater", "commitlets", "rollbacks");
  if (!existsSync(root)) return { removed: [], kept: [] };
  const entries = readdirSync(root)
    .map((name) => ({ name, path: join(root, name), mtimeMs: statSync(join(root, name)).mtimeMs }))
    .filter((entry) => statSync(entry.path).isDirectory())
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept = entries.slice(0, keepLatest).map((entry) => entry.name);
  const removed: string[] = [];
  for (const entry of entries.slice(keepLatest)) {
    rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed, kept };
}

function isVirtualPath(path: string): boolean {
  return path.endsWith("/") || path.startsWith("(");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
