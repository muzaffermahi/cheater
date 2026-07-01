import type { ApprovalState, BlueprintPlan, BlueprintRunState, FinalReviewResult, PacketStatus } from "./types.js";

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

  setReview(review: FinalReviewResult): BlueprintRunState {
    this.state = { ...this.state, lastReview: review };
    return this.state;
  }

  setApproval(approval: ApprovalState): BlueprintRunState {
    const plan = this.state.currentPlan;
    if (!plan) return this.state;
    this.state = {
      ...this.state,
      currentPlan: { ...plan, approval }
    };
    return this.state;
  }

  updatePacket(packetId: string, status: PacketStatus, summary?: string): BlueprintRunState {
    const plan = this.state.currentPlan;
    if (!plan) return this.state;
    const workPackets = plan.workPackets.map((packet) => {
      if (packet.id !== packetId) return packet;
      return {
        ...packet,
        status,
        result: summary
          ? {
              summary,
              filesTouched: packet.filesToTouch.map((file) => file.path),
              verificationPassed: status === "done"
            }
          : packet.result
      };
    });
    this.state = {
      ...this.state,
      currentPlan: {
        ...plan,
        workPackets,
        planGraph: {
          ...plan.planGraph,
          nodes: plan.planGraph.nodes.map((node) =>
            node.packetId === packetId || node.id === packetId ? { ...node, status } : node
          )
        }
      }
    };
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
