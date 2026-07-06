// Tool exposure lattice: the runtime has many capabilities; the model sees few choices.
//
// This planner only ever SHRINKS what a session can touch. Worker roles get subsets of the
// existing 8-tool worker set (never more); the controller keeps orchestration tools but its
// file/shell tools are blocked when real workers exist; validators can read and run checks
// but cannot edit. No mode adds a tool that today's flow does not already expose - the whole
// point is fewer choices for a small model, with enforcement at spawn time (tool list) and
// at tool_call time (hook blocks), never by prompt begging alone.

export type ExposureMode =
  | "answer_only"
  | "controller_planner"
  | "worker_read"
  | "worker_edit"
  | "validator"
  | "reviewer"
  | "repair"
  | "reserve";

export interface ToolExposurePlan {
  mode: ExposureMode;
  /** Pi-native tool list for a spawned worker session (undefined = main session, not a worker). */
  workerTools?: string[];
  /** Native tools the tool_call hook must block for this mode in the MAIN session. */
  blockedNativeTools: string[];
  /** cheater_* tools that may stay visible (main-session masks; workers get none). */
  visibleCheaterTools: string[];
  notes: string[];
}

// Mirrors WORKER_TOOLS in blueprint/worker.ts (asserted equal by test). Kept literal here so
// the lattice has no runtime dependency on the Pi SDK import graph.
export const WORKER_EDIT_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "cheater_line_edit"];
export const WORKER_READ_TOOLS = ["read", "grep", "find", "ls"];
export const VALIDATOR_TOOLS = ["read", "grep", "find", "ls", "bash"];

/** Orchestration tools no spawned worker may ever see or call. */
export const CONTROLLER_ONLY_TOOLS = [
  "cheater_reliability_start",
  "cheater_commitlet_next",
  "cheater_finish_gate",
  "cheater_verification_run",
  "cheater_commitlet_revert"
];

/** Broad retrieval tools workers must not see by default: retrieval is controller-side. */
export const RETRIEVAL_TOOLS = ["cheater_memory_search"];

const MAIN_SESSION_CHEATER_TOOLS: Record<string, string[]> = {
  answer_only: ["cheater_reliability_start", "cheater_memory_search", "cheater_project_brief"],
  controller_planner: ["cheater_reliability_start", "cheater_commitlet_next", "cheater_verification_run", "cheater_finish_gate", "cheater_ledger_status"],
  validator: ["cheater_verification_run", "cheater_finish_gate", "cheater_ledger_status"],
  reserve: ["cheater_verification_run", "cheater_finish_gate", "cheater_ledger_status"]
};

export function planToolExposure(mode: ExposureMode): ToolExposurePlan {
  switch (mode) {
    case "answer_only":
      return { mode, blockedNativeTools: [], visibleCheaterTools: MAIN_SESSION_CHEATER_TOOLS.answer_only, notes: ["read-only conversation; reliability_start stays reachable (a misroute must never lock the flow)"] };
    case "controller_planner":
      return {
        mode,
        blockedNativeTools: ["read", "edit", "write", "grep", "find", "ls", "bash"],
        visibleCheaterTools: MAIN_SESSION_CHEATER_TOOLS.controller_planner,
        notes: ["controller plans and integrates; file/shell work belongs to workers (enforced only when real workers can spawn)"]
      };
    case "worker_read":
      return { mode, workerTools: WORKER_READ_TOOLS, blockedNativeTools: ["write", "edit", "bash", "cheater_line_edit"], visibleCheaterTools: [], notes: ["bounded inspection only"] };
    case "worker_edit":
      return { mode, workerTools: WORKER_EDIT_TOOLS, blockedNativeTools: [], visibleCheaterTools: [], notes: ["edit allowed files, run focused checks, report, terminate"] };
    case "repair":
      return { mode, workerTools: WORKER_EDIT_TOOLS, blockedNativeTools: [], visibleCheaterTools: [], notes: ["targeted fix for a named failing validation only"] };
    case "reviewer":
      return { mode, workerTools: WORKER_READ_TOOLS, blockedNativeTools: ["write", "edit", "bash", "cheater_line_edit"], visibleCheaterTools: [], notes: ["read and judge; never fix"] };
    case "validator":
      return { mode, workerTools: VALIDATOR_TOOLS, blockedNativeTools: ["write", "edit", "cheater_line_edit"], visibleCheaterTools: MAIN_SESSION_CHEATER_TOOLS.validator, notes: ["run checks and read ledgers; edits require repair mode"] };
    case "reserve":
      return { mode, blockedNativeTools: [], visibleCheaterTools: MAIN_SESSION_CHEATER_TOOLS.reserve, notes: ["final cheap checks only; risky state changes are blocked by the phase hook"] };
  }
}

/** A worker tool list may never contain controller/spawn/retrieval tools. */
export function violatesWorkerToolPolicy(tools: string[]): string | null {
  for (const tool of tools) {
    if (CONTROLLER_ONLY_TOOLS.includes(tool)) return `worker tool list contains controller tool ${tool}`;
    if (RETRIEVAL_TOOLS.includes(tool)) return `worker tool list contains broad retrieval tool ${tool} (retrieval is controller-side)`;
  }
  if (tools.length > WORKER_EDIT_TOOLS.length) {
    return `worker tool list has ${tools.length} tools - more than the ${WORKER_EDIT_TOOLS.length}-tool baseline; exposure may only shrink`;
  }
  return null;
}

/** Map a commitlet to its worker exposure mode. */
export function workerModeForCommitlet(commitlet: { id: string; scope?: string; allowedActions?: string[] }): ExposureMode {
  if (/-repair$/.test(commitlet.id)) return "repair";
  if (commitlet.scope === "review") return "reviewer";
  const actions = commitlet.allowedActions ?? [];
  if (actions.length && !actions.includes("edit")) return "worker_read";
  return "worker_edit";
}
