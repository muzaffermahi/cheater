import type { BlueprintCandidate, BlueprintPreview, OfficialDocsFact, RepoOrientation, BlueprintMemoryHit } from "./types.js";
import { buildCandidatePackets, verificationFor } from "./workPackets.js";
import type { GraphFileTarget, SymbolCluster } from "../commitlet/constraintGraph.js";

export function generateBlueprintCandidates(params: {
  preview: BlueprintPreview;
  orientation: RepoOrientation;
  docsFacts?: OfficialDocsFact[];
  memoryHits?: BlueprintMemoryHit[];
  count?: number;
  maxCallsPerPacket?: number;
  graphTargets?: GraphFileTarget[];
  symbolClusters?: SymbolCluster[];
}): BlueprintCandidate[] {
  const strategies: BlueprintCandidate["strategy"][] = ["minimal", "architecture_clean", "test_safety_first"];
  const count = Math.max(1, Math.min(params.count ?? 3, 3));
  return strategies.slice(0, count).map((strategy, index) => {
    const packets = buildCandidatePackets({
      preview: params.preview,
      orientation: params.orientation,
      strategy,
      maxCallsPerPacket: params.maxCallsPerPacket ?? 1,
      graphTargets: params.graphTargets,
      symbolClusters: params.symbolClusters
    });
    return {
      id: `candidate-${String.fromCharCode(65 + index)}`,
      name: candidateName(strategy),
      strategy,
      summary: candidateSummary(strategy, params.preview.taskSummary),
      nonGoals: [
        "Do not create a standalone Cheater agent loop.",
        "Do not create a standalone Cheater TUI.",
        "Do not require users to copy prompts into Pi or type /blueprint for normal work."
      ],
      assumptions: [
        "Pi remains responsible for reading, editing, shell execution, sessions, and normal coding-agent behavior.",
        "Cheater can steer Pi through extension tools, commands, prompts, and lifecycle hooks."
      ],
      constraints: [
        "Use existing Cheater/Pi extension patterns.",
        "Keep packets sequential and bounded.",
        "Use official/local docs only when docs are needed."
      ],
      risks: params.preview.likelyRisks,
      verification: verificationFor(params.orientation),
      workPackets: packets,
      estimatedModelCalls: packets.reduce((sum, packet) => sum + packet.estimatedModelCalls, 0)
    };
  });
}

function candidateName(strategy: BlueprintCandidate["strategy"]): string {
  if (strategy === "minimal") return "A: minimal viable implementation";
  if (strategy === "architecture_clean") return "B: architecture-clean implementation";
  return "C: test/safety-first implementation";
}

function candidateSummary(strategy: BlueprintCandidate["strategy"], goal: string): string {
  if (strategy === "minimal") return `Smallest working implementation for: ${goal}`;
  if (strategy === "architecture_clean") return `Repo-fit implementation with explicit module boundaries for: ${goal}`;
  return `Safety-first implementation with focused tests before final review for: ${goal}`;
}
