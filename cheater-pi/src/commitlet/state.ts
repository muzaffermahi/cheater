import type { Commitlet, CommitletPlan, CommitletStatus } from "./types.js";

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

  updateCommitlet(id: string, status: CommitletStatus, summary?: string, result?: Commitlet["result"]): void {
    const plan = this.state.currentPlan;
    if (!plan) return;
    const commitlets = plan.commitlets.map((commitlet) => commitlet.id === id
      ? {
          ...commitlet,
          status,
          result: result ?? (summary
            ? {
                // Honest defaults: carry forward previously observed changes rather than
                // asserting expectedFilesTouched actually changed, and never claim a diff
                // size or verification pass the grader did not observe.
                filesChanged: commitlet.result?.filesChanged ?? [],
                diffLines: commitlet.result?.diffLines ?? 0,
                testsRun: commitlet.result?.testsRun ?? [],
                verificationPassed: commitlet.result?.verificationPassed ?? false,
                healthPassed: commitlet.result?.healthPassed ?? false,
                rollbackAvailable: Boolean(commitlet.rollbackPoint),
                summary,
                issues: status === "failed" ? [summary] : commitlet.result?.issues ?? []
              }
            : commitlet.result)
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
