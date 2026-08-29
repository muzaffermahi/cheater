// Keeping a long run inside its context window, without paying a model call to do it.
//
// The failure this exists for was observed live: a from-scratch build that scored 13/13 on a hidden
// oracle reported itself as "model call failed: HTTP 500: Context size has been exceeded." The work
// was done; the run simply outgrew its window on a later turn and had no way to shed weight. Nothing
// in the agent loop ever removed anything from `messages` — it grew monotonically across up to forty
// turns of tool output, and the only bound was per-call truncation.
//
// The obvious fix is to summarize old turns with the model. Do not: at ~25 tok/s a 2,000-token
// summary is eighty seconds of frozen UI, and it destroys the KV prefix (llama.cpp reuses a cached
// prefix only when the PROMPT BYTES match, so rewriting the middle of the conversation re-prefills
// everything after it).
//
// The measured alternative is **observation masking**: replace old TOOL OUTPUT with a short stub and
// leave the conversation's shape alone. JetBrains ran both over 250-turn SWE-bench trajectories and
// masking matched or beat summarization — +2.6% solve rate at 52% lower cost. It is also the only
// one of the two that a cache can survive: the stub is written once and never rewritten, so the
// prefix stabilizes instead of churning.
//
// Three invariants, each of which is a real failure if broken:
//
//  1. **Never touch the system message or the task.** They are the prefix everything else is cached
//     against, and the task is the only thing the run is about.
//  2. **Never orphan a tool result.** Chat templates reject a `tool` message whose `assistant`
//     tool-call turn is missing (and vice versa) — masking rewrites content, never removes messages,
//     precisely so the pairing cannot break.
//  3. **Never mask the recent past.** The last few turns are what the model is actually working from;
//     eliding those trades a context error for an amnesia bug.

import type { ChatMessage } from "./llm.js";

/** Tool results shorter than this are not worth stubbing — the stub itself costs tokens. */
const MIN_MASKABLE_CHARS = 400;
/** Tool results from this many messages back are considered live and are never masked. */
const KEEP_RECENT_MESSAGES = 8;
/** Chars per token. Deliberately crude: this decides whether to act, not what to charge. */
const CHARS_PER_TOKEN = 4;

export interface MaskOptions {
  /** The engine's context window in tokens. 0/undefined disables masking entirely. */
  contextWindowTokens?: number;
  /** Tokens reserved for the response and the next tool result. */
  reserveTokens?: number;
  /** Overrides for tests. */
  keepRecent?: number;
  minMaskableChars?: number;
}

export interface MaskResult {
  /** How many tool results were stubbed. 0 means the transcript was left alone. */
  masked: number;
  /** Characters removed from the prompt. */
  charsFreed: number;
}

/** A crude but stable token estimate for a message list. */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    // A tool-call turn carries its arguments as structure, not content; they are real prompt bytes.
    for (const c of m.tool_calls ?? []) chars += (c.function?.arguments?.length ?? 0) + (c.function?.name?.length ?? 0);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** True once a message's content is a stub this module wrote, so it is never re-stubbed. */
export function isMasked(message: ChatMessage): boolean {
  return message.role === "tool" && message.content.startsWith("[output elided");
}

/** The stub that replaces a tool result: enough to remember what it was, not enough to reason from. */
function stub(original: string): string {
  const firstLine = original.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return `[output elided to stay inside the context window — ${original.length} chars. It began: ${JSON.stringify(firstLine.slice(0, 160))}. Re-run the command or re-read the file if you need it again.]`;
}

/**
 * Shrink `messages` in place until it fits, oldest tool output first. Returns what it did.
 *
 * Mutates rather than copying because the agent loop's `messages` array is the run's live state and
 * every caller would otherwise have to remember to write the result back — a footgun that only shows
 * up as a context error forty turns later.
 */
export function maskOldObservations(messages: ChatMessage[], opts: MaskOptions = {}): MaskResult {
  const window = opts.contextWindowTokens ?? 0;
  if (!(window > 0)) return { masked: 0, charsFreed: 0 };
  // Reserve room for the model's own answer plus the next tool result, so masking fires BEFORE the
  // call that would have overflowed rather than after it.
  const reserve = opts.reserveTokens ?? Math.max(1024, Math.min(8192, Math.floor(window * 0.25)));
  const budget = window - reserve;
  if (budget <= 0) return { masked: 0, charsFreed: 0 };
  if (estimateTokens(messages) <= budget) return { masked: 0, charsFreed: 0 };

  const minChars = opts.minMaskableChars ?? MIN_MASKABLE_CHARS;
  let masked = 0;
  let charsFreed = 0;

  const maskUpTo = (limit: number): void => {
    // Index 0 is the system message and index 1 is the task; both are off limits by construction
    // (neither is a tool result), but starting at 2 makes the intent explicit.
    for (let i = 2; i < limit; i++) {
      if (estimateTokens(messages) <= budget) return;
      const m = messages[i];
      if (m.role !== "tool" || isMasked(m) || m.content.length < minChars) continue;
      const before = m.content.length;
      m.content = stub(m.content);
      charsFreed += before - m.content.length;
      masked++;
    }
  };

  const keepRecent = opts.keepRecent ?? KEEP_RECENT_MESSAGES;
  maskUpTo(messages.length - keepRecent);

  // A handful of recent turns can be bigger than the whole window on their own — four 12 KB command
  // outputs against an 8k context is not a strange situation, it is a normal build log. Keeping the
  // recent past is a preference, not a guarantee: a run that cannot fit its last few exchanges still
  // has to make the call, and an elided observation it can re-read beats an engine that refuses.
  // So walk the boundary in, never past the final exchange.
  for (let keep = keepRecent - 2; keep >= 2 && estimateTokens(messages) > budget; keep -= 2) {
    maskUpTo(messages.length - keep);
  }
  return { masked, charsFreed };
}
