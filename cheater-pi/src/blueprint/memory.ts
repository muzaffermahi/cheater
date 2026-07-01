import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintMemoryHit, BlueprintPlan, OfficialDocsFact, RepoOrientation } from "./types.js";

export function retrievePlanningMemory(cwd: string, query: string, enabled = true): BlueprintMemoryHit[] {
  if (!enabled) return [];
  const files = [
    { path: join(cwd, ".cheater", "memory", "notes.jsonl"), source: "project" as const },
    { path: blueprintPlanMemoryPath(cwd), source: "plan" as const }
  ];
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
  return files.flatMap((file) => {
    if (!existsSync(file.path)) return [];
    return readFileSync(file.path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => safeParse(line, index, file.source))
      .filter((entry): entry is BlueprintMemoryHit => !!entry);
  })
  .filter((hit) => terms.some((term) => hit.summary.toLowerCase().includes(term)))
  .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
  .slice(0, 8);
}

export function retrieveFeedbackMemory(cwd: string, failureText: string, enabled = true): BlueprintMemoryHit[] {
  return retrievePlanningMemory(cwd, failureText, enabled).map((hit) => ({ ...hit, source: "bug" }));
}

export function disagreementGate(params: {
  memoryHits: BlueprintMemoryHit[];
  docsFacts: OfficialDocsFact[];
  orientation: RepoOrientation;
}): { trustedMemory: BlueprintMemoryHit[]; trustedDocs: OfficialDocsFact[]; excluded: string[] } {
  const languages = params.orientation.languages.map((item) => item.toLowerCase());
  const frameworks = params.orientation.frameworks.map((item) => item.toLowerCase());
  const contextWords = new Set([...languages, ...frameworks, "local", "pi", "cheater"]);
  const excluded: string[] = [];
  const trustedMemory = params.memoryHits.filter((hit) => {
    const lower = hit.summary.toLowerCase();
    const matched = [...contextWords].some((word) => lower.includes(word)) || hit.confidence === "high";
    if (!matched) excluded.push(`memory:${hit.id}`);
    return matched;
  });
  const trustedDocs = params.docsFacts.filter((fact) => {
    if (fact.sourceDomain === "local" || fact.confidence === "high") return true;
    const matched = [...contextWords].some((word) => fact.packageOrLibrary.toLowerCase().includes(word) || fact.claim.toLowerCase().includes(word));
    if (!matched) excluded.push(`docs:${fact.sourceUrl}`);
    return matched;
  });
  return { trustedMemory, trustedDocs, excluded };
}

export function blueprintArtifactDir(cwd: string): string {
  return join(cwd, ".cheater", "blueprints");
}

export function blueprintPlanMemoryPath(cwd: string): string {
  return join(cwd, ".cheater", "memory", "blueprint_plans.jsonl");
}

export function persistBlueprintArtifacts(cwd: string, plan: BlueprintPlan): { markdownPath: string; jsonPath: string; memoryPath: string } {
  const dir = blueprintArtifactDir(cwd);
  mkdirSync(dir, { recursive: true });
  const markdownPath = join(dir, `${plan.id}.md`);
  const jsonPath = join(dir, `${plan.id}.json`);
  writeFileSync(markdownPath, plan.artifactMarkdown, "utf8");
  writeFileSync(jsonPath, JSON.stringify(plan, null, 2), "utf8");
  appendPlanMemory(cwd, plan);
  return { markdownPath, jsonPath, memoryPath: blueprintPlanMemoryPath(cwd) };
}

function appendPlanMemory(cwd: string, plan: BlueprintPlan): void {
  const path = blueprintPlanMemoryPath(cwd);
  mkdirSync(join(cwd, ".cheater", "memory"), { recursive: true });
  const entry = {
    id: plan.id,
    source: "plan",
    confidence: plan.qualityGate.localModelFit === "excellent" ? "high" : "medium",
    summary: [
      `blueprint plan ${plan.id}`,
      `goal: ${plan.userGoal}`,
      `strategy: ${plan.selectedCandidateId}`,
      `quality: ${plan.qualityGate.score} ${plan.qualityGate.localModelFit}`,
      `decisions: ${plan.intelligence?.architectureDecisions.map((item) => item.decision).join(" | ") ?? ""}`,
      `packets: ${plan.workPackets.map((packet) => `${packet.id}:${packet.title}`).join(" | ")}`,
      `verification: ${plan.verification.map((step) => step.command ?? step.description).join(" | ")}`
    ].join("; ")
  };
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a", encoding: "utf8" });
}

function safeParse(line: string, index: number, fallbackSource: BlueprintMemoryHit["source"]): BlueprintMemoryHit | undefined {
  try {
    const parsed = JSON.parse(line) as { id?: string; text?: string; summary?: string; source?: BlueprintMemoryHit["source"]; confidence?: BlueprintMemoryHit["confidence"]; createdAt?: string };
    return {
      id: parsed.id ?? `${fallbackSource}-${index}`,
      source: parsed.source ?? fallbackSource,
      summary: parsed.summary ?? parsed.text ?? line,
      confidence: parsed.confidence ?? "medium"
    };
  } catch {
    return undefined;
  }
}

function confidenceRank(confidence: BlueprintMemoryHit["confidence"]): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}
