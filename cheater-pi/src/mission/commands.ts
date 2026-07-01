import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyTask, type ClassifyInput } from "./classifier.js";
import { loadOrientation, pickFocusedTestCommand, scanOrientation, saveOrientation } from "./orientation.js";
import { runRepro } from "./repro.js";
import { gatherEvidence, formatEvidencePacket } from "./evidence.js";
import { allPlaybooks, getPlaybook, playbookFor } from "./playbooks.js";
import { runOracleStack } from "./oracles.js";
import { formatClassification, formatMissionDashboard, formatOrientation, formatPlaybook } from "./ui.js";
import { proposeLearning, saveMissionBugMemoryCard } from "./learn.js";
import { loadDeltaBench, summarizeDeltaBench } from "./bench.js";
import type { CheaterConfig } from "../types.js";
import type { Mission, MissionStore } from "./store.js";
import type { ClassificationResult, MissionType } from "./types.js";

type ExtensionAPI = any;
type CommandContext = any;

export interface MissionCommandDeps {
  store: MissionStore;
  config: CheaterConfig;
  getCwd: (ctx: CommandContext) => string;
  saveProjectMemory?: (cwd: string, text: string) => string;
  notify?: (ctx: CommandContext, text: string, level?: "info" | "warning") => void;
  widget?: (ctx: CommandContext, key: string, lines: string[]) => void;
  sendUserMessage?: (pi: ExtensionAPI, text: string) => void;
}

function notifyDefault(deps: MissionCommandDeps, ctx: CommandContext, text: string, level: "info" | "warning" = "info"): void {
  if (deps.notify) {
    deps.notify(ctx, text, level);
  } else {
    ctx.ui.notify(text, level);
  }
  if (deps.widget) {
    deps.widget(ctx, "cheater-mission", text.split("\n").slice(0, 60));
  } else {
    ctx.ui.setWidget?.("cheater-mission", text.split("\n").slice(0, 60), { placement: "aboveEditor" });
  }
}

function startMission(deps: MissionCommandDeps, ctx: CommandContext, userGoal: string, overrideType?: MissionType): Mission {
  const cwd = deps.getCwd(ctx);
  const repoHints = {
    hasPackageJson: existsSync(join(cwd, "package.json")),
    hasPyproject: existsSync(join(cwd, "pyproject.toml")),
    hasTests: existsSync(join(cwd, "tests")) || existsSync(join(cwd, "test"))
  };
  const classification = overrideType
    ? {
        missionType: overrideType,
        confidence: 0.7,
        why: "user explicitly requested this mission type",
        recommendedFirstSteps: ["scan orientation", "reproduce or prove no-op"],
        shouldPatch: overrideType !== "explanation_only",
        needsRepro: overrideType === "bug_fix" || overrideType === "test_failure" || overrideType === "import_error" || overrideType === "type_error",
        risk: "medium" as const
      }
    : classifyTask({ message: userGoal, repoHints, reproRequired: deps.config.reproRequiredBeforePatch !== false });

  const mission = deps.store.create({ userGoal, missionType: classification.missionType, repoRoot: cwd });
  const withClassification = deps.store.setClassification(mission.id, classification);
  deps.store.setStatus(withClassification.id, "orienting", "classified");
  const orientation = loadOrientation(cwd) ?? scanOrientation(cwd);
  if (!loadOrientation(cwd)) saveOrientation(cwd, orientation);
  const withOrientation = deps.store.setProjectOrientation(withClassification.id, orientation);
  const playbook = playbookFor(classification.missionType, !!withOrientation.repro?.reproduced);
  return deps.store.setPlaybook(withOrientation.id, playbook);
}

function renderDashboard(deps: MissionCommandDeps, ctx: CommandContext, mission: Mission): void {
  const text = formatMissionDashboard(mission);
  notifyDefault(deps, ctx, text);
}

export function registerMissionCommands(pi: ExtensionAPI, deps: MissionCommandDeps): void {
  pi.registerCommand("mission", {
    description: "Start a Cheater Mission Control flow",
    handler: async (args: string, ctx: CommandContext) => {
      const goal = args.trim();
      if (!goal) {
        const active = deps.store.active();
        if (active) {
          renderDashboard(deps, ctx, active);
          return;
        }
        notifyDefault(deps, ctx, "Usage: /mission <task description>", "warning");
        return;
      }
      const mission = startMission(deps, ctx, goal);
      renderDashboard(deps, ctx, mission);
      if (deps.sendUserMessage) {
        deps.sendUserMessage(pi, buildMissionBrief(mission));
      }
    }
  });

  pi.registerCommand("mission-status", {
    description: "Show the active Cheater mission dashboard",
    handler: async (_args: string, ctx: CommandContext) => {
      const active = deps.store.active();
      if (!active) {
        notifyDefault(deps, ctx, "No active Cheater mission. Use /mission to start one.", "warning");
        return;
      }
      renderDashboard(deps, ctx, active);
    }
  });

  pi.registerCommand("mission-cancel", {
    description: "Cancel the active Cheater mission",
    handler: async (_args: string, ctx: CommandContext) => {
      const active = deps.store.active();
      if (!active) {
        notifyDefault(deps, ctx, "No active mission to cancel.", "warning");
        return;
      }
      const updated = deps.store.setStatus(active.id, "cancelled", "user_cancelled");
      renderDashboard(deps, ctx, updated);
    }
  });

  pi.registerCommand("mission-save", {
    description: "Persist active Cheater mission learning",
    handler: async (_args: string, ctx: CommandContext) => {
      const active = deps.store.active();
      if (!active) {
        notifyDefault(deps, ctx, "No active mission to save.", "warning");
        return;
      }
      const proposal = proposeLearning({ mission: active, cwd: active.repoRoot, config: deps.config });
      const saved: string[] = [];
      if (proposal.saveBugMemory) {
        const id = `mission-${active.id}`;
        const text = `bug_memory ${id}: ${proposal.saveBugMemory.summary}`;
        const card = saveMissionBugMemoryCard(active.repoRoot, active);
        if (deps.saveProjectMemory) {
          deps.saveProjectMemory(active.repoRoot, text);
        }
        if (card.saved) saved.push("bugMemoryCard");
        else if (deps.saveProjectMemory) saved.push("bugMemoryNote");
      }
      if (proposal.saveProjectFact) {
        if (deps.saveProjectMemory) {
          deps.saveProjectMemory(active.repoRoot, `project fact: ${proposal.saveProjectFact}`);
          saved.push("projectFact");
        }
      }
      if (proposal.savePlaybookNote) {
        if (deps.saveProjectMemory) {
          deps.saveProjectMemory(active.repoRoot, `playbook note: ${proposal.savePlaybookNote}`);
          saved.push("playbookNote");
        }
      }
      if (proposal.saveAntiPattern) {
        if (deps.saveProjectMemory) {
          deps.saveProjectMemory(active.repoRoot, `anti-pattern: ${proposal.saveAntiPattern}`);
          saved.push("antiPattern");
        }
      }
      notifyDefault(deps, ctx, saved.length > 0 ? `Saved: ${saved.join(", ")}` : "Nothing to save yet.");
    }
  });

  pi.registerCommand("fix", {
    description: "Shortcut: start a bug_fix Cheater mission",
    handler: async (args: string, ctx: CommandContext) => {
      const goal = args.trim();
      if (!goal) {
        notifyDefault(deps, ctx, "Usage: /fix <failing test, error, or bug description>", "warning");
        return;
      }
      const mission = startMission(deps, ctx, goal, "bug_fix");
      renderDashboard(deps, ctx, mission);
      if (deps.sendUserMessage) {
        deps.sendUserMessage(pi, buildMissionBrief(mission));
      }
    }
  });

  pi.registerCommand("orient", {
    description: "Show / refresh Cheater project orientation",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const refresh = /\brefresh\b/i.test(args);
      const facts = refresh ? scanOrientation(cwd) : (loadOrientation(cwd) ?? scanOrientation(cwd));
      if (refresh || !loadOrientation(cwd)) saveOrientation(cwd, facts);
      const active = deps.store.active();
      if (active) {
        deps.store.setProjectOrientation(active.id, facts);
      }
      notifyDefault(deps, ctx, formatOrientation(facts));
    }
  });

  pi.registerCommand("orientation", {
    description: "Alias for /orient",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const facts = loadOrientation(cwd) ?? scanOrientation(cwd);
      notifyDefault(deps, ctx, formatOrientation(facts));
    }
  });

  pi.registerCommand("repro", {
    description: "Run the repro gate for the active mission",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const active = deps.store.active();
      const orientation = active?.projectOrientation ?? loadOrientation(cwd) ?? scanOrientation(cwd);
      const command = args.trim() || pickFocusedTestCommand(orientation) || "";
      if (!command) {
        const noCommand = runRepro({ cwd, command: "", allowNoCommand: true });
        if (active) {
          const updated = deps.store.setRepro(active.id, noCommand.result);
          deps.store.setStatus(updated.id, "waiting_for_user", "awaiting_repro_command");
        }
        notifyDefault(deps, ctx, noCommand.result.summary, "warning");
        return;
      }
      const output = runRepro({ cwd, command });
      if (active) {
        const updated = deps.store.setRepro(active.id, output.result);
        deps.store.addCommand(updated.id, command);
        if (output.result.reproduced) {
          deps.store.setStatus(updated.id, "gathering_evidence", "repro_done");
        } else if (output.result.alreadyPassing) {
          deps.store.setStatus(updated.id, "no_change_needed", "no_op_detected");
        } else if (output.result.environmentFailure) {
          deps.store.setStatus(updated.id, "failed", "env_failure");
        }
      }
      notifyDefault(deps, ctx, `${output.result.summary}\nfailure kind: ${output.result.failureKind}\nfailing tests: ${output.result.failingTests.length}\nfiles: ${output.result.topStackFiles.join(", ") || "(none)"}\nexit: ${output.result.exitCode}`);
    }
  });

  pi.registerCommand("evidence", {
    description: "Gather evidence for the active mission",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const active = deps.store.active();
      const orientation = active?.projectOrientation ?? loadOrientation(cwd) ?? scanOrientation(cwd);
      const query = args.trim() || active?.userGoal || active?.repro?.errorType || "current failure";
      if (!active) {
        notifyDefault(deps, ctx, "No active mission. Use /mission or /fix to start one.", "warning");
        return;
      }
      const packet = await gatherEvidence({
        cwd,
        query,
        repro: active.repro,
        orientation,
        onlineEnabled: deps.config.onlineEvidenceEnabled,
        offlineStackOverflowEnabled: deps.config.offlineStackOverflowEnabled ?? false,
        maxItems: deps.config.maxEvidenceItems ?? 5
      });
      const updated = deps.store.setEvidence(active.id, packet);
      deps.store.setStatus(updated.id, "patching", "evidence_gathered");
      notifyDefault(deps, ctx, formatEvidencePacket(packet));
    }
  });

  pi.registerCommand("playbook", {
    description: "Show the playbook for the active mission",
    handler: async (args: string, ctx: CommandContext) => {
      const name = args.trim();
      if (name) {
        const playbook = getPlaybook(name);
        if (!playbook) {
          notifyDefault(deps, ctx, `Unknown playbook: ${name}`, "warning");
          return;
        }
        notifyDefault(deps, ctx, formatPlaybook(playbook));
        return;
      }
      const active = deps.store.active();
      if (!active) {
        const list = allPlaybooks().map((p) => p.name).join(", ");
        notifyDefault(deps, ctx, `No active mission. Available playbooks: ${list}`);
        return;
      }
      const playbook = active.playbook ?? playbookFor(active.missionType, !!active.repro?.reproduced);
      notifyDefault(deps, ctx, formatPlaybook(playbook));
    }
  });

  pi.registerCommand("verify", {
    description: "Run the Cheater oracle stack for the active mission",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const active = deps.store.active();
      const orientation = active?.projectOrientation ?? loadOrientation(cwd) ?? scanOrientation(cwd);
      const focused = args.trim() || active?.repro?.command || pickFocusedTestCommand(orientation) || "";
      const report = runOracleStack({
        cwd,
        orientation,
        focusedCommand: focused,
        runBroadTests: deps.config.oracleRunBroadTests ?? "ask",
        runAllChecks: deps.config.oracleRunAllChecks !== false,
        userConfirmedBroad: /--broad\b/i.test(args)
      });
      if (active) {
        const updated = deps.store.setVerification(active.id, report);
        const allGreen = [report.focusedTestsOk, report.typecheckOk, report.lintOk, report.broadTestsOk].every((v) => v === null || v === true);
        deps.store.setStatus(updated.id, allGreen ? "complete" : "verifying", "oracles_run");
      }
      const ok = report.failures.length === 0;
      notifyDefault(deps, ctx, `${report.summary}${focused ? `\nfocused: ${focused}` : ""}`, ok ? "info" : "warning");
    }
  });

  pi.registerCommand("learn", {
    description: "Propose or persist learning from the active mission",
    handler: async (args: string, ctx: CommandContext) => {
      const active = deps.store.active();
      if (!active) {
        notifyDefault(deps, ctx, "No active mission to learn from.", "warning");
        return;
      }
      const proposal = proposeLearning({ mission: active, cwd: active.repoRoot, config: deps.config });
      if (/--save\b/i.test(args) && deps.config.autoSaveLearning) {
        notifyDefault(deps, ctx, "Saved learning (auto-save mode).");
        return;
      }
      const lines = [
        "Cheater learning proposal",
        `bugMemory: ${proposal.saveBugMemory ? proposal.saveBugMemory.summary : "(none)"}`,
        `projectFact: ${proposal.saveProjectFact ?? "(none)"}`,
        `playbookNote: ${proposal.savePlaybookNote ?? "(none)"}`,
        `antiPattern: ${proposal.saveAntiPattern ?? "(none)"}`,
        `avoidance: ${proposal.saveAvoidance ?? "(none)"}`,
        `missingEvidence: ${proposal.saveMissingEvidence ?? "(none)"}`,
        "Use /mission-save to persist confirmed items."
      ];
      notifyDefault(deps, ctx, lines.join("\n"));
    }
  });

  pi.registerCommand("delta-bench", {
    description: "Show mini Cheater delta-benchmark report",
    handler: async (args: string, ctx: CommandContext) => {
      const cwd = deps.getCwd(ctx);
      const entries = loadDeltaBench(cwd);
      if (entries.length === 0) {
        notifyDefault(deps, ctx, "No delta-bench entries recorded yet.", "warning");
        return;
      }
      const summary = summarizeDeltaBench(entries);
      const lines = [
        `Cheater delta-bench`,
        `total: ${summary.total}`,
        `by mode: ${Object.entries(summary.byMode).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        `success rate: ${summary.successRate}`,
        `reproduction rate: ${summary.reproductionRate}`,
        `no-op rate: ${summary.noOpRate}`,
        `avg evidence confidence: ${summary.averageConfidence}`,
        `per mission:`,
        ...Object.entries(summary.perMission).map(([k, v]) => `  - ${k}: ${v.success}/${v.count}`)
      ];
      if (/--raw\b/i.test(args)) {
        lines.push(`entries:`);
        for (const entry of entries.slice(-10)) {
          lines.push(`  - ${entry.at} ${entry.mode} ${entry.missionType} success=${entry.success} conf=${entry.evidenceConfidence}`);
        }
      }
      notifyDefault(deps, ctx, lines.join("\n"));
    }
  });
}

function buildMissionBrief(mission: Mission): string {
  return [
    `Cheater Mission Control started.`,
    `type: ${mission.missionType}`,
    `playbook: ${mission.playbook?.name ?? "(none)"}`,
    `next:`,
    `  1. /orient to confirm project facts`,
    `  2. /repro <focused command> to reproduce the failure (or prove no-op)`,
    `  3. /evidence to consult bug memory + docs`,
    `  4. patch only after evidence supports a cause`,
    `  5. /verify to run the oracle stack`,
    `  6. /learn to propose saving, /mission-save to persist`,
    `goal: ${mission.userGoal}`
  ].join("\n");
}
