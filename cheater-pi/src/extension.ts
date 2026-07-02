import { buildSystemPrompt } from "./prompts.js";
import { registerCheaterCommands } from "./commands.js";
import { registerCheaterTools } from "./tools.js";
import { startupCard } from "./ui.js";
import { loadConfig } from "./config.js";
import { registerAutopilotCommands } from "./autopilot/commands.js";
import { routeAutopilot, buildAutopilotInstruction } from "./autopilot/router.js";
import { defaultAutopilotState } from "./autopilot/status.js";
import { formatAutopilotDecision } from "./autopilot/ui.js";
import { registerBlueprintCommands } from "./blueprint/commands.js";
import { defaultBlueprintState } from "./blueprint/state.js";
import { contextCompactRatio, isBlueprintWorkerSession, mainSessionContextCap, workerBackendState } from "./blueprint/worker.js";
import { registerGymCommands } from "./gym/commands.js";
import { registerReliabilityCommands } from "./reliability/commands.js";
import { registerCommitletCommands } from "./commitlet/commands.js";
import { registerCommitletTools } from "./commitlet/tools.js";
import { defaultCommitletState } from "./commitlet/state.js";
import { formatPlanChecklist } from "./commitlet/ui.js";
import { liveSessionState } from "./reliability/sessionState.js";
import { ledgerAllowsFinish } from "./reliability/lifecycle.js";
import { loadProjectCommands } from "./reliability/projectCommands.js";
import { checkFileSyntax } from "./reliability/diagnostics.js";
import { editRescueNotice } from "./reliability/editMatch.js";
import { checkImports } from "./reliability/importGate.js";
import { compressFailureOutput } from "./reliability/failureCompressor.js";
import { buildCheatSheet, renderCheatSheet } from "./reliability/cheatSheet.js";
import { saveVerifiedFix } from "./reliability/experience.js";
import { classifyFailure, type CompletionLedger } from "./reliability/lifecycle.js";
import { activeTaskRun, endTaskRun, resumeTaskRun } from "./runstate/runState.js";
import { preToolUse, postToolUse, bridgeLoopEvents } from "./runstate/hooks.js";
import { listUnfinishedRuns } from "./runstate/worldState.js";
import { reconstructRunState, renderReincarnationBrief } from "./runstate/workerPlans.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CheaterConfig } from "./types.js";

type ExtensionAPI = any;

const PLANNER_BLOCKED_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls", "bash"]);
const EDIT_TOOLS = new Set(["edit", "write", "cheater_line_edit"]);
const COMMAND_TOOLS = new Set(["bash", "run_command", "run", "shell"]);

// Mode-scoped cheater tool sets. Pi-native tools are never touched (we only ever filter the
// cheater_* namespace), so a small model - whose weakest skill is multi-tool orchestration -
// sees only the handful of tools that phase actually needs, never the full ~20 cheater tools.
//
// Deliberately excluded from execute mode: project_brief, focus_test, and diff_safety_check.
// The harness already provides all three deterministically during execution (the env block
// injects git state + project commands, cheater_commitlet_next runs the diff guard, and
// cheater_verification_run detects and runs the focused test), so exposing them again only
// adds redundant tool-choice ambiguity for a weak model. Blueprint tools are deliberately in
// no mode: blueprint planning runs INSIDE cheater_reliability_start, not via model calls.
export const CHEATER_TOOL_MODES: Record<"answer_only" | "planner" | "execute", string[]> = {
  // cheater_reliability_start stays visible even in answer_only: routing is heuristic and
  // sometimes wrong, and a misroute must NEVER hard-lock the model out of starting the flow.
  // (Observed live: "proceed" after an approval question routed answer_only, masked the
  // planner tool away, and the model - narrating "launching the planner now" - could only
  // emit bug_memory_search five times in a row. The mask is guidance, not a cage.)
  answer_only: ["cheater_reliability_start", "cheater_bug_memory_search", "cheater_memory_search", "cheater_project_brief"],
  planner: ["cheater_reliability_start", "cheater_commitlet_next", "cheater_verification_run", "cheater_finish_gate", "cheater_bug_memory_search", "cheater_ledger_status"],
  execute: ["cheater_reliability_start", "cheater_commitlet_next", "cheater_verification_run", "cheater_finish_gate", "cheater_line_edit", "cheater_bug_memory_search", "cheater_memory_search", "cheater_ledger_status", "cheater_rollback_status", "cheater_commitlet_revert"]
};

/** The cheater tools visible in a mode. Every registered cheater tool appears in a mode. */
export function cheaterToolsForMode(mode: "answer_only" | "planner" | "execute", _config: CheaterConfig): string[] {
  return [...CHEATER_TOOL_MODES[mode]];
}

// getActiveTools/setActiveTools live on the ExtensionAPI (`pi`) object, NOT on the per-event
// ctx (verified against pi-coding-agent's extensions/types.d.ts) - calling them on ctx was a
// silent no-op that left every mode exposing all ~20 cheater tools.
function applyToolMask(pi: ExtensionAPI, config: CheaterConfig, mode: "answer_only" | "planner" | "execute"): void {
  const active: string[] | undefined = pi.getActiveTools?.();
  if (!active || typeof pi.setActiveTools !== "function") return;
  // Pi-native tools persist (never removed); recompute the cheater subset from the known
  // mode map so masking is reversible across turns.
  const piNative = active.filter((name) => !name.startsWith("cheater_"));
  pi.setActiveTools([...piNative, ...cheaterToolsForMode(mode, config)]);
}

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
  const lastV = s?.verification.at(-1);
  return [
    "Cheater working set (restated so it survives compaction):",
    s?.userGoal ? `goal: ${s.userGoal}` : "",
    // The full focus-chain checklist, not just a counter: after compaction this is often
    // the ONLY place the remaining work is spelled out, and a small model that can't see
    // items 4-6 will finish item 3 and declare the task done.
    formatPlanChecklist(plan),
    running ? `current: ${running.title} (edit only: ${running.allowedFiles.join(", ")})` : "",
    s?.changedFiles.length ? `files touched: ${s.changedFiles.slice(0, 6).join(", ")}` : "",
    lastV ? `last verification: ${lastV.stage} ${lastV.status}` : "",
    "Continue the active plan; do not restart planning."
  ].filter(Boolean).join("\n");
}

/** Compact, code-generated completion receipt: what the harness actually observed. */
export function buildCompletionReceipt(ledger: CompletionLedger): string {
  const s = ledger.get();
  const okStages = s.verification.filter((v) => v.status === "ok").map((v) => v.stage);
  const lines = [
    "Cheater: done - verified",
    `changed: ${s.changedFiles.slice(0, 6).join(", ") || "(none)"}`,
    `ran: ${s.commandsRun.slice(-3).join(" | ") || "(none)"}`,
    `verified: ${okStages.join(", ") || "(none)"}`
  ];
  // Resampling and evidence facts come from ledger entries the harness itself recorded -
  // the receipt reports what actually happened, including degraded fresh-worker modes.
  const resamples = s.entries.filter((entry) => entry.kind === "resample");
  if (resamples.length) {
    const last = resamples.at(-1)!;
    const x = last.extra as { attemptsRun?: number; samplesRequested?: number; appliedAttempt?: number; passed?: boolean; freshWorkerMode?: string };
    lines.push(`resampling: attempt ${x.appliedAttempt}/${x.attemptsRun} applied (${x.passed ? "verified pass" : "best failing candidate"}); workers: ${x.freshWorkerMode ?? "real"}`);
  }
  const evidence = s.entries.filter((entry) => entry.kind === "cheat_evidence");
  if (evidence.length) {
    const sources = [...new Set(evidence.flatMap((entry) => ((entry.extra as { sources?: string[] })?.sources ?? [])))];
    lines.push(`evidence: cheat sheet used (${sources.join(", ")})`);
  }
  return lines.join("\n");
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
 * Pick the command the harness runs to auto-verify an edit, preferring a real test but
 * falling back to typecheck then build so a repo with no tests still gets deterministic edit
 * verification (tsc/mypy/build catches the most common edit errors) instead of leaving the
 * finish gate to nag for a command that does not exist. Returns null when nothing is runnable.
 */
export function pickAutoVerifyCommand(cmds: {
  focusedTestCommand?: string | null;
  testCommand?: string | null;
  typecheckCommand?: string | null;
  buildCommand?: string | null;
}): { cmd: string; stage: "focused_tests" | "smoke"; kind: "test" | "typecheck_or_build" } | null {
  const test = cmds.focusedTestCommand ?? cmds.testCommand;
  if (test) return { cmd: test, stage: "focused_tests", kind: "test" };
  const fallback = cmds.typecheckCommand ?? cmds.buildCommand;
  if (fallback) return { cmd: fallback, stage: "smoke", kind: "typecheck_or_build" };
  return null;
}

async function harnessAutoVerify(cwd: string, ledger: CompletionLedger, ctx: any, config?: CheaterConfig): Promise<boolean> {
  const state = ledger.get();
  if (!state.changedFiles.length) return false;
  const picked = pickAutoVerifyCommand(loadProjectCommands(cwd));
  if (!picked) return false;
  const { cmd, stage, kind } = picked;
  ctx?.ui?.notify?.(`Cheater verifying: ${cmd}`, "info");
  const r = await runCommandAsync(cmd, cwd, 90000);
  const ok = r.code === 0;
  let summary = ok ? `harness auto-verify ok: ${cmd}` : compressFailureOutput(cmd, r.stdout, r.stderr, r.code);
  if (!ok) {
    // Cheat Layer: the harness classifies the failure, retrieves evidence across every
    // source it owns (verified experience -> bug corpus -> local docs -> official docs when
    // enabled), and attaches at most three hypothesis cards - no model search tool involved.
    const sheet = await buildCheatSheet(cwd, summary, config ?? {});
    if (sheet) summary = `${summary}\n${renderCheatSheet(sheet, cmd)}`;
  } else if (config?.experienceStoreEnabled !== false) {
    // Verified fail->pass inside one session: the harness itself observed the earlier failed
    // stage and now the pass, and git shows what changed - write the experience card.
    const priorFailure = state.verification.filter((v) => v.status === "failed").at(-1);
    if (priorFailure?.summary) {
      saveVerifiedFix(cwd, {
        failureText: priorFailure.summary,
        diffText: gitDiffFor(cwd, state.changedFiles),
        files: state.changedFiles.slice(0, 6),
        goal: state.userGoal
      });
    }
  }
  ledger.recordCommand(cmd);
  ledger.recordVerificationStage({
    stage,
    status: ok ? "ok" : "failed",
    summary,
    failureClass: ok ? "unknown" : classifyFailure({ exitCode: r.code, stdout: r.stdout, stderr: r.stderr }),
    artifacts: [],
    signals: { auto: true, command: cmd, kind }
  });
  // Mirror into the run's validation ledger with whole-workspace dependency (empty
  // validates), so ANY later mutation stales this auto-verify pass.
  if (config?.runStateEnabled !== false) {
    activeTaskRun()?.recordValidation({
      name: `auto_verify:${stage}`,
      command: cmd,
      actor: "harness_auto_verify",
      validates: [],
      status: ok ? "pass" : "fail",
      outputSummary: summary.slice(0, 300)
    });
  }
  return true;
}

/** Bounded git diff over specific files (tracked modifications only; best-effort). */
function gitDiffFor(cwd: string, files: string[]): string {
  if (!files.length) return "";
  try {
    const r = spawnSync("git", ["diff", "HEAD", "--", ...files.slice(0, 8)], { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
    return r.status === 0 ? (r.stdout ?? "").slice(0, 20000) : "";
  } catch {
    return "";
  }
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

/**
 * Repo-relative dirty files (git porcelain, gitignore honored) with a cheap content
 * fingerprint (mtime:size). Membership alone is not enough: a file left dirty by a previous
 * turn and re-edited via bash this turn is "already in the baseline" and would never be
 * recorded - the fingerprint catches the re-edit.
 */
function gitChangedFingerprints(cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return out;
    for (const line of (r.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
      const file = line.slice(3).trim().replace(/^"|"$/g, "");
      let fp = "";
      try {
        const s = statSync(join(cwd, file));
        fp = `${s.mtimeMs}:${s.size}`;
      } catch {
        fp = "missing";
      }
      out.set(file, fp);
    }
    return out;
  } catch {
    return out;
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
/**
 * Project rule files (Cline's .clinerules, plus Cheater's own location): user-authored,
 * project-local instructions that ride into every session's system prompt. Bounded hard -
 * rules are constraints, not documentation dumps.
 */
export function projectRules(cwd: string): string {
  for (const rel of [".cheater/rules.md", ".clinerules", ".clinerules.md"]) {
    try {
      const abs = join(cwd, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const text = readFileSync(abs, "utf8").trim();
      if (!text) continue;
      const clipped = text.length <= 1500 ? text : `${text.slice(0, 1500)}\n... [rules truncated]`;
      return `## Project rules (${rel})\n${clipped}`;
    } catch { /* unreadable rules must not break startup */ }
  }
  return "";
}

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
  const rules = projectRules(cwd);
  if (rules) lines.push("", rules);
  return lines.join("\n");
}

// A soft, non-alarming context note for the MAIN session. The old version shouted "HARD
// SESSION CAP under 12000 tokens" and unconditionally pasted blueprint-planner-only rules
// into every session - which made a large-context model panic about budget and agonize over
// whether it was "in blueprint_orchestrator mode" (it usually is not). Pi already
// auto-compacts; the working-set capsule already restates the goal afterward. So this is now
// a single quiet line, and only when the cap is meaningfully below the model's window.
function cheaterCapPrompt(cap: number): string {
  return `You have room to work: aim to keep this session under about ${cap} context tokens; Cheater and Pi compact automatically when needed, so do not ration your work or cut scope to save budget.`;
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
  // Per-turn git baseline so shell-based edits (sed/echo/git apply) that bypass the
  // structured edit tools still land in the completion ledger and count as real work.
  let gitBaseline: Map<string, string> | null = null;
  // Run-state hints raised at tool_call time, delivered in-band on the matching tool_result.
  const pendingRunHints = new Map<string, string[]>();
  // De-dup for risk-middleware hints: the same standing condition (e.g. "stale validation
  // exists") must not be re-attached to every subsequent tool result.
  let lastRunHintKey = "";
  // Last fingerprint the RUN's mutation ledger saw per file. The per-turn gitBaseline must
  // stay frozen for the completion ledger, but re-recording the same shell edit against the
  // frozen baseline on every later command would wrongly stale validations that ran AFTER
  // the edit - the mutation ledger only records a file when its fingerprint moves again.
  let runSeenFingerprints = new Map<string, string>();

  registerCheaterCommands(pi, config);
  registerCheaterTools(pi);
  if (config.autopilotEnabled !== false) {
    registerAutopilotCommands(pi);
  }
  if (config.blueprintModeEnabled !== false) {
    registerBlueprintCommands(pi, { config });
  }
  if (config.commitletModeEnabled !== false) {
    registerCommitletCommands(pi);
    registerCommitletTools(pi, { config });
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
    ctx.ui.setWidget?.("cheater-startup", startupCard(ctx.cwd, ctx.model?.id, config), { placement: "aboveEditor" });
    ctx.ui.notify?.("Cheater mode active", "info");
  });

  // Pi has no "before_user_message" event; routing must hang off the real "input" event,
  // which fires for both interactive typing and extension-generated messages (tagged
  // source: "extension"). Only interactive input resets per-turn reliability state and
  // gets routed - otherwise the finish-gate nudge below would reset its own counter.
  pi.on("input", async (event: { type: "input"; text?: string; source?: string }, ctx: any) => {
    if (event.source !== "interactive") return { action: "continue" };
    const message = (event.text ?? "").trim();
    // Slash commands and empty submits must not touch per-turn state: resetting the loop
    // governor / nudge counter on "/help" mid-task would wipe a stalled session's detection
    // history and let a loop restart its streak from zero.
    if (!message || message.startsWith("/")) return { action: "continue" };
    liveSessionState.beginInteractiveTurn(config);
    gitBaseline = gitChangedFingerprints(ctx.cwd);
    runSeenFingerprints = new Map(gitBaseline);
    liveSessionState.setLastUserGoal(message);

    // Session reincarnation: an unfinished durable run from a dead session resumes from its
    // run directory alone - no old chat context exists or is wanted. A continuation message
    // ("continue", "go ahead") resumes the most recent unfinished run with a small brief; a
    // clearly new goal is never force-resumed (a notice surfaces the unfinished work).
    if (config.runStateEnabled !== false && !activeTaskRun() && !defaultCommitletState.get().currentPlan) {
      const unfinished = listUnfinishedRuns(ctx.cwd);
      if (unfinished.length && !looksLikeNewGoal(message)) {
        const target = unfinished[0];
        resumeTaskRun(ctx.cwd, target.taskId, target.goal);
        const brief = renderReincarnationBrief(reconstructRunState(ctx.cwd, target.taskId), 2000);
        ctx.ui.notify?.(
          unfinished.length > 1
            ? `Cheater: resuming unfinished run ${target.taskId} (${unfinished.length - 1} other(s): ${unfinished.slice(1, 4).map((run) => run.taskId).join(", ")})`
            : `Cheater: resuming unfinished run ${target.taskId}`,
          "info"
        );
        applyToolMask(pi, config, "execute");
        return {
          action: "transform",
          text: [
            `User request: ${message}`,
            "",
            brief,
            "",
            `Resume this task now: call cheater_reliability_start with the original goal ("${target.goal.slice(0, 200)}"). The contract, ledgers, and protected artifacts above persist on disk.`
          ].join("\n")
        };
      }
      if (unfinished.length) {
        ctx.ui.notify?.(`Cheater: ${unfinished.length} unfinished run(s) on disk (${unfinished.slice(0, 3).map((run) => run.taskId).join(", ")}). Say "continue" to resume.`, "info");
      }
    }

    // Mid-task follow-ups ("ok continue", "yes go ahead") must not be re-classified: a bare
    // acknowledgement routes to answer_only and would inject "do not edit files" while a plan
    // is in flight. If a commitlet plan is active, continue it instead of re-routing.
    const activePlan = defaultCommitletState.get().currentPlan;
    const activeCommitlet = activePlan?.commitlets.find((c) => c.status === "pending" || c.status === "running");
    const continuingPlan = Boolean(activePlan && activeCommitlet && !looksLikeNewGoal(message));

    // A genuinely new goal gets a fresh completion ledger seeded with the REAL goal text.
    // Without this, an unverified previous turn's ledger (stale changedFiles, unresolved
    // failures, old goal) leaks into unrelated turns and wedges the finish gate; and because
    // observeToolCall auto-creates the ledger before any goal is known, the goal used to be
    // stuck as "current session" forever.
    if (!continuingPlan && looksLikeNewGoal(message)) {
      liveSessionState.reset(message);
      // A new goal also retires the previous durable run: its ledgers/guard must not veto or
      // protect anything for an unrelated task. The run directory itself stays on disk.
      endTaskRun("new goal");
    }

    if (config.autopilotEnabled === false || config.autopilotRouteAllCodeTasks === false) return { action: "continue" };

    if (continuingPlan && activePlan && activeCommitlet) {
      const done = activePlan.commitlets.filter((c) => ["passed", "skipped", "repaired"].includes(c.status)).length;
      applyToolMask(pi, config, "execute");
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

    // Bare acknowledgements ("proceed", "yes", "go ahead") must NEVER be re-classified: with
    // no plan active yet they used to route as unknown -> answer_only, which masked
    // cheater_reliability_start away and hard-locked the model out of ever starting.
    const previous = defaultAutopilotState.get();
    if (!looksLikeNewGoal(message) && previous.lastDecision && previous.currentGoal) {
      // Case 1: the previous decision was blocked pending approval - the ack IS the approval.
      // Re-route the ORIGINAL goal with the approval recorded so policy skips the block.
      if (previous.lastDecision.executionDiscipline === "blocked_needs_user") {
        const approved = routeAutopilot({ cwd: ctx.cwd, message: previous.currentGoal, repoHints: { userApprovedHighRisk: true } });
        defaultAutopilotState.setDecision(previous.currentGoal, approved);
        applyToolMask(pi, config, approved.executionMode === "answer_only" ? "answer_only" : approved.executionMode === "blueprint_orchestrator" ? "planner" : "execute");
        ctx.ui.setWidget?.("cheater-autopilot", formatAutopilotDecision(approved).split("\n"), { placement: "aboveEditor" });
        liveSessionState.reset(previous.currentGoal);
        liveSessionState.setLastUserGoal(previous.currentGoal);
        return {
          action: "transform",
          text: [
            `User request: ${message}`,
            "",
            `Cheater: the user just approved the previously blocked request. Original goal: ${previous.currentGoal.slice(0, 400)}`,
            buildAutopilotInstruction(approved, previous.currentGoal)
          ].join("\n")
        };
      }
      // Case 2: any other prior code-mode decision - the ack means "go", so re-issue the
      // prior instruction and mask instead of re-classifying the ack itself.
      if (previous.lastDecision.executionMode !== "answer_only") {
        const prior = previous.lastDecision;
        applyToolMask(pi, config, prior.executionMode === "blueprint_orchestrator" ? "planner" : "execute");
        liveSessionState.setLastUserGoal(previous.currentGoal);
        return {
          action: "transform",
          text: [
            `User request: ${message}`,
            "",
            `Cheater: the user confirmed the previous request. Goal: ${previous.currentGoal.slice(0, 400)}`,
            buildAutopilotInstruction(prior, previous.currentGoal)
          ].join("\n")
        };
      }
    }

    const atFiles = resolveAtFiles(ctx.cwd, message);
    const decision = routeAutopilot({ cwd: ctx.cwd, message, repoHints: atFiles.files.length ? { likelyFiles: atFiles.files } : undefined, requireApproval: config.requireApprovalForHighRisk === true });
    defaultAutopilotState.setDecision(message, decision);
    applyToolMask(pi, config, decision.executionMode === "answer_only" ? "answer_only" : decision.executionMode === "blueprint_orchestrator" ? "planner" : "execute");
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
      // Only terminal text-loop verdicts surface as chat notifications; non-terminal ones
      // would inject chat lines mid-stream and jump the viewport (see tool_call above).
      if (evt.terminal) ctx.ui.notify?.(evt.message, "error");
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
    // The MAIN session breathes up to (near) the model's real context window - NOT the tiny
    // per-worker packet budget. Only compact when genuinely near that real ceiling.
    const cap = mainSessionContextCap(config, usage?.contextWindow);
    const threshold = Math.floor(cap * contextCompactRatio(config));
    const shouldCompact = typeof usage?.tokens === "number" && usage.tokens >= threshold;
    if (shouldCompact) {
      ctx.compact?.({
        customInstructions: [
          `Cheater session reached the ${threshold}/${cap} token compaction threshold.`,
          "Preserve the user goal, current mode, active plan/packet statuses, files touched, verification results, and blockers.",
          "Drop repeated file reads, stale tool outputs, and duplicated planner narration."
        ].join(" ")
      });
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}\n\n${buildEnvBlock(ctx.cwd)}\n\n${cheaterCapPrompt(cap)}`,
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

    // Durable-run pre-tool hook pipeline: controlled-exec policy (guard, reserve, shell-edit
    // scope, long-running), phase budget, protected artifacts, read-before-write, and
    // large-write - blocks return immediately; warns become pending hints delivered in-band
    // on the tool's own result (never a mid-stream chat notification - that jumps the
    // viewport).
    const run = config.runStateEnabled !== false ? activeTaskRun() : null;
    if (run) {
      const runningCommitlet = defaultCommitletState.get().currentPlan?.commitlets.find((commitlet) => commitlet.status === "running");
      const content = (event.input as { content?: unknown } | undefined)?.content;
      const decisions = preToolUse({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        cwd: ctx.cwd,
        path: extractPath(event.input) || undefined,
        command: extractCommand(event.input) || undefined,
        contentChars: typeof content === "string" ? content.length : undefined,
        commitletAllowedFiles: runningCommitlet?.allowedFiles.filter((file) => !file.startsWith("("))
      }, run, config);
      const blocked = decisions.find((decision) => decision.action === "block");
      if (blocked && blocked.action === "block") {
        ctx.ui?.notify?.(`Cheater ${blocked.hook.replace(/_/g, " ")} hook blocked ${event.toolName}`, "error");
        return { block: true, reason: `Cheater ${blocked.hook} hook: ${blocked.reason}` };
      }
      const warns = decisions.filter((decision) => decision.action === "warn").map((decision) => (decision as { message: string }).message);
      if (warns.length) {
        if (pendingRunHints.size > 50) pendingRunHints.clear();
        pendingRunHints.set(event.toolCallId, warns);
      }
    }

    // Planner/worker isolation only makes sense when real fresh workers can actually spawn.
    // On a local backend that can't spawn sub-sessions (the common case), reliability_start
    // hands the packet to THIS session to execute - so blocking its file tools here would
    // deadlock every complex task (told to edit, forbidden to touch files). The commitlet
    // scope guard above already keeps edits inside the allowed file, so this legacy planner
    // block is only enforced when the backend is confirmed able to run isolated workers.
    if (
      config.blueprintBlockPlannerFileTools !== false
      && !isBlueprintWorkerSession()
      && workerBackendState() === "available"
    ) {
      const plan = defaultBlueprintState.get().currentPlan;
      const activeBlueprint = Boolean(plan && plan.workPackets.some((packet) => packet.status === "pending" || packet.status === "running"));
      if (activeBlueprint && PLANNER_BLOCKED_TOOLS.has(event.toolName)) {
        return {
          block: true,
          reason: "Cheater blueprint planner sessions cannot use file or shell tools. Call cheater_commitlet_next to run the next file change in a fresh worker."
        };
      }
    }

    if (config.loopGovernorEnabled === false) return {};
    const path = extractPath(event.input);
    const query = extractQuery(event.input);
    const command = extractCommand(event.input);
    const events = liveSessionState.observeToolCall({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      path: path || undefined,
      query: query || undefined,
      command: command || undefined,
      input: event.input
    }, config);
    for (const evt of events) {
      // Non-terminal warnings are delivered in-band on the tool's own result text; notifying
      // here as well injected a chat line MID-STREAM on every flagged tool call (Pi's notify
      // appends to the chat container), which forcibly jumped the viewport.
      if (evt.terminal) {
        // Graceful-stop semantics (ported from Cline): a hard stop must tell the model AND
        // the user that nothing is lost and exactly how to resume.
        const preserved = "Session state is preserved: the plan, rollback snapshots, and ledger are intact. Send a new instruction to resume, or /commitlet-revert to roll back.";
        ctx.ui.notify?.(evt.message, "error");
        ctx.ui.setWidget?.("cheater-lifecycle", [evt.message, preserved], { placement: "aboveEditor" });
        return {
          block: true,
          reason: `${evt.message} ${preserved}`
        };
      }
    }
    return {};
  });

  pi.on("tool_result", async (event: { toolName: string; toolCallId: string; input?: Record<string, unknown>; content?: Array<{ type: string; text?: string }>; isError?: boolean }, ctx: any) => {
    const warning = liveSessionState.consumeLoopWarning(event.toolCallId);
    let extraNotice = "";
    if (warning) extraNotice += `\n\n[${warning.message}]`;

    // Deliver run-state hints raised at tool_call time in-band on this tool's own result.
    const runHints = pendingRunHints.get(event.toolCallId);
    if (runHints?.length) {
      pendingRunHints.delete(event.toolCallId);
      extraNotice += `\n\n[${runHints.join("]\n[")}]`;
    }

    // Edit-failure rescue (ported from Cline's replace_in_file fallback matchers): a small
    // model's #1 edit failure is oldText that differs from disk only by whitespace or a
    // hazy middle line. Instead of letting it retry blind, locate the line-trimmed or
    // block-anchor near-match and hand back the EXACT on-disk text to retry with.
    if (EDIT_TOOLS.has(event.toolName) && event.isError === true) {
      const editedPath = extractPath(event.input);
      const searches: string[] = [
        ...(Array.isArray((event.input as any)?.edits) ? (event.input as any).edits.map((e: any) => String(e?.oldText ?? "")) : []),
        ...(typeof (event.input as any)?.expectedText === "string" ? [(event.input as any).expectedText] : [])
      ].filter(Boolean);
      if (editedPath && searches.length) {
        try {
          const abs = resolve(ctx.cwd, editedPath);
          if (existsSync(abs)) {
            const content = readFileSync(abs, "utf8");
            for (const search of searches) {
              const rescue = editRescueNotice(content, search);
              if (rescue) { extraNotice += `\n\n[${rescue}]`; break; }
            }
          }
        } catch { /* rescue is best-effort; the original error still stands */ }
      }
    }

    // Post-edit gates: after a successful edit, run the cheapest per-file checks and surface
    // problems in-band on the edit's own result so the model fixes them now instead of
    // discovering them three tool calls later via a failed test. Syntax first (does it
    // parse), then imports (hallucinated modules/symbols/packages - the most common
    // small-model failure).
    if (EDIT_TOOLS.has(event.toolName) && event.isError !== true) {
      const editedPath = extractPath(event.input);
      if (editedPath) {
        if (config.postEditSyntaxGateEnabled !== false) {
          const diag = checkFileSyntax(ctx.cwd, editedPath);
          if (diag && !diag.ok) extraNotice += `\n\n[Cheater syntax gate: ${editedPath} does not parse. Fix it before continuing:\n${diag.message}]`;
        }
        if (config.postEditImportGateEnabled !== false) {
          const imports = checkImports(ctx.cwd, editedPath);
          if (!imports.ok) extraNotice += `\n\n[Cheater import gate (${editedPath}):\n- ${imports.issues.join("\n- ")}]`;
        }
      }
    }

    // Durable-run post-tool hook pipeline: file mutations and commands land in the ledgers
    // (staleing dependent validations), reads feed the read-before-write evidence, check
    // commands become typed validation evidence, and the risk middleware gets one look at
    // the completed action - filesystem truth as state, not scrollback.
    const run = config.runStateEnabled !== false ? activeTaskRun() : null;
    if (run) {
      const editedPath = extractPath(event.input);
      const feedback = postToolUse({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        cwd: ctx.cwd,
        path: editedPath || undefined,
        command: extractCommand(event.input) || undefined,
        isError: event.isError === true,
        outputText: resultText(event.content).slice(0, 4000)
      }, run);
      if (EDIT_TOOLS.has(event.toolName) && event.isError !== true && editedPath) {
        // Sync the seen-fingerprint map so the git sweep below does not re-record this same
        // edit after a later command and wrongly stale a validation that ran in between.
        try {
          const abs = resolve(ctx.cwd, editedPath);
          const stat = statSync(abs);
          // Key by the repo-relative forward-slash path git porcelain uses, so the sweep's
          // lookup actually hits this entry.
          runSeenFingerprints.set(relative(ctx.cwd, abs).replace(/\\/g, "/"), `${stat.mtimeMs}:${stat.size}`);
        } catch { /* file may be virtual or deleted; the sweep will handle it */ }
      }
      const key = feedback.notices.join("|");
      if (feedback.notices.length && key !== lastRunHintKey) {
        lastRunHintKey = key;
        extraNotice += `\n\n[${feedback.notices.join("]\n[")}]`;
      }
    }

    // Ground-truth: after a shell command, record any files git sees as newly changed OR
    // re-modified vs the turn baseline (fingerprint compare catches bash edits to files that
    // were already dirty), so shell edits bypass neither the ledger nor scope tracking.
    if (COMMAND_TOOLS.has(event.toolName) && gitBaseline) {
      const ledger = liveSessionState.getLedger();
      if (ledger) {
        for (const [file, fp] of gitChangedFingerprints(ctx.cwd)) {
          if (gitBaseline.get(file) !== fp) {
            ledger.recordFileChange(file);
            if (run && runSeenFingerprints.get(file) !== fp) {
              runSeenFingerprints.set(file, fp);
              run.recordFileMutation(file, "file_modified", "main-session", "shell edit (git fingerprint)");
            }
          }
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
      // Loop/non-progress bridge: loop-governor verdicts also become durable run risk events.
      if (run && events.length) bridgeLoopEvents(run, events);
      for (const evt of events) {
        // Delivered in-band on the tool result below; a chat notification per flagged tool
        // result injected mid-stream chat lines and jumped the viewport. Terminal verdicts
        // still notify - the user must see a hard stop.
        if (evt.terminal) ctx.ui.notify?.(evt.message, "error");
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
    // Only edits create a verification obligation. A read-only turn (ls, git status, running
    // tests to answer a question) records commands into the ledger but changes nothing -
    // nudging "this task is not verified" on a Q&A turn is noise, not truthfulness.
    if (!state.changedFiles.length) return;
    if (!liveSessionState.canNudge()) return;
    const last = event.messages?.at(-1);
    if (last?.stopReason === "aborted" || last?.stopReason === "error") return;
    if (ctx.hasPendingMessages?.()) return;
    // Harness-run verification: rather than only nudging the model to remember
    // cheater_verification_run, run the detected focused test ourselves and record it. The
    // model's only remaining job is fixing a failure it is handed - the task it does best.
    if (config.autoVerifyOnFinish !== false && !ledgerAllowsFinish(ledger).allowed) {
      const ran = await harnessAutoVerify(ctx.cwd, ledger, ctx, config);
      if (ran && ledgerAllowsFinish(ledger).allowed) {
        ctx.ui.notify?.("Cheater auto-verified the changes; finish gate is satisfied.", "info");
        return;
      }
    }
    const verdict = ledgerAllowsFinish(ledger);
    // Freshness downgrade: the completion ledger can say "verified" while the run-state
    // ledger knows every pass went stale (files changed after the last green run). A stale
    // "done" is the exact lie this layer exists to stop.
    const run = config.runStateEnabled !== false ? activeTaskRun() : null;
    const freshness = run?.finishCheck();
    if (verdict.allowed && (!freshness || freshness.ok)) {
      // Deterministic completion receipt from the ledger - ground truth, not model prose.
      ctx.ui.setWidget?.("cheater-status", buildCompletionReceipt(ledger).split("\n"), { placement: "aboveEditor" });
      return;
    }
    liveSessionState.recordNudge();
    pi.sendMessage({
      customType: "cheater-finish-gate",
      content: [
        "Cheater Finish Gate: this task is not verified yet.",
        `reason: ${verdict.allowed ? "validation evidence is stale or proxy-only" : verdict.reason}`,
        ...(freshness && !freshness.ok ? freshness.warnings.map((warning) => `- ${warning}`) : []),
        // Show the remaining work, not just "not verified": a small model that stopped
        // early usually stopped because it lost sight of the unfinished checklist items.
        formatPlanChecklist(defaultCommitletState.get().currentPlan),
        "Before telling the user this is done, do exactly one of the following:",
        "- call cheater_verification_run to collect verification evidence, then cheater_finish_gate to confirm,",
        "- fix the specific failure named above and re-run verification,",
        "- or state explicitly that verification was skipped/blocked and why."
      ].filter(Boolean).join("\n"),
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
