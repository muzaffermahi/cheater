// Kitten Ascent — worked-example anchor gate. The single safest verification signal on a hidden-oracle
// task: the worked examples IN THE PROMPT are real ground truth (the spec's own I/O), not model-generated
// (which are self-flattering — a model passes its own tests at 41% even when they're conditioned on buggy
// code; arXiv:2409.09464). Research says execution feedback is the load-bearing component for a weak
// model (Self-Edit +48% rel even at tiny scale), pure reflection hurts, and a single I/O example in the
// prompt is worth ~+11pp (Tests-as-Prompt). So: extract the examples deterministically, run the
// candidate against them, and REFUSE to finish while any fails — feeding the exact failing case back for
// a bounded repair. This catches gross/interface/return-type bugs before they ship.
//
// Extraction is pure + balanced-bracket aware (args and expected values nest brackets/quotes and span
// backticks/newlines). It only trusts an example whose expected side parses as a Python literal.

import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface WorkedExample {
  call: string;      // e.g. `next_times("*/15 * * * *", "2024-01-01T00:07", 4)`
  expected: string;  // e.g. `["2024-01-01T00:15", "2024-01-01T00:30"]`
}

const CONNECTORS = ["->", "=>", "→", "==", "returns", "return", "yields", "gives", "produces", "=", "is"];

/** Match a balanced bracketed span starting at `text[open]` (must be one of ()[]{}); returns end index (exclusive) or -1. */
function matchBalanced(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const close = pairs[text[open]];
  if (!close) return -1;
  let depth = 0, inStr: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Grab the expected value after a connector: a Python literal (balanced) or a quoted/number/bare token. */
function grabExpected(text: string, from: number): { value: string; end: number } | null {
  let i = from;
  while (i < text.length && /[\s`]/.test(text[i])) i++;
  if (i >= text.length) return null;
  const c = text[i];
  if (c === "[" || c === "{" || c === "(") { const end = matchBalanced(text, i); if (end < 0) return null; return { value: text.slice(i, end), end }; }
  if (c === '"' || c === "'") { let j = i + 1; while (j < text.length && text[j] !== c) { if (text[j] === "\\") j++; j++; } return { value: text.slice(i, j + 1), end: j + 1 }; }
  // bare token: number / True/False/None / identifier, up to a terminator. The number branch must cover
  // scientific notation (1e6) and digit-group underscores (1_000) — otherwise `1e6` captured only `1`
  // and a correct solution returning 1000000 FALSE-FAILED against the truncated expected value.
  const m = text.slice(i).match(/^(-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|True|False|None|-?\w[\w.]*)/);
  if (m) return { value: m[1], end: i + m[1].length };
  return null;
}

/** Quick check that a string is a plausible Python literal (list/dict/tuple/str/num/bool/None). */
function looksLikeLiteral(s: string): boolean {
  const t = s.trim();
  if (/^-?\d/.test(t) || t === "True" || t === "False" || t === "None") return true;
  if (/^["'\[{(]/.test(t)) return true;
  return false;
}

// Python builtins / common noise that appear as `name(` in prose but are never the task's target symbol.
const CALL_NOISE = new Set([
  "print", "range", "len", "int", "str", "list", "dict", "set", "tuple", "float", "bool", "type",
  "repr", "sorted", "sum", "min", "max", "abs", "map", "filter", "zip", "enumerate", "open", "input",
  "isinstance", "getattr", "setattr", "format", "round", "any", "all", "next", "iter", "super",
]);

/** Discover call-symbols from `identifier( ... ) <connector> <literal>`-shaped text — used when the
 *  caller passed no symbols (a contract that missed the function name must not disable ground truth). */
function discoverCallSymbols(text: string): string[] {
  const found = new Set<string>();
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (CALL_NOISE.has(name)) continue;
    found.add(name);
    if (found.size >= 24) break;
  }
  return [...found];
}

/**
 * Extract worked examples `symbol(args) <connector> expected` from the task text for the given symbols.
 * Balanced-bracket aware; only keeps examples whose expected side is a literal. Deduped, bounded.
 * When `symbols` is empty (contract missed the function), symbols are DISCOVERED from the example shapes
 * themselves — the per-example validation (a connector + a Python literal, no ellipsis) filters prose.
 */
export function extractWorkedExamples(task: string, symbols: string[]): WorkedExample[] {
  const text = task ?? "";
  const out: WorkedExample[] = [];
  const seen = new Set<string>();
  let syms = symbols.filter((s) => /^[A-Za-z_]\w*$/.test(s));
  if (!syms.length) syms = discoverCallSymbols(text);
  if (!syms.length) return out;
  const symRe = new RegExp(`\\b(${syms.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = symRe.exec(text)) !== null) {
    const parenOpen = m.index + m[0].length - 1;
    const callEnd = matchBalanced(text, parenOpen);
    if (callEnd < 0) continue;
    const call = text.slice(m.index, callEnd);
    // Find the nearest connector after the call (skipping backticks/whitespace/newlines, bounded window).
    let rest = text.slice(callEnd, callEnd + 200);
    // strip a leading closing-backtick + whitespace
    const connMatch = rest.match(new RegExp(`^[\\s\`]*(${CONNECTORS.map((c) => c.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&")).join("|")})`));
    if (!connMatch) continue;
    const afterConn = callEnd + connMatch[0].length;
    const exp = grabExpected(text, afterConn);
    if (!exp || !looksLikeLiteral(exp.value)) continue;
    // Skip abbreviated examples: a prompt often shows `[{...}, ...]` or `[…]` as shorthand, which is not
    // a real literal — asserting against it would FALSE-FAIL a correct solution.
    if (/\.\.\.|…/.test(exp.value) || /\.\.\.|…/.test(call)) continue;
    const key = call + "=>" + exp.value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ call: call.trim(), expected: exp.value.trim() });
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Extract setup variable definitions `name = <literal>` from the task text (e.g. json_query's
 * `data = {...}`), so worked examples that reference them can run. Only literal RHS values are kept.
 */
export function extractSetupVars(task: string): string[] {
  const text = task ?? "";
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\n|`)\s*([a-z_]\w*)\s*=\s*(?=[[{("'\d-])/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (["if", "for", "while", "def", "return", "assert", "is", "in", "and", "or", "not"].includes(name)) continue;
    const from = m.index + m[0].length;
    const val = grabExpected(text, from - 0);
    if (!val || !looksLikeLiteral(val.value)) continue;
    // Skip abbreviated setup data (`grid = [[1, ...]]`): `...` runs as Python Ellipsis and would
    // false-fail a correct solution. Mirrors the same guard in extractWorkedExamples.
    if (/\.\.\.|…/.test(val.value)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(`${name} = ${val.value}`);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Build a runnable python test that imports `module` and asserts each worked example. Returns the test
 * source. Each assertion is guarded so ONE failing example reports as a clear line, not a crash. Setup
 * variables referenced by the examples (e.g. `data = {...}`) are defined first.
 */
export function buildExampleTest(examples: WorkedExample[], module: string, setupVars: string[] = []): string {
  const modName = module.replace(/\.py$/, "");
  const lines = [
    "import json, sys",
    `import ${modName} as _m`,
    "from " + modName + " import *",
    ...setupVars.map((v) => `try:\n    ${v}\nexcept Exception: pass`),
    "fails = []",
  ];
  examples.forEach((ex, i) => {
    lines.push(
      `try:`,
      `    _got = (${ex.call})`,
      `    _exp = (${ex.expected})`,
      `    if _got != _exp: fails.append({"i": ${i}, "call": ${JSON.stringify(ex.call)}, "got": repr(_got)[:200], "expected": ${JSON.stringify(ex.expected)}})`,
      `except Exception as _e:`,
      `    fails.append({"i": ${i}, "call": ${JSON.stringify(ex.call)}, "error": type(_e).__name__ + ": " + str(_e)[:160]})`,
    );
  });
  lines.push(`print("WORKED_EXAMPLES " + json.dumps({"total": ${examples.length}, "fails": fails}))`);
  lines.push(`sys.exit(1 if fails else 0)`);
  return lines.join("\n");
}

export interface ExampleRunResult {
  ran: boolean;
  total: number;
  passed: number;
  failures: Array<{ call: string; got?: string; expected?: string; error?: string }>;
}

/**
 * Run the worked examples for a task against the candidate in `cwd`. Writes a throwaway test into cwd,
 * executes it, parses the WORKED_EXAMPLES json. Never throws; ran:false means no signal (no examples, or
 * the module couldn't load — which is itself a bug the finish gate surfaces separately).
 */
export function runExampleTest(cwd: string, module: string, examples: WorkedExample[], setupVars: string[] = []): ExampleRunResult {
  const empty: ExampleRunResult = { ran: false, total: examples.length, passed: 0, failures: [] };
  if (!examples.length) return empty;
  if (!existsSync(join(cwd, module))) return empty;
  const testPath = join(cwd, "_kitten_worked_test.py");
  try {
    writeFileSync(testPath, buildExampleTest(examples, module, setupVars));
    const r = spawnSync("python", [testPath], { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
    const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("WORKED_EXAMPLES "));
    if (!line) return empty;
    const obj = JSON.parse(line.slice("WORKED_EXAMPLES ".length)) as { total: number; fails: ExampleRunResult["failures"] };
    return { ran: true, total: obj.total, passed: obj.total - obj.fails.length, failures: obj.fails };
  } catch {
    return empty;
  } finally {
    try { rmSync(testPath, { force: true }); } catch { /* ignore */ }
  }
}

/** Render the failing worked examples into a tight repair-grounding block (the shortest first). */
export function renderExampleFailures(r: ExampleRunResult, max = 3): string {
  if (!r.failures.length) return "";
  const sorted = [...r.failures].sort((a, b) => a.call.length - b.call.length).slice(0, max);
  const lines = [`Your code fails ${r.failures.length}/${r.total} of the worked examples GIVEN IN THE TASK (these are ground truth — fix exactly these):`];
  for (const f of sorted) {
    if (f.error) lines.push(`- ${f.call}  →  raised ${f.error}  (expected ${f.expected ?? "?"})`);
    else lines.push(`- ${f.call}  →  got ${f.got}  but expected ${f.expected}`);
  }
  return lines.join("\n");
}
