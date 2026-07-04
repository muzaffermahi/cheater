// Prompt capsule: the complete, minimal context for one spawned worker.
//
// The core harness principle: no worker ever inherits the controller's chat, system prompt,
// or terminal scrollback. A capsule is built field-by-field from durable state (contract,
// digest, ledger summaries, prior report digests) plus the one job's own scope, and the
// worker prompt is rendered FROM the capsule - so what the worker sees is exactly what the
// capsule records, and both are persisted to the run directory. By construction there is no
// field for a transcript or a raw log; bloat cannot leak in through a parameter that does
// not exist. Target size 1-4K tokens; anything above 8K is flagged, because the target
// models often have 64K total and a worker that starts fat has no room to work.

import type { RunPhase } from "./phaseController.js";
import { writeRunFile } from "./runDir.js";

export interface FileBrief {
  path: string;
  reason: string;
  /** Small code excerpt (already sliced/bounded upstream); never a whole large file. */
  snippet?: string;
}

export interface PromptCapsule {
  capsuleId: string;
  taskId: string;
  workerRole: string;
  workerGoal: string;
  nonGoals: string[];
  /** Compact contract + acceptance lines - the literal terms of done. */
  acceptanceContract: string[];
  /**
   * Repair workers: the compressed failure card (plus any harness-retrieved cheat sheet)
   * this worker exists to fix. A typed field, not appended prose - the single most
   * important input a repair worker has.
   */
  observedFailure?: string;
  /** Resample-attempt steering ("smallest fix" / "root cause" / "clean rewrite"). */
  attemptStance?: string;
  /** Model-class operating rules (small/medium/large) - how THIS model should work. */
  operatingRules?: string[];
  /** World-state delta since the previous worker - "what changed", never the whole past. */
  worldDiff?: string[];
  relevantFiles: FileBrief[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  repoFacts: string[];
  constraints: string[];
  riskWarnings: string[];
  validationPlan: string[];
  /** The current workspace digest, bounded - state truth, not scrollback. */
  workspaceDigest: string;
  mutationSummary: string[];
  priorWorkerReports: string[];
  /** What the WorkerReport must contain. */
  outputInstructions: string[];
  phaseLines: string[];
  rulePack: string[];
  tokenBudgetHint: number;
  /** Audit trail: the typed context fragments that entered this capsule. */
  fragments?: Array<{ id: string; kind: string; chars: number; freshness: string }>;
}

export interface CapsuleSizeReport {
  capsuleId: string;
  workerRole: string;
  estimatedTokens: number;
  fileCount: number;
  snippetChars: number;
  priorReportCount: number;
  ruleCount: number;
  fragmentCount: number;
  digestIncluded: boolean;
  /** Always false by construction; recorded so the metric proves it. */
  fullLogsIncluded: boolean;
  warning?: string;
}

export const CAPSULE_TARGET_TOKENS = 4000;
export const CAPSULE_WARN_TOKENS = 8000;

// Lean mode (Track 3 - prefill reduction): cap the growing/fixed fields harder so each worker prompt
// is smaller, cutting the main model's per-commitlet prefill (the "main works too hard" bottleneck).
// Set per-run from config (leanWorkerPromptEnabled); OFF = the exact caps below, byte-identical. No
// field is DROPPED - only capped tighter - so nothing load-bearing (contract, failure, scope) is lost.
let leanMode = false;
export function setLeanCapsule(enabled: boolean): void { leanMode = enabled; }
export function leanCapsuleEnabled(): boolean { return leanMode; }

const DEFAULT_OUTPUT_INSTRUCTIONS = [
  "files changed (exact paths)",
  "commands run and their outcomes",
  "validation results (which check, pass/fail, fresh or not)",
  "remaining risks or problems",
  "exact next action you recommend",
  "whether the acceptance contract appears satisfied (yes/no/unknown)"
];

function clampList(items: string[] | undefined, maxItems: number, maxChars: number): string[] {
  return (items ?? [])
    .map((item) => (item ?? "").trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => (item.length <= maxChars ? item : item.slice(0, maxChars - 3) + "..."));
}

function clampText(text: string | undefined, maxChars: number): string {
  const value = (text ?? "").trim();
  return value.length <= maxChars ? value : value.slice(0, maxChars - 12) + "\n[clipped]";
}

export interface BuildCapsuleInput {
  taskId: string;
  workerRole: string;
  workerGoal: string;
  nonGoals?: string[];
  acceptanceContract?: string[];
  observedFailure?: string;
  attemptStance?: string;
  operatingRules?: string[];
  worldDiff?: string[];
  relevantFiles?: FileBrief[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  repoFacts?: string[];
  constraints?: string[];
  riskWarnings?: string[];
  validationPlan?: string[];
  workspaceDigest?: string;
  mutationSummary?: string[];
  priorWorkerReports?: string[];
  outputInstructions?: string[];
  phaseLines?: string[];
  rulePack?: string[];
  tokenBudgetHint?: number;
  fragments?: Array<{ id: string; kind: string; chars: number; freshness: string }>;
}

/**
 * Assemble a capsule with every field bounded. This is the ONLY path to a worker prompt;
 * there is deliberately no parameter for a transcript, a system prompt, or raw logs.
 */
export function buildPromptCapsule(input: BuildCapsuleInput): PromptCapsule {
  return {
    capsuleId: `${input.workerRole}-${Date.now().toString(36)}`,
    taskId: input.taskId,
    workerRole: input.workerRole,
    workerGoal: clampText(input.workerGoal, 500),
    nonGoals: clampList(input.nonGoals, 5, 120),
    acceptanceContract: clampList(input.acceptanceContract, 10, 160),
    // 2600 chars: enough for a compressed failure card plus a <=1.3KB cheat sheet. Learned
    // live: clipping this to 1400 chopped the evidence out of repair packets.
    observedFailure: input.observedFailure?.trim() ? clampText(input.observedFailure, 2600) : undefined,
    attemptStance: input.attemptStance?.trim() ? clampText(input.attemptStance, 300) : undefined,
    operatingRules: input.operatingRules?.length ? clampList(input.operatingRules, leanMode ? 4 : 6, 160) : undefined,
    worldDiff: input.worldDiff?.length ? clampList(input.worldDiff, leanMode ? 5 : 8, 160) : undefined,
    relevantFiles: (input.relevantFiles ?? []).slice(0, leanMode ? 4 : 6).map((file) => ({
      path: file.path,
      reason: clampText(file.reason, 100),
      snippet: file.snippet ? clampText(file.snippet, leanMode ? 1100 : 1600) : undefined
    })),
    allowedFiles: clampList(input.allowedFiles, 8, 200),
    forbiddenFiles: clampList(input.forbiddenFiles, 8, 200),
    repoFacts: clampList(input.repoFacts, 8, 160),
    constraints: clampList(input.constraints, 8, 160),
    riskWarnings: clampList(input.riskWarnings, 4, 200),
    validationPlan: clampList(input.validationPlan, 5, 160),
    workspaceDigest: clampText(input.workspaceDigest, leanMode ? 900 : 1500),
    mutationSummary: clampList(input.mutationSummary, leanMode ? 4 : 6, 160),
    priorWorkerReports: clampList(input.priorWorkerReports, leanMode ? 2 : 3, 240),
    outputInstructions: clampList(input.outputInstructions ?? DEFAULT_OUTPUT_INSTRUCTIONS, 8, 120),
    phaseLines: clampList(input.phaseLines, 4, 160),
    rulePack: clampList(input.rulePack, leanMode ? 7 : 12, 140),
    tokenBudgetHint: input.tokenBudgetHint ?? CAPSULE_TARGET_TOKENS,
    fragments: input.fragments?.slice(0, 20)
  };
}

/** Render the worker prompt FROM the capsule - the capsule is the whole context. */
export function renderCapsulePrompt(capsule: PromptCapsule): string {
  const lines: string[] = [];
  lines.push(`You are a focused ${capsule.workerRole} worker for Cheater.`);
  lines.push("Your only job:");
  lines.push(capsule.workerGoal);
  lines.push("");
  if (leanMode) {
    lines.push("Stay strictly in scope: only the listed files, no unrelated fixes, no broad rewrites or refactors.");
  } else {
    lines.push("Do not solve unrelated problems.");
    lines.push("Do not inspect the whole repo unless a listed file requires it.");
    lines.push("Do not refactor outside allowed files.");
    lines.push("Do not perform broad rewrites.");
  }
  if (capsule.nonGoals.length) {
    lines.push("Non-goals:");
    for (const nonGoal of capsule.nonGoals) lines.push(`- ${nonGoal}`);
  }
  if (capsule.acceptanceContract.length) {
    lines.push("");
    lines.push("Acceptance contract (literal - do not rename or approximate):");
    for (const term of capsule.acceptanceContract) lines.push(`- ${term}`);
  }
  if (capsule.observedFailure) {
    lines.push("");
    lines.push("Observed failure (fix exactly this):");
    lines.push(capsule.observedFailure);
  }
  if (capsule.attemptStance) {
    lines.push("");
    lines.push(capsule.attemptStance);
  }
  if (capsule.allowedFiles.length) {
    lines.push("");
    lines.push(`Files you may touch: ${capsule.allowedFiles.join(", ")}`);
  }
  if (capsule.forbiddenFiles.length) lines.push(`Files you must not touch: ${capsule.forbiddenFiles.join(", ")}`);
  if (capsule.relevantFiles.length) {
    lines.push("");
    lines.push("Files to inspect:");
    for (const file of capsule.relevantFiles) {
      lines.push(`- ${file.path}: ${file.reason}`);
      if (file.snippet) {
        lines.push("```");
        lines.push(file.snippet);
        lines.push("```");
      }
    }
  }
  if (capsule.repoFacts.length) {
    lines.push("");
    lines.push("Repo facts:");
    for (const fact of capsule.repoFacts) lines.push(`- ${fact}`);
  }
  if (capsule.constraints.length) {
    lines.push("");
    lines.push("Known constraints:");
    for (const constraint of capsule.constraints) lines.push(`- ${constraint}`);
  }
  if (capsule.phaseLines.length) {
    lines.push("");
    lines.push(...capsule.phaseLines);
  }
  if (capsule.riskWarnings.length) {
    lines.push("");
    lines.push("Risks:");
    for (const risk of capsule.riskWarnings) lines.push(`- ${risk}`);
  }
  if (capsule.workspaceDigest) {
    lines.push("");
    lines.push("Workspace digest (current state truth):");
    lines.push(capsule.workspaceDigest);
  }
  if (capsule.mutationSummary.length) {
    lines.push("");
    lines.push("Changes so far:");
    for (const mutation of capsule.mutationSummary) lines.push(`- ${mutation}`);
  }
  if (capsule.worldDiff?.length) {
    lines.push("");
    lines.push("Since the last worker:");
    for (const line of capsule.worldDiff) lines.push(`- ${line}`);
  }
  if (capsule.priorWorkerReports.length) {
    lines.push("");
    lines.push("Prior worker reports (compact):");
    for (const report of capsule.priorWorkerReports) lines.push(`- ${report}`);
  }
  if (capsule.operatingRules?.length) {
    lines.push("");
    lines.push("Operating rules for this model class:");
    for (const rule of capsule.operatingRules) lines.push(`- ${rule}`);
  }
  if (capsule.rulePack.length) {
    lines.push("");
    lines.push("Rules for this task family:");
    for (const rule of capsule.rulePack) lines.push(`- ${rule}`);
  }
  if (capsule.validationPlan.length) {
    lines.push("");
    lines.push("Validation:");
    for (const step of capsule.validationPlan) lines.push(`- ${step}`);
  }
  lines.push("");
  lines.push("When done, write a WorkerReport with:");
  for (const instruction of capsule.outputInstructions) lines.push(`- ${instruction}`);
  lines.push("");
  lines.push("Stop when your narrow goal is done or blocked. Do not continue into a new concern - report it instead.");
  return lines.join("\n");
}

/** chars/4 estimate over the rendered prompt - cheap, deterministic, good enough to police bloat. */
export function estimateCapsuleTokens(capsule: PromptCapsule): number {
  return Math.ceil(renderCapsulePrompt(capsule).length / 4);
}

export function capsuleSizeReport(capsule: PromptCapsule): CapsuleSizeReport {
  const estimatedTokens = estimateCapsuleTokens(capsule);
  const snippetChars = capsule.relevantFiles.reduce((sum, file) => sum + (file.snippet?.length ?? 0), 0);
  return {
    capsuleId: capsule.capsuleId,
    workerRole: capsule.workerRole,
    estimatedTokens,
    fileCount: capsule.relevantFiles.length,
    snippetChars,
    priorReportCount: capsule.priorWorkerReports.length,
    ruleCount: capsule.rulePack.length,
    fragmentCount: capsule.fragments?.length ?? 0,
    digestIncluded: capsule.workspaceDigest.length > 0,
    fullLogsIncluded: false,
    warning:
      estimatedTokens > CAPSULE_WARN_TOKENS
        ? `capsule is ~${estimatedTokens} tokens - above the ${CAPSULE_WARN_TOKENS} hard warning; trim snippets/files`
        : estimatedTokens > CAPSULE_TARGET_TOKENS
          ? `capsule is ~${estimatedTokens} tokens - above the ${CAPSULE_TARGET_TOKENS} target`
          : undefined
  };
}

export function saveCapsule(runDir: string, capsule: PromptCapsule): string {
  return writeRunFile(runDir, `capsules/${capsule.workerRole}-capsule.json`, JSON.stringify(capsule, null, 2) + "\n");
}
