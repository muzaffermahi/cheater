// A memory of what has already been tried, and failed.
//
// Terminal-Bench 2's failure taxonomy names this as its long-horizon failure mode: past a certain
// number of turns an agent starts **re-proposing solutions identical to ones that already failed**.
// It is not that the model forgot — the failure is right there in the transcript — it is that after
// forty turns the transcript is long enough that the most recent framing wins over the evidence.
// The same shape shows up in Kitten's own recorded frictions as "loop lockout": a run spinning on
// one command until the turn budget ran out.
//
// The cheap fix is a ledger. Normalize each failed action to a signature, and when the model asks
// for a signature that has already failed, do not silently execute it again — answer with what
// happened last time and ask for something different.
//
// Two rules keep this from becoming a cage:
//
//  1. **Repetition is not always a mistake.** `npm test` failing, an edit, then `npm test` again is
//     the correct loop — the second run is a different question because the world changed. So a
//     signature is only "stale" while nothing has been mutated since it failed. Any successful
//     write/edit clears the ledger's staleness, and every recorded attempt becomes fair game again.
//  2. **The first repeat is a warning, not a wall.** It answers with the previous failure and lets
//     the call through; only from the second repeat of an unchanged world is the call short-circuited.
//     A model that repeats once is often about to notice; a model that repeats three times is stuck.

/** How many times an unchanged signature may be re-attempted before the ledger answers for it. */
const BLOCK_AFTER = 2;
/** Signatures kept. A long run's tail is what matters; the head is already summarized elsewhere. */
const MAX_ENTRIES = 64;

export interface LedgerEntry {
  signature: string;
  /** How the action failed, compressed to something worth re-reading. */
  error: string;
  attempts: number;
  /** The `epoch` at which this was last attempted; compared against the ledger's current epoch. */
  epoch: number;
}

export interface LedgerVerdict {
  /** True when the caller should NOT execute, and should feed `feedback` back to the model instead. */
  blocked: boolean;
  /** Non-null when the model should be told about the earlier failure (whether or not it is blocked). */
  feedback?: string;
}

/** Collapse the volatile parts of a shell command so two spellings of one action share a signature. */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:sudo|env|time|nice)\s+/i, "")
    // Absolute paths differ between a container and a checkout; the trailing component is the intent.
    .replace(/(^|\s)(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/]([^\s'"/\\]+)/g, "$1$2")
    .replace(/\s*(?:2>&1|>\s*\/dev\/null|>\s*NUL)\s*$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * The signature of a tool call: what was attempted, ignoring incidental detail. Two `bash` calls
 * that differ only in whitespace are one attempt; an `edit` is identified by its file and the text
 * it searched for, because re-searching for a string that was not found is the repeat that matters.
 */
export function attemptSignature(name: string, args: Record<string, unknown>): string | null {
  if (name === "bash") {
    const command = normalizeCommand(String(args.command ?? ""));
    return command ? `bash:${command}` : null;
  }
  if (name === "edit") {
    const path = String(args.path ?? "").replace(/\\/g, "/").toLowerCase();
    const search = String(args.search ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return path && search ? `edit:${path}:${search}` : null;
  }
  if (name === "read") {
    const path = String(args.path ?? "").replace(/\\/g, "/").toLowerCase();
    return path ? `read:${path}` : null;
  }
  // write/glob/grep/task/finish are either idempotent or cheap; repeating them is not the failure
  // mode this exists for, and signing them would generate noise.
  return null;
}

/** Compress a tool failure to the line worth repeating back. */
export function failureSignal(output: string): string {
  const text = (output ?? "").replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // The bash tool frames its result with an echoed `$ command` and a `[exit 1]` footer. Both are
    // structure, not diagnosis — and `[exit 1]` matches every "did it fail" pattern there is, so
    // without this the signal is always the least informative line in the output.
    .filter((l) => !/^\$ /.test(l) && !/^\[[^\]]*\]$/.test(l));
  // Prefer the line that names the failure over the banner around it.
  const salient = [...lines].reverse()
    .find((l) => /error|failed|not found|no such|cannot|denied|refused|exception|assert|traceback/i.test(l));
  return (salient ?? lines[lines.length - 1] ?? "failed").slice(0, 200);
}

/**
 * The per-run ledger. Deterministic and side-effect-free — the agent loop owns one and nothing else
 * can see it, so a candidate in an isolated workspace never inherits another candidate's history.
 */
export class AttemptLedger {
  private entries = new Map<string, LedgerEntry>();
  /** Bumped whenever the world changes, so an earlier failure stops counting against a new attempt. */
  private epoch = 0;

  /** Record that something about the workspace changed — every prior failure is now re-attemptable. */
  noteMutation(): void {
    this.epoch++;
  }

  /** Record a failed attempt. Successes are not recorded: they are not what gets repeated. */
  recordFailure(name: string, args: Record<string, unknown>, output: string): void {
    const signature = attemptSignature(name, args);
    if (!signature) return;
    const existing = this.entries.get(signature);
    if (existing && existing.epoch === this.epoch) {
      existing.attempts++;
      existing.error = failureSignal(output);
      return;
    }
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(signature, { signature, error: failureSignal(output), attempts: 1, epoch: this.epoch });
  }

  /** What to do about a call the model is about to make. */
  consider(name: string, args: Record<string, unknown>): LedgerVerdict {
    const signature = attemptSignature(name, args);
    if (!signature) return { blocked: false };
    const entry = this.entries.get(signature);
    // A failure from before the workspace changed is history, not a warning.
    if (!entry || entry.epoch !== this.epoch) return { blocked: false };
    const what = name === "bash" ? `\`${String(args.command ?? "").slice(0, 160)}\`` : `this ${name}`;
    if (entry.attempts >= BLOCK_AFTER) {
      return {
        blocked: true,
        feedback: `not run: ${what} has already failed ${entry.attempts} times in this run, and nothing has changed on disk since. It failed with: ${entry.error}. Repeating it will produce the same result — change the approach, inspect why it fails, or edit something first.`,
      };
    }
    return {
      blocked: false,
      feedback: `note: ${what} already failed earlier in this run with: ${entry.error}. Nothing has changed on disk since, so expect the same outcome.`,
    };
  }

  /** For receipts and tests: the failures still considered current. */
  current(): LedgerEntry[] {
    return [...this.entries.values()].filter((e) => e.epoch === this.epoch);
  }
}
