// Tool-error normalization: turn raw command/tool sludge into a small, bounded, structured shape so
// the big model receives a compact normalized error, not pages of stderr. This is DETERMINISTIC
// (pattern-matching) - the sidecar's distillFailure can compress further, but code is the floor and
// never needs the big model for this clerical job.
//
// Non-authoritative: this only RESHAPES text. It never decides whether a gate passes or whether the
// code is correct - the verifier/ledger remain the source of truth.

export type ToolErrorKind =
  | "command_not_found"
  | "permission_denied"
  | "timeout"
  | "typecheck_failed"
  | "test_failed"
  | "build_failed"
  | "edit_conflict"
  | "file_stale"
  | "not_found"
  | "unknown";

export interface NormalizedToolError {
  kind: ToolErrorKind;
  /** One bounded line naming the failure. */
  summary: string;
  /** A few bounded lines of the most salient output (the strongest error lines), or undefined. */
  detail?: string;
  /** A deterministic next-step hint (no model needed). */
  hint?: string;
}

const ERROR_LINE = /(^|\b)(error|failed|failure|assert(ion)?|exception|traceback|cannot|not\s+found|undefined|unresolved|denied|refused|TS\d{4}|[A-Za-z]*(Error|Exception))\b/i;

// Ordered most-specific-first: the first matching kind wins.
const KIND_RULES: Array<{ kind: ToolErrorKind; re: RegExp; hint: string }> = [
  { kind: "command_not_found", re: /command not found|is not recognized as an internal|: not found\b|No such file or directory\b.*\b(sh|bash|npm|node|python)\b/i, hint: "The command/binary is missing - install it or use the project's local script (package.json scripts, ./node_modules/.bin)." },
  { kind: "permission_denied", re: /permission denied|EACCES|EPERM|Access is denied|Operation not permitted/i, hint: "A permission/ownership problem - do not retry blindly; check the path's permissions or run without elevation." },
  { kind: "timeout", re: /timed out|ETIMEDOUT|deadline exceeded|operation timed out/i, hint: "The operation exceeded its time budget - it may be a slow/wedged process, not a code bug." },
  { kind: "typecheck_failed", re: /error TS\d{3,5}\b|is not assignable to|has no exported member|Cannot find name|Cannot find module/i, hint: "A type error - fix the referenced symbol/import in the changed file; do not broaden scope." },
  { kind: "edit_conflict", re: /edit conflict|patch does not apply|hunk failed|merge conflict|<<<<<<<|has been modified since/i, hint: "The file changed under the edit - re-read the exact current lines, then apply the smallest patch." },
  { kind: "file_stale", re: /stale|file changed on disk|out of date|ENOENT.*(open|read)|no longer exists/i, hint: "The target is stale/missing - re-read it before editing." },
  { kind: "test_failed", re: /\b(\d+\s+(failing|failed))\b|tests? failed|AssertionError|assert\b|not ok \d+|\bFAIL\b|✗|expected .* (to|but)/i, hint: "A test assertion failed - read the exact expected-vs-actual and make the smallest change that satisfies it." },
  { kind: "build_failed", re: /build failed|compilation (error|failed)|webpack|rollup|esbuild|error: could not compile/i, hint: "The build failed - fix the first reported error; later errors are often cascades." },
  { kind: "not_found", re: /ENOENT|No such file or directory|not found|404|does not exist/i, hint: "A referenced path/name does not exist - verify it before using it." }
];

function strongestLines(text: string, max = 4): string[] {
  const lines = (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => ERROR_LINE.test(l));
  const picked = (errs.length ? errs : lines).slice(0, max);
  return picked.map((l) => (l.length > 200 ? l.slice(0, 200) + "…" : l));
}

/**
 * Normalize a raw tool/command result into a bounded structured error. `isError` false with empty
 * output yields a benign "unknown". Never throws.
 */
export function normalizeToolError(input: { tool?: string; command?: string; output?: string; isError?: boolean }): NormalizedToolError {
  const text = `${input.command ? input.command + "\n" : ""}${input.output ?? ""}`;
  const detailLines = strongestLines(input.output ?? "");
  const detail = detailLines.length ? detailLines.join("\n") : undefined;
  for (const rule of KIND_RULES) {
    if (rule.re.test(text)) {
      const head = detailLines[0] ?? `${input.tool ?? "tool"} failed`;
      return { kind: rule.kind, summary: `${rule.kind.replace(/_/g, " ")}: ${head.slice(0, 160)}`, detail, hint: rule.hint };
    }
  }
  const head = detailLines[0] ?? `${input.tool ?? "tool"} ${input.isError ? "failed" : "output"}`;
  return { kind: "unknown", summary: head.slice(0, 160), detail, hint: input.isError ? "Re-read the exact failing region and make the smallest change that satisfies the check." : undefined };
}

/** Render a normalized error as a compact block for a failure card / repair note (bounded). */
export function renderNormalizedToolError(err: NormalizedToolError): string {
  const lines = [`tool error [${err.kind}]: ${err.summary}`];
  if (err.detail) lines.push(err.detail);
  if (err.hint) lines.push(`hint: ${err.hint}`);
  return lines.join("\n");
}
