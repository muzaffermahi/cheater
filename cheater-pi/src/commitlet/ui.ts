import type { CommitletFinalReview, CommitletPlan, DiffGuardReport, PatchHealthReport, TestAuditReport } from "./types.js";

export function formatCommitletPlan(plan: CommitletPlan): string {
  return [
    "Cheater Reliability Kernel",
    `goal: ${plan.userGoal}`,
    `status: ${plan.status}`,
    `summary: ${plan.summary}`,
    "commitlets:",
    ...plan.commitlets.map((c, index) => `  ${index + 1}. ${c.id} ${c.status} ${c.title} [${c.allowedFiles.join(", ") || "inspect"}]`)
  ].join("\n");
}

export function formatCommitletStatus(plan: CommitletPlan | null): string {
  if (!plan) return "No active Cheater commitlet plan.";
  const current = plan.commitlets[plan.currentIndex] ?? plan.commitlets.at(-1);
  return [
    `Commitlet plan: ${plan.status}`,
    current ? `Current: ${current.id} ${current.status} - ${current.title}` : "Current: none",
    current ? `Allowed files: ${current.allowedFiles.join(", ") || "(inspect only)"}` : "",
    current ? `Verification: ${current.focusedVerification.map((step) => step.command ?? step.purpose).join("; ") || "manual review"}` : "",
    current?.rollbackPoint ? "Rollback: available" : "Rollback: pending"
  ].filter(Boolean).join("\n");
}

export function formatGuardHealthAudit(params: { guard?: DiffGuardReport; health?: PatchHealthReport; audit?: TestAuditReport }): string {
  return [
    params.guard ? `Diff guard: ${params.guard.passed ? "pass" : "block"} ${params.guard.blockingIssues.join("; ")}` : undefined,
    params.health ? `Health score: ${params.health.score} ${params.health.passed ? "pass" : "block"} ${params.health.blockingIssues.join("; ")}` : undefined,
    params.audit ? `Test audit: ${params.audit.passed ? "pass" : "block"} ${params.audit.blockingIssues.join("; ")}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatCommitletFinalReview(review: CommitletFinalReview): string {
  return [
    `Commitlet final review: ${review.accepted ? "accepted" : "blocked"}`,
    review.summary,
    `health: ${review.health.score}`,
    review.blockingIssues.length ? `blocking: ${review.blockingIssues.join("; ")}` : "blocking: none",
    review.warnings.length ? `warnings: ${review.warnings.join("; ")}` : "warnings: none"
  ].join("\n");
}
