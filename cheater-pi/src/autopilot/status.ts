import type { AutopilotDecision } from "./types.js";

export interface AutopilotStatus {
  lastDecision: AutopilotDecision | null;
  currentMode: AutopilotDecision["executionMode"] | "idle";
  currentGoal: string;
  updatedAt: string | null;
}

export class AutopilotState {
  private status: AutopilotStatus = {
    lastDecision: null,
    currentMode: "idle",
    currentGoal: "",
    updatedAt: null
  };

  setDecision(goal: string, decision: AutopilotDecision): AutopilotStatus {
    this.status = {
      lastDecision: decision,
      currentMode: decision.executionMode,
      currentGoal: goal,
      updatedAt: new Date().toISOString()
    };
    return this.status;
  }

  get(): AutopilotStatus {
    return this.status;
  }

  clear(): AutopilotStatus {
    this.status = {
      lastDecision: null,
      currentMode: "idle",
      currentGoal: "",
      updatedAt: new Date().toISOString()
    };
    return this.status;
  }
}

export const defaultAutopilotState = new AutopilotState();
