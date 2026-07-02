import type { CheaterConfig } from "./types.js";

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
    "status: /cheater /autopilot-status /reliability-status /commitlet-status /rollback-status /commitlet-health",
    "memory: compacted solved-bug corpus auto-consulted on failures via cheater_bug_memory_search"
  ];
  if (gymOn(config)) lines.push("gym (local benchmark): /gym /gym-list /gym-run /gym-report");
  return lines;
}

export function commandHelp(config?: CheaterConfig): string {
  const lines: string[] = [
    "Cheater commands",
    "Normal workflow",
    "Just ask - autopilot routes code requests through: reliability_start -> edit -> commitlet_next -> verify -> finish_gate.",
    "/cheater  Show Cheater help and status",
    "/autopilot-status Show latest automatic routing decision",
    "/reliability-status Show Reliability Kernel status (with run telemetry)",
    "/commitlet-status Show active commitlet status",
    "/commitlet-plan Show active commitlet chain",
    "/commitlet-revert Revert current or named commitlet if safe",
    "/commitlet-health Show latest health/final review",
    "/rollback-status Show rollback snapshot status",
    "/constraint-graph Show compact repo constraint graph facts",
    "/bench-report Show latest reliability benchmark report",
    "/model-profile Show local-model packet settings"
  ];

  if (blueprintOn(config)) {
    lines.push(
      "/blueprint-show Show current internal blueprint plan",
      "/blueprint-cancel Cancel current blueprint run",
      "/blueprint-docs <query> Search official/local docs facts",
      "/blueprint-memory Show blueprint memories"
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
    "Debug-only commands",
    "/commitlet-next Prepare the next fresh-call commitlet",
    "/commitlet-debug Show detailed commitlet JSON",
    "Use these only when inspecting Cheater itself; normal coding requests should go through Autopilot."
  );

  return lines.join("\n");
}
