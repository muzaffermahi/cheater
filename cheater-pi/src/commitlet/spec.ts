import type { TaskKind } from "../autopilot/types.js";
import type { Commitlet, CommitletSpec } from "./types.js";

export function forgeCommitletSpec(commitlet: Commitlet, taskKind: TaskKind, userGoal: string): CommitletSpec {
  const isBug = taskKind === "bug_fix" || taskKind === "test_failure";
  const isRefactor = taskKind === "refactor";
  return {
    behaviorMustHold: [
      isBug ? "The reproduced failure is fixed without unrelated behavior changes." : `The user goal remains satisfied: ${compact(userGoal)}.`,
      ...commitlet.focusedVerification.map((step) => `Verification remains green: ${step.command ?? step.purpose}.`)
    ],
    behaviorMustNotChange: isRefactor
      ? ["Observable behavior must not change.", "Public API and command/tool registrations must stay compatible unless explicitly scoped."]
      : ["Unrelated files and behavior must remain unchanged."],
    edgeCases: isBug ? ["Failure should not be hidden by weakening tests."] : ["Do not overbuild beyond the acceptance criteria."],
    acceptanceCriteria: commitlet.expectedFilesTouched.length
      ? commitlet.expectedFilesTouched.map((file) => `${file} is the only expected edit target for this commitlet.`)
      : [`Commitlet purpose is satisfied: ${commitlet.purpose}.`],
    temporaryTestsAllowed: isBug,
    permanentTestsAllowed: isBug || /test/i.test(commitlet.scope),
    reproductionCommand: isBug ? commitlet.focusedVerification.find((step) => step.command)?.command : undefined,
    observedFailure: isBug ? "Use Mission Control repro/evidence output as the observed failure." : undefined,
    expectedBehavior: isBug ? "Focused verification passes for the original failure." : undefined,
    nonGoals: [
      "Do not touch files outside allowedFiles.",
      "Do not change dependencies, lockfiles, generated artifacts, or tests unless this commitlet explicitly allows it.",
      "Do not continue into another commitlet or another file after this scope is complete."
    ]
  };
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}
