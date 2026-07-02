import type { BlueprintPlan, BlueprintRunState } from "./types.js";

export class BlueprintState {
  private state: BlueprintRunState = {
    currentPlan: null,
    lastReview: null,
    cancelled: false
  };

  setPlan(plan: BlueprintPlan): BlueprintRunState {
    this.state = { currentPlan: plan, lastReview: null, cancelled: false };
    return this.state;
  }

  cancel(): BlueprintRunState {
    this.state = { ...this.state, cancelled: true };
    return this.state;
  }

  clear(): BlueprintRunState {
    this.state = { currentPlan: null, lastReview: null, cancelled: false };
    return this.state;
  }

  get(): BlueprintRunState {
    return this.state;
  }
}

export const defaultBlueprintState = new BlueprintState();
