// Context invariant checker: the last gate before any worker spawn.
//
// A capsule that violates the invariants does not spawn a worker - the controller is told
// to split the task or compress the capsule instead. This is deterministic policy, not
// advice: over-hard-limit context, poisoned content, missing contract/validation/phase, too
// many allowed files, or an over-broad tool list all fail closed (config override exists
// for the size limit only, and is itself recorded).

import type { PromptCapsule } from "./promptCapsule.js";
import { estimateCapsuleTokens, CAPSULE_TARGET_TOKENS, CAPSULE_WARN_TOKENS, renderCapsulePrompt } from "./promptCapsule.js";
import { violatesWorkerToolPolicy } from "./toolExposure.js";
import type { TaskRunState } from "./runState.js";
import type { CheaterConfig } from "../types.js";

export interface InvariantReport {
  ok: boolean;
  failures: string[];
  warnings: string[];
}

export const DEFAULT_MAX_WORKER_ALLOWED_FILES = 4;

export interface InvariantOptions {
  run?: TaskRunState | null;
  /** The worker's tool list, when known. */
  workerTools?: string[];
  config?: CheaterConfig;
  /** Inspect-only workers legitimately have no validation plan. */
  inspectOnly?: boolean;
}

export function checkCapsuleInvariants(capsule: PromptCapsule, opts: InvariantOptions = {}): InvariantReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  const config = opts.config ?? {};
  const rendered = renderCapsulePrompt(capsule);
  const tokens = estimateCapsuleTokens(capsule);

  if (tokens > CAPSULE_WARN_TOKENS) {
    if (config.capsuleInvariantOverride === true) {
      warnings.push(`capsule is ~${tokens} tokens (> ${CAPSULE_WARN_TOKENS} hard limit) - allowed only by capsuleInvariantOverride`);
    } else {
      failures.push(`capsule is ~${tokens} tokens - above the ${CAPSULE_WARN_TOKENS} hard limit; split the task or trim snippets`);
    }
  } else if (tokens > CAPSULE_TARGET_TOKENS) {
    warnings.push(`capsule is ~${tokens} tokens - above the ${CAPSULE_TARGET_TOKENS} target`);
  }

  // Poison / parent-context markers. There is no field for a transcript, but a marker
  // arriving through a text field must still fail the spawn.
  if (/<think(?:ing)?>/i.test(rendered)) failures.push("capsule contains a thinking block");
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[/.test(rendered)) failures.push("capsule contains raw terminal escapes (full logs are forbidden)");
  if (/PARENT_SESSION_TRANSCRIPT|BEGIN PARENT TRANSCRIPT|^\s*(?:user|assistant):\s.*\n\s*(?:user|assistant):/im.test(rendered)) {
    failures.push("capsule appears to contain a parent transcript");
  }

  if (!capsule.workerGoal.trim()) failures.push("worker has no goal");
  if (capsule.workerGoal.length > 500) failures.push("worker goal is not narrow (over 500 chars)");
  const maxFiles = config.maxWorkerAllowedFiles ?? DEFAULT_MAX_WORKER_ALLOWED_FILES;
  const realAllowed = capsule.allowedFiles.filter((file) => !file.startsWith("("));
  if (realAllowed.length > maxFiles) {
    failures.push(`worker has ${realAllowed.length} allowed files (max ${maxFiles}) - split into one worker per file cluster`);
  }
  if (!capsule.acceptanceContract.length) failures.push("capsule has no acceptance contract terms");
  if (!capsule.phaseLines.length) failures.push("capsule has no phase information");
  if (!opts.inspectOnly && !capsule.validationPlan.length) failures.push("edit worker has no validation plan");

  // Standing truths must ride along when they exist.
  if (opts.run) {
    const summary = opts.run.validations.summary();
    const capsuleText = rendered.toLowerCase();
    if (summary.stalePasses > 0 && !capsuleText.includes("stale")) {
      failures.push("run has stale validations but the capsule does not warn about them");
    }
    if (opts.run.guard.hasProtections() && !capsuleText.includes("protected")) {
      failures.push("run has protected artifacts but the capsule does not mention them");
    }
  }

  if (opts.workerTools) {
    const violation = violatesWorkerToolPolicy(opts.workerTools);
    if (violation) failures.push(violation);
  }

  return { ok: failures.length === 0, failures, warnings };
}
