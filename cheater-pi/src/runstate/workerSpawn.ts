// Worker spawn specs: parent-context inheritance is explicit, never accidental.
//
// Every fresh worker is described by a WorkerSpawnSpec persisted next to its capsule. The
// forkMode default is "none" - the worker session starts empty and its prompt is rendered
// from the capsule/plan files, never from the parent chat. Inheriting history ("last_n" /
// "all") requires BOTH a config override and a logged reason, and still writes a warning
// event; there is no code path that silently defaults to it. Workers never spawn workers:
// their tool lists contain no controller/spawn tools (enforced by the exposure lattice).

import type { TaskRunState } from "./runState.js";
import type { ExposureMode } from "./toolExposure.js";
import { planToolExposure, violatesWorkerToolPolicy } from "./toolExposure.js";
import { appendRunEvent, writeRunFile } from "./runDir.js";
import type { CheaterConfig } from "../types.js";

export type ForkMode = "none" | "last_n" | "all";

export type WorkerRole = "controller" | "file_worker" | "frontend" | "backend" | "test" | "review" | "repair" | "docs";

export interface WorkerSpawnSpec {
  workerId: string;
  role: WorkerRole;
  taskName: string;
  forkMode: ForkMode;
  forkTurns?: number;
  capsulePath: string;
  planPath: string;
  reportPath: string;
  allowedFiles: string[];
  forbiddenFiles: string[];
  visibleToolMode: ExposureMode;
  tools: string[];
  maxContextTokens: number;
  maxToolCalls: number;
  phase: string;
}

export interface BuildSpawnSpecInput {
  run: TaskRunState;
  workerId: string;
  role: WorkerRole;
  taskName: string;
  allowedFiles: string[];
  forbiddenFiles: string[];
  mode: ExposureMode;
  maxContextTokens: number;
  maxToolCalls: number;
  config?: CheaterConfig;
}

export interface SpawnSpecResult {
  spec: WorkerSpawnSpec;
  warnings: string[];
}

/**
 * Build (and persist) the spawn spec. Fork inheritance is resolved here and nowhere else:
 * without the explicit override the requested mode is forced back to "none".
 */
export function buildWorkerSpawnSpec(input: BuildSpawnSpecInput): SpawnSpecResult {
  const warnings: string[] = [];
  const config = input.config ?? {};
  let forkMode: ForkMode = "none";
  const requested = config.workerForkMode;
  if (requested === "last_n" || requested === "all") {
    if (config.workerForkModeOverrideReason?.trim()) {
      forkMode = requested;
      const warning = `worker ${input.workerId} spawned with forkMode=${requested} (override reason: ${config.workerForkModeOverrideReason.slice(0, 120)}) - parent context WILL leak into this worker`;
      warnings.push(warning);
      appendRunEvent(input.run.runDir, "fork_mode_override", { workerId: input.workerId, forkMode: requested, reason: config.workerForkModeOverrideReason.slice(0, 200) });
    } else {
      warnings.push(`workerForkMode=${requested} requested without workerForkModeOverrideReason - forced back to "none"`);
    }
  }
  const exposure = planToolExposure(input.mode);
  const tools = exposure.workerTools ?? [];
  const policyViolation = violatesWorkerToolPolicy(tools);
  if (policyViolation) warnings.push(policyViolation);

  const spec: WorkerSpawnSpec = {
    workerId: input.workerId,
    role: input.role,
    taskName: input.taskName.slice(0, 160),
    forkMode,
    forkTurns: forkMode === "last_n" ? Math.max(1, Math.min(10, Number(config.workerForkTurns ?? 3))) : undefined,
    capsulePath: `capsules/${input.workerId}-capsule.json`,
    planPath: `workers/${input.workerId}.md`,
    reportPath: `reports/${input.workerId}-report.md`,
    allowedFiles: input.allowedFiles.slice(0, 8),
    forbiddenFiles: input.forbiddenFiles.slice(0, 8),
    visibleToolMode: input.mode,
    tools,
    maxContextTokens: input.maxContextTokens,
    maxToolCalls: input.maxToolCalls,
    phase: input.run.currentPhase()
  };
  try {
    writeRunFile(input.run.runDir, `workers/${input.workerId}.spawn.json`, JSON.stringify(spec, null, 2) + "\n");
  } catch {
    // best-effort persistence
  }
  appendRunEvent(input.run.runDir, "worker_spawn_spec", {
    workerId: spec.workerId,
    role: spec.role,
    forkMode: spec.forkMode,
    visibleToolMode: spec.visibleToolMode,
    toolCount: spec.tools.length
  });
  return { spec, warnings };
}

/** Map a commitlet role string onto the spec's role vocabulary. */
export function roleForCommitlet(commitlet: { id: string; scope?: string }): WorkerRole {
  if (/-repair$/.test(commitlet.id)) return "repair";
  if (commitlet.scope === "review") return "review";
  if (commitlet.scope === "test") return "test";
  if (commitlet.scope === "docs") return "docs";
  return "file_worker";
}
