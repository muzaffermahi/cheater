// Prompt/prefix discipline: measure whether a prompt we send the big model is cache-friendly and
// free of bloat, so we can send SMALLER prompts and (where the runtime supports it) reuse a warm
// prefix. This is measurement + warnings only - it never rewrites a prompt; the caller decides.
//
// Cache-friendly means: the fixed content (Cheater rules, output contract, tool/capsule rules)
// comes FIRST as a stable prefix, dynamic per-call content comes LAST, and nothing is duplicated.
// A stable section that appears AFTER dynamic content cannot be part of a reusable prefix, so it
// is wasted - we flag it. We do NOT claim a KV-cache speedup here; a good shape only makes reuse
// POSSIBLE where the provider supports it (measured separately by the provider probe).

/** One labelled slice of a prompt. `stable` = identical across calls (rules/format); else per-call. */
export interface PromptSection {
  name: string;
  content: string;
  stable: boolean;
}

export interface PromptShapeReport {
  totalEstimatedTokens: number;
  stablePrefixEstimatedTokens: number;
  dynamicEstimatedTokens: number;
  duplicateSectionWarnings: string[];
  /** True when the stable prefix leads, no stable section trails dynamic content, and no dupes. */
  cacheFriendly: boolean;
  /** stablePrefix / total, 0..1 - how much of the prompt is a reusable leading prefix. */
  stablePrefixRatio: number;
  reason: string;
}

// Match the capsule size estimator's ratio (promptCapsule.capsuleSizeReport uses ~3.5 chars/token)
// so numbers are consistent across the codebase. This is an ESTIMATE, never billed truth.
const CHARS_PER_TOKEN = 3.5;
export function estimateTokens(text: string | undefined): number {
  return Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
}

function normalizeForDupe(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Analyze an ordered list of prompt sections. The stable PREFIX is the leading run of stable
 * sections up to the first dynamic one; a stable section after that run is a cache-unfriendly
 * ordering (its bytes can't be reused). Duplicate long sections are flagged as pure waste.
 */
export function analyzePromptShape(sections: PromptSection[]): PromptShapeReport {
  const totalEstimatedTokens = sections.reduce((sum, s) => sum + estimateTokens(s.content), 0);

  // Leading run of stable sections = the reusable prefix.
  let stablePrefixEstimatedTokens = 0;
  let prefixOpen = true;
  let stableAfterDynamic = false;
  for (const s of sections) {
    if (s.stable && prefixOpen) {
      stablePrefixEstimatedTokens += estimateTokens(s.content);
    } else if (!s.stable) {
      prefixOpen = false;
    } else if (s.stable && !prefixOpen) {
      stableAfterDynamic = true; // a fixed block sitting after dynamic content - wasted for caching
    }
  }
  const dynamicEstimatedTokens = sections.filter((s) => !s.stable).reduce((sum, s) => sum + estimateTokens(s.content), 0);

  // Duplicate detection: the same substantial content appearing twice (bounded to avoid flagging
  // short boilerplate like "---").
  const seen = new Map<string, string>();
  const duplicateSectionWarnings: string[] = [];
  for (const s of sections) {
    const key = normalizeForDupe(s.content);
    if (key.length < 40) continue;
    const first = seen.get(key);
    if (first) duplicateSectionWarnings.push(`section "${s.name}" duplicates "${first}" (${estimateTokens(s.content)} est tokens wasted)`);
    else seen.set(key, s.name);
  }

  const cacheFriendly = !stableAfterDynamic && duplicateSectionWarnings.length === 0;
  const stablePrefixRatio = totalEstimatedTokens > 0 ? stablePrefixEstimatedTokens / totalEstimatedTokens : 0;
  const reasonParts: string[] = [];
  if (stableAfterDynamic) reasonParts.push("a fixed section appears after dynamic content (move it into the leading prefix)");
  if (duplicateSectionWarnings.length) reasonParts.push(`${duplicateSectionWarnings.length} duplicated section(s)`);
  if (stablePrefixEstimatedTokens === 0 && sections.length) reasonParts.push("no stable prefix (dynamic content leads)");
  const reason = cacheFriendly
    ? `cache-friendly: ${Math.round(stablePrefixRatio * 100)}% stable prefix, no duplication`
    : reasonParts.join("; ") || "not cache-friendly";

  return { totalEstimatedTokens, stablePrefixEstimatedTokens, dynamicEstimatedTokens, duplicateSectionWarnings, cacheFriendly, stablePrefixRatio, reason };
}

// The most recent worker-prompt shape this run, so the receipt can show prompt size / cache-
// friendliness without threading the report through the call stack. Reset per task.
let lastWorkerPromptShape: PromptShapeReport | undefined;
export function recordWorkerPromptShape(report: PromptShapeReport): void { lastWorkerPromptShape = report; }
export function getWorkerPromptShape(): PromptShapeReport | undefined { return lastWorkerPromptShape; }
export function resetWorkerPromptShape(): void { lastWorkerPromptShape = undefined; }

/** One compact receipt line from a shape report, or "" when there is nothing to say. */
export function promptShapeLine(report: PromptShapeReport | undefined): string {
  if (!report || !report.totalEstimatedTokens) return "";
  const dupes = report.duplicateSectionWarnings.length ? `, ${report.duplicateSectionWarnings.length} dup` : "";
  return `prompt shape: ~${report.totalEstimatedTokens} tok, ${Math.round(report.stablePrefixRatio * 100)}% stable prefix, ${report.cacheFriendly ? "cache-friendly" : "NOT cache-friendly"}${dupes}`;
}
