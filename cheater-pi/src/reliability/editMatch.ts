// Edit fallback matching, ported from Cline's replace_in_file matcher cascade - the single
// biggest reason weak models' edits land in Cline. A small model reproduces the target text
// with slightly wrong whitespace, a drifted blank line, or a re-wrapped middle - and an
// exact-match edit tool (Pi's `edit`, most old_str tools) hard-fails on all of it.
//
// Cascade, most to least strict:
//   1. exact substring match
//   2. line-trimmed match: compare line-by-line with each line trimmed, so indentation and
//      trailing-whitespace drift do not matter
//   3. block-anchor match: for blocks of 3+ lines, anchor on the FIRST and LAST trimmed
//      lines and accept the span between them, so a hazy middle still locates the block
//
// Cheater uses this harness-side: when a model's edit fails, the harness finds the true
// near-match and hands back the exact on-disk text in-band, turning the #1 edit failure
// into a one-step recovery instead of a retry spiral. It never silently applies a fuzzy
// edit on its own - the model confirms by retrying with corrected text.

export interface EditMatch {
  /** Character offset where the match starts in the content. */
  start: number;
  /** Character offset just past the match. */
  end: number;
  /** 1-based first line of the match. */
  startLine: number;
  /** 1-based last line of the match. */
  endLine: number;
  method: "exact" | "line-trimmed" | "block-anchor";
  /** The exact on-disk text of the matched region (what a retry should use as oldText). */
  actualText: string;
}

interface LineIndex {
  lines: string[];
  /** Character offset of the start of each line. */
  offsets: number[];
}

function indexLines(content: string): LineIndex {
  const lines = content.split("\n");
  const offsets: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    offsets[i] = offset;
    offset += lines[i].length + 1; // +1 for the split newline
  }
  return { lines, offsets };
}

function sliceMatch(content: string, index: LineIndex, firstLine: number, lastLine: number, method: EditMatch["method"]): EditMatch {
  const start = index.offsets[firstLine];
  const lastLineEnd = index.offsets[lastLine] + index.lines[lastLine].length;
  return {
    start,
    end: lastLineEnd,
    startLine: firstLine + 1,
    endLine: lastLine + 1,
    method,
    actualText: content.slice(start, lastLineEnd)
  };
}

/** Line-trimmed match: every line equal after trimming. */
function lineTrimmedMatch(content: string, search: string, index: LineIndex): EditMatch | null {
  const searchLines = search.split("\n").map((line) => line.trim());
  // Drop a trailing empty line produced by a trailing newline in the search text.
  while (searchLines.length && searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (!searchLines.length) return null;
  const { lines } = index;
  outer: for (let i = 0; i + searchLines.length <= lines.length; i += 1) {
    for (let j = 0; j < searchLines.length; j += 1) {
      if (lines[i + j].trim() !== searchLines[j]) continue outer;
    }
    return sliceMatch(content, index, i, i + searchLines.length - 1, "line-trimmed");
  }
  return null;
}

/**
 * Block-anchor match: for 3+ line blocks, find a span whose FIRST and LAST trimmed lines
 * match the search block's, with the same line count. The middle may differ (the model
 * paraphrased or slightly mis-copied it) - the anchors and the length localize the block.
 */
function blockAnchorMatch(content: string, search: string, index: LineIndex): EditMatch | null {
  const searchLines = search.split("\n");
  while (searchLines.length && searchLines[searchLines.length - 1].trim() === "") searchLines.pop();
  if (searchLines.length < 3) return null;
  const first = searchLines[0].trim();
  const last = searchLines[searchLines.length - 1].trim();
  if (!first || !last) return null;
  const span = searchLines.length;
  const { lines } = index;
  for (let i = 0; i + span <= lines.length; i += 1) {
    if (lines[i].trim() !== first) continue;
    if (lines[i + span - 1].trim() !== last) continue;
    return sliceMatch(content, index, i, i + span - 1, "block-anchor");
  }
  return null;
}

/**
 * Find where `search` really lives in `content`, tolerating the whitespace/middle drift a
 * small model typically introduces. Returns null only when nothing plausible matches.
 */
export function findEditMatch(content: string, search: string): EditMatch | null {
  if (!content || !search?.trim()) return null;
  const exactStart = content.indexOf(search);
  if (exactStart >= 0) {
    const before = content.slice(0, exactStart);
    const startLine = before.split("\n").length;
    const endLine = startLine + search.split("\n").length - 1;
    return { start: exactStart, end: exactStart + search.length, startLine, endLine, method: "exact", actualText: search };
  }
  const index = indexLines(content);
  return lineTrimmedMatch(content, search, index) ?? blockAnchorMatch(content, search, index);
}

/**
 * In-band rescue notice for a failed exact-match edit: locate the near-match and hand the
 * model the EXACT on-disk text to retry with. Bounded; null when there is nothing to say
 * (no near-match, or the region is too large to inline).
 */
export function editRescueNotice(content: string, failedSearch: string, maxChars = 900): string | null {
  const match = findEditMatch(content, failedSearch);
  if (!match || match.method === "exact") return null;
  const actual = match.actualText.length <= maxChars
    ? match.actualText
    : `${match.actualText.slice(0, maxChars)}\n... [clipped - read lines ${match.startLine}-${match.endLine} for the full text]`;
  return [
    `Cheater edit rescue: your oldText did not match exactly, but a ${match.method} match exists at lines ${match.startLine}-${match.endLine}.`,
    "Retry the edit using this EXACT on-disk text as oldText (copy it verbatim):",
    "<<<",
    actual,
    ">>>"
  ].join("\n");
}
