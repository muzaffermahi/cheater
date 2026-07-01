import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_DIFF_LINES = 1500;

export function diffFileContents(file: string, before: string | null, after: string | null): string {
  if (before === after) return "";
  if (before === null) return unifiedHeader(file) + splitLines(after ?? "").map((line) => `+${line}`).join("\n") + "\n";
  if (after === null) return unifiedHeader(file) + splitLines(before).map((line) => `-${line}`).join("\n") + "\n";
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return unifiedHeader(file) + a.map((line) => `-${line}`).join("\n") + "\n" + b.map((line) => `+${line}`).join("\n") + "\n";
  }
  return unifiedHeader(file) + lineDiff(a, b).join("\n") + "\n";
}

/**
 * Computes touched files + a compact unified-style diff for a commitlet by comparing its
 * rollback snapshot (before) with the repo's current content (after). Snapshots only cover
 * `commitlet.allowedFiles`, so callers must union in any harness-observed edits to catch
 * out-of-scope changes (createRollbackPoint only copies allowedFiles).
 */
export function buildCommitletDiff(repoRoot: string, files: string[], snapshotDir: string | undefined): { diffText: string; touchedFiles: string[] } {
  const touchedFiles: string[] = [];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    if (!rel || rel.startsWith("(") || rel.endsWith("/") || seen.has(rel)) continue;
    seen.add(rel);
    const currentPath = join(repoRoot, rel);
    const current = existsSync(currentPath) ? readFileSync(currentPath, "utf8") : null;
    const snapshotPath = snapshotDir ? join(snapshotDir, rel) : undefined;
    const before = snapshotPath && existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : null;
    if (before === current) continue;
    touchedFiles.push(rel);
    const part = diffFileContents(rel, before, current);
    if (part) parts.push(part);
  }
  return { diffText: parts.join("\n"), touchedFiles };
}

function unifiedHeader(file: string): string {
  return `--- a/${file}\n+++ b/${file}\n`;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    out.push(`-${a[i]}`);
    i += 1;
  }
  while (j < m) {
    out.push(`+${b[j]}`);
    j += 1;
  }
  return out;
}
