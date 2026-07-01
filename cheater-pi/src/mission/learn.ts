import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BugMemoryCard } from "../bug-memory.js";
import type { CheaterConfig } from "../types.js";
import type { Mission, MissionStatus } from "./types.js";

export interface LearnOptions {
  mission: Mission;
  cwd: string;
  config: CheaterConfig;
}

export interface LearningProposal {
  saveBugMemory: { id: string; summary: string } | null;
  saveProjectFact: string | null;
  savePlaybookNote: string | null;
  saveAntiPattern: string | null;
  saveAvoidance: string | null;
  saveMissingEvidence: string | null;
}

export interface MissionBugMemoryCard extends BugMemoryCard {
  source_mission_id: string;
  created_at: string;
  workflow_steps: string[];
  do_not_do: string[];
}

export function proposeLearning(options: LearnOptions): LearningProposal {
  const { mission } = options;
  const succeeded = mission.status === "complete";
  const noOp = mission.status === "no_change_needed";
  const failed = mission.status === "failed";
  const repro = mission.repro;

  const proposal: LearningProposal = {
    saveBugMemory: null,
    saveProjectFact: null,
    savePlaybookNote: null,
    saveAntiPattern: null,
    saveAvoidance: null,
    saveMissingEvidence: null
  };

  if (succeeded || noOp) {
    if (repro?.reproduced) {
      proposal.saveBugMemory = {
        id: `mission-${mission.id}`,
        summary: `${mission.missionType}: ${mission.userGoal.slice(0, 200)} -> ${mission.patchSummary.slice(0, 200)}`
      };
    }
    if (mission.projectOrientation) {
      const tcmd = mission.projectOrientation.testCommands[0];
      if (tcmd) proposal.saveProjectFact = `focused test command: ${tcmd}`;
    }
    if (mission.playbook) {
      proposal.savePlaybookNote = `playbook ${mission.playbook.name} verified for ${mission.missionType}`;
    }
  }

  if (failed) {
    proposal.saveAntiPattern = `mission ${mission.missionType} failed: ${mission.userGoal.slice(0, 200)}`;
    proposal.saveAvoidance = `avoid this approach next time for ${mission.missionType}`;
    if (!repro?.reproduced) {
      proposal.saveMissingEvidence = `mission lacked reproduction; needed a focused command before patching`;
    }
  }

  return proposal;
}

export function buildMissionBugMemoryCard(mission: Mission): MissionBugMemoryCard | null {
  const repro = mission.repro;
  if (!repro?.reproduced && mission.status !== "complete") return null;
  if (!mission.patchSummary.trim() && mission.status !== "no_change_needed") return null;
  const language = mission.projectOrientation?.languages[0] ?? inferLanguage(mission.filesTouched, repro?.topStackFiles ?? []);
  const keyFiles = unique([...mission.filesTouched, ...(repro?.topStackFiles ?? [])]).slice(0, 8);
  const testSignal = [
    repro?.failureKind,
    repro?.errorType,
    ...(repro?.failingTests ?? []),
    mission.testsRun[0] ?? repro?.command
  ].filter(Boolean).join(" | ");
  const rootCause = mission.evidence?.memoryHits[0]?.rootCause
    ?? mission.patchSummary
    ?? repro?.summary
    ?? mission.userGoal;
  const fixPattern = mission.evidence?.memoryHits[0]?.fixPattern
    ?? mission.patchSummary
    ?? "Use the smallest local change that makes the focused repro pass.";
  const workflowSteps = [
    repro?.command ? `Reproduce with: ${repro.command}` : "Reproduce with the narrowest focused command.",
    keyFiles.length ? `Inspect: ${keyFiles.join(", ")}` : "Inspect the failing stack file or smallest related local module.",
    "Compare local code against any memory/docs hypothesis before editing.",
    `Apply fix pattern: ${fixPattern}`,
    mission.verification?.summary ? `Verify: ${mission.verification.summary}` : (mission.testsRun[0] ? `Verify with: ${mission.testsRun[0]}` : "Verify with the focused repro before broad checks.")
  ];
  const symptom = repro?.summary || mission.userGoal;
  return {
    id: `mission-${mission.id}`,
    source_mission_id: mission.id,
    created_at: new Date().toISOString(),
    repo: repoName(mission.repoRoot),
    language,
    bug_type: mission.missionType,
    symptom,
    root_cause: rootCause,
    fix_pattern: fixPattern,
    failed_approaches: mission.evidence?.doNotDo ?? [],
    key_files: keyFiles,
    search_keywords: unique([
      ...tokenish(mission.userGoal),
      ...tokenish(repro?.errorType ?? ""),
      ...tokenish(repro?.failureKind ?? ""),
      ...keyFiles.flatMap(tokenish)
    ]).slice(0, 16),
    test_signal: testSignal,
    embedding_text: [
      mission.missionType,
      symptom,
      rootCause,
      fixPattern,
      testSignal,
      workflowSteps.join(" ")
    ].filter(Boolean).join("\n"),
    quality_score: mission.status === "complete" && mission.verification?.failures.length === 0 ? 0.95 : 0.75,
    quality_tier: mission.status === "complete" ? "high" : "medium",
    workflow_steps: workflowSteps,
    do_not_do: mission.evidence?.doNotDo ?? []
  };
}

export function missionBugMemoryPath(cwd: string): string {
  return join(cwd, ".cheater", "bug_memories.jsonl");
}

export function saveMissionBugMemoryCard(cwd: string, mission: Mission): { saved: boolean; path: string; card: MissionBugMemoryCard | null } {
  const card = buildMissionBugMemoryCard(mission);
  const path = missionBugMemoryPath(cwd);
  if (!card) return { saved: false, path, card };
  appendJsonl(path, card);
  return { saved: true, path, card };
}

export interface PersistLearningOptions {
  cwd: string;
  config: CheaterConfig;
  proposal: LearningProposal;
  mission: Mission;
}

export interface PersistLearningResult {
  saved: string[];
  skipped: string[];
}

export function persistLearning(options: PersistLearningOptions): PersistLearningResult {
  const saved: string[] = [];
  const skipped: string[] = [];

  if (options.config.autoSaveLearning) {
    return saveAll(options, saved, skipped);
  }

  return { saved, skipped };
}

function appendJsonl(file: string, entry: object): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { flag: "a", encoding: "utf8" });
}

function saveAll(options: PersistLearningOptions, saved: string[], skipped: string[]): PersistLearningResult {
  const dir = join(options.cwd, ".cheater", "learn");
  mkdirSync(dir, { recursive: true });

  if (options.proposal.saveBugMemory) {
    appendJsonl(join(dir, "bug_memory_proposals.jsonl"), { missionId: options.mission.id, ...options.proposal.saveBugMemory });
    saveMissionBugMemoryCard(options.cwd, options.mission);
    saved.push("bugMemory");
  }
  if (options.proposal.saveProjectFact) {
    appendJsonl(join(dir, "project_facts.jsonl"), { missionId: options.mission.id, fact: options.proposal.saveProjectFact });
    saved.push("projectFact");
  }
  if (options.proposal.savePlaybookNote) {
    appendJsonl(join(dir, "playbook_notes.jsonl"), { missionId: options.mission.id, note: options.proposal.savePlaybookNote });
    saved.push("playbookNote");
  }
  if (options.proposal.saveAntiPattern) {
    appendJsonl(join(dir, "anti_patterns.jsonl"), { missionId: options.mission.id, anti_pattern: options.proposal.saveAntiPattern });
    saved.push("antiPattern");
  }
  if (options.proposal.saveAvoidance) {
    appendJsonl(join(dir, "avoidance_rules.jsonl"), { missionId: options.mission.id, rule: options.proposal.saveAvoidance });
    saved.push("avoidance");
  }
  if (options.proposal.saveMissingEvidence) {
    appendJsonl(join(dir, "missing_evidence.jsonl"), { missionId: options.mission.id, note: options.proposal.saveMissingEvidence });
    saved.push("missingEvidence");
  }
  return { saved, skipped };
}

function repoName(repoRoot: string): string {
  return repoRoot.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") || "(local)";
}

function inferLanguage(files: string[], stackFiles: string[]): string {
  const all = [...files, ...stackFiles].join(" ");
  if (/\.(ts|tsx)\b/.test(all)) return "TypeScript";
  if (/\.(js|jsx)\b/.test(all)) return "JavaScript";
  if (/\.py\b/.test(all)) return "Python";
  if (/\.go\b/.test(all)) return "Go";
  if (/\.rs\b/.test(all)) return "Rust";
  return "(unknown)";
}

function tokenish(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function recordMissionEnd(mission: Mission, status: MissionStatus, summary: string): Mission {
  return {
    ...mission,
    status,
    currentStep: summary,
    updatedAt: new Date().toISOString()
  };
}

export function learningPath(cwd: string): string {
  const dir = join(cwd, ".cheater", "learn");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
