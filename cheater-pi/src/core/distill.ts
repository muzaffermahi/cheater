// Kitten Ascent — attempt distillation and reuse (Parallel-Distill-Refine).
//
// THE IDEA, and why it is the right one for THIS hardware:
//
// "Scaling Test-Time Compute for Agentic Coding" (arXiv 2604.16529) reports that test-time scaling
// for long-horizon agents is fundamentally a problem of REPRESENTATION, SELECTION and REUSE — not of
// generating more attempts. Their Parallel-Distill-Refine conditions each new attempt on summaries
// distilled from prior attempts, keeping salient hypotheses, progress and failure modes while
// discarding low-signal trace. Reported: SWE-Bench Verified 70.9 → 77.6, Terminal-Bench 2.0
// 46.9 → 59.1 on frontier models.
//
// On a 20 tok/s local model this matters MORE than it does for a hosted frontier model, because the
// affordable number of rollouts is tiny. A measured Ascent run on this workstation took 589 s for two
// candidates. Adding a third costs another ~290 s; making the second one learn from the first costs
// a few hundred tokens of prompt. When rollouts are expensive, reuse beats width.
//
// WHAT THIS REPLACES: the repair round previously seeded from ONE failure — the first candidate that
// failed a worked example, or a single error signature — and discarded everything else the round
// learned. Two candidates could fail for two different reasons and the second reason was thrown away.
//
// DISCIPLINE: every field here is derived from what the attempt actually DID (files it wrote, tools
// it ran, the error text it hit, its stance). Nothing is inferred about intent, and nothing is
// invented. A distillation that speculates would propagate a wrong hypothesis into every later
// attempt with the authority of "what we learned last round" — strictly worse than saying less.

import type { BurstAttempt } from "./cloudBurst.js";

/** One attempt reduced to what a later attempt needs to avoid repeating it. */
export interface AttemptDigest {
  index: number;
  /** The diversity stance this attempt was given (root-cause, minimal, defensive, …). */
  stance: string;
  /** Did it reach its own finish gate? */
  finished: boolean;
  /** Why it stopped, in the engine's words. */
  stopReason: string;
  /** Files it actually wrote — the concrete shape of the approach it took. */
  filesWritten: string[];
  /** Commands it ran that FAILED, with the error line. The highest-signal content in a trajectory. */
  failures: string[];
  /** A normalized error signature, when one is identifiable. */
  errorSignature?: string;
  /** Ground-truth example failures (got ≠ expected) — the strongest possible repair signal. */
  groundTruthFailure?: string;
}

const MAX_DIGEST_CHARS = 2400;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The last identifiable error signature in an attempt's tool output. */
function errorSignature(attempt: BurstAttempt): string | undefined {
  for (const event of [...attempt.result.events].reverse()) {
    if (event.kind !== "tool" || !event.data?.error || !event.data?.output) continue;
    const match = String(event.data.output).match(/([A-Za-z]*(?:Error|Exception)[^\n]*)/);
    if (match) return clip(match[1], 200);
  }
  return undefined;
}

/**
 * Failed commands, newest first, deduplicated by normalized shape.
 *
 * Deduplication matters more than it looks: an agent that retries the same broken command six times
 * produces six identical failures, and six copies of one fact would crowd out the other candidate's
 * distinct failure entirely — turning a summary of the round into a summary of one stuck loop.
 */
function failureLines(attempt: BurstAttempt, limit = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of [...attempt.result.events].reverse()) {
    if (event.kind !== "tool" || !event.data?.error) continue;
    const command = event.detail.split("(")[0].trim() || "tool";
    const target = (() => {
      const open = event.detail.indexOf("(");
      const close = event.detail.lastIndexOf(")");
      return open >= 0 && close > open ? event.detail.slice(open + 1, close).trim() : "";
    })();
    const output = String(event.data.output ?? "");
    const salient = output.split(/\r?\n/).find((line) => /error|exception|failed|assert|cannot|not found/i.test(line)) ?? output.split(/\r?\n/)[0] ?? "";
    const line = clip(`${command}${target ? ` ${target}` : ""} → ${salient}`, 220);
    const key = line.toLowerCase().replace(/\d+/g, "#");
    if (!line.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/** Reduce one attempt to its reusable content. Pure — no model call, no filesystem access. */
export function distillAttempt(attempt: BurstAttempt, groundTruthFailure?: string): AttemptDigest {
  return {
    index: attempt.index,
    stance: String(attempt.plan?.stance ?? "default"),
    finished: attempt.result.finished,
    stopReason: clip(attempt.result.stopReason ?? "", 120),
    filesWritten: attempt.result.filesWritten.slice(0, 8),
    failures: failureLines(attempt),
    errorSignature: errorSignature(attempt),
    ...(groundTruthFailure ? { groundTruthFailure: clip(groundTruthFailure, 600) } : {}),
  };
}

/**
 * Render digests into the block a later attempt is conditioned on.
 *
 * Framed as EVIDENCE, never as instruction. An earlier attempt's approach is data about the search
 * space, not a plan to follow — and a small model reads every rendered line as something to do. (The
 * Task Compiler learned this the expensive way: an adversarial verification probe rendered into the
 * implementer's contract made the model build defenses nobody asked for.) So this block states what
 * happened and asks for a different approach; it never says "do X".
 */
export function renderDigests(digests: readonly AttemptDigest[]): string {
  if (!digests.length) return "";
  const blocks: string[] = [];
  for (const digest of digests) {
    const lines = [`Attempt ${digest.index} (${digest.stance}): ${digest.finished ? "reached its finish gate" : "did not finish"} — ${digest.stopReason || "no reason recorded"}`];
    if (digest.filesWritten.length) lines.push(`  wrote: ${digest.filesWritten.join(", ")}`);
    if (digest.groundTruthFailure) lines.push(`  failed the task's own examples: ${digest.groundTruthFailure}`);
    else if (digest.failures.length) lines.push(...digest.failures.map((failure) => `  failed: ${failure}`));
    else if (digest.errorSignature) lines.push(`  error: ${digest.errorSignature}`);
    blocks.push(lines.join("\n"));
  }
  const body = blocks.join("\n").slice(0, MAX_DIGEST_CHARS);
  return [
    "Previous attempts at this task and what happened to them:",
    body,
    "Treat this as evidence about the problem, not as a plan to copy. Do not repeat an approach that",
    "already failed for a reason that still applies. If an attempt failed on a concrete example, make",
    "that example pass.",
  ].join("\n");
}

/** Is there anything here worth spending prompt tokens on? An all-clean round teaches nothing. */
export function digestsAreInformative(digests: readonly AttemptDigest[]): boolean {
  return digests.some((digest) => digest.groundTruthFailure || digest.failures.length || digest.errorSignature || !digest.finished);
}

/** Compact receipt line, so the user can see what the repair round was actually told. */
export function digestReceiptLine(digests: readonly AttemptDigest[]): string {
  const parts = digests.map((digest) => {
    const why = digest.groundTruthFailure ? "example-fail" : digest.errorSignature ? "error" : digest.failures.length ? "tool-fail" : digest.finished ? "clean" : "unfinished";
    return `#${digest.index}:${why}`;
  });
  return `distilled ${digests.length} prior attempt(s) into the repair prompt [${parts.join(" ")}]`;
}
