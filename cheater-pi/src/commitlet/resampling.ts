// Verified resampling: best-of-N fresh workers with deterministic selection.
//
// Every mainstream harness is sample-frugal because API tokens cost money. Local tokens are
// nearly free - the only cost is wall-clock - and a small model's pass@N on a bounded
// single-file commitlet approaches a frontier model's pass@1. Cheater already owns the
// deterministic verifier (diff guard + patch health + focused verification); this module
// turns it from an accept/reject gate for ONE attempt into a SELECTOR across independent
// attempts:
//
//   for attempt in 1..N:
//     fresh worker edits from the clean rollback snapshot (independent sample - no failure
//     context, which a small model would only be poisoned by)
//     score the candidate in code (guard -> health -> focused verification)
//     fully passed? accept and stop early.
//     otherwise capture the candidate's bytes, revert to the snapshot, resample.
//   none passed? re-apply the best-ranked failing candidate so the existing bounded-repair
//   path starts from the strongest attempt instead of the last one.
//
// commitletCandidateSamples=1 (the default) is exactly today's single-attempt behavior.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDiffGuard } from "./guard.js";
import { scorePatchHealth } from "./health.js";
import { runFocusedVerification } from "./verification.js";
import { buildCommitletDiff } from "./diffUtil.js";
import { revertRollbackPoint } from "./rollback.js";
import { spawnFreshWorkerForCommitlet } from "./executor.js";
import { maxWorkerConcurrency, parallelResamplingAvailable } from "./workerPool.js";
import { sdkFreshAgentPacketRunner, type FreshAgentPacketResult, type FreshAgentPacketRunner } from "../blueprint/worker.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import type { CheaterConfig } from "../types.js";
import { computeBudget } from "../runtime/computeBudget.js";

export interface CandidateScore {
  touchedFiles: string[];
  diffLines: number;
  guardPassed: boolean;
  healthPassed: boolean;
  healthScore: number;
  verifyPassed: boolean;
  verifyFailureCount: number;
  /** Everything passed: this candidate is a verified winner. */
  passed: boolean;
  summary: string;
}

export interface CandidateAttempt {
  index: number;
  workerResult: FreshAgentPacketResult;
  score: CandidateScore;
  /** Post-edit bytes of the commitlet's allowed files (null = file absent). */
  snapshot: Map<string, Buffer | null>;
}

export interface ResampleOutcome {
  workerResult: FreshAgentPacketResult;
  attemptsRun: number;
  samplesRequested: number;
  /** 1-based index of the attempt left applied on disk. */
  appliedAttempt: number;
  /** True when the applied attempt fully passed guard+health+verification. */
  passed: boolean;
  note: string;
}

function editableFiles(commitlet: Commitlet): string[] {
  return commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/"));
}

/** Untracked (gitignore-honored) files right now, or null when not a git repo. */
function untrackedFiles(cwd: string): Set<string> | null {
  try {
    const r = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return null;
    return new Set((r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, "/")));
  } catch {
    return null;
  }
}

/**
 * Workspace-checkpoint hygiene (the targeted port of Cline's full-workspace checkpoints):
 * the allowed-files snapshot restores in-scope files, but a rogue attempt can CREATE stray
 * files outside its scope (helper scripts, debug dumps), and those used to survive reverts
 * and leak into later attempts and the final result. Delete any file that is untracked NOW,
 * was not untracked at the attempt baseline, and is not in the commitlet's allowed files.
 */
function removeStrayFiles(cwd: string, baseline: Set<string> | null, commitlet: Commitlet): string[] {
  if (!baseline) return [];
  const now = untrackedFiles(cwd);
  if (!now) return [];
  const allowed = new Set(editableFiles(commitlet).map((f) => f.replace(/\\/g, "/")));
  const removed: string[] = [];
  for (const file of now) {
    if (baseline.has(file) || allowed.has(file)) continue;
    try {
      rmSync(join(cwd, file), { force: true });
      removed.push(file);
    } catch { /* best-effort */ }
  }
  return removed;
}

/**
 * Score the current on-disk state of a commitlet's files against its rollback snapshot,
 * without mutating any plan state. Verification is skipped (counted as failed) when the
 * guard or health already reject the diff, so hopeless candidates do not burn a test run.
 */
export function scoreCandidate(cwd: string, commitlet: Commitlet, config: CheaterConfig): CandidateScore {
  const { diffText, touchedFiles } = buildCommitletDiff(cwd, editableFiles(commitlet), commitlet.rollbackPoint?.snapshotDir);
  const guard = runDiffGuard(commitlet, { touchedFiles, diffText });
  const health = scorePatchHealth({
    diffText,
    filesTouched: touchedFiles,
    threshold: config.healthScoreThreshold,
    hardRejectThreshold: config.hardRejectHealthThreshold
  });
  const structurallyOk = guard.passed && health.passed && touchedFiles.length > 0;
  const verify = structurallyOk
    ? runFocusedVerification(cwd, commitlet)
    : { passed: false, commandsRun: [], failures: touchedFiles.length ? [...guard.blockingIssues, ...health.blockingIssues] : ["no files were changed"], summary: touchedFiles.length ? "guard/health rejected; verification skipped" : "no edit was made" };
  return {
    touchedFiles,
    diffLines: guard.diffLines,
    guardPassed: guard.passed,
    healthPassed: health.passed,
    healthScore: health.score,
    verifyPassed: structurallyOk && verify.passed,
    verifyFailureCount: verify.failures.length,
    passed: structurallyOk && verify.passed,
    summary: verify.summary
  };
}

/** Capture the current bytes of the commitlet's editable files so a candidate can be re-applied later. */
export function captureCandidate(cwd: string, commitlet: Commitlet): Map<string, Buffer | null> {
  const snapshot = new Map<string, Buffer | null>();
  for (const rel of editableFiles(commitlet)) {
    const abs = join(cwd, rel);
    snapshot.set(rel, existsSync(abs) ? readFileSync(abs) : null);
  }
  return snapshot;
}

/** Write a captured candidate's bytes back to disk (null = ensure the file is absent). */
export function applyCandidate(cwd: string, snapshot: Map<string, Buffer | null>): void {
  for (const [rel, bytes] of snapshot) {
    const abs = join(cwd, rel);
    if (bytes === null) {
      rmSync(abs, { force: true });
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
  }
}

/**
 * The lexicographic rank vector for a candidate score (higher is better) for "best failing
 * candidate" selection: prefer an actual edit, then a guard-passing diff, then fewer verification
 * failures, then higher health, then the smaller diff. Shared by fresh-worker resampling and
 * in-session best-of-N (inSessionResample.ts) so both select the strongest failing candidate
 * identically.
 */
export function scoreRankVector(s: CandidateScore): number[] {
  return [
    s.touchedFiles.length > 0 ? 1 : 0,
    s.guardPassed ? 1 : 0,
    -s.verifyFailureCount,
    s.healthScore,
    -s.diffLines
  ];
}

/** Rank vector for a fresh-worker candidate attempt (see scoreRankVector). */
export function rankAttempt(attempt: CandidateAttempt): number[] {
  return scoreRankVector(attempt.score);
}

function betterThan(a: CandidateAttempt, b: CandidateAttempt): boolean {
  const ra = rankAttempt(a);
  const rb = rankAttempt(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i];
  }
  return a.index < b.index;
}

/**
 * Run a commitlet through up to `commitletCandidateSamples` independent fresh workers,
 * accepting the first verified pass and otherwise leaving the best-ranked candidate applied.
 * Requires a rollback snapshot (prepared commitlets always have one); without it, exactly one
 * attempt runs (today's behavior).
 */
export async function runResampledWorker(
  plan: CommitletPlan,
  commitlet: Commitlet,
  config: CheaterConfig,
  runner: FreshAgentPacketRunner = sdkFreshAgentPacketRunner,
  model?: unknown,
  onProgress?: (message: string) => void,
  onHeartbeat?: (elapsedMs: number) => void
): Promise<ResampleOutcome> {
  // Adaptive test-time compute (P5): the best-of-N sample count scales with this commitlet's
  // hardness (task kind, risk, files in scope, repair) when adaptiveComputeEnabled; otherwise this
  // is exactly config.commitletCandidateSamples ?? 1 (today's static behavior).
  const budget = computeBudget({
    taskKind: plan.autopilotDecision?.taskKind,
    risk: String(plan.risk ?? ""),
    filesInScope: editableFiles(commitlet).length,
    isRepair: /-repair$/.test(commitlet.id) || Boolean(commitlet.spec?.observedFailure)
  }, config);
  const requested = budget.samples;
  const canResample = Boolean(commitlet.rollbackPoint?.snapshotDir);
  const samples = canResample ? requested : 1;
  // WorkerPool seam: on a single serialized GPU, N concurrent attempts just contend, so we run
  // them sequentially and say why. The batching parallel path (runPool over isolated worktrees)
  // engages only when parallelResamplingAvailable() is ok.
  if (samples > 1 && maxWorkerConcurrency(config) > 1) {
    const parallel = parallelResamplingAvailable(config, plan.repoRoot);
    if (!parallel.ok) onProgress?.(`running ${samples} attempts sequentially - ${parallel.reason}`);
  }
  const attempts: CandidateAttempt[] = [];
  const files = commitlet.allowedFiles.filter((file) => !file.startsWith("(")).join(", ") || "(inspect)";
  const untrackedBaseline = untrackedFiles(plan.repoRoot);

  for (let i = 0; i < samples; i += 1) {
    const startedAt = Date.now();
    onProgress?.(`worker attempt ${i + 1}/${samples} for ${commitlet.id} (${files}) - streaming on the local model, this can take minutes`);
    const workerResult = await spawnFreshWorkerForCommitlet(plan, commitlet, config, runner, i + 1, model, onHeartbeat);
    onProgress?.(`worker attempt ${i + 1}/${samples} finished in ${Math.round((Date.now() - startedAt) / 1000)}s${workerResult.ok ? "" : ` (${workerResult.error ?? "failed"})`}; scoring candidate...`);
    if (workerResult.error === "worker_backend_unavailable" && i === 0) {
      // The backend cannot even create a session; resampling would fail N identical times.
      return {
        workerResult,
        attemptsRun: 1,
        samplesRequested: requested,
        appliedAttempt: 1,
        passed: false,
        note: "fresh worker backend unavailable; no attempts could run"
      };
    }
    const score = scoreCandidate(plan.repoRoot, commitlet, config);
    const snapshot = captureCandidate(plan.repoRoot, commitlet);
    const attempt: CandidateAttempt = { index: i + 1, workerResult, score, snapshot };
    attempts.push(attempt);
    if (score.passed) {
      onProgress?.(`attempt ${attempt.index} PASSED guard+health+verification - applying it`);
      return {
        workerResult,
        attemptsRun: attempts.length,
        samplesRequested: requested,
        appliedAttempt: attempt.index,
        passed: true,
        note: attempts.length > 1
          ? `verified resampling: attempt ${attempt.index}/${samples} passed guard+health+verification (earlier attempts discarded)`
          : samples > 1
            ? `verified resampling: attempt 1/${samples} passed; no resample needed`
            : "single attempt passed verification"
      };
    }
    onProgress?.(`attempt ${attempt.index} did not pass (${score.summary.slice(0, 100)})${i < samples - 1 ? "; reverting and resampling fresh" : ""}`);
    if (i < samples - 1) {
      revertRollbackPoint(plan.repoRoot, commitlet);
      const strays = removeStrayFiles(plan.repoRoot, untrackedBaseline, commitlet);
      if (strays.length) onProgress?.(`removed ${strays.length} stray out-of-scope file(s) from the failed attempt: ${strays.slice(0, 4).join(", ")}`);
    }
  }

  // No attempt fully passed: leave the strongest candidate on disk so the bounded repair
  // path starts from the best starting point instead of whatever ran last.
  let best = attempts[0];
  for (const attempt of attempts.slice(1)) {
    if (betterThan(attempt, best)) best = attempt;
  }
  if (best.index !== attempts.length) {
    revertRollbackPoint(plan.repoRoot, commitlet);
    applyCandidate(plan.repoRoot, best.snapshot);
  }
  // The applied best candidate must not carry another attempt's (or its own) stray files.
  removeStrayFiles(plan.repoRoot, untrackedBaseline, commitlet);
  return {
    workerResult: best.workerResult,
    attemptsRun: attempts.length,
    samplesRequested: requested,
    appliedAttempt: best.index,
    passed: false,
    note: attempts.length > 1
      ? `verified resampling: 0/${attempts.length} attempts passed; kept best candidate (attempt ${best.index}: ${best.score.summary.slice(0, 140)})`
      : `single attempt did not pass verification: ${best.score.summary.slice(0, 140)}`
  };
}
