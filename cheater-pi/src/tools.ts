import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { formatBugMemoryHits, searchBugMemories } from "./bug-memory.js";
import { focusTestCommand, detectProjectCommands } from "./reliability/projectCommands.js";

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
    promptGuidelines: [
      "Use cheater_bug_memory_search when a failure has a distinctive error, API behavior, parser issue, framework symptom, or test signal.",
      "Treat returned memories as analogies, not facts about the current repo. Verify against local code before editing.",
      "Prefer the top 1-3 memories and ignore weak or mismatched ones."
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

export function registerCheaterTools(pi: ExtensionAPI): void {
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

  pi.registerTool({
    name: "cheater_focus_test",
    label: "Cheater Focus Test",
    description: "Suggest a focused test command for the current repo.",
    promptSnippet: "cheater_focus_test - suggest a narrow test command before broad verification.",
    parameters: Type.Object({
      hint: Type.Optional(Type.String({ description: "Optional file, framework, or failing command hint" }))
    }),
    async execute(_toolCallId: string, params: { hint?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const cmds = detectProjectCommands(cwd);
      const command = focusTestCommand(cwd, params.hint);
      const lines = [
        command,
        `packageManager: ${cmds.packageManager}`,
        `framework: ${cmds.framework ?? "(auto-detected)"}`,
        cmds.evidence.slice(0, 4).join("; ")
      ];
      return textResult(lines.join("\n"), { command, packageManager: cmds.packageManager, framework: cmds.framework, evidence: cmds.evidence });
    }
  });

  pi.registerTool({
    name: "cheater_diff_safety_check",
    label: "Cheater Diff Safety",
    description: "Check a changed-file list for risky Cheater diff categories.",
    promptSnippet: "cheater_diff_safety_check - flag tests, dependencies, lockfiles, and large diffs.",
    parameters: Type.Object({
      files: Type.Array(Type.String(), { description: "Changed file paths to inspect" })
    }),
    async execute(_toolCallId: string, params: { files: string[] }) {
      const files = params.files ?? [];
      const risky = files.filter((file) =>
        /(^|[\\/])(test|tests|__tests__)[\\/]/i.test(file) ||
        /(^|[\\/])package-lock\.json$|(^|[\\/])pnpm-lock\.yaml$|(^|[\\/])yarn\.lock$|(^|[\\/])requirements\.txt$|(^|[\\/])pyproject\.toml$/i.test(file)
      );
      const tooMany = files.length > 12;
      const verdict = risky.length || tooMany ? "review carefully before applying" : "focused diff shape";
      return textResult(
        [`verdict: ${verdict}`, `files: ${files.length}`, risky.length ? `risk files: ${risky.join(", ")}` : "risk files: none"].join("\n"),
        { risky, tooMany }
      );
    }
  });

  pi.registerTool(createCheaterLineEditTool());

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

  pi.registerTool(createCheaterBugMemorySearchTool());
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
