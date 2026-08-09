// Kitten Core — native tools. NO Pi tool chrome.
//
// These are the tools the standalone agent exposes to the model. They bake in three Tier-A
// research levers directly:
//   - edit = search/replace with a lenient/fuzzy applier + repair-ready errors (Aider: format alone
//     moves a fixed model 20%->61%; a lenient applier is -9x edit errors). We separate "wrong code"
//     (the model's job) from "wrong whitespace" (our applier's job).
//   - read = bounded, line-numbered windows (SWE-agent: a full-file `cat` is -5.3 pts vs a window;
//     too much context distracts a weak model).
//   - bash = truncated output (a verbose result floods a small model's context; -worse than nothing).
// Every tool returns a plain string the model sees, and never throws.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { ToolSchema } from "./llm.js";
import { shellFailureHint, interactiveStallHint } from "./shellGuard.js";

export interface ToolContext {
  cwd: string;
  /** Files the agent has read this run — read-before-write evidence. */
  filesRead: Set<string>;
  /** Files the agent has written this run. */
  filesWritten: Set<string>;
  /** Abort signal for the run — a cancellable tool (bash) kills its process tree when this fires. */
  signal?: AbortSignal;
  /** Main-agent-only delegation hook. Subagents receive no hook and therefore cannot recurse. */
  spawnTask?: (input: { agent: string; prompt: string; model?: string }) => Promise<{ conversationId: string; runId: string; status: string; summary: string }>;
  /** Optional task scope. An empty allow-list means "workspace", otherwise paths must match it. */
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
  /** Live progress sink: a long-running tool (bash) streams bounded output chunks here so a UI can
   *  show "what is it doing right now". Purely progressive — the final ToolResult stays authoritative. */
  onOutput?: (chunk: string) => void;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  /** structured signals for the harness (not shown to the model). */
  meta?: Record<string, unknown>;
}

export interface Tool {
  schema: ToolSchema;
  /** Sync tools return a ToolResult directly; a cancellable tool (bash) returns a Promise. */
  execute(args: Record<string, unknown>, ctx: ToolContext): ToolResult | Promise<ToolResult>;
}

const READ_WINDOW = 400;
const BASH_HEAD = 8000;
const BASH_TAIL = 4000;

function abs(ctx: ToolContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}
function rel(ctx: ToolContext, p: string): string {
  return relative(ctx.cwd, p).replace(/\\/g, "/") || p;
}

/** Windows and macOS compare paths case-insensitively; a scope check that does not would be bypassable. */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

/**
 * A POSIX shell for the `bash` tool on Windows, or null to fall back to cmd.exe.
 *
 * `spawn(cmd, { shell: true })` resolves to %COMSPEC% on Windows, so every `ls`, `pwd`, `cat` and
 * `grep` the model types comes back "is not recognized as an internal or external command". Models
 * are trained overwhelmingly on POSIX; on the bakeoff's mini_sql task two consecutive orientation
 * commands failed that way and the run never recovered its footing. Windows is this product's
 * primary platform, so that is a self-inflicted tax on every run.
 *
 * Git for Windows ships a real bash and is already a dependency of anyone using a coding agent.
 *
 * `C:\Windows\System32\bash.exe` and the WindowsApps stub are DELIBERATELY excluded: those launch
 * WSL, a different filesystem namespace where the workspace path (`C:\Users\...`) does not exist and
 * `cwd` would be meaningless. Silently running the model's commands in the wrong filesystem is far
 * worse than cmd.exe.
 */
export function resolvePosixShell(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== "win32") return null;      // spawn's own shell is already POSIX
  const usable = (p: string | undefined): p is string => {
    if (!p) return false;
    const norm = p.replace(/\\/g, "/").toLowerCase();
    if (norm.includes("/system32/") || norm.includes("/windowsapps/")) return false;  // WSL, not bash
    return existsSync(p);
  };
  const override = env.KITTEN_SHELL?.trim();
  if (override) return usable(override) ? override : null;   // explicit and wrong: don't guess past it
  // Derive from the git on PATH, so a non-default install location still works.
  const candidates: string[] = [];
  try {
    const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const root = execPath.stdout?.trim().replace(/\\/g, "/").replace(/\/mingw\d+\/libexec\/git-core\/?$/i, "");
    if (root) candidates.push(`${root}/bin/bash.exe`, `${root}/usr/bin/bash.exe`);
  } catch { /* git absent — fall through to the well-known locations */ }
  candidates.push(
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
  );
  return candidates.find(usable) ?? null;
}

/** Resolved once per process — the git probe spawns, and `bash` is called constantly. */
let posixShellCache: string | null | undefined;
function bashShellOption(): string | true {
  if (posixShellCache === undefined) posixShellCache = resolvePosixShell();
  return posixShellCache ?? true;
}
function fold(value: string): string {
  return CASE_INSENSITIVE_PATHS ? value.toLowerCase() : value;
}

/**
 * Resolve a tool path against the project root and return it as a root-relative POSIX path, or
 * `null` when it lands outside the root. Resolution walks to the nearest existing ancestor first, so
 * a file that does not exist yet is judged by the real directory it would be created in: a lexical
 * check alone is satisfied by a `..` chain, and also by a symlink or NTFS junction inside the project
 * that points at the rest of the disk.
 */
function rootRelative(root: string, target: string): string | null {
  const segments: string[] = [];
  let probe = resolve(target);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    segments.unshift(basename(probe));
    probe = parent;
  }
  const real = (value: string): string => { try { return realpathSync(value); } catch { return resolve(value); } };
  const resolvedRoot = real(root);
  const full = segments.length ? join(real(probe), ...segments) : real(probe);
  const relativePath = relative(resolvedRoot, full).replace(/\\/g, "/");
  if (relativePath.startsWith("../") || relativePath === ".." || isAbsolute(relativePath)) return null;
  return relativePath;
}

function scopeError(ctx: ToolContext, p: string): string | undefined {
  // Two independent gates. The project root is absolute: every tool path must land inside it, task
  // scope or not. The task scope then narrows further for a bounded subagent.
  const normalized = rootRelative(ctx.cwd, abs(ctx, p));
  if (normalized === null) return `path scope denied: ${p} resolves outside the project root`;
  const matches = (candidate: string): boolean => {
    const value = fold(candidate.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
    const subject = fold(normalized);
    return Boolean(value) && (subject === value || subject.startsWith(`${value}/`));
  };
  if ((ctx.forbiddenFiles ?? []).some(matches)) return `path scope denied: ${p} is forbidden for this task`;
  if ((ctx.allowedFiles?.length ?? 0) > 0 && !ctx.allowedFiles!.some(matches)) return `path scope denied: ${p} is outside the task's allowed files`;
  return undefined;
}

// --- read -----------------------------------------------------------------------------------

export const readTool: Tool = {
  schema: {
    name: "read",
    description: "Read a text file, returned with line numbers. Large files return a bounded window; use offset to page.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path (relative to the project root)" },
        offset: { type: "integer", description: "1-based line to start from (optional)" },
        limit: { type: "integer", description: "max lines to return (optional)" }
      },
      required: ["path"]
    }
  },
  execute(args, ctx) {
    const p = String(args.path ?? "");
    if (!p) return { output: "read: missing path", isError: true };
    const denied = scopeError(ctx, p);
    if (denied) return { output: `read: ${denied}`, isError: true };
    const full = abs(ctx, p);
    if (!existsSync(full)) return { output: `read: file not found: ${p}`, isError: true };
    let text: string;
    try { text = readFileSync(full, "utf8"); } catch (e) { return { output: `read: ${(e as Error).message}`, isError: true }; }
    ctx.filesRead.add(rel(ctx, full));
    const lines = text.split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.max(1, Number(args.limit ?? READ_WINDOW));
    const end = Math.min(lines.length, offset - 1 + limit);
    const slice = lines.slice(offset - 1, end);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)} ${l}`).join("\n");
    const header = lines.length > slice.length ? `(${p}: ${lines.length} lines; showing ${offset}-${end})\n` : "";
    return { output: header + numbered, isError: false, meta: { lines: lines.length } };
  }
};

// --- write ----------------------------------------------------------------------------------

export const writeTool: Tool = {
  schema: {
    name: "write",
    description: "Create a new file or overwrite an existing one with the given content. Creates parent directories.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  },
  execute(args, ctx) {
    const p = String(args.path ?? "");
    const content = typeof args.content === "string" ? args.content : "";
    if (!p) return { output: "write: missing path", isError: true };
    const denied = scopeError(ctx, p);
    if (denied) return { output: `write: ${denied}`, isError: true };
    const full = abs(ctx, p);
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    } catch (e) { return { output: `write: ${(e as Error).message}`, isError: true }; }
    ctx.filesWritten.add(rel(ctx, full));
    ctx.filesRead.add(rel(ctx, full));
    return { output: `wrote ${p} (${content.split(/\r?\n/).length} lines)`, isError: false };
  }
};

// --- edit (search/replace + lenient apply) --------------------------------------------------

/** Normalize whitespace for a lenient (fuzzy) match: collapse runs of spaces/tabs, trim line ends. */
function normWs(s: string): string {
  return s.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trimEnd()).join("\n").trim();
}

export const editTool: Tool = {
  schema: {
    name: "edit",
    description: "Replace an exact snippet of an existing file with new text. Provide enough of the original ('search') to be unique. Whitespace is matched leniently. To create a new file use write.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string", description: "the exact original text to replace (include a few surrounding lines to be unique)" },
        replace: { type: "string", description: "the new text" }
      },
      required: ["path", "search", "replace"]
    }
  },
  execute(args, ctx) {
    const p = String(args.path ?? "");
    const search = typeof args.search === "string" ? args.search : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    if (!p || !search) return { output: "edit: need path and non-empty search", isError: true };
    const denied = scopeError(ctx, p);
    if (denied) return { output: `edit: ${denied}`, isError: true };
    const full = abs(ctx, p);
    if (!existsSync(full)) return { output: `edit: file not found: ${p} (use write to create a new file)`, isError: true };
    let text: string;
    try { text = readFileSync(full, "utf8"); } catch (e) { return { output: `edit: ${(e as Error).message}`, isError: true }; }

    // 1. Exact match.
    const exactIdx = indexAllExact(text, search);
    if (exactIdx.length === 1) return applyEdit(ctx, full, p, text, exactIdx[0], search.length, replace);
    if (exactIdx.length > 1) return { output: `edit: 'search' matched ${exactIdx.length} places exactly — add more surrounding context so it is unique.`, isError: true };

    // 2. Lenient (whitespace-normalized) match: find the line span whose normalized form equals the
    //    normalized search. This rescues a small model that got indentation/spacing slightly wrong.
    const lenient = findLenient(text, search);
    if (lenient && "ambiguous" in lenient) {
      return { output: `edit: 'search' leniently matched ${lenient.ambiguous} places — add more surrounding context so it is unique.`, isError: true };
    }
    if (lenient) return applyEdit(ctx, full, p, text, lenient.start, lenient.len, replace);

    // 3. No match — repair-ready error with the nearest lines.
    const near = nearestLines(text, search);
    return { output: `edit: 'search' not found in ${p}.${near ? ` Nearest existing lines:\n${near}` : ""}\nRe-read the file and copy the exact current text.`, isError: true };
  }
};

function indexAllExact(text: string, needle: string): number[] {
  const out: number[] = [];
  let i = text.indexOf(needle);
  while (i >= 0) { out.push(i); i = text.indexOf(needle, i + 1); }
  return out;
}

function findLenient(text: string, search: string): { start: number; len: number } | { ambiguous: number } | null {
  const normSearch = normWs(search);
  if (!normSearch) return null;
  const searchLineCount = search.split(/\r?\n/).length;
  // Map matched line spans back to EXACT char offsets in the ORIGINAL text. A prior version rejoined
  // lines with "\n" and indexOf'd that, which never matched a \r\n (Windows) file — so the lenient
  // rescue was dead on CRLF. lineStarts[k] = char offset where line k begins (terminators preserved).
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const matches: Array<{ start: number; len: number }> = [];
  for (let i = 0; i + searchLineCount <= lineStarts.length; i++) {
    const start = lineStarts[i];
    let end = i + searchLineCount < lineStarts.length ? lineStarts[i + searchLineCount] : text.length;
    // Trim the trailing terminator of the last window line so the replaced span is line CONTENT (the
    // following newline stays intact, matching the exact-match path) — handles both \n and \r\n.
    if (end > start && text.charCodeAt(end - 1) === 10) { end--; if (end > start && text.charCodeAt(end - 1) === 13) end--; }
    if (normWs(text.slice(start, end)) === normSearch) matches.push({ start, len: end - start });
  }
  // Mirror the exact-match path: a lenient search matching 2+ regions is ambiguous — never guess which.
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ambiguous: matches.length };
  return null;
}

function applyEdit(ctx: ToolContext, full: string, p: string, text: string, start: number, len: number, replace: string): ToolResult {
  const next = text.slice(0, start) + replace + text.slice(start + len);
  try { writeFileSync(full, next, "utf8"); } catch (e) { return { output: `edit: write failed: ${(e as Error).message}`, isError: true }; }
  ctx.filesWritten.add(rel(ctx, full));
  ctx.filesRead.add(rel(ctx, full));
  // Show the applied result (SWE-agent's editor-with-feedback lever): a small model that only sees
  // "edited" often rewrites the whole file to be sure the change landed. A line-numbered window of the
  // changed region is concrete proof, so it trusts the edit and moves on instead of re-writing.
  return { output: `edited ${p}\n${changedWindow(next, start, replace.length)}`, isError: false };
}

/** A line-numbered window around the just-edited region (± 3 lines) — the "here's what it looks like now". */
function changedWindow(text: string, start: number, replaceLen: number): string {
  const lines = text.split(/\r?\n/);
  const startLine = text.slice(0, start).split(/\r?\n/).length - 1;              // 0-based
  const endLine = text.slice(0, start + replaceLen).split(/\r?\n/).length - 1;
  const from = Math.max(0, startLine - 3);
  const to = Math.min(lines.length - 1, endLine + 3);
  const width = String(to + 1).length;
  const body = [];
  for (let i = from; i <= to; i++) body.push(`${String(i + 1).padStart(width)}  ${lines[i]}`);
  return `now reads:\n${body.join("\n")}`;
}

function nearestLines(text: string, search: string): string {
  const firstLine = (search.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  if (firstLine.length < 3) return "";
  const key = firstLine.slice(0, 40).toLowerCase();
  const hits = text.split(/\r?\n/).map((l, i) => ({ l, i })).filter(({ l }) => l.toLowerCase().includes(key.slice(0, 12))).slice(0, 3);
  return hits.map(({ l, i }) => `${i + 1}: ${l}`).join("\n");
}

// --- bash -----------------------------------------------------------------------------------

/**
 * Commands that, invoked bare, drop into an interactive REPL and read from a terminal forever.
 *
 * A model reaches for these more often than you would expect — `python` to "just check something",
 * `node` to poke at a value. With no terminal on the other end they block until the timeout, and on
 * this machine Python 3.14's REPL hangs even with stdin redirected from NUL. Measured live: three
 * bare `python` calls burned six minutes inside a single task and taught the model nothing.
 *
 * So refuse instantly with the fix. A one-line correction the model can act on beats a two-minute
 * silence every time. Only the BARE form is refused: `python -c "..."`, `python script.py`, and
 * anything piped or redirected are all real commands and run untouched.
 */
const INTERACTIVE_BARE = new Set([
  "python", "python3", "py", "node", "irb", "ghci", "julia", "scala", "R",
  "sqlite3", "mysql", "psql", "mongo", "redis-cli", "ftp", "telnet",
  "vi", "vim", "nano", "emacs", "less", "more", "top", "htop", "cat", "head", "sort",
]);

/** The guidance for a bare interactive command, or null when the command is fine to run. */
export function interactiveCommandRefusal(command: string): string | null {
  const trimmed = (command ?? "").trim();
  // Anything with a pipe, redirect, or chain has a real stdin/purpose — leave it alone.
  if (/[|<>&;]/.test(trimmed)) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) return null;
  const base = parts[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  if (!INTERACTIVE_BARE.has(base) && !INTERACTIVE_BARE.has(parts[0])) return null;
  const hint = base === "python" || base === "python3" || base === "py"
    ? 'run the code non-interactively instead, e.g. python -c "import mod; print(mod.f(1))" or python script.py'
    : base === "node"
      ? 'run the code non-interactively instead, e.g. node -e "console.log(require(\'./mod\').f(1))" or node script.js'
      : base === "cat" || base === "head" || base === "sort"
        ? "give it a file argument (it is waiting on standard input)"
        : "pass the command/query as an argument instead of opening the interactive session";
  return `blocked: \`${trimmed}\` opens an interactive session with no terminal attached, so it would hang until the timeout — ${hint}.`;
}

export const bashTool: Tool = {
  schema: {
    name: "bash",
    description: "Run a shell command in the project root and return its combined output (truncated if long). Use for building, running tests, and inspecting the project.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeout_seconds: { type: "integer", description: "optional, default 120" } },
      required: ["command"]
    }
  },
  execute(args, ctx): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command.trim()) return Promise.resolve({ output: "bash: empty command", isError: true });
    // Refuse a hang before paying for it, with the correction inline.
    const refusal = interactiveCommandRefusal(command);
    if (refusal) return Promise.resolve({ output: refusal, isError: true, meta: { interactive: true } });
    // A non-numeric timeout_seconds (the model can emit "5 minutes"; args aren't schema-coerced) would
    // make Number(...) NaN → setTimeout(NaN) ≈ 0ms → the command is killed instantly and falsely reported
    // as timed out. Fall back to the 120s default for anything that doesn't parse to a finite number.
    const rawTimeout = Number(args.timeout_seconds ?? 120);
    const timeoutMs = Math.max(1000, (Number.isFinite(rawTimeout) ? rawTimeout : 120) * 1000);
    return new Promise<ToolResult>((resolve) => {
      // Already-cancelled: don't even start.
      if (ctx.signal?.aborted) { resolve({ output: `$ ${command}\n[cancelled before start]`, isError: true, meta: { cancelled: true } }); return; }
      // detached on POSIX so we can signal the whole process GROUP; on Windows we taskkill the tree.
      // stdin is CLOSED, not an open pipe. A model reaches for an interactive tool more often than
      // you would think (`python` with no script, `node`, `cat`, a pager, `ssh`), and with an open
      // stdin every one of those blocks until the timeout expires — measured live: three bare
      // `python` REPLs burned six minutes of a single task. With stdin at EOF they exit at once,
      // and the model gets an immediate, honest result it can act on.
      const child = spawn(command, { cwd: ctx.cwd, shell: bashShellOption(), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "", killedBy: "timeout" | "cancelled" | null = null;
      const CAP = 12 * 1024 * 1024;
      // Live progress: coalesce output into at most 8 bounded chunks per call (flush at ≥1KB or 500ms)
      // so a chatty build log becomes a handful of progress events, never a firehose. The completion
      // output below stays authoritative — dropping every streamed chunk loses nothing.
      const MAX_STREAM_CHUNKS = 8, STREAM_FLUSH_CHARS = 1024, STREAM_FLUSH_MS = 500;
      let streamed = 0, pending = "";
      let streamTimer: NodeJS.Timeout | null = null;
      const flushStream = (): void => {
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
        if (pending && streamed < MAX_STREAM_CHUNKS) { streamed++; ctx.onOutput?.(pending.slice(0, 2048)); }
        pending = "";
      };
      const pushStream = (text: string): void => {
        if (!ctx.onOutput || streamed >= MAX_STREAM_CHUNKS || !text) return;
        pending += text;
        if (pending.length >= STREAM_FLUSH_CHARS) flushStream();
        else if (!streamTimer) streamTimer = setTimeout(flushStream, STREAM_FLUSH_MS);
      };
      // Decode via StringDecoder so a multibyte UTF-8 char split across two chunks isn't corrupted into
      // U+FFFD (a plain per-chunk d.toString("utf8") mangles boundary-straddling sequences).
      const decOut = new StringDecoder("utf8"), decErr = new StringDecoder("utf8");
      const onOut = (d: Buffer): void => { if (out.length < CAP) { const s = decOut.write(d); out += s; pushStream(s); } };
      const onErr = (d: Buffer): void => { if (err.length < CAP) { const s = decErr.write(d); err += s; pushStream(s); } };
      child.stdout?.on("data", onOut);
      child.stderr?.on("data", onErr);
      const timer = setTimeout(() => { killedBy = "timeout"; killTree(child); }, timeoutMs);
      const onAbort = (): void => { killedBy = "cancelled"; killTree(child); };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const done = (code: number | null, signalName: NodeJS.Signals | null): void => {
        clearTimeout(timer);
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; } // completion output is authoritative; no final flush
        ctx.signal?.removeEventListener("abort", onAbort);
        out += decOut.end(); err += decErr.end(); // flush any trailing partial multibyte sequence
        const combined = truncate([out, err].filter(Boolean).join("\n"));
        const status = killedBy === "timeout" ? `(timed out after ${timeoutMs / 1000}s — process tree killed)`
          : killedBy === "cancelled" ? "(cancelled — process tree killed)"
          : signalName ? `killed by ${signalName}` : `exit ${code ?? 1}`;
        // A shell failure that names something — a binary, a path — is worth one more sentence:
        // what DOES exist nearby. "command not found" is the largest single failure bucket in the
        // TB2 taxonomy, and on its own it tells the model nothing it can act on. See shellGuard.ts.
        const hint = killedBy === "timeout"
          ? interactiveStallHint(combined)
          : killedBy === null ? shellFailureHint(combined, ctx.cwd) : null;
        resolve({
          output: `$ ${command}\n${combined || "(no output)"}\n[${status}]${hint ? `\n${hint}` : ""}`,
          isError: killedBy !== null || (code ?? 1) !== 0 || !!signalName,
          meta: { exitCode: code, timedOut: killedBy === "timeout", cancelled: killedBy === "cancelled", signal: signalName, ...(hint ? { hint: true } : {}) },
        });
      };
      // "close" waits for every stdio pipe to drain, which is right for a normal finish: it
      // guarantees the full output. But once we have DELIBERATELY killed the tree it becomes a trap.
      // Under the POSIX shell, `bash -c "node -e ..."` runs the real work in a GRANDCHILD; killing
      // bash leaves that grandchild holding the stdout pipe open, so "close" does not fire until it
      // exits on its own — a cancel that should take milliseconds took the command's full 10s.
      // After a kill, the child we spawned is gone and its own exit is the honest signal to report.
      let settled = false;
      const settle = (code: number | null, signalName: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        done(code, signalName);
      };
      child.on("close", settle);
      child.on("exit", (code, signalName) => {
        if (killedBy === null) return;        // normal finish: let "close" deliver the complete output
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code, signalName);
      });
      child.on("error", (e) => { clearTimeout(timer); if (streamTimer) clearTimeout(streamTimer); ctx.signal?.removeEventListener("abort", onAbort); if (!settled) { settled = true; resolve({ output: `bash: ${e.message}`, isError: true }); } });
    });
  }
};

/** Kill a child and its whole descendant tree (a shell often spawns grandchildren — e.g. a test server). */
function killTree(child: import("node:child_process").ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } // negative pid = process group
    }
  } catch { /* already gone */ }
}

function truncate(s: string): string {
  if (s.length <= BASH_HEAD + BASH_TAIL + 100) return s;
  const hidden = s.length - BASH_HEAD - BASH_TAIL;
  return `${s.slice(0, BASH_HEAD)}\n... [${hidden} chars truncated] ...\n${s.slice(-BASH_TAIL)}`;
}

// --- ls / glob / grep -----------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", ".cheater", "dist", "build", "__pycache__", ".venv", "venv", ".next", "out", "coverage", "target", ".pytest_cache"]);

/** A grep that silently stops at its ceiling teaches the model the repo is smaller than it is. */
const GREP_MAX_HITS = 400;
const GLOB_MAX_HITS = 400;

/**
 * Translate a shell-style glob into an anchored RegExp over root-relative POSIX paths.
 * `**` crosses directory separators, `*` and `?` do not — the usual contract, so a model that has
 * seen any other tool gets what it expects.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` must also match zero directories, so `**/*.ts` finds a root-level file.
        if (pattern[i + 2] === "/") { source += "(?:.*/)?"; i += 2; continue; }
        source += ".*"; i += 1; continue;
      }
      source += "[^/]*";
      continue;
    }
    if (ch === "?") { source += "[^/]"; continue; }
    source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, CASE_INSENSITIVE_PATHS ? "i" : "");
}

/**
 * Does a file match the pattern? A pattern containing `/` is judged against the whole root-relative
 * path; a bare one (`*.ts`) is judged against the basename at any depth. Forcing a globstar prefix
 * for the common case would just be a trap for a weak model.
 */
function globMatches(re: RegExp, hasSlash: boolean, relativePath: string, name: string): boolean {
  return re.test(hasSlash ? relativePath : name);
}

export const lsTool: Tool = {
  schema: {
    name: "ls",
    description: "List files and directories under a path (project-relative). Recursive up to a bounded depth.",
    parameters: { type: "object", properties: { path: { type: "string", description: "default '.'" } }, required: [] }
  },
  execute(args, ctx) {
    const p = String(args.path ?? ".");
    const root = abs(ctx, p);
    if (!existsSync(root)) return { output: `ls: not found: ${p}`, isError: true };
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || out.length > 400) return;
      let entries: import("node:fs").Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        out.push(rel(ctx, full) + (e.isDirectory() ? "/" : ""));
        if (e.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(root, 0);
    return { output: out.join("\n") || "(empty)", isError: false };
  }
};

export const grepTool: Tool = {
  schema: {
    name: "grep",
    description: "Search file contents for a regular expression across the project. Returns matching path:line: text.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string", description: "optional subdir" }, glob: { type: "string", description: "optional filename filter e.g. *.py" } },
      required: ["pattern"]
    }
  },
  execute(args, ctx) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return { output: "grep: missing pattern", isError: true };
    let re: RegExp;
    try { re = new RegExp(pattern); } catch (e) { return { output: `grep: bad pattern: ${(e as Error).message}`, isError: true }; }
    const globPattern = args.glob ? String(args.glob) : "";
    const globRe = globPattern ? globToRegExp(globPattern) : null;
    const globHasSlash = globPattern.includes("/");
    const root = abs(ctx, String(args.path ?? "."));
    const hits: string[] = [];
    let truncated = false;
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || truncated) return;
      let entries: import("node:fs").Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (truncated) return;
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (globRe && !globMatches(globRe, globHasSlash, rel(ctx, full), e.name)) continue;
        try {
          if (statSync(full).size > 1024 * 1024) continue;
          const content = readFileSync(full, "utf8");
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (hits.length >= GREP_MAX_HITS) { truncated = true; return; }
            if (re.test(lines[i])) hits.push(`${rel(ctx, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        } catch { /* binary/unreadable */ }
      }
    };
    walk(root, 0);
    if (!hits.length) return { output: `(no matches for /${pattern}/)`, isError: false, meta: { count: 0, truncated: false } };
    // Say so explicitly: a model that assumes it saw every match will "fix" one call site of three.
    const notice = truncated ? `\n(truncated at ${GREP_MAX_HITS} matches - narrow the pattern or pass path/glob to see the rest)` : "";
    return { output: hits.join("\n") + notice, isError: false, meta: { count: hits.length, truncated } };
  }
};

export const globTool: Tool = {
  schema: {
    name: "glob",
    description: "Find files by name pattern, e.g. '**/*.test.ts' or 'Dockerfile'. Returns project-relative paths. Use this to locate files; use grep to search their contents.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob pattern; ** crosses directories, * and ? do not" },
        path: { type: "string", description: "optional subdir to search under (default '.')" }
      },
      required: ["pattern"]
    }
  },
  execute(args, ctx) {
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return { output: "glob: missing pattern", isError: true };
    const start = String(args.path ?? ".");
    const denied = scopeError(ctx, start);
    if (denied) return { output: `glob: ${denied}`, isError: true };
    const root = abs(ctx, start);
    if (!existsSync(root)) return { output: `glob: not found: ${start}`, isError: true };
    let re: RegExp;
    try { re = globToRegExp(pattern); } catch (e) { return { output: `glob: bad pattern: ${(e as Error).message}`, isError: true }; }
    const hasSlash = pattern.includes("/");
    const matches: string[] = [];
    let truncated = false;
    const walk = (dir: string, depth: number): void => {
      if (depth > 12 || truncated) return;
      let entries: import("node:fs").Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (truncated) return;
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (matches.length >= GLOB_MAX_HITS) { truncated = true; return; }
        if (globMatches(re, hasSlash, rel(ctx, full), e.name)) matches.push(rel(ctx, full));
      }
    };
    walk(root, 0);
    if (!matches.length) return { output: `(no files match ${pattern})`, isError: false, meta: { count: 0, truncated: false } };
    const notice = truncated ? `\n(truncated at ${GLOB_MAX_HITS} files - narrow the pattern or pass path to see the rest)` : "";
    return { output: matches.join("\n") + notice, isError: false, meta: { count: matches.length, truncated } };
  }
};

// --- finish ---------------------------------------------------------------------------------

export const finishTool: Tool = {
  schema: {
    name: "finish",
    description: "Call this ONLY when the task is fully done and you have verified it (e.g. tests pass). Provide a one-line summary of what you did.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }
  },
  execute(args) {
    return { output: "finish acknowledged", isError: false, meta: { finish: true, summary: String(args.summary ?? "") } };
  }
};

export const taskTool: Tool = {
  schema: {
    name: "task",
    description: "Delegate a bounded coding subtask to a named Kitten agent and wait for its durable report. Use explore/review/verify for read-only work; use general only when edits are explicitly required.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "agent profile: explore, review, verify, or general" },
        prompt: { type: "string", description: "self-contained objective and acceptance criteria; do not assume the child sees this conversation" },
        model: { type: "string", description: "optional model override" }
      },
      required: ["agent", "prompt"]
    }
  },
  async execute(args, ctx) {
    if (!ctx.spawnTask) return { output: "task: delegation is unavailable in this agent profile", isError: true };
    const agent = String(args.agent ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    if (!agent || !prompt) return { output: "task: agent and prompt are required", isError: true };
    try {
      const result = await ctx.spawnTask({ agent, prompt: prompt.slice(0, 4000), model: typeof args.model === "string" ? args.model : undefined });
      return { output: `child ${result.conversationId} (${result.status}): ${result.summary}`.slice(0, 2000), isError: result.status === "failed" || result.status === "cancelled", meta: result };
    } catch (error) {
      return { output: `task failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), isError: true };
    }
  }
};

export const CORE_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, lsTool, globTool, grepTool, taskTool, finishTool];

export function toolByName(name: string): Tool | undefined {
  return CORE_TOOLS.find((t) => t.schema.name === name);
}
