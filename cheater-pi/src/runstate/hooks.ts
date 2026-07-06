// Pre/post tool lifecycle hooks: do not prompt the model to be careful - enforce care.
//
// preToolUse runs before a tool executes and can block (guard, reserve phase, out-of-scope
// shell edit, unread-file overwrite) or warn (long-running command, shell edit in scope,
// large rewrite). postToolUse runs after and folds the result into durable state: mutations
// (which stale dependent validations), commands, and check outcomes as typed validation
// evidence. The extension's tool_call/tool_result handlers are thin adapters over this
// pipeline; every decision here is deterministic and testable without Pi.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskRunState } from "./runState.js";
import { classifyCommand, preExecPolicy, summarizeCommandOutput } from "./controlledExec.js";
import type { CheaterConfig } from "../types.js";

export type HookDecision =
  | { action: "allow" }
  | { action: "block"; reason: string; hook: string }
  | { action: "warn"; message: string; hook: string };

const EDIT_TOOLS = new Set(["edit", "write", "cheater_line_edit"]);
const COMMAND_TOOLS = new Set(["bash", "run_command", "run", "shell"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface PreToolInput {
  toolName: string;
  toolCallId: string;
  cwd: string;
  path?: string;
  command?: string;
  /** Content length for write-tool calls, when available (large-write hook). */
  contentChars?: number;
  /** The running commitlet's allowed files, when one is active. */
  commitletAllowedFiles?: string[];
}

export const LARGE_WRITE_WARN_CHARS = 6000;

/**
 * All pre-execution hooks, in blocking-first order. Also notes the action against the phase
 * budget and counts blocks into run telemetry.
 */
export function preToolUse(event: PreToolInput, run: TaskRunState, config: CheaterConfig = {}): HookDecision[] {
  const decisions: HookDecision[] = [];
  const stateChanging = EDIT_TOOLS.has(event.toolName) || COMMAND_TOOLS.has(event.toolName);

  // ControlledExec policy: guard + reserve + shell-edit scope + long-running, composed.
  if (event.command && COMMAND_TOOLS.has(event.toolName)) {
    const policy = preExecPolicy({
      command: event.command,
      phase: run.currentPhase(),
      guard: run.guard,
      allowedFiles: event.commitletAllowedFiles
    });
    if (policy.verdict === "block") {
      run.bumpTelemetry(policy.kind === "git_destructive" || /protected/i.test(policy.message ?? "") ? "guardBlocks" : "reserveBlocks");
      run.bumpTelemetry("blockedToolCalls");
      decisions.push({ action: "block", reason: policy.message ?? "blocked by exec policy", hook: "controlled_exec" });
      return decisions;
    }
    if (policy.verdict === "warn" && policy.message) {
      decisions.push({ action: "warn", message: policy.message, hook: "controlled_exec" });
    }
  }

  // Phase hook for non-command state changes (edits); command phase policy lives above.
  const phaseVerdict = run.noteAction(stateChanging ? "state_changing" : "read", event.command || event.path || event.toolName);
  if (phaseVerdict.verdict === "block") {
    run.bumpTelemetry("reserveBlocks");
    run.bumpTelemetry("blockedToolCalls");
    decisions.push({ action: "block", reason: phaseVerdict.message ?? "blocked by phase controller", hook: "phase" });
    return decisions;
  }
  if (phaseVerdict.verdict === "warn" && phaseVerdict.message) {
    decisions.push({ action: "warn", message: phaseVerdict.message, hook: "phase" });
  }

  // Protected-artifact hook for direct file mutations.
  if (EDIT_TOOLS.has(event.toolName) && event.path) {
    const guardVerdict = run.guard.assessFileMutation(event.path);
    if (guardVerdict.verdict === "warn" && guardVerdict.message) {
      decisions.push({ action: "warn", message: guardVerdict.message, hook: "protected_artifact" });
    }
  }

  // Read-before-write: overwriting an existing file the run never read (and that is not a
  // contract-expected artifact) is how full-file rewrites destroy code the model never saw.
  if (event.toolName === "write" && event.path) {
    const abs = resolve(event.cwd, event.path);
    const isContractArtifact = run.contract.outputPaths.some((p) => event.path!.replace(/\\/g, "/").endsWith(p))
      || run.contract.files.some((p) => event.path!.replace(/\\/g, "/").endsWith(p));
    if (existsSync(abs) && !run.wasRead(event.path) && !run.wasMutated(event.path) && !isContractArtifact) {
      run.bumpTelemetry("blockedToolCalls");
      decisions.push({
        action: "block",
        reason: `Read-before-write: ${event.path} exists but was never read in this run (and is not a contract artifact). Read it (or use a targeted edit) before overwriting it.`,
        hook: "read_before_write"
      });
      return decisions;
    }
  }

  // Large-write hook: full-file rewrites over the threshold need verification right after.
  if (event.toolName === "write" && event.path && (event.contentChars ?? 0) > (config.largeWriteWarnChars ?? LARGE_WRITE_WARN_CHARS)) {
    const abs = resolve(event.cwd, event.path);
    if (existsSync(abs)) {
      decisions.push({
        action: "warn",
        message: `Large rewrite of an existing file (${event.contentChars} chars). Run focused verification immediately after this write.`,
        hook: "large_write"
      });
    }
  }

  return decisions.length ? decisions : [{ action: "allow" }];
}

export interface PostToolInput {
  toolName: string;
  toolCallId: string;
  cwd: string;
  path?: string;
  command?: string;
  isError: boolean;
  outputText?: string;
}

export interface HookFeedback {
  /** Short in-band notices for the tool's own result. */
  notices: string[];
}

/** Post-execution: fold the completed action into durable state, then assess risk once. */
export function postToolUse(event: PostToolInput, run: TaskRunState): HookFeedback {
  const notices: string[] = [];

  if (READ_TOOLS.has(event.toolName) && event.path) {
    run.noteFileRead(event.path);
  }

  if (EDIT_TOOLS.has(event.toolName) && !event.isError && event.path) {
    run.recordFileMutation(event.path, event.toolName === "write" ? "file_created" : "file_modified", "main-session", event.toolName);
  }

  if (COMMAND_TOOLS.has(event.toolName) && event.command) {
    run.recordCommand(event.command, "main-session");
    const kind = classifyCommand(event.command);
    // A check command's outcome IS validation evidence - typed, capped, whole-workspace
    // scoped so any later mutation stales it. Only checks count; ls/cat/git status do not.
    if (kind === "test" || kind === "lint_typecheck" || kind === "build") {
      run.recordValidation({
        name: `${kind}:${event.command.slice(0, 60)}`,
        command: event.command,
        actor: "main-session",
        validates: [],
        status: event.isError ? "fail" : "pass",
        outputSummary: summarizeCommandOutput(event.command, event.outputText ?? "", "", 300)
      });
    }
  }

  if (COMMAND_TOOLS.has(event.toolName) || EDIT_TOOLS.has(event.toolName)) {
    const hints = run.riskHints({
      toolName: event.toolName,
      command: event.command || undefined,
      files: event.path ? [event.path] : []
    });
    notices.push(...hints);
  }

  return { notices };
}

/** Loop/non-progress bridge: loop-governor verdicts become durable run risk events. */
export function bridgeLoopEvents(run: TaskRunState, events: Array<{ message: string; terminal?: boolean }>): void {
  for (const event of events) {
    run.recordRiskEvent(event.terminal ? "loop_terminal" : "loop_warning", event.message);
  }
}
