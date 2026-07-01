import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Commitlet, RollbackPoint } from "./types.js";

export function createRollbackPoint(repoRoot: string, commitlet: Commitlet): RollbackPoint {
  const id = `rollback-${commitlet.id}-${Date.now().toString(36)}`;
  const snapshotDir = join(repoRoot, ".cheater", "commitlets", "rollbacks", id);
  mkdirSync(snapshotDir, { recursive: true });
  for (const rel of commitlet.allowedFiles.filter((file) => !isVirtualPath(file))) {
    const src = join(repoRoot, rel);
    const dest = join(snapshotDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(src)) writeFileSync(dest, readFileSync(src), "utf8");
  }
  const rollback: RollbackPoint = {
    id,
    createdAt: new Date().toISOString(),
    snapshotDir,
    description: `Snapshot of allowed files before commitlet ${commitlet.id}.`
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
  for (const rel of commitlet.allowedFiles.filter((file) => !isVirtualPath(file))) {
    const snapshot = join(point.snapshotDir, rel);
    if (!existsSync(snapshot)) continue;
    const target = join(repoRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(snapshot, "utf8"), "utf8");
    restoredFiles.push(rel);
  }
  return {
    ok: true,
    restoredFiles,
    reason: restoredFiles.length ? `Restored ${restoredFiles.length} allowed file snapshot(s).` : "No snapshot files needed restoring."
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
