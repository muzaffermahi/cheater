import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeltaBenchEntry, MissionType } from "./types.js";

export interface RecordDeltaBenchOptions {
  cwd: string;
  entry: DeltaBenchEntry;
}

export interface RecordDeltaBenchResult {
  path: string;
  indexPath: string;
}

function benchDir(cwd: string): string {
  const candidates = [join(cwd, ".cheater", "bench"), join(cwd, ".pi", "cheater", "bench")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const target = join(cwd, ".cheater", "bench");
  mkdirSync(target, { recursive: true });
  return target;
}

function benchIndex(dir: string): string {
  return join(dir, "index.jsonl");
}

export function recordDeltaBench(options: RecordDeltaBenchOptions): RecordDeltaBenchResult {
  const dir = benchDir(options.cwd);
  const indexPath = benchIndex(dir);
  writeFileSync(indexPath, `${JSON.stringify(options.entry)}\n`, { flag: "a", encoding: "utf8" });
  return { path: indexPath, indexPath };
}

export function loadDeltaBench(cwd: string): DeltaBenchEntry[] {
  const dir = benchDir(cwd);
  const file = benchIndex(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DeltaBenchEntry);
}

export interface DeltaBenchReport {
  total: number;
  byMode: Record<string, number>;
  successRate: number;
  reproductionRate: number;
  noOpRate: number;
  averageConfidence: number;
  perMission: Record<string, { count: number; success: number }>;
}

export function summarizeDeltaBench(entries: DeltaBenchEntry[]): DeltaBenchReport {
  const byMode: Record<string, number> = {};
  const perMission: Record<string, { count: number; success: number }> = {};
  let success = 0;
  let reproduced = 0;
  let noOp = 0;
  let confidenceSum = 0;
  for (const entry of entries) {
    byMode[entry.mode] = (byMode[entry.mode] ?? 0) + 1;
    const bucket = perMission[entry.missionType] ?? { count: 0, success: 0 };
    bucket.count += 1;
    if (entry.success) {
      bucket.success += 1;
      success += 1;
    }
    perMission[entry.missionType] = bucket;
    if (entry.reproductionDone) reproduced += 1;
    if (entry.noOpDetected) noOp += 1;
    confidenceSum += entry.evidenceConfidence;
  }
  const total = entries.length;
  return {
    total,
    byMode,
    successRate: total === 0 ? 0 : Number((success / total).toFixed(3)),
    reproductionRate: total === 0 ? 0 : Number((reproduced / total).toFixed(3)),
    noOpRate: total === 0 ? 0 : Number((noOp / total).toFixed(3)),
    averageConfidence: total === 0 ? 0 : Number((confidenceSum / total).toFixed(3)),
    perMission
  };
}

export interface BuildEntryInput {
  mode: "cheater" | "vanilla";
  missionType: MissionType;
  success: boolean;
  reproductionDone: boolean;
  noOpDetected: boolean;
  memoryUsed: boolean;
  evidenceConfidence: number;
  filesRead: number;
  filesEdited: number;
  testsRun: number;
  rawCommandFailures: number;
  verification: string;
  userAccepted: boolean | null;
  notes?: string;
}

export function buildDeltaBenchEntry(input: BuildEntryInput): DeltaBenchEntry {
  return {
    at: new Date().toISOString(),
    mode: input.mode,
    missionType: input.missionType,
    success: input.success,
    reproductionDone: input.reproductionDone,
    noOpDetected: input.noOpDetected,
    memoryUsed: input.memoryUsed,
    evidenceConfidence: input.evidenceConfidence,
    filesRead: input.filesRead,
    filesEdited: input.filesEdited,
    testsRun: input.testsRun,
    rawCommandFailures: input.rawCommandFailures,
    verification: input.verification,
    userAccepted: input.userAccepted,
    notes: input.notes ?? ""
  };
}
