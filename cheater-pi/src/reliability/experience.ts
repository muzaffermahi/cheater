// Experience store: bug memory that writes itself from receipts.
//
// Every other memory design (including Cheater's static compacted corpus) shares two
// weaknesses for a small local model: the entries are someone else's bugs, and the model has
// to REMEMBER to search them. This store fixes both. Cards are created only by the harness,
// only on a verified fail->pass transition (the completion ledger / commitlet grader observed
// verification fail with failure F, then pass after diff D - ground truth, zero model
// involvement). And recall is in-band: when a later failure matches a stored fingerprint, the
// hint is appended to the compressed failure card the model already receives, so no tool call
// and no recall skill is required.
//
// Storage is project-local JSONL (.cheater/experience/cards.jsonl), bounded, deterministic.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ExperienceCard {
  fingerprint: string;
  errorType: string;
  tokens: string[];
  /** Compact text of the failure that was observed (clipped). */
  failureText: string;
  /** The verified fix: a diff skeleton (only +/- lines) or file list description. */
  fixSummary: string;
  files: string[];
  goal: string;
  createdAt: string;
  /** How many verified fixes have re-confirmed this card. */
  hits: number;
}

const MAX_CARDS = 300;
const MATCH_THRESHOLD = 0.55;

// Words that appear in nearly every failure card and carry no signal.
const STOP_WORDS = new Set([
  "error", "errors", "failed", "failure", "failures", "expected", "received", "command",
  "exit", "test", "tests", "testing", "assert", "assertion", "assertionerror", "file",
  "files", "line", "lines", "summary", "next", "flags", "cheater", "this", "that", "with",
  "from", "into", "does", "should", "would", "could", "have", "will", "when", "then",
  "localize", "smallest", "cause", "fix", "instead", "value", "true", "false", "none",
  "null", "undefined", "return", "returns"
]);

function stripNoise(text: string): string {
  return (text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .toLowerCase()
    // quoted strings and absolute/relative paths are instance-specific noise
    .replace(/["'`][^"'`\n]*["'`]/g, " ")
    .replace(/(?:[a-z]:)?[\w.-]*[\\/][\w\\/.-]+/g, " ")
    .replace(/0x[0-9a-f]+/g, " ")
    .replace(/\d+/g, "#");
}

/** Extract the dominant error type from raw failure text ("TypeError", "ts2345", "test_failure"). */
export function extractErrorType(text: string): string {
  const raw = text ?? "";
  const ts = raw.match(/\bTS(\d{3,5})\b/);
  if (ts) return `ts${ts[1]}`;
  const err = raw.match(/\b(\w+(?:Error|Exception))\b/);
  if (err) return err[1].toLowerCase();
  if (/\bFAILED\b|\d+ failed|✕|●/.test(raw)) return "test_failure";
  if (/ModuleNotFound|Cannot find module|ImportError|ERR_MODULE_NOT_FOUND/i.test(raw)) return "import_error";
  return "unknown";
}

/** Significant, order-independent tokens of a failure text (normalized, deduped, sorted). */
export function failureTokens(text: string): string[] {
  const norm = stripNoise(text);
  const words = norm.split(/[^a-z#_]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return [...new Set(words)].sort().slice(0, 24);
}

/**
 * Stable fingerprint of a failure. Tolerant by construction: paths, line numbers, quoted
 * values, and hex are stripped before tokenizing, so "the same bug on a different line"
 * fingerprints identically. Used for dedupe on save; recall additionally does fuzzy matching.
 */
export function fingerprintFailure(text: string): string {
  return `${extractErrorType(text)}|${failureTokens(text).slice(0, 12).join(",")}`;
}

/**
 * Overlap coefficient (Szymkiewicz-Simpson) of two token sets: intersection over the SMALLER
 * set. Deliberately not Jaccard: a recall probe is often a long composite text (rendered
 * failure card + harness notes) while the stored card is short - symmetric Jaccard punishes
 * that length mismatch and misses true matches whose card tokens all appear in the probe.
 */
function overlapCoefficient(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((t) => setB.has(t)).length;
  return inter / Math.min(a.length, b.length);
}

/** Similarity in [0,1]: error-type agreement plus token overlap. */
export function failureSimilarity(card: ExperienceCard, failureText: string): number {
  const typeScore = card.errorType !== "unknown" && card.errorType === extractErrorType(failureText) ? 0.4 : 0;
  return typeScore + 0.6 * overlapCoefficient(card.tokens, failureTokens(failureText));
}

/** Keep only the changed lines of a diff (the fix itself), bounded. */
export function diffSkeleton(diffText: string, maxLines = 12, maxChars = 500): string {
  const lines = (diffText ?? "")
    .split(/\r?\n/)
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line) && line.trim().length > 1);
  const kept = lines.slice(0, maxLines).join("\n");
  return kept.length <= maxChars ? kept : `${kept.slice(0, maxChars)}\n... [clipped]`;
}

function storeFile(cwd: string): string {
  return join(cwd, ".cheater", "experience", "cards.jsonl");
}

export function loadExperience(cwd: string): ExperienceCard[] {
  const file = storeFile(cwd);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExperienceCard)
      .filter((card) => card && card.fingerprint && card.fixSummary)
      .slice(-MAX_CARDS);
  } catch {
    return [];
  }
}

function persist(cwd: string, cards: ExperienceCard[]): void {
  const file = storeFile(cwd);
  mkdirSync(join(cwd, ".cheater", "experience"), { recursive: true });
  writeFileSync(file, cards.slice(-MAX_CARDS).map((card) => JSON.stringify(card)).join("\n") + "\n", "utf8");
}

/**
 * Record a VERIFIED fail->pass transition. Called only by harness code that has both the
 * observed failure and proof the fix passed verification. Dedupes by fingerprint: a repeat
 * fix of the same failure replaces the fix and increments hits.
 */
export function saveVerifiedFix(cwd: string, params: {
  failureText: string;
  diffText?: string;
  files: string[];
  goal?: string;
}): ExperienceCard | null {
  const failureText = (params.failureText ?? "").trim();
  if (!failureText) return null;
  const fixSummary = diffSkeleton(params.diffText ?? "") || (params.files.length ? `changed: ${params.files.slice(0, 4).join(", ")}` : "");
  if (!fixSummary) return null;
  const card: ExperienceCard = {
    fingerprint: fingerprintFailure(failureText),
    errorType: extractErrorType(failureText),
    tokens: failureTokens(failureText),
    failureText: failureText.slice(0, 300),
    fixSummary,
    files: params.files.slice(0, 6),
    goal: (params.goal ?? "").slice(0, 120),
    createdAt: new Date().toISOString(),
    hits: 1
  };
  const cards = loadExperience(cwd);
  const existing = cards.findIndex((c) => c.fingerprint === card.fingerprint);
  if (existing >= 0) {
    card.hits = cards[existing].hits + 1;
    card.createdAt = cards[existing].createdAt;
    cards[existing] = card;
  } else {
    cards.push(card);
  }
  try {
    persist(cwd, cards);
  } catch {
    return null; // best-effort; never break the grading path over memory persistence
  }
  return card;
}

/**
 * Structured recall: the best-matching verified prior fix for a fresh failure, with its
 * similarity score, or null below the match threshold. The Cheat Layer consumes this to
 * build an evidence card; recallExperience below renders the same hit as prose.
 */
export function recallExperienceCard(cwd: string, failureText: string): { card: ExperienceCard; score: number } | null {
  if (!(failureText ?? "").trim()) return null;
  const cards = loadExperience(cwd);
  if (!cards.length) return null;
  let best: ExperienceCard | null = null;
  let bestScore = 0;
  for (const card of cards) {
    const score = failureSimilarity(card, failureText);
    if (score > bestScore) { best = card; bestScore = score; }
  }
  if (!best || bestScore < MATCH_THRESHOLD) return null;
  return { card: best, score: bestScore };
}

/**
 * In-band recall: given a fresh failure text, return a compact hint block when a verified
 * prior fix matches, else null. The model receives the memory without having to remember
 * any tool.
 */
export function recallExperience(cwd: string, failureText: string): string | null {
  const hit = recallExperienceCard(cwd, failureText);
  if (!hit) return null;
  const best = hit.card;
  return [
    "=== CHEATER EXPERIENCE (a matching failure was fixed and verified before) ===",
    `then: ${best.failureText.slice(0, 160)}`,
    `verified fix${best.files.length ? ` (${best.files.slice(0, 3).join(", ")})` : ""}:`,
    best.fixSummary,
    "If the same cause applies here, make the analogous fix; otherwise ignore this hint."
  ].join("\n");
}
