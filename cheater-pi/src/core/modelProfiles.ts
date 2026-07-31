// Hardware-aware guidance for the model tiers Kitten is designed around.
// These are class profiles, not claims about a particular checkpoint or vendor.

import type { HardwareProfile } from "./modelRuntime.js";

export type ModelProfileRole = "main" | "sidecar";
export type ModelFit = "good" | "tight" | "unavailable";

export interface ModelProfile {
  id: string;
  label: string;
  role: ModelProfileRole;
  parameterClass: string;
  minimumMemoryGiB: number;
  comfortableMemoryGiB: number;
  guidance: string;
}

export interface ModelProfileRecommendation extends ModelProfile {
  fit: ModelFit;
  availableMemoryGiB: number;
}

export const MODEL_PROFILES: readonly ModelProfile[] = [
  { id: "main-35b", label: "Main · 35B class", role: "main", parameterClass: "35B–40B", minimumMemoryGiB: 20, comfortableMemoryGiB: 28, guidance: "Best default for a single high-end consumer GPU or a 32–64 GB workstation." },
  { id: "main-70b", label: "Main · 70B class", role: "main", parameterClass: "70B–80B", minimumMemoryGiB: 40, comfortableMemoryGiB: 56, guidance: "Use when the machine has substantial unified memory or multi-GPU capacity." },
  { id: "main-120b", label: "Main · 120B class", role: "main", parameterClass: "100B–140B", minimumMemoryGiB: 72, comfortableMemoryGiB: 96, guidance: "Workstation/server tier; keep context and parallelism conservative." },
  { id: "main-200b", label: "Main · 200B class", role: "main", parameterClass: "180B–220B", minimumMemoryGiB: 120, comfortableMemoryGiB: 160, guidance: "Large workstation/server tier; prefer quantized weights and a dedicated inference device." },
  { id: "sidecar-2b", label: "Sidecar · 2B class", role: "sidecar", parameterClass: "2B–4B", minimumMemoryGiB: 3, comfortableMemoryGiB: 6, guidance: "Fast clerical lane for routing, titles, extraction, summaries, and evidence formatting." },
  { id: "sidecar-7b", label: "Sidecar · 7–9B class", role: "sidecar", parameterClass: "7B–9B", minimumMemoryGiB: 8, comfortableMemoryGiB: 14, guidance: "Stronger sidecar for review, test selection, conflict prediction, and repair planning." },
];

function availableMemoryGiB(hardware: HardwareProfile): number {
  const system = hardware.ramBytes / (1024 ** 3);
  const gpu = hardware.gpus.reduce((sum, item) => sum + (item.vramBytes ?? 0), 0) / (1024 ** 3);
  // Avoid treating every byte as model memory: leave a conservative OS/runtime margin.
  return Math.max(0, Math.floor((system + gpu) * 0.72));
}

export function recommendModelProfiles(hardware: HardwareProfile): ModelProfileRecommendation[] {
  const available = availableMemoryGiB(hardware);
  return MODEL_PROFILES.map((profile) => ({
    ...profile,
    availableMemoryGiB: available,
    fit: available >= profile.comfortableMemoryGiB ? "good" : available >= profile.minimumMemoryGiB ? "tight" : "unavailable",
  }));
}

export function profileSummary(recommendations: readonly ModelProfileRecommendation[]): string {
  const choose = (role: ModelProfileRole): ModelProfileRecommendation | undefined => {
    const viable = recommendations.filter((item) => item.role === role && item.fit !== "unavailable");
    return viable.sort((a, b) => (a.fit === b.fit ? b.minimumMemoryGiB - a.minimumMemoryGiB : a.fit === "good" ? -1 : 1))[0];
  };
  const main = choose("main");
  const sidecar = choose("sidecar");
  if (!main || !sidecar) return "Hardware guidance: use a smaller main model or disable the sidecar until more memory is available.";
  return `Hardware guidance: ${main.label} (${main.fit}) + ${sidecar.label} (${sidecar.fit}); estimated available memory ${main.availableMemoryGiB} GiB.`;
}
