// Noun firewall: hallucinated paths die at the door, not in a stack trace.
//
// TB2 failure class #3: a worker invents a path (writes to /app/tls when the real dir is /app/ssl),
// the tool errors, and the model burns a whole session discovering the truth by trial and error. All
// the other cheater gates are POST-edit. This one is PRE-execution: before a read / exec / cd / edit
// touches a path that MUST already exist, the harness checks the filesystem itself, and on a miss
// returns a repair-ready result ("Path not found: /app/tls. Nearest existing: /app/ssl") instead of
// letting the model spelunk. One correction turn, not a spelunking session.
//
// Two hard rules keep this from ever blocking legitimate work:
//   1. Scope guard - only workspace paths are gated; system paths (/usr, /bin, C:\Windows) pass.
//   2. Fail-open - if extraction is unsure, the token is not gated; and after a couple of blocks on
//      the SAME phantom the gate opens (the miss then flows to the normal error + loop machinery).
//
// Everything is deterministic fs + string work; there is no model-facing tool here.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type NounGateVerdict =
  | { action: "allow" }
  | { action: "block"; reason: string; phantomPath: string; suggestions: string[] };

export interface NounGateInput {
  toolName: string;
  input: Record<string, unknown> | undefined;
  cwd: string;
}

/** Internal kill-switch (not a CheaterConfig flag). */
export const NOUN_GATE = { enabled: true };

// The gate deliberately does NOT touch the read/ls/cat TOOLS: a read miss already returns a clean
// "file not found", and reading a maybe-missing file is a legitimate existence probe - gating it
// would fight the model's normal "check then create" pattern. The expensive, buried-error failure
// mode (TB2 #3) is EXECUTION against a phantom path (openssl -in /app/tls/... , cd wrong && longcmd),
// a shell redirect into a missing dir, or EDITING a file that does not exist. Those are what we gate.
const EDIT_EXIST_TOOLS = new Set(["edit", "edit_file", "cheater_line_edit", "cheater_replace"]);
const COMMAND_TOOLS = new Set(["bash", "run_command", "run", "shell", "exec"]);

// After this many blocks on the same phantom path, the gate opens so a genuine miss reaches the
// normal error path and the loop governor - the noun gate itself must never become the loop.
const MAX_BLOCKS_PER_PATH = 2;
const blockCounts = new Map<string, number>();

/** Reset the per-run phantom-block counters (called at run start and in tests). */
export function resetNounGate(): void {
  blockCounts.clear();
}

// --- path classification ---------------------------------------------------------------------

function normKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** Is `child` at or under `parent`? Cross-platform (path.relative handles drive/case). */
function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A path is in scope for gating only when it resolves at or under the workspace root. System paths
 * (/usr/bin, C:\Windows), home (~), and URLs are out of scope - never gated.
 */
export function isWorkspacePath(target: string, cwd: string): boolean {
  const t = (target ?? "").trim().replace(/^["']|["']$/g, "");
  if (!t) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL scheme (http://, file://, ...)
  if (t.startsWith("~")) return false; // home-relative
  if (t.startsWith("$") || t.includes("$(") || t.includes("${")) return false; // shell variable
  const root = resolve(cwd);
  const resolved = isAbsolute(t) || /^[A-Za-z]:[\\/]/.test(t) ? resolve(t) : resolve(cwd, t);
  return isUnder(resolved, root);
}

/** Does a token look like a filesystem path (vs a bare word, flag, glob, or option)? */
export function isPathLike(token: string): boolean {
  const t = token.trim();
  if (!t || t.length > 400) return false;
  if (t.startsWith("-")) return false; // flag
  if (/[*?\[\]]/.test(t)) return false; // glob - existence is not meaningful
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL
  if (t.startsWith("$") || t.includes("$(") || t.includes("${") || t.includes("`")) return false; // expansion
  // Code, not a path: parens/quotes/operators mean this is an inline expression (a `/` here is
  // division, not a directory separator) — e.g. evaluate('10/4') inside `python -c`. Real filesystem
  // paths do not contain these. Rejecting them kills the "arithmetic looks like a path" false block.
  if (/[()'"`;=,!]/.test(t)) return false;
  if (/^\d+\s*\/\s*\d+$/.test(t)) return false; // bare arithmetic like 10/4
  if (t.includes("/") || t.includes("\\")) return true; // has a separator -> path
  if (/^\.\.?$/.test(t)) return true; // . or ..
  // A bare filename with a real extension (server.crt, config.yaml) is path-like.
  return /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(t) && !/^\d+\.\d+$/.test(t);
}

/** Tokenize a single shell segment, stripping simple surrounding quotes. */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  return tokens.filter(Boolean);
}

// Verbs that EXECUTE their path argument (a phantom here wastes a whole session on a buried error),
// or crypto/archive tools TB2 tasks lean on. Deliberately NOT the pure-read verbs (cat/head/tail/wc):
// those error cleanly and are used to probe, so gating them would fight normal inspection.
const READ_EXEC_VERBS = new Set([
  "source", ".", "bash", "sh", "zsh",
  "python", "python3", "py", "node", "deno", "ruby", "perl", "php", "go",
  "openssl", "tar", "unzip"
]);
const CD_VERBS = new Set(["cd", "pushd"]);
// Verbs that CREATE their target (the path is allowed to be new).
const CREATE_VERBS = new Set(["mkdir", "touch", "tee"]);

/**
 * Extract path tokens from a shell command, split into paths that must already exist (read/exec/cd/
 * input redirect) and paths that may be new (output redirect). Deliberately conservative: a token is
 * classified must-exist only in a clear read/exec context, so ordinary commands are never gated.
 */
export function extractCommandPaths(command: string): { mustExist: string[]; mayBeNew: string[] } {
  const mustExist: string[] = [];
  const mayBeNew: string[] = [];
  const segments = (command ?? "").split(/&&|\|\||[;|]/);
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment.trim());
    if (!tokens.length) continue;
    const verb = basename(tokens[0]).toLowerCase();
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      // Inline code / module args are not paths: the token after -c/-e/-m/--eval is a program or a
      // module name (`python -c "..."`, `node -e "..."`, `python -m pytest`). Skip it so its contents
      // are never mistaken for filesystem paths.
      if (/^(-c|-e|-m|--eval|--command)$/.test(tok)) { i++; continue; }
      // Redirections: `> out` / `>> out` (new), `< in` (must exist). Also attached forms (`>out`).
      const redirOut = tok.match(/^>>?(.*)$/);
      const redirIn = tok.match(/^<(.*)$/);
      if (redirOut) {
        const target = redirOut[1] || tokens[++i] || "";
        if (isPathLike(target)) mayBeNew.push(target);
        continue;
      }
      if (redirIn) {
        const target = redirIn[1] || tokens[++i] || "";
        if (isPathLike(target)) mustExist.push(target);
        continue;
      }
      if (i === 0) continue; // the verb itself
      if (!isPathLike(tok)) continue;
      if (CD_VERBS.has(verb)) mustExist.push(tok);
      else if (CREATE_VERBS.has(verb)) mayBeNew.push(tok);
      else if (READ_EXEC_VERBS.has(verb)) mustExist.push(tok);
      // any other verb: not gated (fail-open)
    }
  }
  return { mustExist: dedupe(mustExist), mayBeNew: dedupe(mayBeNew) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((i) => i.trim()).filter(Boolean))];
}

function extractPathField(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "file_path", "filePath", "target", "file", "dir", "directory"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Classify the path tokens a tool call will touch into must-exist vs may-be-new. */
export function classifyPathTokens(toolName: string, input: Record<string, unknown> | undefined): { mustExist: string[]; mayBeNew: string[] } {
  if (COMMAND_TOOLS.has(toolName)) {
    const command = typeof input?.command === "string" ? input.command : typeof input?.cmd === "string" ? String(input.cmd) : "";
    return extractCommandPaths(command);
  }
  const path = extractPathField(input);
  if (!path) return { mustExist: [], mayBeNew: [] };
  if (EDIT_EXIST_TOOLS.has(toolName)) return { mustExist: [path], mayBeNew: [] };
  // The write tool is intentionally NOT gated: Pi's write creates parent dirs, and from-scratch
  // scaffolds legitimately write into not-yet-existing directories. The read/ls tools are not gated
  // either (clean errors + existence probing). Bash redirects (which bash will NOT auto-create) are
  // still caught via extractCommandPaths above.
  return { mustExist: [], mayBeNew: [] };
}

// --- suggestions -----------------------------------------------------------------------------

/** Bounded Levenshtein distance between two short strings. */
export function editDistance(a: string, b: string): number {
  const s = a.slice(0, 80);
  const t = b.slice(0, 80);
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

const SUGGEST_SKIP = new Set([".git", "node_modules", ".cheater", ".pisession", "dist", "build", ".next", "out", "coverage", ".vite", "__pycache__", ".venv", "venv", ".pytest_cache", "target"]);

/** The nearest existing ancestor directory of an (absolute) path. */
function nearestExistingAncestor(absPath: string): string {
  let dir = dirname(absPath);
  for (let i = 0; i < 12; i++) {
    if (existsSync(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/**
 * Up to `limit` existing paths nearest to a missing target: same-basename matches rank first (the
 * classic /app/ssl/server.crt for a phantom /app/tls/server.crt), then smallest edit distance on the
 * path relative to the nearest existing ancestor. Bounded walk; never throws.
 */
export function nearestExistingPaths(target: string, cwd: string, limit = 2): string[] {
  try {
    const root = resolve(cwd);
    const targetAbs = isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) ? resolve(target) : resolve(cwd, target);
    const targetBase = basename(targetAbs).toLowerCase();
    const anchor = nearestExistingAncestor(targetAbs);
    const searchRoot = isUnder(anchor, root) || anchor === root ? anchor : root;
    const candidates: Array<{ path: string; score: number }> = [];
    let seen = 0;
    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || seen > 3000) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (seen > 3000) return;
        if (SUGGEST_SKIP.has(entry.name)) continue;
        seen++;
        const abs = join(dir, entry.name);
        const rel = relative(root, abs).replace(/\\/g, "/");
        const base = entry.name.toLowerCase();
        // Basename match is the strongest signal (right file, wrong dir).
        const baseMatch = base === targetBase ? 0 : editDistance(base, targetBase);
        if (baseMatch <= Math.max(2, Math.floor(targetBase.length / 3))) {
          candidates.push({ path: rel, score: baseMatch * 10 + editDistance(rel.toLowerCase(), targetAbs.replace(/\\/g, "/").toLowerCase().slice(-rel.length)) });
        }
        if (entry.isDirectory()) walk(abs, depth + 1);
      }
    };
    walk(searchRoot, 0);
    candidates.sort((a, b) => a.score - b.score);
    return [...new Set(candidates.map((c) => c.path))].slice(0, limit);
  } catch {
    return [];
  }
}

// --- the gate --------------------------------------------------------------------------------

function buildBlockReason(phantom: string, suggestions: string[]): string {
  const near = suggestions.length ? ` Nearest existing: ${suggestions.join(", ")}.` : "";
  return `Path not found: ${phantom}.${near} Use an existing path, or create ${phantom} first if it is genuinely new. (This is a pre-execution check - the path does not exist yet, so the command was not run.)`;
}

function buildParentReason(phantom: string, missingParent: string, suggestions: string[]): string {
  const near = suggestions.length ? ` Nearest existing directory: ${suggestions.join(", ")}.` : "";
  return `Cannot write ${phantom}: its parent directory ${missingParent} does not exist.${near} Create the directory first (mkdir -p) or fix the path.`;
}

/**
 * The pre-execution noun gate. Returns block with repair-ready suggestions when a must-exist
 * workspace path is missing (or a shell output redirect targets a missing parent dir). Fail-open on
 * anything ambiguous, on out-of-scope paths, and after MAX_BLOCKS_PER_PATH repeats of one phantom.
 */
export function nounGateVerdict(inp: NounGateInput): NounGateVerdict {
  try {
    if (!NOUN_GATE.enabled) return { action: "allow" };
    const { mustExist, mayBeNew } = classifyPathTokens(inp.toolName, inp.input);
    for (const path of mustExist) {
      if (!isWorkspacePath(path, inp.cwd)) continue;
      const abs = resolve(inp.cwd, path);
      if (existsSync(abs)) continue;
      const key = normKey(abs);
      const count = (blockCounts.get(key) ?? 0) + 1;
      blockCounts.set(key, count);
      if (count > MAX_BLOCKS_PER_PATH) continue; // fail open -> normal error + loop machinery
      const suggestions = nearestExistingPaths(path, inp.cwd);
      return { action: "block", phantomPath: path, suggestions, reason: buildBlockReason(path, suggestions) };
    }
    for (const path of mayBeNew) {
      if (!isWorkspacePath(path, inp.cwd)) continue;
      const parent = dirname(resolve(inp.cwd, path));
      if (existsSync(parent)) continue;
      if (parent === dirname(parent)) continue; // filesystem root, never gate
      const key = normKey(parent);
      const count = (blockCounts.get(key) ?? 0) + 1;
      blockCounts.set(key, count);
      if (count > MAX_BLOCKS_PER_PATH) continue;
      const suggestions = nearestExistingPaths(dirname(path), inp.cwd);
      return { action: "block", phantomPath: path, suggestions, reason: buildParentReason(path, relative(resolve(inp.cwd), parent).replace(/\\/g, "/") || parent, suggestions) };
    }
    return { action: "allow" };
  } catch {
    return { action: "allow" }; // the gate must never break a run
  }
}
