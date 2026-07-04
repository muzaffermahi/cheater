// Live run console: a compact, always-current status widget so the user can SEE what Cheater is
// doing during a multi-minute local run (which mode, which commitlet, what just verified, what the
// sidecar is up to, backend health) instead of staring at a bare spinner.
//
// Split into a PURE renderer (renderRunConsole, fully testable) and a thin gatherer/updater that
// reads the harness singletons and pushes the lines to a Pi widget. Reading-only; never mutates
// run state, never blocks.

import { defaultCommitletState } from "../commitlet/state.js";
import { liveSessionState } from "./sessionState.js";
import { sidecarScheduler } from "../sidecar/scheduler.js";
import { steeringControl } from "../runstate/steering.js";
import { workerBackendReason, workerBackendState } from "../blueprint/worker.js";

export interface RunConsoleSnapshot {
  status: string;
  goal?: string;
  commitlet?: string;
  progress?: { done: number; total: number };
  lastVerification?: { stage: string; status: string };
  changedFiles: number;
  unresolvedFailures: number;
  sidecar?: string;
  steering?: string;
  backend?: string;
}

const BAR_WIDTH = 16;

function progressBar(done: number, total: number): string {
  if (total <= 0) return "";
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH)));
  return `[${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}] ${done}/${total}`;
}

/** Pure renderer: snapshot -> widget lines. Deterministic and testable. */
export function renderRunConsole(snapshot: RunConsoleSnapshot): string[] {
  const lines = [`Cheater - ${snapshot.status}`];
  if (snapshot.goal) lines.push(`goal: ${snapshot.goal.slice(0, 70)}`);
  if (snapshot.progress && snapshot.progress.total > 0) {
    lines.push(`commitlets: ${progressBar(snapshot.progress.done, snapshot.progress.total)}`);
  }
  if (snapshot.commitlet) lines.push(`current: ${snapshot.commitlet.slice(0, 70)}`);
  if (snapshot.lastVerification) lines.push(`verify: ${snapshot.lastVerification.stage} -> ${snapshot.lastVerification.status}`);
  const tallies: string[] = [];
  if (snapshot.changedFiles) tallies.push(`${snapshot.changedFiles} file(s) changed`);
  if (snapshot.unresolvedFailures) tallies.push(`${snapshot.unresolvedFailures} unresolved`);
  if (tallies.length) lines.push(tallies.join(", "));
  if (snapshot.sidecar) lines.push(snapshot.sidecar);
  if (snapshot.steering) lines.push(snapshot.steering);
  if (snapshot.backend) lines.push(`backend: ${snapshot.backend}`);
  return lines;
}

/** Gather a snapshot from the harness singletons. Read-only, defensive, never throws. */
export function runConsoleSnapshot(): RunConsoleSnapshot | null {
  try {
    const plan = defaultCommitletState.get().currentPlan;
    const ledger = liveSessionState.getLedger();
    const state = ledger?.get();
    // Nothing to show for an idle session with no active plan and no work recorded.
    if (!plan && !(state && (state.changedFiles.length || state.verification.length))) return null;

    const commitlets = plan?.commitlets ?? [];
    const done = commitlets.filter((c) => c.status === "passed").length;
    const running = commitlets.find((c) => c.status === "running");
    const lastVerify = state?.verification.at(-1);
    const backendState = workerBackendState();

    return {
      status: plan ? `running (${plan.status})` : "working",
      goal: state?.userGoal || plan?.userGoal,
      commitlet: running?.title,
      progress: commitlets.length ? { done, total: commitlets.length } : undefined,
      lastVerification: lastVerify ? { stage: lastVerify.stage, status: lastVerify.status } : undefined,
      changedFiles: state?.changedFiles.length ?? 0,
      unresolvedFailures: state?.unresolvedFailures.length ?? 0,
      // Show the clerk whenever a real client is configured (so ONLINE/OFFLINE is visible even
      // before it dispatches) or once it has done work this session.
      sidecar: (sidecarScheduler.stateLine() !== "" || sidecarScheduler.stats().dispatched > 0) ? sidecarScheduler.consoleLine() : undefined,
      steering: (steeringControl.pendingCount() > 0 || steeringControl.stopRequested()) ? steeringControl.statusLine() : undefined,
      backend: backendState === "unavailable" ? `unavailable - ${workerBackendReason()}` : backendState
    };
  } catch {
    return null;
  }
}

type ExtensionAPI = { on: (event: string, handler: (...args: unknown[]) => unknown) => void };

/**
 * Register the live run console: refresh a widget on notification events (turn boundaries, tool
 * results) so it tracks the run in real time. Pure-notification taps only, so it never interferes.
 */
export function registerRunConsole(pi: ExtensionAPI): void {
  const refresh = (_event: unknown, ctx: any) => {
    try {
      const snapshot = runConsoleSnapshot();
      if (snapshot) ctx?.ui?.setWidget?.("cheater-run-console", renderRunConsole(snapshot), { placement: "aboveEditor" });
    } catch {
      // the console must never break a turn
    }
  };
  pi.on("turn_end", refresh);
  pi.on("tool_execution_end", refresh);
  pi.on("agent_end", refresh);
}
