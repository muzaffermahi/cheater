import type { CommitletPlan, CommitletStatus } from "./types.js";

export interface CommitletRunState {
  currentPlan: CommitletPlan | null;
}

class CommitletState {
  private state: CommitletRunState = { currentPlan: null };

  get(): CommitletRunState {
    return this.state;
  }

  setPlan(plan: CommitletPlan): void {
    this.state = { currentPlan: plan };
  }

  clear(): void {
    this.state = { currentPlan: null };
  }

  updateCommitlet(id: string, status: CommitletStatus, summary?: string): void {
    const plan = this.state.currentPlan;
    if (!plan) return;
    const commitlets = plan.commitlets.map((commitlet) => commitlet.id === id
      ? {
          ...commitlet,
          status,
          result: summary
            ? {
                filesChanged: commitlet.expectedFilesTouched,
                diffLines: 0,
                testsRun: commitlet.focusedVerification.map((step) => step.command ?? step.purpose),
                verificationPassed: status === "passed" || status === "repaired",
                healthPassed: status === "passed" || status === "repaired",
                rollbackAvailable: Boolean(commitlet.rollbackPoint),
                summary,
                issues: status === "failed" ? [summary] : []
              }
            : commitlet.result
        }
      : commitlet);
    const nextIndex = Math.min(commitlets.findIndex((commitlet) => commitlet.status === "pending"), commitlets.length);
    this.state = {
      currentPlan: {
        ...plan,
        commitlets,
        currentIndex: nextIndex < 0 ? commitlets.length : nextIndex,
        status: commitlets.every((commitlet) => ["passed", "skipped", "repaired"].includes(commitlet.status)) ? "complete" : plan.status
      }
    };
  }
}

export const defaultCommitletState = new CommitletState();
