// ControlledExec: bash is not a string runner, it is a dangerous state-mutation interface.
//
// Pi owns raw shell execution; Cheater owns the policy around it. Before a command runs it
// is classified (test/install/dev server/git-destructive/shell-edit/...), checked against
// phase, protections, and scope, given an output budget, and assigned an id. After it runs,
// output is capped before it can enter any capsule or report. All pure and deterministic -
// this is hidden policy machinery behind hooks, never a model-facing tool.

import type { PostSuccessGuard } from "./postSuccessGuard.js";
import type { RunPhase } from "./phaseController.js";

export type CommandKind =
  | "read_only"
  | "test"
  | "build"
  | "lint_typecheck"
  | "dev_server"
  | "install"
  | "git_destructive"
  | "git_status"
  | "artifact_generation"
  | "shell_edit"
  | "unknown_shell";

const READ_ONLY_RE = /^\s*(ls|dir|cat|head|tail|pwd|which|where|type|stat|wc|du|df|env|echo\s+[^>]*$|grep|rg|find|git\s+(log|diff|show|blame))\b/;
const TEST_RE = /\b(pytest|jest|vitest|mocha|node\s+--test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|go\s+test|cargo\s+test|dotnet\s+test|phpunit|rspec)\b/;
const BUILD_RE = /\b(npm\s+run\s+build|yarn\s+build|pnpm\s+build|cargo\s+build|go\s+build|make(\s+[\w-]+)?$|tsc\s+-b|webpack|vite\s+build|dotnet\s+build|mvn\s+package|gradle\s+build)\b/;
const LINT_RE = /\b(eslint|ruff|flake8|pylint|mypy|tsc(\s+--noEmit)?$|cargo\s+(check|clippy)|go\s+vet|prettier\s+--check|black\s+--check)\b/;
const DEV_SERVER_RE = /\b(npm\s+(run\s+)?(dev|start|serve)|yarn\s+(dev|start)|pnpm\s+(dev|start)|vite(\s+dev)?$|next\s+dev|flask\s+run|uvicorn|gunicorn|python3?\s+-m\s+http\.server|rails\s+s(erver)?|node\s+server|serve\b|--watch\b|tail\s+-f)\b/;
const INSTALL_RE = /\b(npm\s+(install|ci|add|i)\b|yarn\s+(add|install)|pnpm\s+(add|install|i)\b|pip3?\s+install|uv\s+(pip\s+)?add|poetry\s+add|cargo\s+add|go\s+get|apt(-get)?\s+install|brew\s+install|gem\s+install|composer\s+require)\b/;
const GIT_DESTRUCTIVE_RE = /\bgit\s+(reset\s+--hard|checkout\s+(--|\.)|clean\s+-[dfx]+|stash\b(?!\s+(list|show))|push\s+--force|rebase|rm\b)/;
const GIT_STATUS_RE = /\bgit\s+(status|branch|remote|rev-parse|ls-files)\b/;
const ARTIFACT_GEN_RE = /\b(generate|regenerate|scaffold|init(?:ialize)?)\b.*>|\bpython3?\s+[\w./-]*generat[\w./-]*\.py\b/i;

// Shell-based file edits: legitimate sometimes, invisible to structured-edit tracking always.
const SHELL_EDIT_PATTERNS: Array<{ re: RegExp; pathGroup: number }> = [
  { re: /\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*(?:\s+-e)?\s+)(?:'[^']*'|"[^"]*"|\S+)\s+([\w./\\-]+)/, pathGroup: 1 },
  { re: /\bperl\s+-[a-zA-Z]*p?i[a-zA-Z]*e?\s+(?:'[^']*'|"[^"]*")\s+([\w./\\-]+)/, pathGroup: 1 },
  { re: /(?:^|[^>])>>?\s*([\w./\\-]+\.[A-Za-z0-9]{1,6})\b/, pathGroup: 1 },
  { re: /\bSet-Content\b[^|;]*?(?:-Path\s+)?["']?([\w./\\-]+)["']?/i, pathGroup: 1 },
  { re: /\bOut-File\b[^|;]*?(?:-FilePath\s+)?["']?([\w./\\-]+)["']?/i, pathGroup: 1 },
  { re: /\btee\s+(?:-a\s+)?([\w./\\-]+)/, pathGroup: 1 },
  { re: /\bgit\s+apply\b/, pathGroup: -1 },
  { re: /\bapply_patch\b/, pathGroup: -1 }
];

export function shellEditTargets(command: string): string[] {
  const cmd = (command ?? "").trim();
  if (!cmd) return [];
  const targets = new Set<string>();
  for (const pattern of SHELL_EDIT_PATTERNS) {
    const match = cmd.match(pattern.re);
    if (!match) continue;
    if (pattern.pathGroup < 0) targets.add("(patch: targets unknown)");
    else if (match[pattern.pathGroup]) targets.add(match[pattern.pathGroup].replace(/\\/g, "/"));
  }
  // /dev/null redirection is not an edit.
  targets.delete("/dev/null");
  return [...targets];
}

export function classifyCommand(command: string): CommandKind {
  const cmd = (command ?? "").trim();
  if (!cmd) return "unknown_shell";
  if (GIT_DESTRUCTIVE_RE.test(cmd)) return "git_destructive";
  if (GIT_STATUS_RE.test(cmd)) return "git_status";
  if (INSTALL_RE.test(cmd)) return "install";
  if (TEST_RE.test(cmd)) return "test";
  if (LINT_RE.test(cmd)) return "lint_typecheck";
  if (BUILD_RE.test(cmd)) return "build";
  if (DEV_SERVER_RE.test(cmd)) return "dev_server";
  if (shellEditTargets(cmd).length) return "shell_edit";
  if (ARTIFACT_GEN_RE.test(cmd)) return "artifact_generation";
  if (READ_ONLY_RE.test(cmd)) return "read_only";
  return "unknown_shell";
}

export function isLongRunning(command: string): boolean {
  return classifyCommand(command) === "dev_server" || /--watch\b|tail\s+-f|\bsleep\s+\d{3,}/.test(command ?? "");
}

export interface ExecPolicy {
  commandId: string;
  kind: CommandKind;
  verdict: "allow" | "warn" | "block";
  message?: string;
  longRunning: boolean;
  outputBudgetChars: number;
}

let commandSeq = 0;

export interface ExecPolicyInput {
  command: string;
  phase: RunPhase;
  guard?: PostSuccessGuard;
  /** Commitlet scope, when one is running. Shell edits outside it are blocked. */
  allowedFiles?: string[];
}

/** Pre-command policy: classify, then compose guard/phase/scope verdicts. Pure. */
export function preExecPolicy(input: ExecPolicyInput): ExecPolicy {
  const kind = classifyCommand(input.command);
  const longRunning = isLongRunning(input.command);
  const base: ExecPolicy = {
    commandId: `cmd-${(++commandSeq).toString(36)}`,
    kind,
    verdict: "allow",
    longRunning,
    outputBudgetChars: kind === "test" || kind === "build" ? 2000 : 1200
  };

  // Protected artifacts outrank everything.
  if (input.guard) {
    const guardVerdict = input.guard.assessCommand(input.command);
    if (guardVerdict.verdict === "block") return { ...base, verdict: "block", message: guardVerdict.message };
    if (guardVerdict.verdict === "warn") { base.verdict = "warn"; base.message = guardVerdict.message; }
  }

  // Reserve phase: block only genuinely destructive git. Dependency installs are LEGITIMATE build
  // actions - a from-scratch app cannot run without its node_modules - so they warn, never block.
  // Hard-blocking `npm install` in RESERVE was a top "the build never finishes" cause.
  if (input.phase === "reserve" && kind === "git_destructive") {
    return { ...base, verdict: "block", message: "RESERVE phase: destructive git operations are blocked; preserve the current result and run final cheap checks only." };
  }
  if (input.phase === "reserve" && kind === "install" && base.verdict === "allow") {
    base.verdict = "warn";
    base.message = "RESERVE phase: late-stage dependency install - proceeding (a build may legitimately need it), but avoid churning dependencies now.";
  }
  if (input.phase === "reserve" && kind === "artifact_generation") {
    return { ...base, verdict: "warn", message: "RESERVE phase: regenerating artifacts now risks overwriting acceptable output." };
  }

  // Shell edits: invisible to structured tracking; out-of-scope ones are blocked.
  const editTargets = shellEditTargets(input.command);
  if (editTargets.length && input.allowedFiles?.length) {
    const allowed = new Set(input.allowedFiles.map((file) => file.replace(/\\/g, "/")));
    const outside = editTargets.filter((target) => !target.startsWith("(") && !allowed.has(target) && ![...allowed].some((file) => target.endsWith(`/${file}`)));
    if (outside.length) {
      return { ...base, verdict: "block", message: `Shell edit targets ${outside[0]} outside the allowed files (${[...allowed].join(", ")}). Use the edit tools on allowed files only.` };
    }
  }
  if (editTargets.length && base.verdict === "allow") {
    base.verdict = "warn";
    base.message = `Shell-based edit detected (${editTargets.join(", ")}). Prefer the structured edit tools; this change is recorded in the mutation ledger.`;
  }

  if (longRunning && base.verdict === "allow") {
    base.verdict = "warn";
    base.message = "Likely long-running/blocking command (dev server or watcher). Make sure it is backgrounded or bounded, and track it for shutdown.";
  }
  return base;
}

/** Cap command output before it can enter any report/capsule: head + tail, never the middle. */
export function summarizeCommandOutput(command: string, stdout: string, stderr: string, cap = 1200): string {
  const merged = [stdout ?? "", stderr ?? ""].filter(Boolean).join("\n").trim();
  if (!merged) return `(no output) ${command}`.slice(0, cap);
  if (merged.length <= cap) return merged;
  const head = merged.slice(0, Math.floor(cap * 0.6));
  const tail = merged.slice(-Math.floor(cap * 0.3));
  return `${head}\n... [${merged.length - head.length - tail.length} chars omitted] ...\n${tail}`;
}
