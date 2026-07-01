import type { WorkPacket } from "../blueprint/types.js";

export function splitPacketsByTouchedFile(packets: WorkPacket[], maxFilesToTouch = 1): WorkPacket[] {
  if (maxFilesToTouch !== 1) return packets;
  const replacements = new Map<string, string>();
  const result: WorkPacket[] = [];
  for (const packet of packets) {
    const deps = packet.dependsOn.map((dep) => replacements.get(dep) ?? dep);
    if (packet.filesToTouch.length <= 1 || packet.type === "review" || packet.type === "inspect") {
      const next = { ...packet, dependsOn: deps };
      result.push(next);
      replacements.set(packet.id, next.id);
      continue;
    }
    const split = packet.filesToTouch.map((file, index) => {
      const id = `${packet.id}-file-${index + 1}-${safePathId(file.path)}`;
      return {
        ...packet,
        id,
        title: `${packet.title}: ${file.path}`,
        dependsOn: index === 0 ? deps : [`${packet.id}-file-${index}-${safePathId(packet.filesToTouch[index - 1].path)}`],
        filesToInspect: [file, ...packet.filesToInspect.filter((item) => item.path !== file.path).slice(0, 2)],
        filesToTouch: [file],
        acceptanceCriteria: packet.acceptanceCriteria.map((item) => `${item} Scope for this worker: ${file.path}.`),
        promptContract: [
          packet.promptContract,
          `This worker may change exactly one file: ${file.path}. Stop after that file; do not continue into another file.`
        ].join(" ")
      };
    });
    result.push(...split);
    replacements.set(packet.id, split.at(-1)?.id ?? packet.id);
  }
  return result.map((packet) => ({
    ...packet,
    dependsOn: packet.dependsOn.map((dep) => replacements.get(dep) ?? dep)
  }));
}

function safePathId(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "target";
}
