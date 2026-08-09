// Versioned, approval-bound plans. A plan is a durable product artifact, not a prompt that gets
// regenerated when the user clicks Implement.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export type PlanStatus = "draft" | "needs_review" | "approved" | "running" | "completed" | "cancelled" | "superseded";

export interface PlanStep {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  agent: string;
  modelTier: "main" | "sidecar";
  allowedFiles: string[];
  forbiddenFiles: string[];
  acceptanceCriteria: string[];
  verification: string[];
  workspaceMode: "shared-readonly" | "isolated-worktree";
}

export interface PlanArtifact {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  revision: number;
  request: string;
  projectRoot: string;
  workspaceFingerprint: string;
  status: PlanStatus;
  goal: string;
  requirements: string[];
  nonGoals: string[];
  assumptions: string[];
  risks: string[];
  steps: PlanStep[];
  verification: string[];
  hash: string;
  approvedHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanPatch {
  goal?: string;
  requirements?: string[];
  nonGoals?: string[];
  assumptions?: string[];
  risks?: string[];
  steps?: PlanStep[];
  verification?: string[];
  workspaceFingerprint?: string;
}

function bounded(value: string, max: number): string { return value.trim().slice(0, max); }
function list(values: readonly string[] | undefined, maxItems: number, maxChars = 500): string[] {
  return [...new Set((values ?? []).map((value) => bounded(String(value), maxChars)).filter(Boolean))].slice(0, maxItems);
}

/** Stable JSON is used for approval and drift checks; object insertion order must not matter. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function hashPlan(plan: Omit<PlanArtifact, "hash" | "approvedHash">): string {
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

function normalizeStep(step: Partial<PlanStep>, index: number): PlanStep {
  const edit = /\b(edit|write|modify|implement|delete|create)\b/i.test(`${step.agent ?? ""} ${step.objective ?? ""}`);
  return {
    id: bounded(String(step.id ?? `step-${index + 1}`), 80),
    title: bounded(String(step.title ?? step.objective ?? `Step ${index + 1}`), 160),
    objective: bounded(String(step.objective ?? step.title ?? ""), 4000),
    dependsOn: list(step.dependsOn, 32, 80),
    agent: bounded(String(step.agent ?? (edit ? "general" : "explore")), 80),
    modelTier: step.modelTier === "sidecar" ? "sidecar" : "main",
    allowedFiles: list(step.allowedFiles, 64, 260),
    forbiddenFiles: list(step.forbiddenFiles, 64, 260),
    acceptanceCriteria: list(step.acceptanceCriteria, 32),
    verification: list(step.verification, 16),
    workspaceMode: step.workspaceMode === "isolated-worktree" || edit ? "isolated-worktree" : "shared-readonly",
  };
}

export function createPlanArtifact(input: {
  id: string;
  conversationId: string;
  request: string;
  projectRoot: string;
  workspaceFingerprint: string;
  goal?: string;
  requirements?: string[];
  nonGoals?: string[];
  assumptions?: string[];
  risks?: string[];
  steps: readonly Partial<PlanStep>[];
  verification?: string[];
  now: number;
}): PlanArtifact {
  const base: Omit<PlanArtifact, "hash" | "approvedHash"> = {
    schemaVersion: 1, id: bounded(input.id, 120), conversationId: bounded(input.conversationId, 120), revision: 1,
    request: bounded(input.request, 12_000), projectRoot: resolve(input.projectRoot), workspaceFingerprint: bounded(input.workspaceFingerprint, 128),
    status: "draft", goal: bounded(input.goal ?? input.request, 4000), requirements: list(input.requirements, 32), nonGoals: list(input.nonGoals, 32),
    assumptions: list(input.assumptions, 32), risks: list(input.risks, 32), steps: input.steps.slice(0, 32).map(normalizeStep),
    verification: list(input.verification, 16), createdAt: input.now, updatedAt: input.now,
  };
  if (!base.steps.length) throw new Error("plan must contain at least one step");
  return { ...base, hash: hashPlan(base) };
}

export function revisePlan(previous: PlanArtifact, patch: PlanPatch, now: number): PlanArtifact {
  if (previous.status === "running" || previous.status === "completed") throw new Error(`cannot revise a ${previous.status} plan`);
  const { hash: _previousHash, approvedHash: _previousApprovedHash, ...previousBase } = previous;
  const base: Omit<PlanArtifact, "hash" | "approvedHash"> = {
    ...previousBase,
    revision: previous.revision + 1,
    status: "draft",
    goal: bounded(patch.goal ?? previous.goal, 4000),
    requirements: list(patch.requirements ?? previous.requirements, 32),
    nonGoals: list(patch.nonGoals ?? previous.nonGoals, 32),
    assumptions: list(patch.assumptions ?? previous.assumptions, 32),
    risks: list(patch.risks ?? previous.risks, 32),
    steps: (patch.steps ?? previous.steps).slice(0, 32).map(normalizeStep),
    verification: list(patch.verification ?? previous.verification, 16),
    workspaceFingerprint: bounded(patch.workspaceFingerprint ?? previous.workspaceFingerprint, 128),
    updatedAt: now,
  };
  if (!base.steps.length) throw new Error("plan must contain at least one step");
  return { ...base, hash: hashPlan(base) };
}

export function approvePlan(plan: PlanArtifact, now: number): PlanArtifact {
  if (plan.status !== "draft" && plan.status !== "needs_review") throw new Error(`cannot approve a ${plan.status} plan`);
  return { ...plan, status: "approved", approvedHash: plan.hash, updatedAt: now };
}

export function isApprovedExact(plan: PlanArtifact): boolean {
  // A cancelled run may resume the same approved revision; drifted/superseded/completed artifacts
  // must still go through an explicit revision and approval cycle.
  return (plan.status === "approved" || plan.status === "cancelled") && plan.approvedHash === plan.hash;
}

/** Fingerprint only the planned files. Unrelated edits and commits do not drift a plan. */
export function workspaceFingerprint(root: string, files: readonly string[] = []): string {
  const base = resolve(root);
  const chunks: string[] = [];
  // Do not include the repository's global HEAD: an unrelated commit must not invalidate an
  // approved plan. Planned-file content (including missing-file markers) is the drift boundary.
  for (const file of [...new Set(files.map((f) => f.replaceAll("\\", "/")))].sort()) {
    const absolute = resolve(base, file);
    const rel = relative(base, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    try {
      const stat = statSync(absolute);
      const content = stat.isFile() ? readFileSync(absolute) : Buffer.from(`dir:${stat.mtimeMs}`);
      chunks.push(`${rel}:${createHash("sha256").update(content).digest("hex")}`);
    } catch { chunks.push(`${rel}:missing`); }
  }
  return createHash("sha256").update(chunks.join("\n")).digest("hex");
}

export function planJson(plan: PlanArtifact): string { return stableJson(plan); }
