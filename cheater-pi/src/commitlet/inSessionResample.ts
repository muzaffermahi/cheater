// In-session sequential best-of-N: the LOCAL best-of-N path.
//
// resampling.ts implements best-of-N by spawning fresh worker sub-sessions. On a single-GPU local
// box that path is unavailable by design - probeWorkerBackend latches "unavailable" to avoid
// sub-session GPU contention (blueprint/worker.ts), so runResampledWorker never runs and P1a's
// adaptive-k has no effect. But pass@k measurement proved best-of-N is ornith's single biggest lever
// (a hard single-file task went 0.33 -> 1.00 across 3 samples). On ONE GPU the samples run
// sequentially anyway, so there is no parallelism to lose: an in-session sequential best-of-N has the
// SAME wall-clock as N fresh workers WITHOUT the sub-session problem or cold-context penalty (the
// MAIN model already explored the repo).
//
// This module runs k independent DIRECT completions from the main model (no tools, no sub-session -
// the model just emits the whole file), diversified WITHOUT a temperature knob (Pi exposes none) by
// reusing the fresh-worker diversity mechanism: per-attempt approach stance + reasoning-depth jitter.
// Each candidate is scored by the SAME deterministic verifier as resampling.ts
// (guard -> health -> focused verification); the first verified pass wins, else the best-ranked
// candidate is left on disk so a follow-up repair starts from the strongest attempt.
//
// It is wired as a PRE-BUILD step in closedLoop's simulated branch (behind inSessionResampleEnabled):
// the harness pre-builds the file, then the existing cheater_commitlet_next grades it - zero change
// to the grade/advance machinery. Applies only to single-file commitlets; multi-file phases still run
// the model's in-session drive.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyCandidate, captureCandidate, scoreCandidate, scoreRankVector, type CandidateScore } from "./resampling.js";
import { createRollbackPoint, revertRollbackPoint } from "./rollback.js";
import { attemptStance, attemptThinkingLevel } from "./executor.js";
import { sdkSidecarClient } from "../sidecar/client.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import type { CheaterConfig } from "../types.js";

/** ornith reasons heavily AND the full file must fit; a normal clerk budget (512) would truncate. */
const DEFAULT_SAMPLE_MAX_TOKENS = 8000;

export interface InSessionSample {
  ok: boolean;
  /** The raw completion text (a fenced code block is extracted from it). */
  text?: string;
  error?: string;
  elapsedMs?: number;
}

/** Produces one independent completion for `attempt` (1-based). Injected so the loop is testable
 *  with no model - the real one is mainModelSampler(). */
export type InSessionSampler = (attempt: number, totalSamples: number) => Promise<InSessionSample>;

interface InSessionAttempt {
  index: number;
  score: CandidateScore;
  snapshot: Map<string, Buffer | null>;
  wrote: boolean;
}

export interface InSessionResampleOutcome {
  attemptsRun: number;
  samplesRequested: number;
  /** 1-based index of the sample left applied on disk (0 = nothing ran). */
  appliedAttempt: number;
  /** True when the applied sample fully passed guard+health+verification. */
  passed: boolean;
  note: string;
  score?: CandidateScore;
}

function editableFiles(commitlet: Commitlet): string[] {
  return commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/"));
}

/** The single CONCRETE target file in a commitlet's allowedFiles (normalized), or null when it edits
 *  zero (e.g. an unresolved "(select ...)" placeholder) or several files. */
export function singleTargetFile(commitlet: Commitlet): string | null {
  const files = editableFiles(commitlet);
  return files.length === 1 ? files[0].replace(/\\/g, "/") : null;
}

// Source-file extensions a from-scratch "create X" goal might name. Used to resolve the target when
// the autopilot left allowedFiles as a placeholder ("(select one target file after inspection)").
const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb|c|h|cc|cpp|cs|css|scss|html|json|ya?ml|toml|sh|md|php|kt|swift|sql)$/i;

/** Distinct source-file names explicitly written in the goal, excluding test files (the target of a
 *  "create X" task is the non-test file). Lets in-session best-of-N resolve a concrete target even
 *  when the commitlet's allowedFiles is a defer-to-inspection placeholder. */
export function extractGoalFilenames(goal: string): string[] {
  const tokens = goal.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [];
  const files = tokens
    .map((token) => token.replace(/\\/g, "/"))
    .filter((token) => SOURCE_EXT.test(token) && !/(^|\/)(test_|.*_test\.|.*\.test\.|.*\.spec\.)/i.test(token));
  return [...new Set(files)];
}

/**
 * The concrete single target file for in-session best-of-N: the one concrete allowedFile if present,
 * else (when allowedFiles is only a placeholder) the single source file named in the goal. Null when
 * the commitlet is genuinely multi-file or no single target can be pinned - then best-of-N stays off
 * and the classic in-session handoff runs.
 */
export function resolveTargetFile(plan: Pick<CommitletPlan, "userGoal">, commitlet: Commitlet): string | null {
  const concrete = editableFiles(commitlet);
  if (concrete.length === 1) return concrete[0].replace(/\\/g, "/");
  if (concrete.length >= 2) return null; // genuinely multi-file
  // allowedFiles carries no concrete file (a placeholder / inspection-deferred commitlet): fall back
  // to a single source file the goal explicitly names.
  const named = extractGoalFilenames(plan.userGoal ?? "");
  return named.length === 1 ? named[0] : null;
}

/** In-session best-of-N applies when the sample budget is > 1 AND a single concrete target file can
 *  be resolved (from allowedFiles or the goal). Everything else falls back to the classic handoff. */
export function shouldResampleInSession(plan: Pick<CommitletPlan, "userGoal">, commitlet: Commitlet, samples: number): boolean {
  return samples > 1 && resolveTargetFile(plan, commitlet) !== null;
}

/**
 * A commitlet with a CONCRETE single target file and a rollback snapshot for it, ready for
 * runInSessionResample - or null when no single target resolves. When allowedFiles was a placeholder
 * (the from-scratch "create X" case), this pins the goal-named file into allowedFiles/
 * expectedFilesTouched and creates a fresh rollback snapshot for it, so BOTH the internal candidate
 * scorer AND the downstream cheater_commitlet_next grade resolve the same concrete file. When the
 * commitlet already targets one concrete file with a snapshot, it is returned unchanged.
 */
export function concreteSingleFileCommitlet(plan: Pick<CommitletPlan, "userGoal">, commitlet: Commitlet, cwd: string): Commitlet | null {
  const target = resolveTargetFile(plan, commitlet);
  if (!target) return null;
  if (singleTargetFile(commitlet) === target && commitlet.rollbackPoint?.snapshotDir) return commitlet;
  const pinned: Commitlet = { ...commitlet, allowedFiles: [target], expectedFilesTouched: [target] };
  return { ...pinned, rollbackPoint: createRollbackPoint(cwd, pinned) };
}

function fileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

// Language tags a fenced block might carry for a given file extension. Used to prefer the block that
// is actually the file over an incidental example/other-language block.
const LANG_ALIASES: Record<string, string[]> = {
  ".py": ["python", "py", "python3"],
  ".ts": ["typescript", "ts"],
  ".tsx": ["tsx", "typescriptreact", "typescript", "ts"],
  ".js": ["javascript", "js", "node"],
  ".jsx": ["jsx", "javascriptreact", "javascript", "js"],
  ".mjs": ["javascript", "js"],
  ".cjs": ["javascript", "js"],
  ".json": ["json", "jsonc"],
  ".css": ["css", "scss", "less"],
  ".scss": ["scss", "css"],
  ".html": ["html"],
  ".sh": ["bash", "sh", "shell", "zsh"],
  ".go": ["go", "golang"],
  ".rs": ["rust", "rs"],
  ".java": ["java"],
  ".rb": ["ruby", "rb"],
  ".c": ["c"],
  ".h": ["c", "cpp", "c++"],
  ".cpp": ["cpp", "c++", "cxx"],
  ".yml": ["yaml", "yml"],
  ".yaml": ["yaml", "yml"],
  ".toml": ["toml"],
  ".md": ["markdown", "md"]
};

// A model that reasons in a REPL leaves `>>> `/`... ` prompt lines; extract only the entered source.
function stripReplPrompts(block: string): string {
  const lines = block.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith(">>> ") || line.startsWith("... "))) return block;
  return lines.filter((line) => line.startsWith(">>> ") || line.startsWith("... ")).map((line) => line.slice(4)).join("\n");
}

/**
 * Pull the file body out of a model completion. Prefers a fenced block whose language matches the
 * target file's extension; among the candidate pool it takes the LONGEST block (the whole file, vs a
 * short usage snippet). Falls back to the raw text only when it plainly looks like source. Returns
 * null when nothing usable is present (that sample then scores as a no-edit and is resampled).
 */
export function extractFileContent(text: string, filename: string): string | null {
  if (!text || !text.trim()) return null;
  const blocks: Array<{ lang: string; body: string }> = [];
  const re = /```([\w.+#-]*)[^\S\r\n]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = stripReplPrompts(match[2].replace(/\s+$/, ""));
    if (body.trim().length > 0) blocks.push({ lang: (match[1] || "").toLowerCase(), body });
  }
  if (blocks.length === 0) {
    const trimmed = text.trim();
    return /^(import |from |export |const |let |var |function |async |def |class |package |#include|#!|<\?|<!|<[a-zA-Z]|\/\/|\/\*|{)/.test(trimmed)
      ? trimmed
      : null;
  }
  const aliases = LANG_ALIASES[fileExt(filename)] ?? [];
  const matching = aliases.length ? blocks.filter((block) => aliases.includes(block.lang)) : [];
  const pool = matching.length ? matching : blocks;
  return pool.reduce((best, block) => (block.body.length >= best.body.length ? block : best)).body;
}

/**
 * Build the single-shot "write this whole file" prompt for one direct completion. The stance
 * (attemptStance) diversifies otherwise-identical samples so best-of-N buys real coverage.
 */
export function buildDirectCompletionPrompt(
  plan: CommitletPlan,
  commitlet: Commitlet,
  target: string,
  currentContent: string | null,
  stance = ""
): { system: string; prompt: string } {
  const spec = commitlet.spec;
  const lines: string[] = [];
  lines.push(`Task: ${plan.userGoal}`);
  lines.push(`Write the complete contents of this one file: ${target}`);
  if (commitlet.purpose && commitlet.purpose !== commitlet.title) lines.push(`Purpose: ${commitlet.purpose}`);
  const section = (label: string, items?: string[]): void => {
    const kept = (items ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 12);
    if (kept.length) {
      lines.push(`${label}:`);
      for (const item of kept) lines.push(`- ${item}`);
    }
  };
  section("Requirements", spec?.behaviorMustHold);
  section("Edge cases to handle", spec?.edgeCases);
  section("Acceptance criteria", spec?.acceptanceCriteria);
  section("Out of scope (do NOT do these)", spec?.nonGoals);
  if (spec?.observedFailure) {
    lines.push(`Currently failing: ${spec.observedFailure}`);
    if (spec.expectedBehavior) lines.push(`Expected behavior: ${spec.expectedBehavior}`);
  }
  if (spec?.reproductionCommand) lines.push(`It will be verified with: ${spec.reproductionCommand}`);
  if (currentContent && currentContent.trim()) {
    lines.push("", `Current contents of ${target} (revise as needed):`, "```", currentContent, "```");
  }
  if (stance) lines.push("", stance);
  lines.push(
    "",
    `Output ONLY the complete, final contents of ${target} as a single fenced code block. No prose before or after, no explanation, no example usage.`
  );
  const system =
    "You are an expert programmer. When asked to write a file, output the ENTIRE file as one fenced code block and nothing else - no prose, no commentary, no example usage.";
  return { system, prompt: lines.join("\n") };
}

function rankGreater(a: InSessionAttempt, b: InSessionAttempt): boolean {
  const ra = scoreRankVector(a.score);
  const rb = scoreRankVector(b.score);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i];
  }
  return a.index < b.index;
}

/**
 * Run up to `samples` independent in-session completions for a single-file commitlet, scoring each
 * against the rollback snapshot and keeping the first verified pass (else the best-ranked candidate)
 * on disk. The sampler is injected; the loop itself touches no model, so it is unit-testable blind.
 */
export async function runInSessionResample(
  plan: CommitletPlan,
  commitlet: Commitlet,
  config: CheaterConfig,
  sampler: InSessionSampler,
  samples: number,
  onProgress?: (message: string) => void
): Promise<InSessionResampleOutcome> {
  const cwd = plan.repoRoot;
  const target = singleTargetFile(commitlet);
  const requested = Math.max(1, Math.trunc(samples));
  if (!target || !commitlet.rollbackPoint?.snapshotDir) {
    return {
      attemptsRun: 0,
      samplesRequested: requested,
      appliedAttempt: 0,
      passed: false,
      note: "in-session resample not applicable (needs a single target file and a rollback snapshot)"
    };
  }
  const targetAbs = join(cwd, target);
  const attempts: InSessionAttempt[] = [];

  for (let i = 0; i < requested; i += 1) {
    const started = Date.now();
    onProgress?.(`in-session sample ${i + 1}/${requested} for ${commitlet.id} (${target}) - direct completion on the local model, can take minutes`);
    let wrote = false;
    try {
      const sample = await sampler(i + 1, requested);
      if (sample.ok && sample.text) {
        const content = extractFileContent(sample.text, target);
        if (content !== null) {
          mkdirSync(dirname(targetAbs), { recursive: true });
          writeFileSync(targetAbs, content.endsWith("\n") ? content : content + "\n");
          wrote = true;
        } else {
          onProgress?.(`sample ${i + 1} produced no extractable ${target} block; scoring as no-edit`);
        }
      } else {
        onProgress?.(`sample ${i + 1} failed: ${sample.error ?? "no completion"}`);
      }
    } catch (err) {
      onProgress?.(`sample ${i + 1} threw: ${(err as Error).message}`);
    }
    const score = scoreCandidate(cwd, commitlet, config);
    const snapshot = captureCandidate(cwd, commitlet);
    attempts.push({ index: i + 1, score, snapshot, wrote });
    onProgress?.(`sample ${i + 1}/${requested} scored in ${Math.round((Date.now() - started) / 1000)}s: ${score.passed ? "PASSED guard+health+verification" : score.summary.slice(0, 80)}`);
    if (score.passed) {
      return {
        attemptsRun: attempts.length,
        samplesRequested: requested,
        appliedAttempt: i + 1,
        passed: true,
        score,
        note: attempts.length > 1
          ? `in-session best-of-N: sample ${i + 1}/${requested} passed guard+health+verification (earlier samples discarded)`
          : "in-session sample passed verification"
      };
    }
    if (i < requested - 1) revertRollbackPoint(cwd, commitlet);
  }

  // None fully passed: re-apply the best-ranked candidate so the existing bounded-repair path starts
  // from the strongest attempt instead of whatever ran last.
  let best = attempts[0];
  for (const attempt of attempts.slice(1)) {
    if (rankGreater(attempt, best)) best = attempt;
  }
  if (best.index !== attempts.length) {
    revertRollbackPoint(cwd, commitlet);
    applyCandidate(cwd, best.snapshot);
  }
  return {
    attemptsRun: attempts.length,
    samplesRequested: requested,
    appliedAttempt: best.index,
    passed: false,
    score: best.score,
    note: attempts.length > 1
      ? `in-session best-of-N: 0/${attempts.length} samples passed; kept best (sample ${best.index}: ${best.score.summary.slice(0, 120)})`
      : `in-session sample did not pass: ${best.score.summary.slice(0, 120)}`
  };
}

/**
 * The real sampler: one bounded, no-tool direct completion on the MAIN model per attempt, diversified
 * by attempt stance (in the prompt) and reasoning-depth jitter (the one knob Pi exposes). The prompt's
 * "current contents" is captured once, before the loop reverts between samples, so every sample starts
 * from the same clean baseline.
 */
export function mainModelSampler(plan: CommitletPlan, commitlet: Commitlet, config: CheaterConfig, ctx: { model?: unknown } | undefined): InSessionSampler {
  const cwd = plan.repoRoot;
  const target = singleTargetFile(commitlet);
  const baseContent = target && existsSync(join(cwd, target)) ? readFileSync(join(cwd, target), "utf8") : null;
  const maxTokens = config.inSessionResampleMaxTokens ?? DEFAULT_SAMPLE_MAX_TOKENS;
  const timeoutMs = config.inSessionResampleTimeoutMs ?? 600_000;
  const client = sdkSidecarClient({ cwd, model: ctx?.model, timeoutMs, maxOutputTokens: maxTokens });
  return async (attempt: number): Promise<InSessionSample> => {
    if (!target) return { ok: false, error: "no single target file" };
    const { system, prompt } = buildDirectCompletionPrompt(plan, commitlet, target, baseContent, attemptStance(attempt));
    const res = await client.complete({
      system,
      prompt,
      maxOutputTokens: maxTokens,
      timeoutMs,
      thinkingLevel: attemptThinkingLevel(attempt),
      label: `insession_resample_${attempt}`
    });
    return res.ok ? { ok: true, text: res.text, elapsedMs: res.elapsedMs } : { ok: false, error: res.error, elapsedMs: res.elapsedMs };
  };
}
