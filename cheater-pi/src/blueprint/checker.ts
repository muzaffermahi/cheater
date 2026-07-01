import type { WorkPacket } from "./types.js";

export function simulatePacket(packet: WorkPacket): WorkPacket {
  const check = {
    packetId: packet.id,
    expectedFileChanges: packet.filesToTouch.map((file) => file.path),
    expectedBehaviorChanges: packet.acceptanceCriteria,
    edgeCases: packet.risk === "high" ? ["approval-sensitive changes must stop before edit"] : ["existing behavior should remain intact"],
    failureModes: ["wrong file touched", "verification omitted", "packet scope expands"],
    verificationMethod: packet.verification.map((step) => step.command ?? step.description).join("; ") || "manual review",
    clear: packet.acceptanceCriteria.length > 0 && (packet.verification.length > 0 || packet.type === "inspect")
  };
  return { ...packet, simulationChecks: [check] };
}

export function simulateBlueprintPackets(packets: WorkPacket[]): WorkPacket[] {
  return packets.map(simulatePacket);
}

export function packetNeedsRevision(packet: WorkPacket): boolean {
  return packet.simulationChecks.some((check) => !check.clear);
}

export function reviseUnclearPacket(packet: WorkPacket): WorkPacket {
  if (!packetNeedsRevision(packet)) return packet;
  return {
    ...packet,
    acceptanceCriteria: packet.acceptanceCriteria.length ? packet.acceptanceCriteria : ["Packet outcome is explicitly verified before proceeding."],
    verification: packet.verification.length ? packet.verification : [{ id: `${packet.id}-review`, description: "Manual review of packet diff and acceptance criteria", required: true }],
    simulationChecks: []
  };
}
