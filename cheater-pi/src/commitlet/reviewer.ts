import { emptyHealthReport, scorePatchHealth } from "./health.js";
import type { CommitletFinalReview, CommitletPlan } from "./types.js";
import type { CheaterConfig } from "../types.js";

export function runCommitletFinalReview(plan: CommitletPlan, diffText = "", config?: CheaterConfig): CommitletFinalReview {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  // Scaffold (from-scratch) builds grade patch health as ADVISORY: the whole app is new files that
  // legitimately score ~0 on the edit-tuned health metric, and the REAL completion gate is the finish
  // gate's "npm run build must pass" (a separate gate). Blocking the final review on health here would
  // reject even a perfect green build (the reported "Patch health score 0" wall). surgical/repair keep
  // the hard health block. Per-phase grading is already lenient this way; this is the missing twin.
  const scaffold = plan.buildMode === "scaffold";
  const unresolved = plan.commitlets.filter((commitlet) => !["passed", "skipped", "repaired"].includes(commitlet.status));
  if (unresolved.length) blockingIssues.push(`Unresolved commitlets: ${unresolved.map((c) => `${c.id}:${c.status}`).join(", ")}`);
  const failedVerification = plan.commitlets.filter((commitlet) => commitlet.result?.verificationPassed === false);
  if (failedVerification.length) blockingIssues.push(`Focused verification failed: ${failedVerification.map((c) => c.id).join(", ")}`);
  const failedHealth = plan.commitlets.filter((commitlet) => commitlet.result?.healthPassed === false);
  if (failedHealth.length) blockingIssues.push(`Commitlet health failed: ${failedHealth.map((c) => c.id).join(", ")}`);
  const forbiddenTouched = plan.commitlets.flatMap((commitlet) => commitlet.result?.filesChanged ?? []).filter((file, index, all) => all.indexOf(file) === index).filter((file) =>
    plan.commitlets.some((commitlet) => commitlet.forbiddenFiles.includes(file))
  );
  if (forbiddenTouched.length) blockingIssues.push(`Forbidden files touched across plan: ${forbiddenTouched.join(", ")}`);
  const filesTouched = plan.commitlets.flatMap((commitlet) => commitlet.result?.filesChanged ?? []);
  const health = diffText || filesTouched.length
    ? scorePatchHealth({ diffText, filesTouched, threshold: config?.healthScoreThreshold, hardRejectThreshold: config?.hardRejectHealthThreshold })
    : emptyHealthReport();
  if (!health.passed) (scaffold ? warnings : blockingIssues).push(...health.blockingIssues);
  if (health.passed && health.score < 75) (scaffold ? warnings : blockingIssues).push(`Patch health score ${health.score} is below preferred threshold${scaffold ? " (advisory for a from-scratch build)" : "; cleanup commitlet required"}.`);
  warnings.push(...health.warnings);
  return {
    accepted: blockingIssues.length === 0,
    summary: blockingIssues.length ? "Commitlet final review blocked the plan." : "Commitlet final review accepted the plan.",
    commitlets: plan.commitlets.map((commitlet) => `${commitlet.id}:${commitlet.status}`),
    finalVerification: plan.finalVerification,
    health,
    blockingIssues,
    warnings,
    suggestedFollowups: health.score < 75 ? ["Create a cleanup commitlet for patch health warnings."] : []
  };
}
