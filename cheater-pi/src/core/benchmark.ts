/** Internal benchmark seams. These types are deliberately not re-exported from the product entrypoint. */
import { createHash } from "node:crypto";

export const TB2_TASK_IDS = [
  "cancel-async-tasks", "configure-git-webserver", "db-wal-recovery", "fix-code-vulnerability",
  "fix-git", "fix-ocaml-gc", "git-leak-recovery", "git-multibranch", "headless-terminal",
  "kv-store-grpc", "large-scale-text-editing", "sanitize-git-repo",
] as const;

export type BenchmarkAgent = "kitten" | "opencode" | "omp";
export type BenchmarkProfile = "full" | "minimal" | "no-compiler" | "no-ascent" | "no-sidecar" | "no-learned";

export interface CampaignManifest {
  schemaVersion: 1;
  campaignId: string;
  frozenAt: string;
  dataset: { name: string; revision: string; sha256: string };
  model: { name: string; endpointId: string };
  budgets: { ceilingSeconds: number; maxModalUsd: number; maxTransferBytes: number };
  executionOrder: Record<BenchmarkAgent, string[]>;
  tasks: Array<{ id: string; image: string; imageDigest: string; repository?: string }>;
  agents: Record<BenchmarkAgent, { version: string; bundleSha256: string; adapter: string; configurationSha256: string }>;
  resultSchema: "trial-record-v1";
}

export interface AgentAdapter {
  name: BenchmarkAgent;
  version: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  bundleSha256: string;
  configurationSha256: string;
}

export interface TrialRecord {
  schemaVersion: 1;
  campaignId: string;
  taskId: string;
  agent: BenchmarkAgent;
  profile: BenchmarkProfile;
  orderIndex: number;
  status: "passed" | "failed" | "timeout" | "invalid" | "interrupted";
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  modelTokens?: { prompt: number; completion: number; reasoning: number };
  modelTimeMs?: number;
  patchSha256?: string;
  imageDigest: string;
  summary?: string;
  failureExcerpt?: string;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function configurationHash(value: unknown): string {
  return sha256(stableJson(value));
}

export function resolveBenchmarkProfile(env: NodeJS.ProcessEnv = process.env): BenchmarkProfile {
  const value = env.KITTEN_BENCH_PROFILE?.trim().toLowerCase();
  return value === "minimal" || value === "no-compiler" || value === "no-ascent" || value === "no-sidecar" || value === "no-learned"
    ? value : "full";
}

export function validateCampaignManifest(manifest: CampaignManifest): void {
  if (manifest.schemaVersion !== 1 || manifest.resultSchema !== "trial-record-v1") throw new Error("unsupported campaign manifest schema");
  if (manifest.budgets.ceilingSeconds !== 900) throw new Error("TB2 ceiling must be exactly 900 seconds");
  if (manifest.budgets.maxModalUsd > 20 || manifest.budgets.maxTransferBytes > 250 * 1024 * 1024) throw new Error("campaign budget exceeds hard cap");
  const ids = new Set(manifest.tasks.map((task) => task.id));
  if (ids.size !== manifest.tasks.length) throw new Error("campaign contains duplicate task ids");
  for (const task of manifest.tasks) if (!task.imageDigest.startsWith("sha256:")) throw new Error(`missing image digest for ${task.id}`);
  for (const agent of ["kitten", "opencode", "omp"] as const) {
    if (!manifest.agents[agent] || manifest.executionOrder[agent]?.length !== manifest.tasks.length) throw new Error(`incomplete ${agent} campaign data`);
  }
}

export function rotateExecutionOrder(taskIds: readonly string[], offset: number): string[] {
  if (!taskIds.length) return [];
  const n = ((offset % taskIds.length) + taskIds.length) % taskIds.length;
  return [...taskIds.slice(n), ...taskIds.slice(0, n)];
}

