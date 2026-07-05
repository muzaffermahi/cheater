import { countDiffLines, isCreationDiff } from "./guard.js";
import type { PatchHealthReport } from "./types.js";

export function scorePatchHealth(params: {
  diffText?: string;
  filesTouched: string[];
  threshold?: number;
  hardRejectThreshold?: number;
}): PatchHealthReport {
  const diff = params.diffText ?? "";
  const diffLines = countDiffLines(diff);
  const duplicationDelta = repeatedAddedBlocks(diff);
  const complexityDelta = countMatches(diff, /^\+.*\b(if|for|while|switch|catch|except|&&|\|\|)\b/gm);
  const largeFunctionDelta = countLargeAddedRuns(diff);
  const assertionDelta = countMatches(diff, /^\+.*\b(assert|expect|should|equal|throws)\b/gm) - countMatches(diff, /^-.*\b(assert|expect|should|equal|throws)\b/gm);
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  // Creating a NEW file (pure-addition diff) is expected to be large - the whole file is added - so do
  // not punish it by line count or big added-runs the way an edit to existing code is punished (that
  // is what dropped a from-scratch 460-line component below the hard-reject threshold). Real quality
  // penalties (duplication, TODO/HACK, broad catch, globals) still apply to new code.
  const created = isCreationDiff(diff);
  let score = 100;
  if (created) {
    score -= Math.max(0, diffLines - 800) * 0.05; // only gently penalize a truly enormous new file
  } else {
    score -= Math.max(0, diffLines - 80) * 0.2;
    score -= largeFunctionDelta * 10;
  }
  score -= Math.max(0, params.filesTouched.length - 2) * 8;
  score -= duplicationDelta * 8;
  score -= complexityDelta * 2;
  if (/^\+.*\b(TODO|HACK|FIXME)\b/gim.test(diff)) score -= 8;
  if (/^\+.*\bcatch\s*\([^)]*\)\s*\{|except\s+Exception\b/gim.test(diff)) score -= 10;
  if (/^\+.*\b(globalThis|global\s+|window\.)\b/gim.test(diff)) score -= 6;
  // Only treat a negative assertion delta as a blocker when a test file was actually
  // touched; otherwise deleting a source line that happens to contain "should"/"expect"
  // (e.g. a comment or a string) false-blocks correct work.
  const touchedTestFile = params.filesTouched.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file));
  if (assertionDelta < 0 && touchedTestFile) blockingIssues.push("Assertions were removed or weakened in a test. -> Restore the removed assertion, or explain in the commitlet why the weaker check is correct.");
  const finalScore = Math.max(0, Math.round(score));
  if (finalScore < (params.hardRejectThreshold ?? 50)) blockingIssues.push(`Patch health score ${finalScore} is below hard reject threshold.`);
  else if (finalScore < (params.threshold ?? 75)) warnings.push(`Patch health score ${finalScore} is below preferred threshold.`);
  return {
    score: finalScore,
    passed: blockingIssues.length === 0 && finalScore >= (params.hardRejectThreshold ?? 50),
    warnings,
    blockingIssues,
    metrics: {
      diffLines,
      filesTouched: params.filesTouched.length,
      duplicationDelta,
      complexityDelta,
      largeFunctionDelta,
      assertionDelta
    }
  };
}

export function emptyHealthReport(): PatchHealthReport {
  return scorePatchHealth({ filesTouched: [], diffText: "" });
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function repeatedAddedBlocks(diff: string): number {
  const added = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1).trim()).filter((line) => line.length > 8);
  const counts = new Map<string, number>();
  let repeats = 0;
  for (const line of added) {
    const count = (counts.get(line) ?? 0) + 1;
    counts.set(line, count);
    if (count === 2) repeats += 1;
  }
  return repeats;
}

function countLargeAddedRuns(diff: string): number {
  let run = 0;
  let large = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      run += 1;
      if (run === 60) large += 1;
    } else {
      run = 0;
    }
  }
  return large;
}
