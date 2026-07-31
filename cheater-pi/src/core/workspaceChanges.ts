import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export interface WorkspaceChangeFile {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface WorkspaceChanges {
  root: string;
  isGit: boolean;
  branch: string | null;
  files: WorkspaceChangeFile[];
  diff: string;
  untrackedPreviews: Array<{ path: string; content: string }>;
  truncated: boolean;
  generatedAt: number;
  note?: string;
}

const DEFAULT_MAX_BYTES = 240_000;
const DEFAULT_MAX_FILES = 80;

/**
 * Read-only, bounded change inspection for the native app. Git is invoked without a shell and
 * untracked files are previewed directly so the user can review all pending work in one place.
 */
export function inspectWorkspaceChanges(root: string, options: { maxBytes?: number; maxFiles?: number } = {}): WorkspaceChanges {
  const resolved = resolve(root);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error("workspace root must be an existing directory");
  const maxBytes = Math.max(8_000, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 2_000_000));
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, 500));
  const generatedAt = Date.now();
  const git = runGit(resolved, ["rev-parse", "--is-inside-work-tree"]);
  if (git.status !== 0 || git.stdout.trim() !== "true") {
    return { root: resolved, isGit: false, branch: null, files: [], diff: "", untrackedPreviews: [], truncated: false, generatedAt, note: "This workspace is not a Git repository." };
  }
  const branchResult = runGit(resolved, ["branch", "--show-current"]);
  const statusResult = runGit(resolved, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const files = parseStatus(statusResult.stdout).filter((file) => !isGeneratedChangePath(file.path)).slice(0, maxFiles);
  let used = 0;
  let truncated = false;
  const diffResult = runGit(resolved, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--"], maxBytes);
  let diff = diffResult.stdout;
  if (diffResult.status !== 0) diff = runGit(resolved, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--"], maxBytes).stdout;
  if (diff.length > maxBytes) { diff = diff.slice(0, maxBytes); truncated = true; }
  used += diff.length;
  const untrackedPreviews: Array<{ path: string; content: string }> = [];
  for (const file of files.filter((f) => f.untracked)) {
    if (used >= maxBytes || untrackedPreviews.length >= 20) { truncated = true; break; }
    const abs = resolve(resolved, file.path);
    const rel = relative(resolved, abs);
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(abs)) continue;
    try {
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > 100_000) continue;
      const remaining = Math.max(0, maxBytes - used);
      const content = readFileSync(abs, "utf8").slice(0, Math.min(remaining, 24_000));
      untrackedPreviews.push({ path: file.path, content });
      used += content.length;
      if (content.length < stat.size) truncated = true;
    } catch { /* best effort: status and tracked diff remain useful */ }
  }
  return { root: resolved, isGit: true, branch: branchResult.status === 0 ? (branchResult.stdout.trim() || null) : null, files, diff, untrackedPreviews, truncated, generatedAt };
}

function runGit(cwd: string, args: string[], maxBuffer = DEFAULT_MAX_BYTES): { status: number | null; stdout: string } {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: Math.max(maxBuffer, 32_000) });
    return { status: result.status, stdout: result.stdout ?? "" };
  } catch { return { status: null, stdout: "" }; }
}

/**
 * Kitten's own state and the language toolchains' caches are not the user's changes. Listing
 * `.cheater/` (Kitten's private cache) and `__pycache__/` next to a real edit makes the review panel
 * look like the agent touched things it never touched.
 */
const GENERATED_PATHS = /(?:^|\/)(?:\.cheater|\.kitten|__pycache__|node_modules|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|dist|build|target|\.next|\.turbo|coverage|\.gradle|\.idea|\.vs)(?:\/|$)/i;

export function isGeneratedChangePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return GENERATED_PATHS.test(normalized) || /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/i.test(normalized) || /\.(?:pyc|pyo|log|tmp)$/i.test(normalized);
}

function parseStatus(text: string): WorkspaceChangeFile[] {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const xy = line.slice(0, 2);
    const rawPath = line.slice(3).trim().replace(/^"|"$/g, "");
    const path = rawPath.includes(" -> ") ? rawPath.slice(rawPath.lastIndexOf(" -> ") + 4) : rawPath;
    return { path: path.replaceAll("\\", "/"), status: xy.trim() || "?", staged: xy[0] !== " " && xy[0] !== "?", unstaged: xy[1] !== " " && xy[1] !== "?", untracked: xy === "??" };
  });
}
