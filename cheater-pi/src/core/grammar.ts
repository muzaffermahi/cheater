// GBNF grammar builders — make malformed output unrepresentable instead of repairing it afterwards.
//
// llama.cpp accepts a `grammar` string that constrains sampling. A constrained decode cannot emit a
// label outside its enum, a path outside the repository, or a patch that does not parse — so the
// "model returned junk, re-ask, re-prefill" turn stops existing. At ~20 tok/s a wasted turn is the
// most expensive failure mode we have.
//
// Two cautions the research pass established, both encoded here:
//   1. Grammar size is not free. Large or naively-nested rules cost real sampling time, so path
//      grammars are bounded and every builder stays flat.
//   2. A path grammar must be two-armed. Constraining output to files that already exist makes
//      creating a file impossible, which turns a capability into a false negative.
//
// Everything here is a pure string builder: no dependencies, deterministic, unit-testable offline.

/** Escape a literal for a GBNF double-quoted string. */
function literal(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * One token of choice and nothing else. Used for routing/triage/family labels, where the answer is a
 * closed set and any prose around it is pure cost.
 */
export function enumGrammar(labels: readonly string[]): string {
  const unique = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (!unique.length) throw new Error("enumGrammar requires at least one label");
  return `root ::= ${unique.map(literal).join(" | ")}`;
}

/** The same closed set, wrapped in a JSON string, for call sites that must stay JSON-shaped. */
export function jsonEnumGrammar(labels: readonly string[], key = "label"): string {
  const unique = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (!unique.length) throw new Error("jsonEnumGrammar requires at least one label");
  return [
    `root ::= "{" ws ${literal(`"${key}"`)} ws ":" ws label ws "}"`,
    `label ::= ${unique.map((value) => literal(`"${value}"`)).join(" | ")}`,
    `ws ::= [ \\t\\n]*`,
  ].join("\n");
}

/**
 * An anchored edit script. The model proposes; the harness applies. Each hunk names a file, the exact
 * text to find, and the replacement — which is far less output than restating a whole file, and cannot
 * express "rewrote the file and dropped half of it".
 */
export const EDIT_SCRIPT_GRAMMAR = [
  `root ::= hunk+`,
  `hunk ::= "<<<< FILE " path "\\n" "<<<< FIND\\n" body ">>>> REPLACE\\n" body ">>>> END\\n"`,
  `path ::= [^\\n]+`,
  `body ::= line+`,
  `line ::= [^\\n]* "\\n"`,
].join("\n");

/**
 * A tool call in the tag format, for the ONE case where constraining decode is clearly right: the
 * retry after the model's own arguments failed to parse.
 *
 * Two findings drive this. NVIDIA measured grammar-constrained RETRY (not always-on constraint)
 * lifting mean bash-task pass rate across thirteen models from 62.5% to 75.2%, with the largest gains
 * on the smallest models, almost entirely by eliminating malformed calls. Kitten's own A/B pushed the
 * other way: an always-on schema constraint COST content on the 2B, and a prompt hint was the better
 * fix. Retry-only is where both results agree.
 *
 * The format matters as much as the constraint. Argument parse failures here are overwhelmingly a
 * large payload — a whole source file inlined into a JSON arguments string, its quotes and newlines
 * escaped — breaking the parser mid-string. The tag format does not escape anything, so the same
 * payload passes through literally and there is nothing left to break. `parseTextToolCalls` already
 * reads it, which is why the retry asks for text rather than a native tool call.
 */
export function toolCallGrammar(toolNames: readonly string[]): string {
  const unique = [...new Set(toolNames.map((n) => n.trim()).filter(Boolean))];
  if (!unique.length) throw new Error("toolCallGrammar requires at least one tool name");
  return [
    `root ::= "<tool_call>\\n<function=" name ">\\n" param+ "</function>\\n</tool_call>"`,
    `name ::= ${unique.map(literal).join(" | ")}`,
    `param ::= "<parameter=" key ">\\n" value "\\n</parameter>\\n"`,
    // A parameter key is a bare identifier; the VALUE is deliberately unconstrained apart from its
    // closing tag, because it may legitimately be an entire file.
    `key ::= [a-z_]+`,
    `value ::= ( [^<] | "<" [^/] )*`,
  ].join("\n");
}

/** A hunk parsed back out of an edit script. */
export interface EditHunk {
  path: string;
  find: string;
  replace: string;
}

/**
 * Parse an edit script. Tolerant on purpose: the grammar guarantees the shape only when the endpoint
 * supports grammars, and this same format has to survive a proxy that does not.
 */
export function parseEditScript(text: string): EditHunk[] {
  const hunks: EditHunk[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const header = lines[index].match(/^<<<< FILE (.+)$/);
    if (!header) { index += 1; continue; }
    const path = header[1].trim();
    index += 1;
    if (lines[index]?.trim() !== "<<<< FIND") continue;
    index += 1;
    const find: string[] = [];
    while (index < lines.length && lines[index].trim() !== ">>>> REPLACE") { find.push(lines[index]); index += 1; }
    index += 1;
    const replace: string[] = [];
    while (index < lines.length && lines[index].trim() !== ">>>> END") { replace.push(lines[index]); index += 1; }
    index += 1;
    if (path) hunks.push({ path, find: find.join("\n"), replace: replace.join("\n") });
  }
  return hunks;
}

/** Bounded so the grammar stays cheap to sample against; the caller ranks before truncating. */
export const MAX_GRAMMAR_PATHS = 400;

export interface PathGrammarOptions {
  /** Marker the model emits when it needs a file that does not exist yet. */
  newFileSentinel?: string;
  maxPaths?: number;
}

/**
 * Constrain a path to the repository — with an explicit escape hatch.
 *
 * The second arm is not optional. A grammar of existing paths alone silently removes the ability to
 * create a file, so the model would be forced to name the wrong existing file instead: the guard would
 * manufacture exactly the error it was built to prevent.
 */
export function pathGrammar(paths: readonly string[], options: PathGrammarOptions = {}): string {
  const sentinel = options.newFileSentinel ?? "NEW_FILE:";
  const max = Math.max(1, Math.min(options.maxPaths ?? MAX_GRAMMAR_PATHS, MAX_GRAMMAR_PATHS));
  const unique = [...new Set(paths.map((path) => path.replace(/\\/g, "/").trim()).filter(Boolean))].slice(0, max);
  const existing = unique.length ? unique.map(literal).join(" | ") : literal("");
  return [
    `root ::= existing | new`,
    `existing ::= ${existing}`,
    `new ::= ${literal(sentinel)} [^\\n]+`,
    ].join("\n");
}

/** True when the model took the escape hatch rather than an indexed file. */
export function isNewFilePath(value: string, sentinel = "NEW_FILE:"): boolean {
  return value.trimStart().startsWith(sentinel);
}

export function newFilePathOf(value: string, sentinel = "NEW_FILE:"): string {
  const trimmed = value.trimStart();
  return trimmed.startsWith(sentinel) ? trimmed.slice(sentinel.length).trim() : trimmed.trim();
}

/**
 * A rough size signal for the sampling-cost budget. Grammar cost tracks the number of alternatives far
 * more than raw byte length, so callers can refuse to ship a grammar that has grown unreasonable.
 */
export function grammarAlternatives(grammar: string): number {
  return grammar.split("\n").reduce((total, line) => total + (line.split("|").length - 1), 0);
}
