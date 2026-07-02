// History-poison prevention for Cheater-owned state.
//
// Local models leak junk: <think> monologues, the same paragraph five times, whole files
// pasted where a summary was asked for. Pi owns the chat history, but Cheater owns its
// capsules, reports, briefs, and controller.md - and nothing poisoned may become durable
// state, because durable state is re-injected into every future context. All deterministic.

const THINK_BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
// An unclosed think block poisons everything after it; drop from the opening tag on.
const OPEN_THINK_RE = /<think(?:ing)?>[\s\S]*$/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export const REPORT_MAX_CHARS = 4000;
export const FRAGMENT_HARD_CAP = 4000;

export function stripThinkBlocks(text: string): string {
  return (text ?? "").replace(THINK_BLOCK_RE, " ").replace(OPEN_THINK_RE, " ");
}

/** Collapse runs of identical (non-trivial) lines - the classic degeneration loop. */
export function compressRepeatedLines(text: string): string {
  const lines = (text ?? "").split(/\r?\n/);
  const out: string[] = [];
  let previous = "";
  let previousRaw = "";
  let repeats = 0;
  const flush = () => {
    // A single repeat is kept verbatim (compression must never lose content); only a RUN of
    // repeats collapses into a marker.
    if (repeats === 1) out.push(previousRaw);
    else if (repeats > 1) out.push(`[repeated x${repeats}]`);
    repeats = 0;
  };
  for (const line of lines) {
    const norm = line.trim();
    if (norm && norm === previous && norm.length > 8) {
      repeats += 1;
      previousRaw = line;
      continue;
    }
    flush();
    out.push(line);
    previous = norm;
  }
  flush();
  return out.join("\n");
}

/**
 * A "code dump" is a long run of code-looking lines where a summary was expected. Keep the
 * head, drop the body, say so - the full content lives on disk, not in context.
 */
export function truncateCodeDumps(text: string, maxRunLines = 30): string {
  const lines = (text ?? "").split(/\r?\n/);
  const codeLike = (line: string) => /^\s{2,}|^```|^[}{)\];]|=>|;\s*$/.test(line);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > maxRunLines) {
      out.push(...run.slice(0, 10), `[code dump truncated: ${run.length - 10} more lines omitted - summarize instead of pasting code]`);
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const line of lines) {
    if (codeLike(line)) run.push(line);
    else { flush(); out.push(line); }
  }
  flush();
  return out.join("\n");
}

/** Full cleaning pass for any model-authored text entering durable runstate. */
export function sanitizeReportText(text: string, maxChars = REPORT_MAX_CHARS): string {
  let clean = stripThinkBlocks(text ?? "");
  clean = clean.replace(ANSI_RE, "");
  clean = compressRepeatedLines(clean);
  clean = truncateCodeDumps(clean);
  clean = clean.replace(/\n{4,}/g, "\n\n\n").trim();
  if (clean.length > maxChars) clean = clean.slice(0, maxChars - 24) + "\n[report clipped at cap]";
  return clean;
}

/** Would this content poison a capsule/fragment? Deterministic heuristics only. */
export function looksPoisoned(text: string): string | null {
  const value = text ?? "";
  if (/<think(?:ing)?>/i.test(value)) return "contains a thinking block";
  if (ANSI_RE.test(value)) return "contains raw terminal escape codes (raw log)";
  const lines = value.split(/\r?\n/);
  const stackFrames = lines.filter((line) => /^\s+at\s.+\(.+:\d+:\d+\)|^\s+File ".+", line \d+/.test(line)).length;
  if (stackFrames > 12) return "contains a raw stack-trace dump";
  const timestamped = lines.filter((line) => /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(line)).length;
  if (timestamped > 10) return "contains raw timestamped log lines";
  return null;
}
