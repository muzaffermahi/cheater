import type { CheaterConfig } from "./types.js";

function missionOn(config?: CheaterConfig): boolean {
  return config?.missionControlEnabled === true;
}

function gymOn(config?: CheaterConfig): boolean {
  return config?.gymEnabled !== false;
}

function blueprintOn(config?: CheaterConfig): boolean {
  return config?.blueprintModeEnabled !== false;
}

export function startupCard(cwd: string, model: string | undefined, config?: CheaterConfig): string[] {
  const lines = [
    "Cheater mode active",
    `repo: ${cwd}`,
    `model: ${model ?? "Pi default"}`,
    "Ask normally. Autopilot routes code requests through the one Reliability flow:",
    "  reliability_start -> edit allowed files -> commitlet_next -> verify -> finish_gate",
    "status: /cheater /autopilot-status /reliability-status /commitlet-status /rollback-status /health-report",
    "memory: compacted solved-bug corpus auto-consulted on failures via cheater_bug_memory_search"
  ];
  const optional: string[] = [];
  if (missionOn(config)) optional.push("mission: /mission /fix /orient /repro /evidence /verify /learn");
  if (gymOn(config)) optional.push("gym (local benchmark): /gym /gym-list /gym-run /gym-report");
  if (optional.length) lines.push(...optional);
  return lines;
}

export function commandHelp(config?: CheaterConfig): string {
  const lines: string[] = [
    "Cheater commands",
    "Normal workflow",
    "Just ask - autopilot routes code requests through: reliability_start -> edit -> commitlet_next -> verify -> finish_gate.",
    "/cheater  Show Cheater help and status",
    "/autopilot-status Show latest automatic routing decision",
    "/reliability-status Show Reliability Kernel status",
    "/commitlet-status Show active commitlet status",
    "/commitlet-plan Show active commitlet chain",
    "/commitlet-verify Run focused verification for a commitlet",
    "/commitlet-revert Revert current or named commitlet if safe",
    "/commitlet-health Show latest health/final review",
    "/rollback-status Show rollback snapshot status",
    "/health-report Show latest Reliability Kernel health report",
    "/constraint-graph Show compact repo constraint graph facts",
    "/bench-report Show latest reliability benchmark report",
    "/loop-report Show Loop Governor diagnostics",
    "/model-profile Show local-model packet settings"
  ];

  if (blueprintOn(config)) {
    lines.push(
      "/blueprint-show Show current internal blueprint plan",
      "/blueprint-review Run final blueprint review",
      "/blueprint-cancel Cancel current blueprint run",
      "/blueprint-force <goal> Force blueprint mode manually",
      "/blueprint-docs <query> Search official/local docs facts",
      "/blueprint-memory Show blueprint memories"
    );
  }

  if (missionOn(config)) {
    lines.push(
      "/mission  Start a Cheater Mission Control flow",
      "/fix      Shortcut: start a bug_fix mission",
      "/orient   Show or refresh Cheater project orientation",
      "/repro    Run the repro gate (focused command or no-op detection)",
      "/evidence Gather an evidence packet (memory + docs)",
      "/playbook Show the playbook for the active mission",
      "/verify   Run the oracle stack (focused/typecheck/lint/broad)",
      "/learn    Propose or persist learning from the active mission",
      "/delta-bench Show Cheater delta-benchmark report"
    );
  }

  if (gymOn(config)) {
    lines.push(
      "/gym      Cheater Gym help and status",
      "/gym-list List Cheater Gym tasks",
      "/gym-run <id>        Prepare a Gym task workspace and prompt",
      "/gym-run-suite [opts] Run a small suite of tasks",
      "/gym-report          Show the latest Gym report",
      "/gym-delta <id>      Show Cheater vs vanilla delta",
      "/gym-learn           Show learning suggestions from past runs",
      "/gym-clean           Remove Gym workspaces and reports"
    );
  }

  lines.push(
    "/test     Infer or run a focused test command",
    "/map      Ask Pi for a compact repo overview",
    "/bug-memory Search compacted solved-bug memories",
    "/remember Save a project note",
    "bug memory tool: cheater_bug_memory_search (auto-invoked on failures)",
    "/skills   List Cheater skills loaded by this package",
    "/traces   Show recent session/history guidance",
    "/settings Show Cheater settings",
    "/doctor   Run Cheater extension diagnostics",
    "",
    "Debug-only commands"
  );

  if (blueprintOn(config)) {
    lines.push(
      "/blueprint-candidates Inspect candidate scores",
      "/blueprint-step Dispatch the next packet through a fresh worker",
      "/blueprint-debug Show graph and packet details",
      "/blueprint-quality-repair Show planner-only quality-gate repair draft"
    );
  }
  lines.push(
    "/commitlet-next Prepare the next fresh-call commitlet",
    "/commitlet-finalize Run commitlet final review",
    "/commitlet-debug Show detailed commitlet JSON",
    "Use these only when inspecting Cheater itself; normal coding requests should go through Autopilot."
  );

  return lines.join("\n");
}
