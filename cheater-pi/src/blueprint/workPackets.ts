import type { BlueprintCandidate, BlueprintPreview, FilePlan, RepoOrientation, VerificationStep, WorkPacket } from "./types.js";
import { inferFilePlans, graphTouchTargets } from "./contextSketch.js";
import type { GraphFileTarget, SymbolCluster } from "../commitlet/constraintGraph.js";

const BASE_ALLOWED_TOOLS = ["search/list/read", "edit", "cheater_line_edit", "shell", "Cheater verification tools"];
const BASE_FORBIDDEN = [
  "standalone TUI",
  "standalone agent loop",
  "parallel swarm",
  "prompt-copying flow",
  "dependency or lockfile edits without approval",
  "broad web search",
  "full-file rewrite of an existing file unless the user explicitly requests it"
];

export function buildCandidatePackets(params: {
  preview: BlueprintPreview;
  orientation: RepoOrientation;
  strategy: BlueprintCandidate["strategy"];
  maxCallsPerPacket: number;
  graphTargets?: GraphFileTarget[];
  symbolClusters?: SymbolCluster[];
}): WorkPacket[] {
  const files = inferFilePlans(params.preview.userGoal, params.orientation, params.graphTargets);
  const verification = verificationFor(params.orientation);
  const touchLimit = params.strategy === "architecture_clean" ? 3 : 2;
  const graphTouch = graphTouchTargets(params.graphTargets);
  const implementationFiles = graphDrivenImplementationFiles(files, graphTouch, params.symbolClusters, touchLimit);
  const inspectPacket = packet({
    id: "inspect",
    title: "Inspect local patterns and scope",
    type: "inspect",
    filesToInspect: files,
    filesToTouch: [],
    dependsOn: [],
    acceptanceCriteria: ["Relevant local patterns and boundaries are identified."],
    verification: [],
    risk: "low",
    maxModelCalls: params.maxCallsPerPacket
  });
  const implementPackets = buildIsolatedImplementationPackets({
    filesToInspect: files,
    filesToTouch: implementationFiles,
    symbolClusters: params.symbolClusters,
    strategy: params.strategy,
    verification,
    dependsOn: inspectPacket.id,
    risk: params.preview.likelyRisks.some((risk) => /approval|dependency|delete/i.test(risk)) ? "high" : "medium",
    maxModelCalls: params.strategy === "test_safety_first" ? Math.max(1, params.maxCallsPerPacket) : params.maxCallsPerPacket
  });
  const packets: WorkPacket[] = [
    inspectPacket,
    ...implementPackets
  ];

  const lastImplementationId = implementPackets[implementPackets.length - 1]?.id ?? inspectPacket.id;

  if (params.strategy === "test_safety_first") {
    packets.push(packet({
      id: "tests",
      title: "Add or update focused tests",
      type: "test",
      filesToInspect: files,
      filesToTouch: [{ path: "test/", reason: "focused coverage for new routing/planning behavior" }],
      dependsOn: [lastImplementationId],
      acceptanceCriteria: ["Focused tests cover routing, planning, and verification-sensitive behavior."],
      verification,
      risk: "medium",
      maxModelCalls: params.maxCallsPerPacket
    }));
  }

  packets.push(packet({
    id: "review",
    title: "Run final review and verification",
    type: "review",
    filesToInspect: files,
    filesToTouch: [],
    dependsOn: [packets[packets.length - 1].id],
    acceptanceCriteria: ["All packets are complete and focused verification has run or a blocker is reported."],
    verification,
    risk: "low",
    maxModelCalls: params.maxCallsPerPacket
  }));

  return packets;
}

function graphDrivenImplementationFiles(files: FilePlan[], graphTouch: string[], symbolClusters: SymbolCluster[] | undefined, touchLimit: number): FilePlan[] {
  if (graphTouch.length) {
    const touchPlans: FilePlan[] = graphTouch.slice(0, touchLimit).map((path) => ({ path, reason: `graph-driven touch target` }));
    const remaining = files.filter((f) => !graphTouch.includes(f.path) && !f.path.startsWith("(") && !f.path.endsWith("/")).slice(0, touchLimit - touchPlans.length);
    return [...touchPlans, ...remaining].slice(0, touchLimit);
  }
  const clusters = (symbolClusters ?? []).filter((c) => files.some((f) => f.path === c.file)).slice(0, touchLimit);
  if (clusters.length) {
    return clusters.map((c) => ({ path: c.file, reason: `symbol cluster: ${c.reason}` }));
  }
  return files.slice(0, touchLimit);
}

function buildIsolatedImplementationPackets(params: {
  filesToInspect: FilePlan[];
  filesToTouch: FilePlan[];
  symbolClusters?: SymbolCluster[];
  strategy: BlueprintCandidate["strategy"];
  verification: VerificationStep[];
  dependsOn: string;
  risk: WorkPacket["risk"];
  maxModelCalls: number;
}): WorkPacket[] {
  const targets = params.filesToTouch.length
    ? params.filesToTouch
    : [{ path: "(implementation target from inspection)", reason: "implementation target selected after inspection" }];
  return targets.map((file, index) => packet({
    id: implementationPacketId(file.path, index),
    title: `${implementationTitle(params.strategy)}: ${file.path}`,
    type: "implement",
    filesToInspect: [file, ...params.filesToInspect.filter((item) => item.path !== file.path).slice(0, 2)],
    filesToTouch: file.path.startsWith("(") ? [] : [file],
    dependsOn: [index === 0 ? params.dependsOn : implementationPacketId(targets[index - 1].path, index - 1)],
    acceptanceCriteria: acceptanceForFile(file, params.symbolClusters),
    verification: params.verification,
    risk: params.risk,
    maxModelCalls: params.maxModelCalls
  }));
}

function acceptanceForFile(file: FilePlan, symbolClusters?: SymbolCluster[]): string[] {
  const cluster = symbolClusters?.find((c) => c.file === file.path);
  if (cluster && cluster.symbols.length) {
    return [`Requested behavior for ${file.path} is implemented via ${cluster.symbols.slice(0, 3).join(", ")} using existing patterns.`];
  }
  return [`Requested behavior for ${file.path} is implemented through existing Pi/Cheater extension patterns.`];
}

export function verificationFor(orientation: RepoOrientation): VerificationStep[] {
  const steps: VerificationStep[] = [];
  const build = orientation.typecheckCommands[0];
  const test = orientation.testCommands[0];
  if (build) steps.push({ id: "typecheck", command: build, description: "Run typecheck/build command", required: true });
  if (test) steps.push({ id: "focused-tests", command: test, description: "Run focused or available test command", required: true });
  if (!steps.length) steps.push({ id: "manual-review", description: "Inspect changed files and run the narrowest available local verification", required: true });
  return steps;
}

function implementationTitle(strategy: BlueprintCandidate["strategy"]): string {
  if (strategy === "minimal") return "Implement minimal viable slice";
  if (strategy === "architecture_clean") return "Implement repo-fit architecture slice";
  return "Implement with test-first safety";
}

function packet(params: Omit<WorkPacket, "status" | "estimatedModelCalls" | "allowedTools" | "forbiddenActions" | "promptContract" | "simulationChecks">): WorkPacket {
  return {
    ...params,
    status: "pending",
    estimatedModelCalls: 1,
    allowedTools: BASE_ALLOWED_TOOLS,
    forbiddenActions: BASE_FORBIDDEN,
    promptContract: [
      `Do only packet ${params.id}: ${params.title}.`,
      "Use the built-in read/edit/shell tools and prefer cheater_line_edit for existing files.",
      "Keep context narrow; do not execute unrelated packets or move to another file.",
      "Read the exact line range before editing. Make the smallest line/range edit that satisfies the packet.",
      "Do not rewrite a whole existing file, template, or stylesheet just to modernize it.",
      "Treat this packet as an isolated fresh-agent run; after changing files, report a compact handoff summary.",
      "Stop and report if approval-sensitive changes are required."
    ].join(" "),
    simulationChecks: []
  };
}

function packetIdForPath(path: string): string {
  const id = path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return id || "target";
}

function implementationPacketId(path: string, index: number): string {
  const suffix = packetIdForPath(path);
  return index === 0 ? `implement-${suffix}` : `implement-${index + 1}-${suffix}`;
}
