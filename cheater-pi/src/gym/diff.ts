import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GymTask } from "./types.js";

export interface DiffSummary {
  filesTouched: string[];
  diffLineCount: number;
  editedTests: boolean;
  editedDependencies: boolean;
  editedForbidden: string[];
  touchedExpected: string[];
}

const TEST_PATH_RE = /(^|[\\/])(tests?|__tests__|spec)([\\/]|$)/i;
const TEST_FILES = new Set(["conftest.py", "conftest.js", "conftest.ts"]);
const DEPENDENCY_FILES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "pyproject.toml", "requirements.txt", "requirements-dev.txt",
  "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock"
]);

function isTestFile(rel: string): boolean {
  if (TEST_PATH_RE.test(rel)) return true;
  const base = rel.split(/[\\/]/).pop() ?? rel;
  return TEST_FILES.has(base);
}

function isDependencyFile(rel: string): boolean {
  const base = rel.split(/[\\/]/).pop() ?? rel;
  return DEPENDENCY_FILES.has(base);
}

function normalize(rel: string): string {
  return rel.split(/[\\/]/).join("/");
}

export function diffWorkspace(baselineDir: string, afterDir: string, task: GymTask): DiffSummary {
  const baseline = readSnapshot(baselineDir);
  const after = readSnapshot(afterDir);
  const allFiles = new Set<string>([...baseline.keys(), ...after.keys()]);
  const expected = new Set(task.expectedTouchedFiles.map(normalize));
  const forbidden = new Set(task.forbiddenTouchedFiles.map(normalize));

  const filesTouched: string[] = [];
  const editedTests: string[] = [];
  const editedDependencies: string[] = [];
  const editedForbidden: string[] = [];
  const touchedExpected: string[] = [];
  let diffLineCount = 0;

  for (const rel of allFiles) {
    const norm = normalize(rel);
    const before = baseline.get(rel);
    const current = after.get(rel);
    if (before === current) continue;
    if (before === undefined && current !== undefined) {
      filesTouched.push(norm);
      diffLineCount += countNewLines(current ?? "");
      if (isTestFile(norm)) editedTests.push(norm);
      if (isDependencyFile(norm)) editedDependencies.push(norm);
      if (forbidden.has(norm)) editedForbidden.push(norm);
      if (expected.has(norm)) touchedExpected.push(norm);
      continue;
    }
    if (current === undefined) {
      filesTouched.push(norm);
      diffLineCount += countNewLines(before ?? "");
      continue;
    }
    const beforeLines = (before ?? "").split(/\r?\n/);
    const afterLines = current.split(/\r?\n/);
    diffLineCount += simpleLineDiff(beforeLines, afterLines);
    filesTouched.push(norm);
    if (isTestFile(norm)) editedTests.push(norm);
    if (isDependencyFile(norm)) editedDependencies.push(norm);
    if (forbidden.has(norm)) editedForbidden.push(norm);
    if (expected.has(norm)) touchedExpected.push(norm);
  }

  return {
    filesTouched: dedupe(filesTouched),
    diffLineCount,
    editedTests: editedTests.length > 0,
    editedDependencies: editedDependencies.length > 0,
    editedForbidden: dedupe(editedForbidden),
    touchedExpected: dedupe(touchedExpected)
  };
}

function readSnapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  const stack = [dir];
  const root = dir;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const stat = statSync(full);
          if (stat.size > 1_500_000) continue;
          const text = readFileSync(full, "utf8");
          const rel = full.startsWith(root) ? full.slice(root.length).replace(/^[\\/]/, "") : full;
          map.set(rel, text);
        } catch {
          // ignore unreadable
        }
      }
    }
  }
  return map;
}

function simpleLineDiff(before: string[], after: string[]): number {
  const set = new Set(before);
  let added = 0;
  for (const line of after) if (!set.has(line)) added += 1;
  return added;
}

function countNewLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
