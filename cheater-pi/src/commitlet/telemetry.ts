import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommitletPlan, CommitletTelemetryEvent } from "./types.js";

export interface CommitletTelemetryOptions {
  startedAt?: number;
  finishedAt?: number;
  modelProfile?: string;
  contextBudget?: number;
  toolCalls?: number;
  loopEvents?: number;
  tokenInput?: number;
  tokenOutput?: number;
  userIntervention?: number;
}

export function telemetryFromPlan(plan: CommitletPlan, options: number | CommitletTelemetryOptions = {}): CommitletTelemetryEvent {
  const opts = typeof options === "number" ? { startedAt: options } : options;
  const finishedAtMs = opts.finishedAt ?? Date.now();
  const parsedCreatedAt = Date.parse(plan.createdAt);
  const startedAtMs = opts.startedAt ?? (Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : finishedAtMs);
  const startedAt = new Date(startedAtMs).toISOString();
  const finishedAt = new Date(finishedAtMs).toISOString();
  return {
    startedAt,
    finishedAt,
    taskKind: plan.autopilotDecision?.taskKind ?? "unknown",
    executionDiscipline: plan.autopilotDecision?.executionDiscipline ?? "none",
    modelProfile: opts.modelProfile,
    contextBudget: opts.contextBudget,
    commitletCount: plan.commitlets.length,
    toolCalls: opts.toolCalls,
    loopEvents: opts.loopEvents ?? 0,
    verificationPassed: plan.commitlets.every((commitlet) => commitlet.result?.verificationPassed !== false),
    healthScore: plan.finalReview.health.score,
    testAuditPassed: !plan.finalReview.blockingIssues.some((issue) => /test/i.test(issue)),
    repairCount: plan.commitlets.filter((commitlet) => commitlet.status === "repaired").length,
    rollbackCount: plan.commitlets.filter((commitlet) => commitlet.rollbackPoint).length,
    finalOutcome: plan.status,
    tokenInput: opts.tokenInput,
    tokenOutput: opts.tokenOutput,
    userIntervention: opts.userIntervention,
    wallMs: Math.max(0, finishedAtMs - startedAtMs)
  };
}

export function writeTelemetry(repoRoot: string, event: CommitletTelemetryEvent): string {
  const dir = join(repoRoot, ".cheater", "telemetry");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `reliability-${Date.now().toString(36)}.json`);
  writeFileSync(file, JSON.stringify(event, null, 2), "utf8");
  return file;
}
