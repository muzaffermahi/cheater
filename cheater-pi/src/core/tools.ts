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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { ToolSchema } from "./llm.js";

export interface ToolContext {
  cwd: string;
  /** Files the agent has read this run — read-before-write evidence. */
  filesRead: Set<string>;
  /** Files the agent has written this run. */
  filesWritten: Set<string>;
  /** Abort signal for the run — a cancellable tool (bash) kills its process tree when this fires. */
  signal?: AbortSignal;
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

function findLenient(text: string, search: string): { start: number; len: number } | null {
  const normSearch = normWs(search);
  if (!normSearch) return null;
  const searchLineCount = search.split(/\r?\n/).length;
  const lines = text.split(/\r?\n/);
  // Precompute cumulative char offsets per line (accounting for the \n we split on — assume \n; if
  // the file has \r\n this is approximate but applyEdit re-reads via indexOf so we snap to exact).
  let matchWindow: string | null = null;
  for (let i = 0; i + searchLineCount <= lines.length; i++) {
    const window = lines.slice(i, i + searchLineCount).join("\n");
    if (normWs(window) === normSearch) { matchWindow = window; break; }
  }
  if (matchWindow === null) return null;
  const start = text.indexOf(matchWindow);
  if (start < 0) return null;
  return { start, len: matchWindow.length };
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
    // A non-numeric timeout_seconds (the model can emit "5 minutes"; args aren't schema-coerced) would
    // make Number(...) NaN → setTimeout(NaN) ≈ 0ms → the command is killed instantly and falsely reported
    // as timed out. Fall back to the 120s default for anything that doesn't parse to a finite number.
    const rawTimeout = Number(args.timeout_seconds ?? 120);
    const timeoutMs = Math.max(1000, (Number.isFinite(rawTimeout) ? rawTimeout : 120) * 1000);
    return new Promise<ToolResult>((resolve) => {
      // Already-cancelled: don't even start.
      if (ctx.signal?.aborted) { resolve({ output: `$ ${command}\n[cancelled before start]`, isError: true, meta: { cancelled: true } }); return; }
      // detached on POSIX so we can signal the whole process GROUP; on Windows we taskkill the tree.
      const child = spawn(command, { cwd: ctx.cwd, shell: true, windowsHide: true, detached: process.platform !== "win32" });
      let out = "", err = "", killedBy: "timeout" | "cancelled" | null = null;
      const CAP = 12 * 1024 * 1024;
      // Decode via StringDecoder so a multibyte UTF-8 char split across two chunks isn't corrupted into
      // U+FFFD (a plain per-chunk d.toString("utf8") mangles boundary-straddling sequences).
      const decOut = new StringDecoder("utf8"), decErr = new StringDecoder("utf8");
      const onOut = (d: Buffer): void => { if (out.length < CAP) out += decOut.write(d); };
      const onErr = (d: Buffer): void => { if (err.length < CAP) err += decErr.write(d); };
      child.stdout?.on("data", onOut);
      child.stderr?.on("data", onErr);
      const timer = setTimeout(() => { killedBy = "timeout"; killTree(child); }, timeoutMs);
      const onAbort = (): void => { killedBy = "cancelled"; killTree(child); };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const done = (code: number | null, signalName: NodeJS.Signals | null): void => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        out += decOut.end(); err += decErr.end(); // flush any trailing partial multibyte sequence
        const combined = truncate([out, err].filter(Boolean).join("\n"));
        const status = killedBy === "timeout" ? `(timed out after ${timeoutMs / 1000}s — process tree killed)`
          : killedBy === "cancelled" ? "(cancelled — process tree killed)"
          : signalName ? `killed by ${signalName}` : `exit ${code ?? 1}`;
        resolve({
          output: `$ ${command}\n${combined || "(no output)"}\n[${status}]`,
          isError: killedBy !== null || (code ?? 1) !== 0 || !!signalName,
          meta: { exitCode: code, timedOut: killedBy === "timeout", cancelled: killedBy === "cancelled", signal: signalName },
        });
      };
      child.on("close", done);
      child.on("error", (e) => { clearTimeout(timer); ctx.signal?.removeEventListener("abort", onAbort); resolve({ output: `bash: ${e.message}`, isError: true }); });
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
    const globRe = args.glob ? new RegExp("^" + String(args.glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
    const root = abs(ctx, String(args.path ?? "."));
    const hits: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || hits.length > 100) return;
      let entries: import("node:fs").Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (globRe && !globRe.test(e.name)) continue;
        try {
          if (statSync(full).size > 1024 * 1024) continue;
          const content = readFileSync(full, "utf8");
          content.split(/\r?\n/).forEach((line, i) => {
            if (hits.length <= 100 && re.test(line)) hits.push(`${rel(ctx, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        } catch { /* binary/unreadable */ }
      }
    };
    walk(root, 0);
    return { output: hits.length ? hits.join("\n") : `(no matches for /${pattern}/)`, isError: false, meta: { count: hits.length } };
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

export const CORE_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, lsTool, grepTool, finishTool];

export function toolByName(name: string): Tool | undefined {
  return CORE_TOOLS.find((t) => t.schema.name === name);
}
