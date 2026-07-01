import type { MissionType, Playbook } from "./types.js";

const PLAYBOOKS: Record<string, Playbook> = {
  import_error: {
    name: "import_error",
    trigger: "ModuleNotFoundError, ImportError, cannot find module, unresolved import",
    steps: [
      "Inspect the failing import line and resolve target",
      "Read package.json / requirements.txt / pyproject.toml for the declared dependency",
      "Call cheater_orientation_show to confirm package manager and install command",
      "Search cheater_bug_memory_search for similar import failures",
      "Patch only the import path or missing dep declaration; do not invent new modules",
      "Run the focused test/import command to verify"
    ],
    allowedTools: ["read", "grep", "glob", "cheater_orientation_show", "cheater_bug_memory_search", "shell", "edit"],
    forbiddenActions: ["add new dependency without user confirmation", "edit lockfile unless required"],
    verification: ["focused test or import smoke", "diff_safety_check on the import change"],
    saveMemoryWhen: ["new package was missing or misnamed", "wrong module path that surprised the model"]
  },
  syntax_error: {
    name: "syntax_error",
    trigger: "SyntaxError, ParseError, unexpected token, invalid syntax",
    steps: [
      "Read the failing line and surrounding context",
      "Identify the smallest syntactic fix",
      "Patch and re-run the focused command"
    ],
    allowedTools: ["read", "edit", "shell", "cheater_focus_test"],
    forbiddenActions: ["refactor the file beyond the failing line", "rewrite the whole module"],
    verification: ["focused test/parse command"],
    saveMemoryWhen: ["common typo or bracket mismatch in this repo"]
  },
  test_assertion_error: {
    name: "test_assertion_error",
    trigger: "AssertionError, expected X to be Y, pytest FAILED, jest FAIL",
    steps: [
      "Re-run the failing test with the focused command",
      "Inspect the expected vs actual values",
      "Search cheater_bug_memory_search for the same symptom",
      "Patch the smallest source behavior to satisfy the assertion",
      "Re-run the focused test"
    ],
    allowedTools: ["read", "grep", "shell", "cheater_focus_test", "cheater_bug_memory_search", "edit"],
    forbiddenActions: ["edit the test to match the broken behavior", "disable or skip the test"],
    verification: ["focused test", "diff_safety_check on the changed file"],
    saveMemoryWhen: ["assertion exposed a subtle off-by-one or wrong-arity bug"]
  },
  type_error: {
    name: "type_error",
    trigger: "TypeError, TS error TSxxxx, property does not exist, not assignable",
    steps: [
      "Read the failing symbol and its type signature",
      "Confirm the runtime call matches the declared type",
      "Patch the smallest call site or narrowest type annotation",
      "Re-run focused test or tsc --noEmit"
    ],
    allowedTools: ["read", "grep", "shell", "cheater_focus_test", "edit"],
    forbiddenActions: ["broaden types with `any` to silence the error", "cast away the error without a reason"],
    verification: ["focused test or tsc --noEmit"],
    saveMemoryWhen: ["type narrowness surprised the model"]
  },
  lint_warning: {
    name: "lint_warning",
    trigger: "ESLint, flake8, ruff, pylint, unused variable, lint warning",
    steps: [
      "Run the linter scoped to the changed file",
      "Apply the minimal style fix",
      "Re-run the linter to confirm clean"
    ],
    allowedTools: ["read", "edit", "shell", "cheater_focus_test"],
    forbiddenActions: ["disable lint rules project-wide", "reformat unrelated files"],
    verification: ["linter clean on changed files"],
    saveMemoryWhen: []
  },
  dependency_version_error: {
    name: "dependency_version_error",
    trigger: "version conflict, requires X, peer dep, resolution failed",
    steps: [
      "Read the failing dependency manifest",
      "Compare the installed version to the required range",
      "Ask the user before editing the manifest",
      "Patch manifest, reinstall minimally, and re-run the focused test"
    ],
    allowedTools: ["read", "shell", "cheater_orientation_show", "cheater_focus_test"],
    forbiddenActions: ["edit lockfile without user confirmation", "force-install older versions without need"],
    verification: ["focused test after install"],
    saveMemoryWhen: ["peer dep mismatch that recurs"]
  },
  config_error: {
    name: "config_error",
    trigger: "config file parse error, missing env var, bad value",
    steps: [
      "Read the failing config file",
      "Identify the missing/typoed value",
      "Patch the config (do not introduce new config schema)",
      "Re-run the focused command"
    ],
    allowedTools: ["read", "edit", "shell", "cheater_focus_test"],
    forbiddenActions: ["change config schema", "add new env vars silently"],
    verification: ["focused command runs clean"],
    saveMemoryWhen: []
  },
  feature_addition: {
    name: "feature_addition",
    trigger: "implement, add, create, build, new feature, add support",
    steps: [
      "Confirm or derive the smallest acceptance criteria",
      "Inspect nearby patterns in the same area of the repo",
      "Implement the minimal slice (no premature abstractions)",
      "Update tests only if the user asked or the repo pattern requires it",
      "Run focused tests"
    ],
    allowedTools: ["read", "grep", "edit", "shell", "cheater_focus_test", "cheater_orientation_show"],
    forbiddenActions: ["refactor unrelated code", "add dependencies unless the user confirmed"],
    verification: ["focused test", "diff_safety_check on the new code"],
    saveMemoryWhen: ["acceptance criteria was ambiguous and needed clarification"]
  },
  refactor: {
    name: "refactor",
    trigger: "refactor, reorganize, restructure, simplify, rename, extract",
    steps: [
      "Write a short plan first: public API boundaries, intended invariants",
      "Do not change behavior",
      "Make the smallest safe change per step",
      "Run existing focused tests after each step"
    ],
    allowedTools: ["read", "grep", "edit", "shell", "cheater_focus_test", "cheater_diff_safety_check"],
    forbiddenActions: ["change behavior", "rename public APIs without confirmation", "broad reformatting"],
    verification: ["existing focused tests still pass", "diff_safety_check"],
    saveMemoryWhen: ["public API invariant worth recording"]
  },
  explanation_only: {
    name: "explanation_only",
    trigger: "explain, what does, how does, walk me through",
    steps: [
      "Read the smallest relevant code region",
      "Explain with file:line references",
      "Stop after the explanation"
    ],
    allowedTools: ["read", "grep"],
    forbiddenActions: ["edit any file", "run shell commands that change state"],
    verification: [],
    saveMemoryWhen: []
  },
  no_op: {
    name: "no_op",
    trigger: "command already passes; user may not need a change",
    steps: [
      "Report the passing run and the focused command used",
      "Ask the user if they still want a proactive change",
      "If no, mark mission no_change_needed"
    ],
    allowedTools: ["read", "shell", "cheater_focus_test"],
    forbiddenActions: ["patch without user confirmation"],
    verification: ["focused command exited 0"],
    saveMemoryWhen: ["command that often produces no-op in this repo"]
  }
};

export function playbookFor(missionType: MissionType, hasRepro: boolean): Playbook {
  if (missionType === "bug_fix" || missionType === "test_failure" || missionType === "unknown") {
    if (hasRepro) return PLAYBOOKS.test_assertion_error;
    return PLAYBOOKS.no_op;
  }
  if (missionType === "feature_addition") return PLAYBOOKS.feature_addition;
  if (missionType === "refactor") return PLAYBOOKS.refactor;
  if (missionType === "import_error") return PLAYBOOKS.import_error;
  if (missionType === "type_error") return PLAYBOOKS.type_error;
  if (missionType === "lint_warning") return PLAYBOOKS.lint_warning;
  if (missionType === "explanation_only") return PLAYBOOKS.explanation_only;
  if (missionType === "repo_orientation") return PLAYBOOKS.explanation_only;
  if (missionType === "benchmark_task") return PLAYBOOKS.feature_addition;
  return PLAYBOOKS.no_op;
}

export function allPlaybooks(): Playbook[] {
  return Object.values(PLAYBOOKS);
}

export function getPlaybook(name: string): Playbook | undefined {
  return PLAYBOOKS[name];
}
