import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { formatBugMemoryHits, searchBugMemories } from "./bug-memory.js";
import type { CheaterConfig } from "./types.js";

type ExtensionAPI = any;
type ExtensionContext = any;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details
  };
}

function safeRepoPath(cwd: string, rawPath: string): string {
  const root = resolve(cwd);
  const target = resolve(root, isAbsolute(rawPath) ? relative(root, rawPath) : rawPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes repo: ${rawPath}`);
  }
  if (/(^|[\\/])(\.git|node_modules|dist|build|coverage)([\\/]|$)/i.test(rel)) {
    throw new Error(`refusing to edit generated or forbidden path: ${rawPath}`);
  }
  return target;
}

function compactGitStatus(cwd: string): string {
  try {
    const gitDir = resolve(cwd, ".git");
    if (!existsSync(gitDir)) return "not a git repository";
    return "git repository detected; use Pi's bash tool for detailed status";
  } catch {
    return "git status unavailable";
  }
}

function listTopLevel(cwd: string): string[] {
  try {
    return readdirSync(cwd)
      .filter((name) => ![".git", "node_modules", ".venv", "__pycache__"].includes(name))
      .slice(0, 40);
  } catch {
    return [];
  }
}

function memoryFile(cwd: string): string {
  const dir = resolve(cwd, ".cheater", "memory");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "notes.jsonl");
}

export function createCheaterLineEditTool() {
  return {
    name: "cheater_line_edit",
    label: "Cheater Line Edit",
    description: "Apply a surgical line-range edit to an existing file. Prefer this over rewriting a whole file.",
    promptSnippet: "cheater_line_edit - replace a small 1-based line range in an existing file after reading that region.",
    promptGuidelines: [
      "Read the exact region first, then edit only the lines that need to change.",
      "Do not use this to rewrite an entire file; split large refactors into small verified edits.",
      "Use expectedText when possible so stale line numbers fail instead of corrupting the file."
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative path to an existing file" }),
      startLine: Type.Number({ description: "1-based first line to replace", minimum: 1 }),
      endLine: Type.Number({ description: "1-based last line to replace, inclusive", minimum: 1 }),
      replacement: Type.String({ description: "Replacement text for the selected line range" }),
      expectedText: Type.Optional(Type.String({ description: "Optional text expected inside the selected range" }))
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; startLine: number; endLine: number; replacement: string; expectedText?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      const startLine = Math.trunc(params.startLine);
      const endLine = Math.trunc(params.endLine);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
        return textResult("line edit refused: invalid line range", { ok: false });
      }
      if (endLine - startLine + 1 > 80) {
        return textResult("line edit refused: range is too large; narrow the edit to 80 lines or fewer", { ok: false });
      }
      let target: string;
      try {
        target = safeRepoPath(ctx.cwd, params.path);
      } catch (err) {
        return textResult(`line edit refused: ${(err as Error).message}`, { ok: false });
      }
      if (!existsSync(target)) return textResult(`line edit refused: file not found: ${params.path}`, { ok: false });
      const original = readFileSync(target, "utf8");
      const newline = original.includes("\r\n") ? "\r\n" : "\n";
      const hadFinalNewline = /\r?\n$/.test(original);
      const lines = original.replace(/\r?\n$/, "").split(/\r?\n/);
      if (startLine > lines.length || endLine > lines.length) {
        return textResult(`line edit refused: range ${startLine}-${endLine} exceeds file length ${lines.length}`, { ok: false });
      }
      const before = lines.slice(startLine - 1, endLine).join(newline);
      // Whitespace-tolerant staleness check (Cline-style): a small model reproduces the
      // expected text with drifted indentation/trailing spaces; that must not fail the
      // guard. Collapsed-whitespace containment still catches genuinely stale ranges.
      const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
      if (params.expectedText && !before.includes(params.expectedText) && !normalize(before).includes(normalize(params.expectedText))) {
        return textResult("line edit refused: expectedText was not found in the selected range", {
          ok: false,
          selected: before.slice(0, 500)
        });
      }
      const replacementLines = params.replacement.replace(/\r?\n$/, "").split(/\r?\n/);
      const nextLines = [
        ...lines.slice(0, startLine - 1),
        ...replacementLines,
        ...lines.slice(endLine)
      ];
      const next = nextLines.join(newline) + (hadFinalNewline ? newline : "");
      writeFileSync(target, next, "utf8");
      return textResult(
        [
          `line edit applied: ${params.path}:${startLine}-${endLine}`,
          `replaced ${endLine - startLine + 1} line(s) with ${replacementLines.length} line(s)`,
          `before: ${before.split(/\r?\n/).slice(0, 3).join(" ").slice(0, 240)}`,
          `after: ${params.replacement.split(/\r?\n/).slice(0, 3).join(" ").slice(0, 240)}`
        ].join("\n"),
        {
          ok: true,
          path: params.path,
          startLine,
          endLine,
          replacementLineCount: replacementLines.length
        }
      );
    }
  };
}

export function createCheaterBugMemorySearchTool() {
  return {
    name: "cheater_bug_memory_search",
    label: "Cheater Bug Memory Search",
    description: "Search the compacted solved-bug memory corpus for highly relevant analogies without loading the full corpus into RAM.",
    promptSnippet: "cheater_bug_memory_search - find compacted solved-bug analogies relevant to the current failure.",
    // Aligned with the authoritative BUG_MEMORY system section (prompts.ts): the harness
    // auto-attaches evidence to failures, so this is a rare last resort - NOT "use it whenever a
    // failure looks distinctive" (that contradiction made a weak model over-search).
    promptGuidelines: [
      "The harness auto-attaches solved-bug evidence to failures, so you rarely need this.",
      "Only call it when stuck on a specific error AND the failure carried no evidence; never pre-emptively.",
      "Treat any memory as an analogy to verify against local code, not a fact about this repo."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Bug description, error text, failing test, or likely API/function names" }),
      topK: Type.Optional(Type.Number({ description: "Number of memories to return, 1-10", minimum: 1, maximum: 10 })),
      memoryPath: Type.Optional(Type.String({ description: "Optional compacted JSONL path; defaults to CHEATER_BUG_MEMORY_PATH or data/cards/compacted.jsonl" })),
      rebuild: Type.Optional(Type.Boolean({ description: "Rebuild the on-disk index before searching" }))
    }),
    async execute(_toolCallId: string, params: { query: string; topK?: number; memoryPath?: string; rebuild?: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const result = await searchBugMemories({
        cwd: ctx.cwd,
        query: params.query,
        topK: params.topK,
        memoryPath: params.memoryPath,
        rebuild: params.rebuild
      });
      return textResult(formatBugMemoryHits(result), {
        query: result.query,
        memoryPath: result.memoryPath,
        indexDir: result.indexDir,
        built: result.built,
        docCount: result.docCount,
        hits: result.hits
      });
    }
  };
}

/**
 * Literal find-and-replace across a file WITHOUT reading or rewriting the whole thing. This is the
 * cheap-token fix for the reported pattern where the model re-generates a 600-1000 line file just to
 * change a few repeated tokens (e.g. a bad `\u{...}` escape in many places): it sends ~50 tokens
 * (find + replace) instead of regenerating ~10k. Also sidesteps the exact-oldText edit failures that
 * wedged the session.
 */
export function createCheaterReplaceTool() {
  return {
    name: "cheater_replace",
    label: "Cheater Replace",
    description: "Literal find-and-replace across an existing file without reading or rewriting it. Use this to fix a repeated token (e.g. a bad escape) instead of regenerating a large file.",
    promptSnippet: "cheater_replace - literal find/replace across a file; far cheaper than rewriting a big file to fix repeated tokens.",
    promptGuidelines: [
      "Prefer this over rewriting a whole file when the same literal must change in one or more places.",
      "find is a LITERAL string (whitespace- and case-sensitive), NOT a regex. Replaces every occurrence unless first:true.",
      "If it reports 0 occurrences, re-check the exact text with grep before trying again."
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative path to an existing file" }),
      find: Type.String({ description: "Literal text to find (not a regex)" }),
      replace: Type.String({ description: "Replacement text" }),
      first: Type.Optional(Type.Boolean({ description: "Replace only the first occurrence (default: replace all)" }))
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; find: string; replace: string; first?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      if (!params.find) return textResult("replace refused: empty find string", { ok: false });
      if (params.find.length > 2000 || (params.replace?.length ?? 0) > 8000) {
        return textResult("replace refused: find/replace too large; use cheater_line_edit for big blocks", { ok: false });
      }
      let target: string;
      try {
        target = safeRepoPath(ctx.cwd, params.path);
      } catch (err) {
        return textResult(`replace refused: ${(err as Error).message}`, { ok: false });
      }
      if (!existsSync(target)) return textResult(`replace refused: file not found: ${params.path}`, { ok: false });
      const original = readFileSync(target, "utf8");
      const occurrences = original.split(params.find).length - 1;
      if (occurrences === 0) {
        return textResult(`replace: 0 occurrences of that exact literal in ${params.path} (find is whitespace/case-sensitive). Re-check with grep.`, { ok: false, replacements: 0 });
      }
      if (occurrences > 1000) {
        return textResult(`replace refused: ${occurrences} occurrences exceeds the 1000 cap; narrow the find string`, { ok: false });
      }
      const next = params.first ? original.replace(params.find, params.replace ?? "") : original.split(params.find).join(params.replace ?? "");
      if (next === original) return textResult(`replace: no change (replacement identical) in ${params.path}`, { ok: false, replacements: 0 });
      writeFileSync(target, next, "utf8");
      const count = params.first ? 1 : occurrences;
      return textResult(`replaced ${count} occurrence(s) in ${params.path}`, { ok: true, path: params.path, replacements: count });
    }
  };
}

export function registerCheaterTools(pi: ExtensionAPI, config: CheaterConfig = {}): void {
  pi.registerTool({
    name: "cheater_project_brief",
    label: "Cheater Project Brief",
    description: "Return a compact Cheater project brief without duplicating Pi file tools.",
    promptSnippet: "cheater_project_brief - compact project status and top-level shape.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const entries = listTopLevel(ctx.cwd);
      return textResult(
        [
          `cwd: ${ctx.cwd}`,
          `model: ${ctx.model?.provider ?? "default"}/${ctx.model?.id ?? "default"}`,
          `status: ${compactGitStatus(ctx.cwd)}`,
          `top-level: ${entries.join(", ") || "(empty or unreadable)"}`
        ].join("\n"),
        { cwd: ctx.cwd, entries }
      );
    }
  });

  // cheater_focus_test and cheater_diff_safety_check were removed: neither appeared in any
  // tool mask (the harness provides both deterministically - project commands ride the env
  // block and the diff guard grades every commitlet), so they were pure dead surface that
  // would only ever appear to a model if masking failed - exactly when extra tool choices
  // hurt most.
  pi.registerTool(createCheaterLineEditTool());
  pi.registerTool(createCheaterReplaceTool());

  pi.registerTool({
    name: "cheater_memory_search",
    label: "Cheater Memory Search",
    description: "Search simple Cheater project notes stored under .cheater/memory.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" })
    }),
    async execute(_toolCallId: string, params: { query: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const file = memoryFile(ctx.cwd);
      if (!existsSync(file)) return textResult("No Cheater memories saved yet.");
      const q = params.query.toLowerCase();
      const hits = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { text: string; createdAt: string })
        .filter((entry) => entry.text.toLowerCase().includes(q))
        .slice(0, 10);
      return textResult(hits.map((hit) => `${hit.createdAt}: ${hit.text}`).join("\n") || "No matching memories.", { hits });
    }
  });

  // Bug-memory search is registered ONLY when the (default-off) feature is explicitly enabled. When
  // off it does not exist at all, so a masking slip can never expose it and the model sees nothing
  // about a bug-memory tool. Re-enable with bugMemoryEnabled:true to A/B test it later.
  if (config.bugMemoryEnabled === true) pi.registerTool(createCheaterBugMemorySearchTool());
  // cheater_skill_search was removed: it ignored its own query param and just dumped the
  // static skill list, which Pi already surfaces natively via --skill progressive disclosure.
}

export function saveMemory(cwd: string, text: string): string {
  const file = memoryFile(cwd);
  const entry = JSON.stringify({ createdAt: new Date().toISOString(), text });
  writeFileSync(file, `${entry}\n`, { flag: "a", encoding: "utf8" });
  statSync(file);
  return file;
}
