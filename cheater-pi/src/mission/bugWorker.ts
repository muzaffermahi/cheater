import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createCheaterBugMemorySearchTool, createCheaterLineEditTool } from "../tools.js";
import type { CheaterConfig } from "../types.js";
import { compactSettingsForCap, compactThresholdTokens, effectiveAgentTokenCap, withIsolatedWorker } from "../blueprint/worker.js";
import type { EvidencePacket, ProjectFacts, ReproResult } from "./types.js";

export interface FreshBugWorkerResult {
  ok: boolean;
  summary: string;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
}

export interface FreshBugWorkerRunner {
  runBug(params: {
    cwd: string;
    goal: string;
    query: string;
    repro: ReproResult | null;
    orientation: ProjectFacts | null;
    evidence: EvidencePacket;
    focusedCommand?: string;
    config: CheaterConfig;
  }): Promise<FreshBugWorkerResult>;
}

function bugSessionId(): string {
  return `cheater-bug-${Date.now().toString(36)}`;
}

function summarizeAssistant(text: string | undefined): string {
  const cleaned = (text ?? "").trim().replace(/\n{3,}/g, "\n\n");
  if (!cleaned) return "Bug worker stopped without a final assistant summary.";
  return cleaned.length <= 1800 ? cleaned : `${cleaned.slice(0, 1800)}\n...`;
}

function renderEvidence(evidence: EvidencePacket): string {
  const memory = evidence.memoryHits.slice(0, 5).map((hit) =>
    `- ${hit.id} score=${hit.score} ${hit.bugType}; root=${hit.rootCause}; fix=${hit.fixPattern}`
  );
  return [
    `failureKind: ${evidence.failureKind}`,
    `reproduced: ${evidence.reproduced}`,
    `confidence: ${evidence.confidence}`,
    `strategy: ${evidence.recommendedStrategy}`,
    "bug memory:",
    ...(memory.length ? memory : ["- none"]),
    "do not:",
    ...evidence.doNotDo.slice(0, 6).map((item) => `- ${item}`)
  ].join("\n");
}

function bugPrompt(params: {
  goal: string;
  query: string;
  repro: ReproResult | null;
  orientation: ProjectFacts | null;
  evidence: EvidencePacket;
  focusedCommand?: string;
  cap: number;
}): string {
  const testCommands = params.orientation?.testCommands ?? [];
  const typecheckCommands = params.orientation?.typecheckCommands ?? [];
  const lintCommands = params.orientation?.lintCommands ?? [];
  return [
    "CHEATER FRESH BUG WORKER SESSION",
    "",
    `Goal: ${params.goal}`,
    `Failure/query: ${params.query}`,
    `Hard token cap for this worker: ${params.cap}`,
    "",
    "Rules:",
    "- You are a fresh bug-fix worker, not the planner.",
    "- Use the bug memory below as hypotheses only; verify against local code before editing.",
    "- Reproduce or use the provided repro signal before patching unless the failure is already reproduced.",
    "- Make the smallest justified code change. Use cheater_line_edit for existing files.",
    "- Do not edit tests to force a pass unless the user explicitly asked for test changes.",
    "- Run the focused command and then any discovered typecheck/lint/broad tests that apply.",
    "- If tests fail, consult bug memory again or stop with a compact failure summary; do not loop.",
    "- End with BUG_WORKER_RESULT, SUMMARY, FILES_TOUCHED, TESTS_RUN, and REMAINING_FAILURES.",
    "",
    "Repro:",
    params.repro ? JSON.stringify(params.repro, null, 2) : "(none provided)",
    "",
    "Evidence:",
    renderEvidence(params.evidence),
    "",
    `Focused command: ${params.focusedCommand || params.repro?.command || testCommands[0] || "(none)"}`,
    `All test commands: ${testCommands.join(" | ") || "(none)"}`,
    `Typecheck commands: ${typecheckCommands.join(" | ") || "(none)"}`,
    `Lint commands: ${lintCommands.join(" | ") || "(none)"}`
  ].join("\n");
}

export const sdkFreshBugWorkerRunner: FreshBugWorkerRunner = {
  async runBug(params) {
    return withIsolatedWorker(async () => {
      const cap = effectiveAgentTokenCap(params.config);
      const threshold = compactThresholdTokens(params.config);
      const settingsManager = SettingsManager.inMemory({
        compaction: compactSettingsForCap(undefined, cap, threshold),
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time"
      }, { projectTrusted: true });
      const sessionManager = SessionManager.create(params.cwd, undefined, { id: bugSessionId() });
      const { session } = await createAgentSession({
        cwd: params.cwd,
        sessionManager,
        settingsManager,
        tools: ["read", "edit", "bash", "grep", "find", "ls", "cheater_line_edit", "cheater_bug_memory_search"],
        customTools: [createCheaterLineEditTool(), createCheaterBugMemorySearchTool()]
      });
      try {
        const contextWindow = session.model?.contextWindow;
        const effectiveCap = effectiveAgentTokenCap(params.config, contextWindow);
        const effectiveThreshold = compactThresholdTokens(params.config, contextWindow);
        session.settingsManager.applyOverrides({
          compaction: compactSettingsForCap(contextWindow, effectiveCap, effectiveThreshold),
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time"
        });
        session.setAutoCompactionEnabled(true);
        session.setSessionName("Cheater bug worker");
        await session.prompt(bugPrompt({ ...params, cap: effectiveCap }), { source: "extension" });
        return {
          ok: true,
          summary: summarizeAssistant(session.getLastAssistantText()),
          sessionId: session.sessionId,
          sessionFile: session.sessionFile
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Bug worker failed: ${(err as Error).message}`,
          error: (err as Error).message,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile
        };
      } finally {
        session.dispose();
      }
    });
  }
};
