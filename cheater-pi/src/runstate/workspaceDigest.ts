// Workspace digest: the tiny canonical state summary that replaces scrollback soup.
//
// A respawned controller or a freshly spawned worker should learn the state of the world
// from 200-600 words, not from ten thousand lines of terminal history. The digest is rebuilt
// deterministically from the ledgers, contract, phase, and guard - it is derived state, so it
// can never drift from the ledgers it summarizes. Rebuilt after every worker report, after
// important commands, and before any new worker spawn.

import type { AcceptanceContract } from "./contract.js";
import { summarizeContract } from "./contract.js";
import type { MutationLedger } from "./mutationLedger.js";
import type { ValidationLedger } from "./validationLedger.js";
import type { RunPhase } from "./phaseController.js";
import { writeRunFile } from "./runDir.js";

export interface WorkspaceDigestInput {
  taskId: string;
  goal: string;
  phase: RunPhase;
  budgetRemainingPercent: number;
  contract: AcceptanceContract | null;
  mutations: MutationLedger;
  validations: ValidationLedger;
  /** e.g. installed packages, background processes - short strings. */
  environmentNotes?: string[];
  blockers?: string[];
  protectedArtifacts?: string[];
  nextAction?: string;
  /** Largest capsule seen so far, tokens. Triggers a context-pressure warning. */
  maxCapsuleTokens?: number;
}

const MAX_WORDS = 600;

function clampWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "\n... [digest clipped]";
}

/** Build the digest markdown. Pure - same inputs, same digest. */
export function buildWorkspaceDigest(input: WorkspaceDigestInput): string {
  const lines: string[] = [];
  lines.push(`# Workspace digest: ${input.taskId}`);
  lines.push("");
  lines.push(`goal: ${input.goal.slice(0, 240)}`);
  lines.push(`phase: ${input.phase.toUpperCase()} (${Math.max(0, Math.round(input.budgetRemainingPercent))}% budget remaining)`);
  lines.push("");
  lines.push("## Contract");
  lines.push(input.contract ? summarizeContract(input.contract, 500) : "(no contract extracted)");
  lines.push("");
  lines.push("## Mutations");
  lines.push(...input.mutations.renderSummaryLines());
  lines.push("");
  lines.push("## Validation");
  lines.push(...input.validations.renderSummaryLines());
  if (input.environmentNotes?.length) {
    lines.push("");
    lines.push("## Environment");
    lines.push(...input.environmentNotes.slice(0, 5).map((n) => `- ${n.slice(0, 120)}`));
  }
  if (input.protectedArtifacts?.length) {
    lines.push("");
    lines.push("## Protected artifacts (do not mutate unless a validation fails)");
    lines.push(...input.protectedArtifacts.slice(0, 8).map((p) => `- ${p}`));
  }
  if (input.blockers?.length) {
    lines.push("");
    lines.push("## Blockers");
    lines.push(...input.blockers.slice(0, 5).map((b) => `- ${b.slice(0, 140)}`));
  }
  lines.push("");
  lines.push("## Next");
  lines.push(input.nextAction?.slice(0, 200) ?? "(controller decides)");
  if (typeof input.maxCapsuleTokens === "number" && input.maxCapsuleTokens > 8000) {
    lines.push("");
    lines.push(`WARNING context pressure: largest capsule is ~${input.maxCapsuleTokens} tokens (target 1-4K). Rebuild capsules smaller.`);
  }
  return clampWords(lines.join("\n"), MAX_WORDS);
}

export function writeWorkspaceDigest(runDir: string, digest: string): void {
  try {
    writeRunFile(runDir, "workspace-digest.md", digest.endsWith("\n") ? digest : digest + "\n");
  } catch {
    // best-effort
  }
}
