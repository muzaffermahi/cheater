import { emptyHealthReport, scorePatchHealth } from "./health.js";
import type { CommitletFinalReview, CommitletPlan } from "./types.js";

export function runCommitletFinalReview(plan: CommitletPlan, diffText = ""): CommitletFinalReview {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
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
    ? scorePatchHealth({ diffText, filesTouched })
    : emptyHealthReport();
  if (!health.passed) blockingIssues.push(...health.blockingIssues);
  if (health.passed && health.score < 75) blockingIssues.push(`Patch health score ${health.score} is below preferred threshold; cleanup commitlet required.`);
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
