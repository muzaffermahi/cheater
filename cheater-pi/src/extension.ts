import { buildSystemPrompt } from "./prompts.js";
import { registerCheaterCommands } from "./commands.js";
import { registerCheaterTools, saveMemory } from "./tools.js";
import { startupCard } from "./ui.js";
import { loadConfig } from "./config.js";
import { registerAutopilotCommands } from "./autopilot/commands.js";
import { routeAutopilot, buildAutopilotInstruction } from "./autopilot/router.js";
import { defaultAutopilotState } from "./autopilot/status.js";
import { formatAutopilotDecision } from "./autopilot/ui.js";
import { registerBlueprintCommands } from "./blueprint/commands.js";
import { registerBlueprintTools } from "./blueprint/tools.js";
import { defaultBlueprintState } from "./blueprint/state.js";
import { compactThresholdTokens, effectiveAgentTokenCap, isBlueprintWorkerSession } from "./blueprint/worker.js";
import { defaultMissionStore } from "./mission/store.js";
import { registerMissionCommands } from "./mission/commands.js";
import { registerMissionTools } from "./mission/tools.js";
import { registerGymCommands } from "./gym/commands.js";
import { registerReliabilityCommands } from "./reliability/commands.js";
import { registerCommitletCommands } from "./commitlet/commands.js";
import { registerCommitletTools } from "./commitlet/tools.js";
import { defaultCommitletState } from "./commitlet/state.js";
import { liveSessionState } from "./reliability/sessionState.js";
import { ledgerAllowsFinish } from "./reliability/lifecycle.js";
import { loadProjectCommands } from "./reliability/projectCommands.js";
import { checkFileSyntax } from "./reliability/diagnostics.js";
import { compressFailureOutput } from "./reliability/failureCompressor.js";
import { classifyFailure, type CompletionLedger } from "./reliability/lifecycle.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type ExtensionAPI = any;

const PLANNER_BLOCKED_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls", "bash"]);
const EDIT_TOOLS = new Set(["edit", "write", "cheater_line_edit"]);
const COMMAND_TOOLS = new Set(["bash", "run_command", "run", "shell"]);

// Mode-scoped cheater tool sets. Pi-native tools are never touched (we only ever filter the
// cheater_* namespace), so a small model - whose weakest skill is multi-tool orchestration -
// sees a handful of relevant tools per phase instead of the full ~20 cheater tools at once.
const CHEATER_TOOL_MODES: Record<"answer_only" | "planner" | "execute", string[]> = {
  answer_only: ["cheater_bug_memory_search", "cheater_project_brief"],
  planner: ["cheater_reliability_start", "cheater_commitlet_next", "cheater_verification_run", "cheater_finish_gate", "cheater_bug_memory_search", "cheater_ledger_status"],
  execute: ["cheater_reliability_start", "cheater_commitlet_next", "cheater_verification_run", "cheater_finish_gate", "cheater_line_edit", "cheater_bug_memory_search", "cheater_ledger_status", "cheater_rollback_status", "cheater_commitlet_revert", "cheater_project_brief", "cheater_focus_test", "cheater_diff_safety_check"]
};

function applyToolMask(ctx: any, mode: "answer_only" | "planner" | "execute"): void {
  const active: string[] | undefined = ctx.getActiveTools?.();
  if (!active || typeof ctx.setActiveTools !== "function") return;
  // Pi-native tools persist (never removed); recompute the cheater subset from the known
  // mode map so masking is reversible across turns.
  const piNative = active.filter((name) => !name.startsWith("cheater_"));
  ctx.setActiveTools([...piNative, ...CHEATER_TOOL_MODES[mode]]);
}

/**
 * Run the detected focused test once and record the stage into the ledger. Bounded by a
 * timeout so it cannot hang the turn. Returns true if it actually ran a command. (A fully
 * async, streaming runner is the follow-up; this sync version buys ground truth now.)
 */
/**
 * Compact restatement of goal + plan + progress, injected after compaction. Periodic goal
 * restatement into fresh context is the documented mitigation for small-model coherence
 * collapse in long trajectories.
 */
function buildWorkingSetCapsule(): string | null {
  const ledger = liveSessionState.getLedger();
  const plan = defaultCommitletState.get().currentPlan;
  if (!ledger && !plan) return null;
  const s = ledger?.get();
  const running = plan?.commitlets.find((c) => c.status === "running" || c.status === "pending");
  const done = plan ? plan.commitlets.filter((c) => ["passed", "skipped", "repaired"].includes(c.status)).length : 0;
  const lastV = s?.verification.at(-1);
  return [
    "Cheater working set (restated so it survives compaction):",
    s?.userGoal ? `goal: ${s.userGoal}` : "",
    plan ? `plan: commitlet ${done}/${plan.commitlets.length}${running ? `; next: ${running.title} (edit only: ${running.allowedFiles.join(", ")})` : ""}` : "",
    s?.changedFiles.length ? `files touched: ${s.changedFiles.slice(0, 6).join(", ")}` : "",
    lastV ? `last verification: ${lastV.stage} ${lastV.status}` : "",
    "Continue the active plan; do not restart planning."
  ].filter(Boolean).join("\n");
}

/** Compact, code-generated completion receipt: what the harness actually observed. */
function buildCompletionReceipt(ledger: CompletionLedger): string {
  const s = ledger.get();
  const okStages = s.verification.filter((v) => v.status === "ok").map((v) => v.stage);
  return [
    "Cheater: done - verified",
    `changed: ${s.changedFiles.slice(0, 6).join(", ") || "(none)"}`,
    `ran: ${s.commandsRun.slice(-3).join(" | ") || "(none)"}`,
    `verified: ${okStages.join(", ") || "(none)"}`
  ].join("\n");
}

function runCommandAsync(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(1); }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", () => finish(1));
  });
}

/**
 * Run the detected focused test once (async, so the extension host is not frozen) and record
 * the stage into the ledger. Returns true if it actually ran a command.
 */
async function harnessAutoVerify(cwd: string, ledger: CompletionLedger, ctx: any): Promise<boolean> {
  const state = ledger.get();
  if (!state.changedFiles.length) return false;
  const cmds = loadProjectCommands(cwd);
  const cmd = cmds.focusedTestCommand ?? cmds.testCommand;
  if (!cmd) return false;
  ctx?.ui?.notify?.(`Cheater verifying: ${cmd}`, "info");
  const r = await runCommandAsync(cmd, cwd, 90000);
  const ok = r.code === 0;
  ledger.recordCommand(cmd);
  ledger.recordVerificationStage({
    stage: "focused_tests",
    status: ok ? "ok" : "failed",
    summary: ok ? `harness auto-verify ok: ${cmd}` : compressFailureOutput(cmd, r.stdout, r.stderr, r.code),
    failureClass: ok ? "unknown" : classifyFailure({ exitCode: r.code, stdout: r.stdout, stderr: r.stderr }),
    artifacts: [],
    signals: { auto: true, command: cmd }
  });
  return true;
}

// @-file references: resolve @path tokens in the user message to bounded excerpts and the
// list of files, so the user can do the localization a small model is worst at. The resolved
// files also seed the autopilot repo hints (previously never populated).
function resolveAtFiles(cwd: string, message: string): { block: string; files: string[] } {
  const tokens = [...message.matchAll(/(?:^|\s)@([\w./\\-]+)/g)].map((m) => m[1]);
  const seen = new Set<string>();
  const files: string[] = [];
  const parts: string[] = [];
  for (const token of tokens) {
    if (seen.has(token) || files.length >= 5) continue;
    seen.add(token);
    try {
      const abs = resolve(cwd, token);
      const rel = relative(cwd, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const content = readFileSync(abs, "utf8");
      const lines = content.split(/\r?\n/);
      const excerpt = lines.length <= 200 ? content : `${lines.slice(0, 200).join("\n")}\n... [truncated ${lines.length - 200} lines]`;
      parts.push(`--- ${rel.replace(/\\/g, "/")} ---\n${excerpt}`);
      files.push(rel.replace(/\\/g, "/"));
    } catch {
      // skip unreadable / escaping paths
    }
  }
  return { block: parts.length ? `\n\nReferenced files (read-only context):\n${parts.join("\n\n")}` : "", files };
}

/** Set of repo-relative paths git currently sees as modified/added/untracked (gitignore honored). */
function gitChangedSet(cwd: string): Set<string> {
  try {
    const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return new Set();
    const files = (r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
    return new Set(files);
  } catch {
    return new Set();
  }
}

function gitStatusLine(cwd: string): string {
  try {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
    if (branch.status !== 0) return "git: not a git repository";
    const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", windowsHide: true });
    const changed = (status.stdout ?? "").split(/\r?\n/).filter(Boolean);
    const sample = changed.slice(0, 4).map((l) => l.trim().replace(/\s+/g, " "));
    return `git: branch ${branch.stdout.trim() || "(detached)"}, ${changed.length} uncommitted file(s)${sample.length ? ` (e.g. ${sample.join(", ")})` : ""}`;
  } catch {
    return "git: unavailable";
  }
}

/**
 * Compact environment block: platform + shell semantics, git state, and the verified project
 * commands. Eliminates whole failure classes for a small local model - wrong-shell command
 * generation on Windows and rediscovering "how do I run tests here" every session.
 */
function buildEnvBlock(cwd: string): string {
  const cmds = loadProjectCommands(cwd);
  const lines: string[] = ["## Environment"];
  const shellNote = process.platform === "win32"
    ? " (Windows; the shell is PowerShell - use PowerShell syntax, not bash-isms like `&&` chaining, `/dev/null`, or `$VAR`)"
    : "";
  lines.push(`platform: ${process.platform}${shellNote}`);
  lines.push(`cwd: ${cwd}`);
  lines.push(gitStatusLine(cwd));
  const cmdParts = [
    cmds.testCommand && `test: ${cmds.testCommand}`,
    cmds.focusedTestCommand && cmds.focusedTestCommand !== cmds.testCommand && `focused: ${cmds.focusedTestCommand}`,
    cmds.lintCommand && `lint: ${cmds.lintCommand}`,
    cmds.typecheckCommand && `typecheck: ${cmds.typecheckCommand}`,
    cmds.buildCommand && `build: ${cmds.buildCommand}`
  ].filter(Boolean);
  if (cmdParts.length) lines.push(`project commands: ${cmdParts.join("; ")}`);
  lines.push(`package manager: ${cmds.packageManager}${cmds.framework ? `, framework ${cmds.framework}` : ""}`);
  return lines.join("\n");
}

function cheaterCapPrompt(cap: number, threshold: number): string {
  return [
    `CHEATER HARD SESSION CAP: keep this LLM session under ${cap} context tokens.`,
    `When estimated context reaches ${threshold} tokens, compact immediately or stop with a compact handoff.`,
    "In blueprint_orchestrator mode, the current session is the planner only: it must not read, grep, list, shell, edit, or write project files.",
    "Use cheater_blueprint_create, then cheater_blueprint_next_packet. Each packet/file change must run in a fresh worker LLM session and stop after its packet.",
    "One file change means one worker. If a second file is needed, stop and dispatch another fresh worker with new context."
  ].join("\n");
}

function inputRecordValue(input: Record<string, unknown> | undefined, keys: string[]): string {
  if (!input) return "";
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function extractPath(input: Record<string, unknown> | undefined): string {
  return inputRecordValue(input, ["path", "file", "filePath"]);
}

function extractCommand(input: Record<string, unknown> | undefined): string {
  return inputRecordValue(input, ["command", "cmd"]);
}

function extractQuery(input: Record<string, unknown> | undefined): string {
  return inputRecordValue(input, ["pattern", "query"]);
}

function resultText(content: Array<{ type: string; text?: string }> | undefined): string {
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

// A short acknowledgement continues the active plan; a longer/imperative message is treated
// as a possible new goal and re-routed. Deliberately conservative so real new requests route.
function looksLikeNewGoal(message: string): boolean {
  const trimmed = message.trim();
  if (/^(ok(ay)?|yes|yep|yeah|sure|go|go ahead|continue|proceed|next|do it|please continue|keep going|carry on|and\b.*)$/i.test(trimmed)) return false;
  if (trimmed.length <= 24) return false;
  return true;
}

function extractMessageText(message: { role?: string; content?: unknown } | undefined): string {
  if (!message || (message.role && message.role !== "assistant")) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object")
      .filter((part) => !part.type || part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  }
  return "";
}

export default function cheaterExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const agentTokenCap = effectiveAgentTokenCap(config);
  const defaultCompactThreshold = compactThresholdTokens(config);
  // Per-turn git baseline so shell-based edits (sed/echo/git apply) that bypass the
  // structured edit tools still land in the completion ledger and count as real work.
  let gitBaseline: Set<string> | null = null;

  registerCheaterCommands(pi);
  registerCheaterTools(pi);
  if (config.autopilotEnabled !== false) {
    registerAutopilotCommands(pi);
  }
  if (config.blueprintModeEnabled !== false) {
    registerBlueprintCommands(pi, { config });
    registerBlueprintTools(pi, { config });
  }
  if (config.commitletModeEnabled !== false) {
    registerCommitletCommands(pi);
    registerCommitletTools(pi, { config });
  }

  if (config.missionControlEnabled !== false) {
    const store = defaultMissionStore({ cwd: process.cwd() });
    registerMissionCommands(pi, {
      store,
      config,
      getCwd: (ctx) => ctx.cwd,
      saveProjectMemory: (cwd, text) => saveMemory(cwd, text)
    });
    registerMissionTools(pi, { store, config });
  }

  if (config.gymEnabled !== false) {
    registerGymCommands(pi, {
      config,
      getCwd: (ctx) => ctx.cwd
    });
  }
  if (config.reliabilityModeEnabled !== false) {
    registerReliabilityCommands(pi, { config });
  }

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    ctx.ui.setTitle?.(`Cheater - ${ctx.cwd}`);
    ctx.ui.setStatus?.("cheater", ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "Cheater") : "Cheater");
    ctx.ui.setWidget?.("cheater-startup", startupCard(ctx.cwd, ctx.model?.id), { placement: "aboveEditor" });
    ctx.ui.notify?.("Cheater mode active", "info");
  });

  // Pi has no "before_user_message" event; routing must hang off the real "input" event,
  // which fires for both interactive typing and extension-generated messages (tagged
  // source: "extension"). Only interactive input resets per-turn reliability state and
  // gets routed - otherwise the finish-gate nudge below would reset its own counter.
  pi.on("input", async (event: { type: "input"; text?: string; source?: string }, ctx: any) => {
    if (event.source !== "interactive") return { action: "continue" };
    liveSessionState.beginInteractiveTurn(config);
    gitBaseline = gitChangedSet(ctx.cwd);
    const message = (event.text ?? "").trim();
    if (!message || message.startsWith("/")) return { action: "continue" };
    liveSessionState.setLastUserGoal(message);
    if (config.autopilotEnabled === false || config.autopilotRouteAllCodeTasks === false) return { action: "continue" };

    // Mid-task follow-ups ("ok continue", "yes go ahead") must not be re-classified: a bare
    // acknowledgement routes to answer_only and would inject "do not edit files" while a plan
    // is in flight. If a commitlet plan is active, continue it instead of re-routing.
    const activePlan = defaultCommitletState.get().currentPlan;
    const activeCommitlet = activePlan?.commitlets.find((c) => c.status === "pending" || c.status === "running");
    if (activePlan && activeCommitlet && !looksLikeNewGoal(message)) {
      const done = activePlan.commitlets.filter((c) => ["passed", "skipped", "repaired"].includes(c.status)).length;
      applyToolMask(ctx, "execute");
      ctx.ui.notify?.(`Continuing active plan (${done}/${activePlan.commitlets.length})`, "info");
      return {
        action: "transform",
        text: [
          `User request: ${message}`,
          "",
          `Cheater: a commitlet plan is active (${done}/${activePlan.commitlets.length} done; next: ${activeCommitlet.title}).`,
          "Continue it: edit the allowed files and call cheater_commitlet_next when the current edit is done. Do not restart planning unless the user changed the goal."
        ].join("\n")
      };
    }

    const atFiles = resolveAtFiles(ctx.cwd, message);
    const decision = routeAutopilot({ cwd: ctx.cwd, message, repoHints: atFiles.files.length ? { likelyFiles: atFiles.files } : undefined });
    defaultAutopilotState.setDecision(message, decision);
    applyToolMask(ctx, decision.executionMode === "answer_only" ? "answer_only" : decision.executionMode === "blueprint_orchestrator" ? "planner" : "execute");
    ctx.ui.setWidget?.("cheater-autopilot", formatAutopilotDecision(decision).split("\n"), { placement: "aboveEditor" });
    ctx.ui.notify?.(decision.userVisibleSummary, "info");
    return {
      action: "transform",
      text: `User request: ${message}\n\n${buildAutopilotInstruction(decision, message)}${atFiles.block}`
    };
  });

  // Text-repetition detection: the classic small-model degeneration mode. observeAssistantText
  // was implemented but never wired; message_end is the real Pi event that carries the model's
  // finished text.
  pi.on("message_end", async (event: { message?: { role?: string; content?: unknown } }, ctx: any) => {
    if (config.loopGovernorEnabled === false) return;
    const text = extractMessageText(event.message);
    if (!text) return;
    const events = liveSessionState.observeAssistantText(text, config);
    for (const evt of events) {
      ctx.ui.notify?.(evt.message, evt.terminal ? "error" : "warning");
    }
  });

  // After any compaction (Pi-initiated auto-compaction or our own), restate the working set
  // so the model does not drift off its goal/plan once the transcript was summarized.
  pi.on("session_compact", async (_event: unknown, ctx: any) => {
    const capsule = buildWorkingSetCapsule();
    if (!capsule) return;
    pi.sendMessage({ customType: "cheater-working-set", content: capsule, display: true }, { deliverAs: "followUp" });
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: any) => {
    const usage = ctx.getContextUsage?.();
    const cap = effectiveAgentTokenCap(config, usage?.contextWindow);
    const threshold = compactThresholdTokens(config, usage?.contextWindow);
    const shouldCompact = typeof usage?.tokens === "number" && usage.tokens >= threshold;
    if (shouldCompact) {
      ctx.compact?.({
        customInstructions: [
          `Cheater session reached the ${threshold}/${cap} token compaction threshold.`,
          "Preserve the user goal, current mode, active blueprint packet statuses, files touched, verification results, and blockers.",
          "Drop repeated file reads, stale tool outputs, and duplicated planner narration."
        ].join(" ")
      });
      ctx.ui.notify?.(`Cheater requested compaction at ${usage.tokens} tokens (threshold ${threshold}, cap ${cap}).`, "warning");
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}\n\n${buildEnvBlock(ctx.cwd)}\n\n${cheaterCapPrompt(cap || agentTokenCap, threshold || defaultCompactThreshold)}`,
      message: shouldCompact ? {
        customType: "cheater-context-cap",
        content: `Cheater requested compaction because this session reached ${threshold} tokens.`,
        display: true,
        details: usage
      } : undefined
    };
  });

  pi.on("tool_call", async (event: { toolName: string; toolCallId: string; input?: Record<string, unknown> }, ctx: any) => {
    const commitletBlock = blockCommitletScopeViolation(event);
    if (commitletBlock) return commitletBlock;
    if (config.loopGovernorEnabled === false) return {};
    const path = extractPath(event.input);
    const query = extractQuery(event.input);
    const command = extractCommand(event.input);
    const events = liveSessionState.observeToolCall({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      path: path || undefined,
      query: query || undefined,
      command: command || undefined
    }, config);
    for (const evt of events) {
      ctx.ui.notify?.(evt.message, evt.terminal ? "error" : "warning");
      if (evt.terminal) {
        ctx.ui.setWidget?.("cheater-lifecycle", [evt.message, "Cheater blocked this action because the session is stalled. Stop and report the blocker."], { placement: "aboveEditor" });
        return {
          block: true,
          reason: evt.message
        };
      }
    }
    if (config.blueprintBlockPlannerFileTools === false) return {};
    if (isBlueprintWorkerSession()) return {};
    const plan = defaultBlueprintState.get().currentPlan;
    const activeBlueprint = Boolean(plan && plan.workPackets.some((packet) => packet.status === "pending" || packet.status === "running"));
    if (!activeBlueprint || !PLANNER_BLOCKED_TOOLS.has(event.toolName)) return {};
    return {
      block: true,
      reason: "Cheater blueprint planner sessions cannot use file or shell tools. Call cheater_blueprint_next_packet to spawn a fresh worker LLM session for the next packet/file change."
    };
  });

  pi.on("tool_result", async (event: { toolName: string; toolCallId: string; input?: Record<string, unknown>; content?: Array<{ type: string; text?: string }>; isError?: boolean }, ctx: any) => {
    const warning = liveSessionState.consumeLoopWarning(event.toolCallId);
    let extraNotice = "";
    if (warning) extraNotice += `\n\n[${warning.message}]`;

    // Post-edit syntax gate: after a successful edit, run the cheapest per-file check and
    // surface any parse error in-band on the edit's own result so the model fixes it now
    // instead of discovering it three tool calls later via a failed test.
    if (config.postEditSyntaxGateEnabled !== false && EDIT_TOOLS.has(event.toolName) && event.isError !== true) {
      const editedPath = extractPath(event.input);
      if (editedPath) {
        const diag = checkFileSyntax(ctx.cwd, editedPath);
        if (diag && !diag.ok) extraNotice += `\n\n[Cheater syntax gate: ${editedPath} does not parse. Fix it before continuing:\n${diag.message}]`;
      }
    }

    // Ground-truth: after a shell command, record any files git sees as newly changed vs the
    // turn baseline, so edits made through bash bypass neither the ledger nor scope tracking.
    if (COMMAND_TOOLS.has(event.toolName) && gitBaseline) {
      const ledger = liveSessionState.getLedger();
      if (ledger) {
        for (const file of gitChangedSet(ctx.cwd)) {
          if (!gitBaseline.has(file)) ledger.recordFileChange(file);
        }
      }
    }

    if (config.loopGovernorEnabled !== false) {
      const path = extractPath(event.input);
      const command = extractCommand(event.input);
      const ok = event.isError !== true;
      const failureClass = !ok && COMMAND_TOOLS.has(event.toolName) ? inferFailureClass(resultText(event.content)) : undefined;
      const events = liveSessionState.observeToolResult({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ok,
        path: path || undefined,
        command: command || undefined,
        failureClass
      }, config);
      for (const evt of events) {
        ctx.ui.notify?.(evt.message, evt.terminal ? "error" : "warning");
        extraNotice += `\n\n[${evt.message}${evt.nonProgress ? `; ${evt.nonProgress.recovery.description}` : ""}]`;
      }
    }

    if (!extraNotice) return {};
    return {
      content: [...(event.content ?? []), { type: "text", text: `Cheater reliability notice:${extraNotice}` }]
    };
  });

  pi.on("agent_end", async (event: { messages?: Array<{ stopReason?: string }> }, ctx: any) => {
    const ledger = liveSessionState.getLedger();
    if (!ledger) return;
    const state = ledger.get();
    if (!state.changedFiles.length && !state.commandsRun.length) return;
    if (!liveSessionState.canNudge()) return;
    const last = event.messages?.at(-1);
    if (last?.stopReason === "aborted" || last?.stopReason === "error") return;
    if (ctx.hasPendingMessages?.()) return;
    // Harness-run verification: rather than only nudging the model to remember
    // cheater_verification_run, run the detected focused test ourselves and record it. The
    // model's only remaining job is fixing a failure it is handed - the task it does best.
    if (config.autoVerifyOnFinish !== false && !ledgerAllowsFinish(ledger).allowed) {
      const ran = await harnessAutoVerify(ctx.cwd, ledger, ctx);
      if (ran && ledgerAllowsFinish(ledger).allowed) {
        ctx.ui.notify?.("Cheater auto-verified the changes; finish gate is satisfied.", "info");
        return;
      }
    }
    const verdict = ledgerAllowsFinish(ledger);
    if (verdict.allowed) {
      // Deterministic completion receipt from the ledger - ground truth, not model prose.
      ctx.ui.setWidget?.("cheater-status", buildCompletionReceipt(ledger).split("\n"), { placement: "aboveEditor" });
      return;
    }
    liveSessionState.recordNudge();
    pi.sendMessage({
      customType: "cheater-finish-gate",
      content: [
        "Cheater Finish Gate: this task is not verified yet.",
        `reason: ${verdict.reason}`,
        "Before telling the user this is done, do exactly one of the following:",
        "- call cheater_verification_run to collect verification evidence, then cheater_finish_gate to confirm,",
        "- fix the specific failure named above and re-run verification,",
        "- or state explicitly that verification was skipped/blocked and why."
      ].join("\n"),
      display: true
    }, { deliverAs: "followUp" });
  });
}

export function blockCommitletScopeViolation(event: any): { block: boolean; reason: string } | undefined {
  if (!EDIT_TOOLS.has(event.toolName)) return undefined;
  const plan = defaultCommitletState.get().currentPlan;
  const running = plan?.commitlets.find((commitlet) => commitlet.status === "running");
  if (!running) return undefined;
  const path = extractPath(event.input);
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/");
  const allowed = running.allowedFiles.some((file) => !file.startsWith("(") && (normalized === file || normalized.endsWith(`/${file}`)));
  if (!allowed) {
    return {
      block: true,
      reason: `Cheater Commitlet guard blocked ${event.toolName} outside allowed files for ${running.id}. Allowed: ${running.allowedFiles.join(", ") || "(none)"}. -> Edit only those files for this commitlet; to change ${path}, finish this commitlet and call cheater_commitlet_next for the next one.`
    };
  }
  if (running.forbiddenFiles.some((file) => normalized === file || normalized.endsWith(`/${file}`))) {
    return {
      block: true,
      reason: `Cheater Commitlet guard blocked ${event.toolName} on forbidden file for ${running.id}: ${path}. -> This file is explicitly out of scope; leave it unchanged.`
    };
  }
  return undefined;
}

function inferFailureClass(text: string): "server_runtime" | "dependency" | "stale_workspace" | "app_bug" | "unknown" {
  if (/\b(eaddrinuse|address already in use|port \d+ is (already )?in use)\b/i.test(text)) return "server_runtime";
  if (/\b(module not found|no module named|cannot find module|importerror)\b/i.test(text)) return "dependency";
  if (/\b(stale|workspace mismatch|serving.*different)\b/i.test(text)) return "stale_workspace";
  if (/\b(assertionerror|typeerror|valueerror|keyerror)\b/i.test(text)) return "app_bug";
  return "unknown";
}
