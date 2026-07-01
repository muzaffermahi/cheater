"""Cheater compound tools (a SWE-agent / Cline style ACI).

These tools wrap multiple low-level operations into single high-level calls
that reduce the number of fragile multi-step tool invocations a 9B model
has to make.

Tools:
  repo_map_build       -- build / refresh the repo map
  repo_map_search      -- search the repo map for files / symbols
  inspect_symbol       -- definition + callers + likely tests
  run_focused_tests    -- run a focused test set; return a compressed summary
  read_context_pack    -- return a compact context pack for the current task
  localize_bug         -- run the localizer and return JSON

All tools honor the standard Tool/ToolContext contract from cheater.tools.
Their output is short, structured, and includes deterministic "next
suggested actions" so the model can keep moving.
"""
from __future__ import annotations

import json
import shlex
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from cheater.tools import Tool, ToolContext, ToolResult


# ---------- helpers ----------

def _truncate(text: str, n: int) -> str:
    if not text or len(text) <= n:
        return text or ""
    return text[: max(0, n - 30)] + "\n... [truncated]"


def _next_actions(lines: list[str]) -> str:
    if not lines:
        return ""
    return "NEXT SUGGESTED ACTIONS:\n" + "\n".join(f"  - {l}" for l in lines)


# ---------- repo_map_build ----------

class RepoMapBuildTool(Tool):
    name = "repo_map_build"
    category = "read"
    description = (
        "Build (or rebuild) the repo map for the current repo. Returns the "
        "number of files indexed and a path to the saved JSON/Markdown."
    )
    args_schema = {
        "out_dir": {"type": "string", "required": False,
                    "description": "Directory to write repo_map.json and repo_map.md (default: <repo>/.cheater)"},
    }
    requires_repo = True
    modifies_filesystem = True
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        out_dir = args.get("out_dir") or ".cheater"
        try:
            out = (ctx.repo_root / out_dir).resolve()
        except (OSError, ValueError) as e:
            return ToolResult(False, f"repo_map_build: {e}", error=str(e),
                              action=self.name, args=args)
        from cheater.repo_map import build_repo_map, save_repo_map
        m = build_repo_map(ctx.repo_root)
        try:
            paths = save_repo_map(m, out)
        except OSError as e:
            return ToolResult(False, f"repo_map_build: write failed: {e}",
                              error=str(e), action=self.name, args=args)
        summary = (
            f"repo_map_build: indexed {len(m.files)} file(s) "
            f"({len(m.all_test_files())} test, {len(m.all_source_files())} source) "
            f"-> {paths['json']}"
        )
        return ToolResult(
            success=True,
            summary=summary,
            output=json.dumps({
                "files": len(m.files),
                "tests": len(m.all_test_files()),
                "sources": len(m.all_source_files()),
                "warnings": m.warnings,
                "paths": paths,
            }, indent=2),
            action=self.name, args=args,
            files_read=[str(p.relative_to(ctx.repo_root.resolve())) for p in (Path(paths['json']),)],
            elapsed=time.time() - start,
        )


# ---------- repo_map_search ----------

class RepoMapSearchTool(Tool):
    name = "repo_map_search"
    category = "read"
    description = (
        "Search the repo map for files and symbols matching a query. Returns "
        "a compact excerpt: top files with imports/classes/functions, top "
        "matching symbols. Use this instead of grep when you need "
        "structure, not raw text."
    )
    args_schema = {
        "query": {"type": "string", "required": True, "description": "Search query"},
        "top_k": {"type": "integer", "required": False, "description": "Max files to return (default 8)"},
        "traceback": {"type": "string", "required": False,
                      "description": "Optional failure text to boost relevant files"},
    }
    requires_repo = True
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        q = (args.get("query") or "").strip()
        if not q:
            return ToolResult(False, "repo_map_search: no query",
                              error="missing query", action=self.name, args=args)
        top_k = int(args.get("top_k", 8))
        tb = args.get("traceback") or ""
        from cheater.repo_map import build_repo_map, select_relevant_map
        m = build_repo_map(ctx.repo_root)
        excerpt = select_relevant_map(m, query=q, traceback=tb, top_k=top_k)
        next_actions = [
            "Use inspect_symbol to see the definition + callers of a top hit.",
            "Use localize_bug if you also have a traceback.",
            "Use read_file on a top hit before editing.",
        ]
        body = excerpt + "\n\n" + _next_actions(next_actions)
        return ToolResult(
            success=True,
            summary=f"repo_map_search: {len(m.files)} file(s) indexed; top {top_k} for '{q[:40]}'",
            output=_truncate(body, 4000),
            action=self.name, args=args,
            elapsed=time.time() - start,
        )


# ---------- inspect_symbol ----------

class InspectSymbolTool(Tool):
    name = "inspect_symbol"
    category = "read"
    description = (
        "Inspect a symbol (class / function / method) or a file path. Returns "
        "the definition snippet, a small list of likely callers (grep), and "
        "likely related tests."
    )
    args_schema = {
        "symbol": {"type": "string", "required": False, "description": "Symbol name to look up (e.g. 'AgentLoop.run')"},
        "path": {"type": "string", "required": False, "description": "Optional file path to look inside"},
    }
    requires_repo = True
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        symbol = (args.get("symbol") or "").strip()
        path = (args.get("path") or "").strip()
        if not symbol and not path:
            return ToolResult(False, "inspect_symbol: need symbol or path",
                              error="missing both", action=self.name, args=args)
        out: list[str] = []
        from cheater.repo_map import build_repo_map
        m = build_repo_map(ctx.repo_root)
        # Resolve target file
        target_path = path
        if not target_path and symbol:
            sym_lower = symbol.split(".")[0].lower()
            for rf in m.files:
                if any(sym_lower == s.lower() for s in rf.symbol_names()):
                    target_path = rf.path
                    break
        # Definition snippet
        if target_path:
            try:
                p = (ctx.repo_root / target_path).resolve()
                p.relative_to(ctx.repo_root.resolve())
            except (OSError, ValueError):
                p = None
            if p and p.is_file():
                try:
                    text = p.read_text(encoding="utf-8", errors="ignore")
                except OSError as e:
                    out.append(f"(read error: {e})")
                    text = ""
                snippet = self._definition_snippet(text, symbol, path)
                out.append(f"### `{target_path}`")
                out.append("```")
                out.append(_truncate(snippet, 1800))
                out.append("```")
                # Callers (grep)
                if symbol:
                    out.append("### callers (grep)")
                    callers = self._grep(ctx.repo_root, symbol)
                    if callers:
                        out.extend(callers[:15])
                    else:
                        out.append("  (no callers found)")
                # Related tests
                rel_tests = m.test_to_source.get(target_path, [])
                if rel_tests:
                    out.append("### related tests")
                    for t in rel_tests:
                        out.append(f"  - `{t}`")
                else:
                    # Look in the other direction
                    for tf, sources in m.test_to_source.items():
                        if target_path in sources:
                            out.append("### related tests")
                            out.append(f"  - `{tf}`")
                            break
            else:
                out.append(f"(file not found: {target_path})")
        elif symbol:
            out.append(f"(symbol '{symbol}' not found in repo map)")
        next_actions = [
            "Use read_file to see more context.",
            "Use run_focused_tests to verify behavior.",
            "Use localize_bug to confirm this is the right file.",
        ]
        body = "\n".join(out) + "\n\n" + _next_actions(next_actions)
        return ToolResult(
            success=True,
            summary=f"inspect_symbol: {symbol or target_path}",
            output=_truncate(body, 4000),
            action=self.name, args=args,
            files_read=[target_path] if target_path else [],
            elapsed=time.time() - start,
        )

    @staticmethod
    def _definition_snippet(text: str, symbol: str, path: str) -> str:
        if not text:
            return "(empty file)"
        lines = text.splitlines()
        target = symbol.split(".")[-1] if symbol else Path(path or "").stem
        # Find first def/class line for the target
        for i, line in enumerate(lines):
            stripped = line.lstrip()
            if (stripped.startswith("def ") or stripped.startswith("class ")
                or stripped.startswith("async def ")) and target in line:
                start = max(0, i - 2)
                # Find the end (next blank then def/class, or +20 lines)
                end = min(len(lines), i + 25)
                return "\n".join(lines[start:end])
        # Fallback: first 20 lines
        return "\n".join(lines[:20])

    @staticmethod
    def _grep(repo_root: Path, needle: str) -> list[str]:
        from cheater.explorer import DEFAULT_IGNORED_DIRS, TEXT_EXTENSIONS
        if not needle:
            return []
        out: list[str] = []
        # Limit scan to first ~200 text files for speed.
        count = 0
        for p in repo_root.rglob("*"):
            if count > 200:
                break
            if not p.is_file():
                continue
            rel = str(p.relative_to(repo_root)).replace("\\", "/")
            if any(part in DEFAULT_IGNORED_DIRS for part in rel.split("/")):
                continue
            if p.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            count += 1
            for i, line in enumerate(text.splitlines(), start=1):
                if needle in line and len(out) < 30:
                    out.append(f"  {rel}:{i}: {line[:160]}")
            if len(out) >= 30:
                break
        return out


# ---------- run_focused_tests ----------

class RunFocusedTestsTool(Tool):
    name = "run_focused_tests"
    category = "run"
    description = (
        "Run a focused test command. Returns a compressed failure summary "
        "(test names, error type, expected/got, top stack files). Use this "
        "instead of run_command for tests so you get structured output."
    )
    args_schema = {
        "cmd": {"type": "string", "required": True, "description": "Test command (e.g. 'pytest tests/test_x.py -x -q')"},
        "timeout": {"type": "integer", "required": False, "description": "Timeout in seconds (default 60, max 300)"},
    }
    requires_repo = True
    modifies_filesystem = True
    runs_command = True

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        cmd = (args.get("cmd") or "").strip()
        if not cmd:
            return ToolResult(False, "run_focused_tests: no cmd",
                              error="missing cmd", action=self.name, args=args)
        if not ctx.runner:
            return ToolResult(False, "run_focused_tests: no runner",
                              error="runner not configured", action=self.name, args=args)
        timeout = float(args.get("timeout", 60))
        if timeout > 300:
            timeout = 300
        from cheater.runner import run as runner_run
        from cheater.failure_compressor import (
            compress_command_result, render_failure_for_model,
        )
        r = runner_run(cmd, cwd=ctx.repo_root, timeout=timeout, yes=True)
        summary = compress_command_result(cmd, r.stdout or "", r.stderr or "", r.returncode)
        next_actions: list[str] = []
        if not summary.passed:
            next_actions.extend([
                "Use localize_bug to find suspect source files for the failure.",
                "Use inspect_symbol to see the failing function's callers.",
                "Use read_context_pack for a focused context block.",
            ])
        else:
            next_actions.append("All focused tests passed. Consider running a broader test command.")
        body = render_failure_for_model(summary, max_tokens=2500) + "\n\n" + _next_actions(next_actions)
        return ToolResult(
            success=summary.passed,
            summary=f"run_focused_tests: exit={r.returncode} passed={summary.passed}",
            output=_truncate(body, 5000),
            error=r.error or "",
            action=self.name, args=args,
            commands_run=[cmd],
            elapsed=time.time() - start,
        )


# ---------- read_context_pack ----------

class ReadContextPackTool(Tool):
    name = "read_context_pack"
    category = "read"
    description = (
        "Build and return a compact context pack for the current task. "
        "Includes the task, any provided traceback, a relevant slice of the "
        "repo map, likely tests, project instructions, and curated memories. "
        "Use this BEFORE editing."
    )
    args_schema = {
        "task": {"type": "string", "required": True, "description": "The task or question"},
        "traceback": {"type": "string", "required": False, "description": "Optional failure text"},
        "max_tokens": {"type": "integer", "required": False, "description": "Max tokens (default 8000)"},
    }
    requires_repo = True
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        task = (args.get("task") or "").strip()
        if not task:
            return ToolResult(False, "read_context_pack: no task",
                              error="missing task", action=self.name, args=args)
        tb = args.get("traceback") or ""
        max_tokens = int(args.get("max_tokens", 8000))
        from cheater.context_pack import build_context_pack, render_for_model
        pack = build_context_pack(
            task=task,
            repo_root=ctx.repo_root,
            traceback=tb,
            memory_store=getattr(ctx, "memory_store", None),
            max_tokens=max_tokens,
        )
        rendered = render_for_model(pack)
        next_actions = [
            "Use repo_map_search to dive deeper into a specific file.",
            "Use localize_bug if you have a traceback or failure.",
            "Use run_focused_tests to verify after any change.",
        ]
        body = _truncate(rendered, max_tokens * 4) + "\n\n" + _next_actions(next_actions)
        return ToolResult(
            success=True,
            summary=f"read_context_pack: task='{task[:60]}' "
                    f"providers={','.join(p.name for p in pack.providers)}",
            output=body,
            action=self.name, args=args,
            elapsed=time.time() - start,
        )


# ---------- localize_bug ----------

class LocalizeBugTool(Tool):
    name = "localize_bug"
    category = "read"
    description = (
        "Run the bug localizer. Returns a JSON object with suspected_files, "
        "suspected_symbols, search_queries, needed_context, and risk_notes. "
        "Does NOT edit anything. Use this to decide WHERE to look before "
        "running run_focused_tests or making edits."
    )
    args_schema = {
        "task": {"type": "string", "required": True, "description": "The task / bug description"},
        "traceback": {"type": "string", "required": False, "description": "Failure text (traceback or pytest output)"},
        "use_model": {"type": "boolean", "required": False, "description": "If true and a model is available, ask it (default false)"},
    }
    requires_repo = True
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        task = (args.get("task") or "").strip()
        if not task:
            return ToolResult(False, "localize_bug: no task",
                              error="missing task", action=self.name, args=args)
        tb = args.get("traceback") or ""
        use_model = bool(args.get("use_model", False))
        from cheater.repo_map import build_repo_map
        from cheater.localizer import (
            deterministic_localize, localize_with_model, LocalizationResult,
        )
        m = build_repo_map(ctx.repo_root)
        result: LocalizationResult
        if use_model and getattr(ctx, "provider", None) is not None:
            from cheater.context_pack import build_context_pack
            pack = build_context_pack(task=task, repo_root=ctx.repo_root,
                                      traceback=tb, include_repo_map=True)
            result = localize_with_model(ctx.provider, task, pack)
        else:
            result = deterministic_localize(task, tb, m)
        out = result.to_dict()
        next_actions: list[str] = []
        if result.suspected_files:
            top = result.suspected_files[0]
            next_actions.append(f"Use inspect_symbol on the top suspect: {top.path}")
        next_actions.append("Use read_context_pack to see snippets of the top files.")
        next_actions.append("Use run_focused_tests on the matching test (if any) to reproduce.")
        if any("do not edit tests" in r.lower() for r in result.risk_notes):
            next_actions.append("Reminder: do not edit tests unless allow_test_edits is true.")
        body = json.dumps(out, indent=2) + "\n\n" + _next_actions(next_actions)
        return ToolResult(
            success=True,
            summary=f"localize_bug: {len(result.suspected_files)} file(s), "
                    f"{len(result.suspected_symbols)} symbol(s) (source={result.source})",
            output=_truncate(body, 5000),
            action=self.name, args=args,
            elapsed=time.time() - start,
        )


# ---------- registry hook ----------

def register_aci_tools(tools: list[Tool]) -> list[Tool]:
    """Append the ACI tools to a list. Returns the new list (does not mutate)."""
    return tools + [
        RepoMapBuildTool(),
        RepoMapSearchTool(),
        InspectSymbolTool(),
        RunFocusedTestsTool(),
        ReadContextPackTool(),
        LocalizeBugTool(),
    ]
