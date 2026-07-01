import type { BlueprintCandidate, BlueprintScore } from "./types.js";

export function scoreBlueprintCandidate(candidate: BlueprintCandidate): BlueprintScore {
  const penalties = candidatePenalties(candidate);
  const completeness = hasPacket(candidate, "implement") && hasPacket(candidate, "review") ? 0.85 : 0.45;
  const feasibility = candidate.workPackets.length <= 8 ? 0.85 : 0.55;
  const edgeCaseCoverage = hasPacket(candidate, "test") ? 0.86 : 0.68;
  const efficiency = Math.max(0.35, 1 - candidate.estimatedModelCalls * 0.06 - candidate.workPackets.length * 0.03);
  const repoFit = penalties.some((penalty) => /standalone|copy-into|vanilla Pi|broad web|dependency/i.test(penalty)) ? 0.25 : 0.82;
  const penaltyScore = penalties.length * 0.08;
  const overall = clamp((completeness + feasibility + edgeCaseCoverage + efficiency + repoFit) / 5 - penaltyScore);
  return {
    candidateId: candidate.id,
    completeness,
    feasibility,
    edgeCaseCoverage,
    efficiency,
    repoFit,
    overall,
    penalties,
    valid: penalties.every((penalty) => !/standalone|copy-into|launches vanilla|no verification|no final review/i.test(penalty))
  };
}

export function scoreBlueprintCandidates(candidates: BlueprintCandidate[]): BlueprintScore[] {
  return candidates.map(scoreBlueprintCandidate);
}

export function selectBestCandidate(candidates: BlueprintCandidate[], scores: BlueprintScore[]): BlueprintCandidate {
  const sorted = [...scores].filter((score) => score.valid).sort((a, b) => b.overall - a.overall);
  const selected = sorted[0] ?? [...scores].sort((a, b) => b.overall - a.overall)[0];
  const candidate = candidates.find((item) => item.id === selected?.candidateId);
  if (!candidate) throw new Error("No blueprint candidates available.");
  return candidate;
}

function candidatePenalties(candidate: BlueprintCandidate): string[] {
  const text = JSON.stringify(candidate).toLowerCase();
  const penalties: string[] = [];
  const touched = new Set(candidate.workPackets.flatMap((packet) => packet.filesToTouch.map((file) => file.path)));
  if (touched.size > 8) penalties.push("too many touched files");
  if (!candidate.verification.length) penalties.push("no verification");
  if (!hasPacket(candidate, "review")) penalties.push("no final review");
  if (candidate.workPackets.some((packet) => packet.promptContract.length < 40)) penalties.push("broad vague packets");
  if (/standalone tui/.test(text)) penalties.push("creates standalone TUI");
  if (/standalone agent loop/.test(text)) penalties.push("creates standalone agent loop");
  if (/copy.*into.*pi|prompt-copying/.test(text)) penalties.push("copy-into-Pi flow");
  if (/launches vanilla pi/.test(text)) penalties.push("launches vanilla Pi without Cheater customization");
  if (/broad web search/.test(text)) penalties.push("broad web search");
  if (/package-lock|pnpm-lock|yarn.lock|dependency/.test(text) && !/approval/.test(text)) penalties.push("dependency/lockfile edits without need");
  return [...new Set(penalties)];
}

function hasPacket(candidate: BlueprintCandidate, type: string): boolean {
  return candidate.workPackets.some((packet) => packet.type === type);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
