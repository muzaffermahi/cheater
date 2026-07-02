// Execution-risk middleware: short, situational hints - not sermons.
//
// Observes a planned action (tool call, command, claimed success) together with run state
// (phase, contract, ledger summaries, guard, repeat counts, capsule sizes) and emits at most
// three compact hints. Everything here is a pure function over inputs; nothing blocks by
// itself - blocking stays with the guard and the commitlet scope check. The hints exist to
// stop the classic small-model failure chains: shallow validation ("/" responded, ship it),
// stale validation (tests passed before the last edit), reserve-phase refactors, and loops.

import type { AcceptanceContract } from "./contract.js";
import type { MutationLedgerSummary } from "./mutationLedger.js";
import type { ValidationLedgerSummary } from "./validationLedger.js";
import type { PostSuccessGuard } from "./postSuccessGuard.js";
import type { RunPhase } from "./phaseController.js";

export interface RiskInput {
  phase: RunPhase;
  budgetRemainingPercent: number;
  toolName?: string;
  command?: string;
  files?: string[];
  contract?: AcceptanceContract | null;
  validationSummary?: ValidationLedgerSummary;
  mutationSummary?: MutationLedgerSummary;
  guard?: PostSuccessGuard;
  /** Consecutive identical/failing repeats of this same action. */
  repeatedCallCount?: number;
  /** Estimated tokens of the capsule/prompt being built, when known. */
  capsuleTokens?: number;
  workerScope?: { role: string; allowedFiles: string[] };
  /** True when this action is a success claim / finish attempt. */
  claimingSuccess?: boolean;
}

const MAX_HINTS = 3;
const LONG_COMMAND_RE = /\b(npm\s+(?:ci|install)|pip3?\s+install|cargo\s+build\s+--release|docker\s+build|apt(?:-get)?\s+install|make\s+all|webpack|vite\s+build|tsc\s+-b)\b/i;
const REFACTOR_RE = /\b(refactor|rewrite|restructure|reformat|rename\s+all|cleanup)\b/i;
const EXISTENCE_ONLY_RE = /^\s*(?:test\s+-[ef]\s|ls\s|dir\s|stat\s|\[\s+-[ef]\s)/;

function normalize(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Root-only URL probe when the contract names a deeper endpoint. */
function shallowEndpointHint(command: string, contract: AcceptanceContract): string | null {
  const deep = contract.endpoints.filter((e) => e !== "/" && e.length > 1);
  if (!deep.length) return null;
  const urlProbe = command.match(/\b(?:curl|wget|http)\b[^\n]*?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(\/[^\s"']*)?/i);
  if (!urlProbe) return null;
  const probedPath = urlProbe[1] ?? "/";
  if (deep.some((e) => probedPath.startsWith(e))) return null;
  return `Risk: this validates ${probedPath} but the contract names ${deep[0]}. Run the exact endpoint check before claiming success.`;
}

export function assessRisk(input: RiskInput): string[] {
  const hints: string[] = [];
  const command = (input.command ?? "").trim();
  const contract = input.contract ?? null;

  // 1. Stale validation: a pass exists but files changed after it.
  if (input.validationSummary && input.validationSummary.stalePasses > 0 && (input.claimingSuccess || input.phase === "validate" || input.phase === "reserve")) {
    hints.push(`Risk: ${input.validationSummary.stalePasses} earlier passing validation(s) are stale (files changed afterwards). Re-run them before trusting the result.`);
  }

  // 2. Shallow validation on a success claim: no fresh evaluator-mirroring pass.
  if (input.claimingSuccess && input.validationSummary && contract) {
    const hasExactTargets = contract.outputPaths.length || contract.endpoints.length || contract.commands.length;
    if (hasExactTargets && input.validationSummary.evaluatorMirroringFreshPasses === 0) {
      const target = contract.outputPaths[0] ?? contract.endpoints[0] ?? `\`${contract.commands[0]}\``;
      hints.push(`Risk: validation so far is proxy-only. The evaluator will touch ${target} - validate that exact artifact before finishing.`);
    }
  }

  // 3. Existence-only checks when the contract requires content.
  if (command && contract && EXISTENCE_ONLY_RE.test(command) && contract.outputPaths.some((p) => command.includes(p))) {
    hints.push("Risk: checking that the file exists is not validation - re-read its content against the contract format.");
  }

  // 4. Root-endpoint probe when contract names a deeper endpoint.
  if (command && contract) {
    const endpointHint = shallowEndpointHint(command, contract);
    if (endpointHint) hints.push(endpointHint);
  }

  // 5. Reserve-phase state changes / late long commands.
  if (input.phase === "reserve" && command && (LONG_COMMAND_RE.test(command) || REFACTOR_RE.test(command))) {
    hints.push(`Risk: RESERVE phase (${Math.round(input.budgetRemainingPercent)}% budget left). Avoid installs/refactors now; preserve the current passing state.`);
  } else if (input.phase === "validate" && command && LONG_COMMAND_RE.test(command)) {
    hints.push("Risk: long-running install/build in VALIDATE phase - only proceed if a validation blocker requires it.");
  }

  // 6. Protected artifacts.
  if (input.guard?.hasProtections()) {
    if (command) {
      const verdict = input.guard.assessCommand(command);
      if (verdict.verdict !== "allow" && verdict.message) hints.push(`Risk: ${verdict.message}`);
    }
    for (const file of (input.files ?? []).slice(0, 5)) {
      const verdict = input.guard.assessFileMutation(file);
      if (verdict.verdict !== "allow" && verdict.message) { hints.push(`Risk: ${verdict.message}`); break; }
    }
  }

  // 7. Worker scope violations.
  if (input.workerScope && input.files?.length && input.workerScope.allowedFiles.length) {
    const allowed = new Set(input.workerScope.allowedFiles.map(normalize));
    const outside = input.files.map(normalize).filter((f) => !allowed.has(f));
    if (outside.length) {
      hints.push(`Risk: ${input.workerScope.role} worker touching ${outside[0]} outside its allowed files. Report the finding instead; the controller decides.`);
    }
  }

  // 8. Repeated same action.
  if ((input.repeatedCallCount ?? 0) >= 3) {
    hints.push(`Risk: the same action has now run ${input.repeatedCallCount} times. Repeating it will not change the outcome - change the approach or stop and report.`);
  }

  // 9. Contract path mismatch on writes: writing near-miss filenames.
  if (contract?.outputPaths.length && input.files?.length) {
    for (const file of input.files.map(normalize)) {
      const base = file.split("/").pop() ?? file;
      for (const wanted of contract.outputPaths) {
        const wantedBase = wanted.split("/").pop() ?? wanted;
        if (base !== wantedBase && base.replace(/[-_]/g, "") === wantedBase.replace(/[-_]/g, "")) {
          hints.push(`Risk: writing ${base} but the contract names ${wantedBase} exactly. Keep the literal filename.`);
        }
      }
    }
  }

  // 10. Capsule/context pressure.
  if ((input.capsuleTokens ?? 0) > 8000) {
    hints.push(`Risk: capsule is ~${input.capsuleTokens} tokens (target 1-4K, warn >8K). Trim files/snippets before spawning this worker.`);
  }

  return [...new Set(hints)].slice(0, MAX_HINTS);
}
