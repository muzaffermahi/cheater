import type { Commitlet, DiffGuardReport } from "./types.js";

export interface DiffInput {
  touchedFiles: string[];
  diffText?: string;
}

export function runDiffGuard(commitlet: Commitlet, input: DiffInput): DiffGuardReport {
  const allowed = new Set(commitlet.allowedFiles);
  const touchedFiles = [...new Set(input.touchedFiles)];
  const diffLines = countDiffLines(input.diffText);
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const outside = touchedFiles.filter((file) => !allowed.has(file));
  if (outside.length) blockingIssues.push(`Touched files outside allowedFiles: ${outside.join(", ")}`);
  const forbidden = touchedFiles.filter((file) => commitlet.forbiddenFiles.includes(file));
  if (forbidden.length) blockingIssues.push(`Touched forbidden files: ${forbidden.join(", ")}`);
  if (touchedFiles.length > commitlet.maxFilesTouched) blockingIssues.push(`Touched ${touchedFiles.length} files, max is ${commitlet.maxFilesTouched}`);
  if (diffLines > commitlet.maxDiffLines) blockingIssues.push(`Diff has ${diffLines} changed lines, max is ${commitlet.maxDiffLines}`);
  if (touchedFiles.some(isDependencyFile) && !commitlet.healthBudget.allowDependencyEdits) blockingIssues.push("Dependency/manifest edit is not allowed for this commitlet.");
  if (touchedFiles.some(isLockfile) && !commitlet.healthBudget.allowLockfileEdits) blockingIssues.push("Lockfile edit is not allowed for this commitlet.");
  if (touchedFiles.some(isTestFile) && !commitlet.healthBudget.allowTestEdits) blockingIssues.push("Test edit is not allowed for this commitlet.");
  if (touchedFiles.some(isGeneratedFile)) blockingIssues.push("Generated/compiled artifact was touched.");
  const churn = formattingChurn(input.diffText ?? "");
  if (churn >= 40) blockingIssues.push(`Broad formatting-only churn detected across ${churn} changed lines.`);
  const deletion = largeDeletion(input.diffText ?? "");
  if (deletion) blockingIssues.push(deletion);
  const editedVerification = editedFocusedVerificationTarget(commitlet, touchedFiles);
  if (editedVerification) blockingIssues.push(editedVerification);
  return {
    passed: blockingIssues.length === 0,
    touchedFiles,
    diffLines,
    blockingIssues,
    warnings
  };
}

export function countDiffLines(diffText = ""): number {
  return diffText.split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !/^\+\+\+|---/.test(line)).length;
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file);
}

function isDependencyFile(file: string): boolean {
  return /(^|\/)(package\.json|pyproject\.toml|requirements.*\.txt|Pipfile|Cargo\.toml)$/i.test(file);
}

function isLockfile(file: string): boolean {
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock)$/i.test(file);
}

function isGeneratedFile(file: string): boolean {
  return /(^|\/)(dist|build|coverage|__pycache__)(\/|$)|\.(pyc|min\.js|map)$/i.test(file);
}

function formattingChurn(diffText: string): number {
  const removed = normalizedChangedLines(diffText, "-");
  const added = normalizedChangedLines(diffText, "+");
  const addedCounts = new Map<string, number>();
  for (const line of added) addedCounts.set(line, (addedCounts.get(line) ?? 0) + 1);
  let matched = 0;
  for (const line of removed) {
    const count = addedCounts.get(line) ?? 0;
    if (count <= 0) continue;
    matched += 1;
    addedCounts.set(line, count - 1);
  }
  return matched * 2;
}

function normalizedChangedLines(diffText: string, prefix: "+" | "-"): string[] {
  return diffText.split(/\r?\n/)
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .map((line) => line.slice(1).replace(/\s+/g, ""))
    .filter(Boolean);
}

function largeDeletion(diffText: string): string | undefined {
  const removed = normalizedChangedLines(diffText, "-").length;
  const added = normalizedChangedLines(diffText, "+").length;
  if (removed >= 50 && added < Math.ceil(removed / 3)) {
    return `Large deletion requires explicit approval: removed ${removed} lines and added ${added}.`;
  }
  return undefined;
}

function editedFocusedVerificationTarget(commitlet: Commitlet, touchedFiles: string[]): string | undefined {
  if (commitlet.healthBudget.allowTestEdits) return undefined;
  const commands = commitlet.focusedVerification.map((step) => step.command ?? "").filter(Boolean);
  const edited = touchedFiles.find((file) => commands.some((command) => command.includes(file)));
  return edited ? `Focused verification target was edited without permission: ${edited}` : undefined;
}
