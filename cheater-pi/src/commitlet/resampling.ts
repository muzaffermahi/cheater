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

import { readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDiffGuard } from "./guard.js";
import { scorePatchHealth } from "./health.js";
import { runFocusedVerification } from "./verification.js";
import { buildCommitletDiff } from "./diffUtil.js";
import { revertRollbackPoint } from "./rollback.js";
import { spawnFreshWorkerForCommitlet } from "./executor.js";
import { sdkFreshAgentPacketRunner, type FreshAgentPacketResult, type FreshAgentPacketRunner } from "../blueprint/worker.js";
import type { Commitlet, CommitletPlan } from "./types.js";
import type { CheaterConfig } from "../types.js";

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
 * Rank for "best failing candidate": prefer an actual edit, then a guard-passing diff, then
 * fewer verification failures, then higher health, then the smaller diff.
 */
export function rankAttempt(attempt: CandidateAttempt): number[] {
  const s = attempt.score;
  return [
    s.touchedFiles.length > 0 ? 1 : 0,
    s.guardPassed ? 1 : 0,
    -s.verifyFailureCount,
    s.healthScore,
    -s.diffLines
  ];
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
  onProgress?: (message: string) => void
): Promise<ResampleOutcome> {
  const requested = Math.max(1, Math.trunc(config.commitletCandidateSamples ?? 1));
  const canResample = Boolean(commitlet.rollbackPoint?.snapshotDir);
  const samples = canResample ? requested : 1;
  const attempts: CandidateAttempt[] = [];
  const files = commitlet.allowedFiles.filter((file) => !file.startsWith("(")).join(", ") || "(inspect)";

  for (let i = 0; i < samples; i += 1) {
    const startedAt = Date.now();
    onProgress?.(`worker attempt ${i + 1}/${samples} for ${commitlet.id} (${files}) - streaming on the local model, this can take minutes`);
    const workerResult = await spawnFreshWorkerForCommitlet(plan, commitlet, config, runner, i + 1, model);
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
