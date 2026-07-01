import type { PlanEdge, PlanGraph, PlanNode, WorkPacket } from "./types.js";

export function buildPlanGraph(packets: WorkPacket[]): PlanGraph {
  const nodes: PlanNode[] = packets.map((packet) => ({
    id: packet.id,
    label: packet.title,
    packetId: packet.id,
    status: packet.status
  }));
  const edges: PlanEdge[] = packets.flatMap((packet) =>
    packet.dependsOn.map((dep) => ({ from: dep, to: packet.id, reason: "packet dependency" }))
  );
  return { nodes, edges };
}

export function topologicalPackets(packets: WorkPacket[]): WorkPacket[] {
  const byId = new Map(packets.map((packet) => [packet.id, packet]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: WorkPacket[] = [];

  const visit = (packet: WorkPacket) => {
    if (visited.has(packet.id)) return;
    if (visiting.has(packet.id)) throw new Error(`Cycle detected at packet ${packet.id}`);
    visiting.add(packet.id);
    for (const dep of packet.dependsOn) {
      const depPacket = byId.get(dep);
      if (depPacket) visit(depPacket);
    }
    visiting.delete(packet.id);
    visited.add(packet.id);
    result.push(packet);
  };

  for (const packet of packets) visit(packet);
  return result;
}

export function detectPlanCycles(graph: PlanGraph): string[] {
  try {
    topologicalPackets(graph.nodes.map((node) => ({
      id: node.id,
      title: node.label,
      type: "inspect",
      status: node.status,
      dependsOn: graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
      estimatedModelCalls: 1,
      maxModelCalls: 1,
      filesToInspect: [],
      filesToTouch: [],
      allowedTools: [],
      forbiddenActions: [],
      promptContract: "",
      acceptanceCriteria: [],
      verification: [],
      simulationChecks: [],
      risk: "low"
    })));
    return [];
  } catch (err) {
    return [(err as Error).message];
  }
}

export function ensureFinalReviewNode(graph: PlanGraph): PlanGraph {
  if (graph.nodes.some((node) => /review/i.test(node.label))) return graph;
  return {
    nodes: [...graph.nodes, { id: "review", label: "Final review", packetId: "review", status: "pending" }],
    edges: graph.nodes.length ? [...graph.edges, { from: graph.nodes[graph.nodes.length - 1].id, to: "review", reason: "mandatory final review" }] : graph.edges
  };
}

export function addDerivedImpactNode(graph: PlanGraph, label: string, dependsOn: string): PlanGraph {
  const id = `derived-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (graph.nodes.some((node) => node.id === id)) return graph;
  return {
    nodes: [...graph.nodes, { id, label, status: "pending" }],
    edges: [...graph.edges, { from: dependsOn, to: id, reason: "impact propagation" }]
  };
}
