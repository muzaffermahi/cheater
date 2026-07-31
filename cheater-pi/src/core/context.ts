// Kitten Core — the conversation ContextBuilder. NO Pi.
//
// A persisted conversation that only replays old events to the UI but sends the model just the latest
// user sentence is NOT restored (Goal §2, P0). This is the ONE place that turns durable conversation
// state into the bounded, model-facing context every lane uses, so a follow-up like "fix the remaining
// one" / "do the same for the parser" / "why did that fail?" resolves against prior turns — including
// after a process restart, because it is rebuilt from the store, not from in-memory chat.
//
// It deliberately SEPARATES the complete human-visible history (durable events, replayed by the UI)
// from the model-facing context (bounded, assembled here). It also folds in current repository truth so
// stale prior tool output isn't treated as current fact after files changed.

import type { ConversationStore, RunRow } from "./store/conversationStore.js";
import type { KittenEvent } from "./events.js";
import { spawnSync } from "node:child_process";

export interface BuiltContext {
  /** The model-facing conversation-context block (empty for a brand-new conversation's first turn). */
  preamble: string;
  /** The last event seq folded into the preamble (for incremental summary coverage later). */
  coveredSeq: number;
  /** Rough token estimate of the preamble (chars/4). */
  approxTokens: number;
  /**
   * Were there ACTUAL earlier turns? Distinct from `preamble.length`, because the preamble also
   * carries the repository capsule — which is non-empty on a brand-new conversation in any git repo.
   * Callers that need to know whether "it"/"that" has a referent must use this, not the preamble:
   * treating a capsule as history is how a first-turn "fix it" gets mistaken for a resolvable
   * follow-up (and how a genuine follow-up gets mistaken for an unanswerable request).
   */
  hasPriorTurns: boolean;
}

export interface ContextBudget {
  /** The model context window (tokens). */
  windowTokens: number;
  /** Reserve for reasoning + output + tool results; the preamble gets what's left, capped. */
  reserveTokens: number;
  /** Hard cap on the preamble regardless of window (keeps easy turns cheap). */
  maxPreambleTokens: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  windowTokens: 16384,
  reserveTokens: 8000,
  maxPreambleTokens: 5600,
};

/** Derive a safe history budget from the configured model context window. Larger local models can
 * use more durable context without starving the current task; small windows keep the old compact
 * floor so prompts do not crowd out tool results. */
export function contextBudgetForWindow(windowTokens: number): ContextBudget {
  const window = Math.max(4096, Math.min(131072, Math.floor(Number.isFinite(windowTokens) ? windowTokens : DEFAULT_CONTEXT_BUDGET.windowTokens)));
  const reserveTokens = Math.min(8000, Math.max(3000, Math.floor(window * 0.45)));
  const maxPreambleTokens = Math.min(8000, Math.max(1800, Math.floor(window * 0.35)));
  return { windowTokens: window, reserveTokens, maxPreambleTokens };
}

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/** One earlier turn, reduced to what the model needs to continue. */
interface TurnDigest {
  request: string;
  lane: string | null;
  outcome: string;
  files: string[];
  verification: string;
  answer?: string;
}

export class ContextBuilder {
  constructor(
    private readonly store: ConversationStore,
    private budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  ) {}

  setWindowTokens(windowTokens: number): void {
    this.budget = contextBudgetForWindow(windowTokens);
  }

  /** The current window (the server-ceiling truth) — effort fractions are computed against this. */
  windowTokens(): number {
    return this.budget.windowTokens;
  }

  /**
   * Build the model-facing context for the NEXT message in `conversationId`. `currentUserText` is the
   * new request (used only to keep the block relevant); it is NOT included — the engine appends it as
   * the task. `cwd` lets us fold in current repo truth.
   *
   * `override.windowTokens` computes THIS call's budget without mutating the shared instance —
   * that is what makes concurrent task-plan children (each at its own effort) safe. The instance
   * budget remains the server-ceiling truth set by setWindowTokens.
   */
  build(conversationId: string, cwd: string, override?: { windowTokens?: number }): BuiltContext {
    const budget = override?.windowTokens && override.windowTokens > 0 ? contextBudgetForWindow(override.windowTokens) : this.budget;
    const events = this.store.readEvents(conversationId);
    const runs = this.store.listRuns(conversationId);
    const turns = this.digestTurns(events, runs);
    const coveredSeq = events.length ? events[events.length - 1].seq : 0;
    if (!turns.length) {
      // First turn — no prior conversation, but still ground the model in current repo state.
      const repo = this.repoCapsule(cwd);
      return { preamble: repo, coveredSeq, approxTokens: approxTokens(repo), hasPriorTurns: false };
    }

    const capsule = this.repoCapsule(cwd);
    const header = "## Conversation so far\nYou are continuing an existing conversation in this project. Earlier turns (oldest first):\n";
    const footer =
      "\nUse this history to resolve references like \"it\", \"that\", \"the remaining one\", \"the same fix\", or \"why did that fail\". " +
      "Do NOT redo work that is already completed and verified above unless the user asks. Trust the CURRENT repository state over older tool output when they disagree. The user's new request follows.\n";

    // Render newest-relevant turns first into the budget, then restore chronological order.
    const budgetTokens = Math.min(
      budget.maxPreambleTokens,
      Math.max(400, budget.windowTokens - budget.reserveTokens),
    );
    const rendered: string[] = [];
    let used = approxTokens(header) + approxTokens(footer) + approxTokens(capsule);
    for (let i = turns.length - 1; i >= 0; i--) {
      const block = this.renderTurn(turns[i], i + 1);
      const t = approxTokens(block);
      if (used + t > budgetTokens && rendered.length) break; // keep at least the most recent turn
      rendered.unshift(block);
      used += t;
      if (used > budgetTokens) break;
    }
    const omitted = turns.length - rendered.length;
    const omittedNote = omitted > 0 ? `(${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted for length)\n` : "";
    const preamble = header + omittedNote + rendered.join("") + capsule + footer;
    return { preamble, coveredSeq, approxTokens: approxTokens(preamble), hasPriorTurns: true };
  }

  /** Group events + run rows into per-turn digests, oldest first. */
  private digestTurns(events: KittenEvent[], runs: RunRow[]): TurnDigest[] {
    const runById = new Map(runs.map((r) => [r.id, r]));
    const turns: TurnDigest[] = [];
    let pendingRequest: string | null = null;
    let pendingAnswer: string | undefined;
    const filesForRun = (runId: string): string[] => runById.get(runId)?.filesChanged ?? [];

    for (const e of events) {
      if (e.type === "user.message") {
        // A new user message closes any prior answer-only turn that produced no run.
        if (pendingRequest !== null) {
          turns.push({ request: pendingRequest, lane: null, outcome: pendingAnswer ? "answered" : "(no outcome recorded)", files: [], verification: "n/a", answer: pendingAnswer });
          pendingAnswer = undefined;
        }
        pendingRequest = e.text;
      } else if (e.type === "assistant.final") {
        pendingAnswer = e.text;
      } else if (e.type === "run.completed") {
        const run = runById.get(e.runId);
        turns.push({
          request: pendingRequest ?? "(request not recorded)",
          lane: e.lane,
          outcome: e.finished ? (e.summary || "completed") : `did not finish (${e.summary || "unfinished"})`,
          files: filesForRun(e.runId),
          verification: run ? gradeString(run) : (e.finished ? "finished" : "unfinished"),
          answer: pendingAnswer,
        });
        pendingRequest = null;
        pendingAnswer = undefined;
      } else if (e.type === "run.failed") {
        turns.push({ request: pendingRequest ?? "(request not recorded)", lane: null, outcome: `failed: ${e.error}`, files: [], verification: "failed", answer: pendingAnswer });
        pendingRequest = null;
        pendingAnswer = undefined;
      } else if (e.type === "run.cancelled" || e.type === "run.interrupted") {
        // Both are terminal (Goal §6). Surface them honestly — files may be partially changed — instead
        // of leaving pendingRequest to fall through to the end-of-loop "(in progress / no outcome)".
        const outcome = e.type === "run.cancelled" ? "cancelled" : "interrupted (left mid-run)";
        turns.push({ request: pendingRequest ?? "(request not recorded)", lane: null, outcome, files: filesForRun(e.runId), verification: outcome, answer: pendingAnswer });
        pendingRequest = null;
        pendingAnswer = undefined;
      }
    }
    if (pendingRequest !== null) {
      turns.push({ request: pendingRequest, lane: null, outcome: pendingAnswer ? "answered" : "(in progress / no outcome)", files: [], verification: "n/a", answer: pendingAnswer });
    }
    return turns;
  }

  private renderTurn(t: TurnDigest, n: number): string {
    const lines: string[] = [`${n}. You asked: ${JSON.stringify(clip(t.request, 300))}`];
    if (t.answer && !t.files.length && t.lane === null) {
      lines.push(`   Answer given: ${JSON.stringify(clip(t.answer, 300))}`);
    } else {
      lines.push(`   Outcome: ${t.lane ? t.lane + " lane — " : ""}${clip(t.outcome, 200)}`);
      if (t.files.length) lines.push(`   Files changed: ${t.files.slice(0, 12).join(", ")}`);
      lines.push(`   Verification: ${t.verification}`);
    }
    return lines.join("\n") + "\n";
  }

  /** A short snapshot of the CURRENT working tree, so old tool text isn't mistaken for current truth. */
  private repoCapsule(cwd: string): string {
    try {
      const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", windowsHide: true });
      if (r.status !== 0) return "";
      const changed = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20);
      if (!changed.length) return "\nCurrent repository: working tree clean.\n";
      return `\nCurrent repository — uncommitted changes right now:\n${changed.map((l) => "  " + l).join("\n")}\n`;
    } catch { return ""; }
  }
}

function gradeString(run: RunRow): string {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "interrupted") return "interrupted (left mid-run)";
  if (run.status === "failed") return `failed${run.error ? `: ${clip(run.error, 120)}` : ""}`;
  if (!run.finished) return "did not finish (unverified)";
  return run.verified ? "verified (behavioral evidence passed)" : "finished but NOT independently verified";
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
