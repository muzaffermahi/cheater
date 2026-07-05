import type { Commitlet, DiffGuardReport } from "./types.js";

export interface DiffInput {
  touchedFiles: string[];
  diffText?: string;
}

export interface DiffGuardOverrides {
  allowLargeDeletion?: boolean;
  /** Effective allow-set to enforce instead of commitlet.allowedFiles (the scaffold lane passes the
   *  plan-wide union so a from-scratch build may touch any planned file, not just the current phase's). */
  allowedScope?: string[];
}

/** A concrete scope is a real path/dir, not the "(select one target file...)" placeholder. */
export function isConcreteScope(file: string): boolean {
  return Boolean(file) && !file.startsWith("(");
}

/** True once the commitlet has at least one real target (not just a placeholder). */
export function hasResolvedScope(allowedFiles: string[]): boolean {
  return allowedFiles.some(isConcreteScope);
}

/** Whether a (forward-slash) file path falls under an allowed scope (exact file or `dir/`). */
export function fileMatchesScope(normalizedFile: string, scope: string): boolean {
  if (!isConcreteScope(scope)) return false;
  if (scope.endsWith("/")) {
    const dir = scope.replace(/\/+$/, "");
    return normalizedFile === dir || normalizedFile.startsWith(`${dir}/`) || normalizedFile.includes(`/${dir}/`);
  }
  return normalizedFile === scope || normalizedFile.endsWith(`/${scope}`);
}

export function runDiffGuard(commitlet: Commitlet, input: DiffInput, overrides: DiffGuardOverrides = {}): DiffGuardReport {
  const touchedFiles = [...new Set(input.touchedFiles)];
  const diffLines = countDiffLines(input.diffText);
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  // The scope enforced here is the effective allow-set: normally the commitlet's own files, but the
  // scaffold lane passes the plan-wide union so building any planned file is never "out of scope".
  const scope = overrides.allowedScope?.length ? overrides.allowedScope : commitlet.allowedFiles;
  const allowedList = scope.join(", ") || "(none)";
  // A commitlet whose allowedFiles are ONLY the "(select a target after inspection)" placeholder
  // has no resolved scope yet - it is self-localizing. Flagging its self-localized edit as
  // "outside allowedFiles" (combined with the tool_call scope guard blocking the edit outright)
  // is a hard deadlock for the common "fix this failing test" / generic-bug path, where the goal
  // terms don't lexically match a source symbol so file selection returns the placeholder. Once
  // any concrete target exists we enforce scope normally; maxFilesTouched still caps sprawl to
  // one file, and the dependency/test/generated-artifact rules below still apply.
  const outside = hasResolvedScope(scope)
    ? touchedFiles.filter((file) => !scope.some((entry) => fileMatchesScope(file.replace(/\\/g, "/"), entry)))
    : [];
  if (outside.length) blockingIssues.push(`Touched files outside allowedFiles: ${outside.join(", ")}. -> Edit only ${allowedList} for this commitlet; to change another file, finish this commitlet and call cheater_commitlet_next.`);
  const forbidden = touchedFiles.filter((file) => commitlet.forbiddenFiles.includes(file));
  if (forbidden.length) blockingIssues.push(`Touched forbidden files: ${forbidden.join(", ")}. -> Revert those files and keep the change inside ${allowedList}.`);
  if (touchedFiles.length > commitlet.maxFilesTouched) blockingIssues.push(`Touched ${touchedFiles.length} files, max is ${commitlet.maxFilesTouched}. -> Split this into one commitlet per file; revert all but one and call cheater_commitlet_next for the rest.`);
  // Creating a NEW file (a pure-addition diff) is expected to be large - the whole file is "added" -
  // so a from-scratch component/module should not be blocked by the edit-tuned maxDiffLines cap.
  const effectiveMaxDiff = isCreationDiff(input.diffText) ? Math.max(commitlet.maxDiffLines, 2000) : commitlet.maxDiffLines;
  if (diffLines > effectiveMaxDiff) blockingIssues.push(`Diff has ${diffLines} changed lines, max is ${effectiveMaxDiff}. -> Make a smaller, more focused change or split it across commitlets.`);
  if (touchedFiles.some(isDependencyFile) && !commitlet.healthBudget.allowDependencyEdits) blockingIssues.push("Dependency/manifest edit is not allowed for this commitlet. -> Revert the manifest change; if a dependency is truly required, tell the user and get explicit approval first.");
  if (touchedFiles.some(isLockfile) && !commitlet.healthBudget.allowLockfileEdits) blockingIssues.push("Lockfile edit is not allowed for this commitlet. -> Revert the lockfile; let the package manager regenerate it only after an approved dependency change.");
  if (touchedFiles.some(isTestFile) && !commitlet.healthBudget.allowTestEdits) blockingIssues.push("Test edit is not allowed for this commitlet. -> Revert the test change and fix the source instead; only edit tests when the task is explicitly about them.");
  if (touchedFiles.some(isGeneratedFile)) blockingIssues.push("Generated/compiled artifact was touched. -> Revert it and change the source that produces it instead.");
  const churn = formattingChurn(input.diffText ?? "");
  if (churn >= 40) {
    // A large formatting-only churn in a single file is usually a real refactor, not a
    // whole-repo reformat; demote it to a warning there and only hard-block multi-file churn.
    const msg = `Broad formatting-only churn detected across ${churn} changed lines. -> Keep whitespace/format changes out of a behavior commitlet.`;
    if (touchedFiles.length <= 1) warnings.push(msg);
    else blockingIssues.push(msg);
  }
  const deletion = largeDeletion(input.diffText ?? "");
  if (deletion && !overrides.allowLargeDeletion) blockingIssues.push(deletion);
  else if (deletion) warnings.push("Large deletion approved via approveLargeDeletion.");
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

/** A pure-addition diff = a newly-created file (or a clean append) - a big one is expected, not risky. */
export function isCreationDiff(diffText = ""): boolean {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (/^\+(?!\+\+)/.test(line)) added += 1;
    else if (/^-(?!--)/.test(line)) removed += 1;
  }
  return added > 0 && removed === 0;
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
    return `Large deletion requires explicit approval: removed ${removed} lines and added ${added}. -> If the deletion is intended, re-run cheater_commitlet_next with approveLargeDeletion=true; otherwise restore what should not be removed.`;
  }
  return undefined;
}

function editedFocusedVerificationTarget(commitlet: Commitlet, touchedFiles: string[]): string | undefined {
  if (commitlet.healthBudget.allowTestEdits) return undefined;
  const commands = commitlet.focusedVerification.map((step) => step.command ?? "").filter(Boolean);
  // Only TEST files named in the verification command are protected (the gate above is
  // allowTestEdits: the rule exists so the model cannot edit the test it is graded by).
  // A source file that appears in the command - e.g. verification is "node app.js" and the
  // commitlet's whole job is fixing app.js - must stay editable, otherwise every
  // repro-command commitlet false-blocks its own edit.
  const edited = touchedFiles.find((file) => isTestFile(file) && commands.some((command) => command.includes(file)));
  return edited ? `Focused verification target was edited without permission: ${edited}` : undefined;
}
