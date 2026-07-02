import { Type } from "typebox";
import { classifyTask } from "./classifier.js";
import { loadOrientation, pickFocusedTestCommand, scanOrientation, saveOrientation } from "./orientation.js";
import { runRepro } from "./repro.js";
import { gatherEvidence, formatEvidencePacket } from "./evidence.js";
import { playbookFor } from "./playbooks.js";
import { runOracleStack } from "./oracles.js";
import { sdkFreshBugWorkerRunner, type FreshBugWorkerRunner } from "./bugWorker.js";
import { formatClassification, formatMissionDashboard, formatOrientation, formatPlaybook } from "./ui.js";
import type { CheaterConfig } from "../types.js";
import type { MissionStore } from "./store.js";
import type { MissionType } from "./types.js";

type ExtensionAPI = any;
type ExtensionContext = any;

function textResult(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text", text }],
    details
  };
}

export interface MissionToolDeps {
  store: MissionStore;
  config: CheaterConfig;
  bugRunner?: FreshBugWorkerRunner;
}

export function registerMissionTools(pi: ExtensionAPI, deps: MissionToolDeps): void {
  const bugRunner = deps.bugRunner ?? sdkFreshBugWorkerRunner;

  pi.registerTool({
    name: "cheater_mission_classify",
    label: "Cheater Mission Classify",
    description: "Classify a user task into a Cheater Mission Control type and return recommended next steps.",
    promptSnippet: "cheater_mission_classify - decide whether to patch, repro, or just explain before doing anything.",
    parameters: Type.Object({
      message: Type.String({ description: "User request text" }),
      recentErrors: Type.Optional(Type.String({ description: "Optional recent error / test output" }))
    }),
    async execute(_id: string, params: { message: string; recentErrors?: string }) {
      const result = classifyTask({
        message: params.message,
        recentErrors: params.recentErrors,
        reproRequired: deps.config.reproRequiredBeforePatch !== false
      });
      return textResult(formatClassification(result), result);
    }
  });

  pi.registerTool({
    name: "cheater_mission_start",
    label: "Cheater Mission Start",
    description: "Start a Cheater mission for a user goal. Persists state, classifies, scans orientation, and selects a playbook.",
    parameters: Type.Object({
      goal: Type.String({ description: "User goal" }),
      missionType: Type.Optional(Type.String({ description: "Override the auto-detected mission type" }))
    }),
    async execute(_id: string, params: { goal: string; missionType?: string }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const override = params.missionType as MissionType | undefined;
      const mission = deps.store.create({ userGoal: params.goal, missionType: override ?? "unknown", repoRoot: cwd });
      const classification = override
        ? {
            missionType: override,
            confidence: 0.7,
            why: "explicit override",
            recommendedFirstSteps: ["scan orientation", "reproduce or prove no-op"],
            shouldPatch: override !== "explanation_only",
            needsRepro: override === "bug_fix" || override === "test_failure" || override === "import_error" || override === "type_error",
            risk: "medium" as const
          }
        : classifyTask({ message: params.goal, reproRequired: deps.config.reproRequiredBeforePatch !== false });
      const updated = deps.store.setClassification(mission.id, classification);
      const orientation = loadOrientation(cwd) ?? scanOrientation(cwd);
      if (!loadOrientation(cwd)) saveOrientation(cwd, orientation);
      const withOrientation = deps.store.setProjectOrientation(updated.id, orientation);
      const playbook = playbookFor(classification.missionType, !!withOrientation.repro?.reproduced);
      const withPlaybook = deps.store.setPlaybook(withOrientation.id, playbook);
      deps.store.setStatus(withPlaybook.id, "orienting", "started");
      return textResult(formatMissionDashboard(withPlaybook), { id: withPlaybook.id });
    }
  });

  pi.registerTool({
    name: "cheater_mission_status",
    label: "Cheater Mission Status",
    description: "Show the active Cheater mission dashboard.",
    parameters: Type.Object({
      missionId: Type.Optional(Type.String({ description: "Mission id; defaults to active mission" }))
    }),
    async execute(_id: string, params: { missionId?: string }) {
      const mission = params.missionId ? deps.store.get(params.missionId) : deps.store.active();
      if (!mission) return textResult("No Cheater mission is active.");
      return textResult(formatMissionDashboard(mission), { id: mission.id });
    }
  });

  pi.registerTool({
    name: "cheater_mission_cancel",
    label: "Cheater Mission Cancel",
    description: "Cancel the active Cheater mission.",
    parameters: Type.Object({
      missionId: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: { missionId?: string }) {
      const mission = params.missionId ? deps.store.get(params.missionId) : deps.store.active();
      if (!mission) return textResult("No Cheater mission to cancel.");
      const updated = deps.store.setStatus(mission.id, "cancelled", "user_cancelled");
      return textResult(formatMissionDashboard(updated));
    }
  });

  pi.registerTool({
    name: "cheater_orientation_scan",
    label: "Cheater Orientation Scan",
    description: "Scan the current repo and persist a compact orientation cache.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const facts = scanOrientation(ctx.cwd);
      saveOrientation(ctx.cwd, facts);
      return textResult(formatOrientation(facts));
    }
  });

  pi.registerTool({
    name: "cheater_orientation_show",
    label: "Cheater Orientation Show",
    description: "Show the cached Cheater project orientation, or scan on miss.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const cached = loadOrientation(ctx.cwd);
      const facts = cached ?? scanOrientation(ctx.cwd);
      if (!cached) saveOrientation(ctx.cwd, facts);
      return textResult(formatOrientation(facts));
    }
  });

  pi.registerTool({
    name: "cheater_orientation_update",
    label: "Cheater Orientation Update",
    description: "Refresh and persist the Cheater project orientation cache.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const facts = scanOrientation(ctx.cwd);
      saveOrientation(ctx.cwd, facts);
      return textResult(formatOrientation(facts));
    }
  });

  pi.registerTool({
    name: "cheater_repro_gate",
    label: "Cheater Repro Gate",
    description: "Run a focused command through the Cheater repro gate and parse a compact result.",
    parameters: Type.Object({
      command: Type.Optional(Type.String({ description: "Focused command to run; if empty, ask the user" })),
      allowNoCommand: Type.Optional(Type.Boolean({ description: "Allow empty command and return a waiting state" }))
    }),
    async execute(_id: string, params: { command?: string; allowNoCommand?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const output = runRepro({ cwd: ctx.cwd, command: params.command ?? "", allowNoCommand: params.allowNoCommand });
      const active = deps.store.active();
      if (active) {
        const updated = deps.store.setRepro(active.id, output.result);
        if (params.command) deps.store.addCommand(updated.id, params.command);
      }
      return textResult(
        [
          output.result.summary,
          `reproduced: ${output.result.reproduced}`,
          `alreadyPassing: ${output.result.alreadyPassing}`,
          `environmentFailure: ${output.result.environmentFailure}`,
          `failureKind: ${output.result.failureKind}`,
          `failingTests: ${output.result.failingTests.join(", ") || "(none)"}`,
          `topStackFiles: ${output.result.topStackFiles.join(", ") || "(none)"}`,
          `errorType: ${output.result.errorType || "(none)"}`,
          `exitCode: ${output.result.exitCode}`
        ].join("\n"),
        output.result
      );
    }
  });

  pi.registerTool({
    name: "cheater_evidence_packet",
    label: "Cheater Evidence Packet",
    description: "Gather a compact evidence packet (bug memory hits, orientation, local docs) for a failure.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Query string; defaults to active mission goal or repro error" }))
    }),
    async execute(_id: string, params: { query?: string }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const active = deps.store.active();
      const orientation = active?.projectOrientation ?? loadOrientation(ctx.cwd) ?? scanOrientation(ctx.cwd);
      const query = params.query ?? active?.userGoal ?? active?.repro?.errorType ?? "current failure";
      const packet = await gatherEvidence({
        cwd: ctx.cwd,
        query,
        repro: active?.repro ?? null,
        orientation,
        onlineEnabled: deps.config.onlineEvidenceEnabled,
        offlineStackOverflowEnabled: deps.config.offlineStackOverflowEnabled ?? false,
        maxItems: deps.config.maxEvidenceItems ?? 5
      });
      if (active) deps.store.setEvidence(active.id, packet);
      return textResult(formatEvidencePacket(packet), { confidence: packet.confidence });
    }
  });

  pi.registerTool({
    name: "cheater_bug_worker",
    label: "Cheater Bug Worker",
    description: "Gather bug memory and dispatch a fresh isolated LLM session to fix one bug/failure.",
    promptSnippet: "cheater_bug_worker - use bug memory, then spawn a fresh bug-fix agent for one failure.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Bug-fix goal; defaults to the active mission goal" })),
      query: Type.Optional(Type.String({ description: "Failure text or memory query; defaults to active repro/goal" })),
      focusedCommand: Type.Optional(Type.String({ description: "Focused command the worker must run" }))
    }),
    async execute(_id: string, params: { goal?: string; query?: string; focusedCommand?: string }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      if (deps.config.bugFreshAgentEnabled === false) {
        return textResult("Fresh bug workers are disabled by config.", { ok: false });
      }
      const active = deps.store.active();
      const orientation = active?.projectOrientation ?? loadOrientation(ctx.cwd) ?? scanOrientation(ctx.cwd);
      const goal = params.goal ?? active?.userGoal ?? "fix current bug";
      const query = params.query ?? active?.repro?.summary ?? active?.repro?.errorType ?? goal;
      const focusedCommand = params.focusedCommand ?? active?.repro?.command ?? pickFocusedTestCommand(orientation);
      const evidence = await gatherEvidence({
        cwd: ctx.cwd,
        query,
        repro: active?.repro ?? {
          reproduced: true,
          alreadyPassing: false,
          environmentFailure: false,
          command: focusedCommand ?? "",
          exitCode: 1,
          failureKind: "unknown",
          failingTests: [],
          errorType: "",
          topStackFiles: [],
          summary: query
        },
        orientation,
        onlineEnabled: deps.config.onlineEvidenceEnabled,
        offlineStackOverflowEnabled: deps.config.offlineStackOverflowEnabled ?? false,
        maxItems: deps.config.maxEvidenceItems ?? 5
      });
      if (active) deps.store.setEvidence(active.id, evidence);
      const result = await bugRunner.runBug({
        cwd: ctx.cwd,
        goal,
        query,
        repro: active?.repro ?? null,
        orientation,
        evidence,
        focusedCommand,
        config: deps.config
      });
      return textResult(
        [
          "Spawned fresh bug worker session.",
          `status: ${result.ok ? "done" : "failed"}`,
          result.sessionId ? `session: ${result.sessionId}` : undefined,
          result.sessionFile ? `sessionFile: ${result.sessionFile}` : undefined,
          "",
          result.summary
        ].filter(Boolean).join("\n"),
        { ok: result.ok, result, evidence }
      );
    }
  });

  pi.registerTool({
    name: "cheater_playbook_show",
    label: "Cheater Playbook Show",
    description: "Show the playbook for the active mission or for a named playbook.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Playbook name; defaults to active mission" }))
    }),
    async execute(_id: string, params: { name?: string }) {
      const active = deps.store.active();
      if (params.name) {
        const playbook = playbookFor(params.name as MissionType, !!active?.repro?.reproduced);
        return textResult(formatPlaybook(playbook));
      }
      if (!active) return textResult("No active mission. Pass a name like 'bug_fix' or 'refactor'.");
      const playbook = active.playbook ?? playbookFor(active.missionType, !!active.repro?.reproduced);
      return textResult(formatPlaybook(playbook));
    }
  });

  pi.registerTool({
    name: "cheater_oracle_stack",
    label: "Cheater Oracle Stack",
    description: "Run the Cheater verification stack: focused test, typecheck, lint, and optional broad tests.",
    parameters: Type.Object({
      focusedCommand: Type.Optional(Type.String()),
      broadCommand: Type.Optional(Type.String()),
      userConfirmedBroad: Type.Optional(Type.Boolean())
    }),
    async execute(_id: string, params: { focusedCommand?: string; broadCommand?: string; userConfirmedBroad?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const active = deps.store.active();
      const orientation = active?.projectOrientation ?? loadOrientation(ctx.cwd) ?? scanOrientation(ctx.cwd);
      const focused = params.focusedCommand ?? active?.repro?.command ?? pickFocusedTestCommand(orientation) ?? "";
      const report = runOracleStack({
        cwd: ctx.cwd,
        orientation,
        focusedCommand: focused,
        broadCommand: params.broadCommand,
        runBroadTests: deps.config.oracleRunBroadTests ?? "ask",
        runAllChecks: deps.config.oracleRunAllChecks !== false,
        userConfirmedBroad: params.userConfirmedBroad ?? false
      });
      if (active) {
        deps.store.setVerification(active.id, report);
        if (focused) deps.store.addTestsRun(active.id, [focused]);
      }
      return textResult(JSON.stringify(report, null, 2), report);
    }
  });

  pi.registerTool({
    name: "cheater_mission_learn",
    label: "Cheater Mission Learn",
    description: "Propose (or persist if auto-save is on) learning from the active mission.",
    parameters: Type.Object({
      save: Type.Optional(Type.Boolean({ description: "If true and auto-save is enabled, persist the proposed learning" }))
    }),
    async execute(_id: string, params: { save?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const active = deps.store.active();
      if (!active) return textResult("No active mission to learn from.");
      const { proposeLearning, saveMissionBugMemoryCard } = await import("./learn.js");
      const proposal = proposeLearning({ mission: active, cwd: ctx.cwd, config: deps.config });
      const lines = [
        `bugMemory: ${proposal.saveBugMemory ? proposal.saveBugMemory.summary : "(none)"}`,
        `projectFact: ${proposal.saveProjectFact ?? "(none)"}`,
        `playbookNote: ${proposal.savePlaybookNote ?? "(none)"}`,
        `antiPattern: ${proposal.saveAntiPattern ?? "(none)"}`,
        `avoidance: ${proposal.saveAvoidance ?? "(none)"}`,
        `missingEvidence: ${proposal.saveMissingEvidence ?? "(none)"}`
      ];
      if (params.save && deps.config.autoSaveLearning) {
        const { saveMemory } = await import("../tools.js");
        if (proposal.saveBugMemory) {
          saveMemory(ctx.cwd, `bug_memory: ${proposal.saveBugMemory.summary}`);
          const savedCard = saveMissionBugMemoryCard(ctx.cwd, active);
          lines.push(savedCard.saved ? `bugMemoryCard: ${savedCard.path}` : "bugMemoryCard: skipped");
        }
        if (proposal.saveProjectFact) saveMemory(ctx.cwd, `project fact: ${proposal.saveProjectFact}`);
        if (proposal.savePlaybookNote) saveMemory(ctx.cwd, `playbook note: ${proposal.savePlaybookNote}`);
        if (proposal.saveAntiPattern) saveMemory(ctx.cwd, `anti-pattern: ${proposal.saveAntiPattern}`);
        if (proposal.saveAvoidance) saveMemory(ctx.cwd, `avoidance: ${proposal.saveAvoidance}`);
        if (proposal.saveMissingEvidence) saveMemory(ctx.cwd, `missing evidence: ${proposal.saveMissingEvidence}`);
        lines.push("status: saved (auto-save)");
      } else {
        // cheater_memory_search only searches memory notes; it cannot persist one. The one
        // real persist path when autoSaveLearning is off is the /mission-save command.
        lines.push("status: proposed only (use /mission-save to persist)");
      }
      return textResult(lines.join("\n"), proposal);
    }
  });

  pi.registerTool({
    name: "cheater_delta_bench",
    label: "Cheater Delta Bench",
    description: "Record a Cheater delta-benchmark entry or summarize past entries.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "cheater or vanilla" })),
      action: Type.Optional(Type.String({ description: "record or summarize" })),
      missionType: Type.Optional(Type.String()),
      success: Type.Optional(Type.Boolean()),
      reproductionDone: Type.Optional(Type.Boolean()),
      noOpDetected: Type.Optional(Type.Boolean()),
      memoryUsed: Type.Optional(Type.Boolean()),
      evidenceConfidence: Type.Optional(Type.Number()),
      filesRead: Type.Optional(Type.Number()),
      filesEdited: Type.Optional(Type.Number()),
      testsRun: Type.Optional(Type.Number()),
      rawCommandFailures: Type.Optional(Type.Number()),
      verification: Type.Optional(Type.String()),
      userAccepted: Type.Optional(Type.Boolean()),
      notes: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: {
      mode?: string;
      action?: string;
      missionType?: string;
      success?: boolean;
      reproductionDone?: boolean;
      noOpDetected?: boolean;
      memoryUsed?: boolean;
      evidenceConfidence?: number;
      filesRead?: number;
      filesEdited?: number;
      testsRun?: number;
      rawCommandFailures?: number;
      verification?: string;
      userAccepted?: boolean;
      notes?: string;
    }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const { buildDeltaBenchEntry, loadDeltaBench, recordDeltaBench, summarizeDeltaBench } = await import("./bench.js");
      const action = params.action ?? (params.mode ? "record" : "summarize");
      if (action === "summarize") {
        const entries = loadDeltaBench(ctx.cwd);
        const summary = summarizeDeltaBench(entries);
        return textResult(JSON.stringify(summary, null, 2), summary);
      }
      const entry = buildDeltaBenchEntry({
        mode: (params.mode === "vanilla" ? "vanilla" : "cheater"),
        missionType: (params.missionType as MissionType) ?? "unknown",
        success: params.success ?? false,
        reproductionDone: params.reproductionDone ?? false,
        noOpDetected: params.noOpDetected ?? false,
        memoryUsed: params.memoryUsed ?? false,
        evidenceConfidence: params.evidenceConfidence ?? 0,
        filesRead: params.filesRead ?? 0,
        filesEdited: params.filesEdited ?? 0,
        testsRun: params.testsRun ?? 0,
        rawCommandFailures: params.rawCommandFailures ?? 0,
        verification: params.verification ?? "",
        userAccepted: params.userAccepted ?? null,
        notes: params.notes ?? ""
      });
      const result = recordDeltaBench({ cwd: ctx.cwd, entry });
      return textResult(`recorded: ${result.indexPath}`, entry);
    }
  });
}
