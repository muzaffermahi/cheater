"""Tool definitions for the Cheater agent loop.

Each tool is a function the model can call. Tools are constrained to a JSON
schema; the agent loop validates every model output against the schema
before running the tool. This is the single biggest reliability win for
9B models: they fail at free-form output ~30% of the time and succeed at
constrained-choice output ~85% of the time.

Public API:
  ToolContext(repo_root, cards, ..., callbacks)   -- dependencies tools need
  ToolResult(success, summary, output, error, ...)  -- what tools return
  Tool(name, description, args_schema, handler)     -- tool definition
  ToolRegistry(tools)                                -- validate + dispatch

Tools in this module (Phase A read-only + Phase B edits):
  read_file, list_files, search_code, run_command,
  search_memory, ask_user, edit_file, create_file,
  finish, i_dont_know
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Iterable


# ---------- data types ----------

@dataclass
class ToolContext:
    """Dependencies that tools need. Created per-run, passed to every tool."""
    repo_root: Path
    cards: list[dict] = field(default_factory=list)
    runner: Any = None  # cheater.runner (avoid circular import)
    memory_search: Any = None  # cheater.memory.memory_search
    memory_store: Any = None  # cheater.memory_store.MemoryStore (v0.5)
    provider: Any = None  # cheater.providers.BaseProvider (v0.6, for compound tools)
    forbidden_paths: tuple = ()
    allowed_paths: tuple = ()  # if set, only paths in this tuple can be edited
    read_only: bool = False
    max_output_chars: int = 4000
    ask_user: Callable[[str], str] | None = None  # prompts the user
    on_step: Callable[[str], None] | None = None  # progress callback


@dataclass
class ToolResult:
    """Result of a tool call. Always has success, summary; output/error optional."""
    success: bool
    summary: str
    output: str = ""
    error: str = ""
    action: str = ""
    args: dict = field(default_factory=dict)
    files_read: list[str] = field(default_factory=list)
    files_written: list[str] = field(default_factory=list)
    commands_run: list[str] = field(default_factory=list)
    memory_cards: list[str] = field(default_factory=list)
    elapsed: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_compact(self) -> dict[str, Any]:
        """Compact form for the working memory prompt."""
        return {
            "action": self.action,
            "args": self.args,
            "success": self.success,
            "summary": self.summary[:200],
        }


# ---------- tool base ----------

class Tool:
    """Base class for a tool."""

    name: str = ""
    description: str = ""
    args_schema: dict[str, Any] = {}
    requires_repo: bool = True
    modifies_filesystem: bool = False
    runs_command: bool = False
    # For 2-stage routing. Tools are grouped by category. The model first
    # picks a category, then sees only the schemas for tools in that
    # category. This halves the schema context for most turns.
    category: str = "read"  # read | write | run | meta

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        raise NotImplementedError

    def validate_args(self, args: Any) -> tuple[bool, str]:
        """Lightweight JSON-schema-ish validation. Returns (ok, error)."""
        if not isinstance(args, dict):
            return False, "args must be a JSON object"
        if not self.args_schema:
            return True, ""
        # Required fields
        for k, spec in self.args_schema.items():
            if isinstance(spec, dict) and spec.get("required") and k not in args:
                return False, f"missing required field: {k}"
        # Type checks (very basic)
        for k, v in args.items():
            if k in self.args_schema and isinstance(self.args_schema[k], dict):
                expected = self.args_schema[k].get("type")
                if expected == "string" and not isinstance(v, str):
                    return False, f"{k} must be a string"
                if expected == "integer" and not isinstance(v, int):
                    return False, f"{k} must be an integer"
                if expected == "number" and not isinstance(v, (int, float)):
                    return False, f"{k} must be a number"
                if expected == "boolean" and not isinstance(v, bool):
                    return False, f"{k} must be a boolean"
                if expected == "array" and not isinstance(v, list):
                    return False, f"{k} must be an array"
                if expected == "object" and not isinstance(v, dict):
                    return False, f"{k} must be an object"
        return True, ""


# ---------- path safety ----------

def _is_forbidden_path(path: str, forbidden: tuple) -> bool:
    from cheater.patch_engine import is_forbidden
    if is_forbidden(path):
        return True
    for f in forbidden:
        if path.startswith(f):
            return True
    return False


def _safe_path(ctx: ToolContext, raw_path: str) -> Path:
    """Resolve a user-supplied path to an absolute path inside repo_root.

    Raises ValueError if the path escapes the repo or hits a forbidden path.
    """
    p = Path(raw_path)
    if not p.is_absolute():
        p = ctx.repo_root / p
    p = p.resolve()
    repo = ctx.repo_root.resolve()
    try:
        p.relative_to(repo)
    except ValueError:
        raise ValueError(f"path escapes repo: {raw_path}")
    return p


# ---------- Phase A: read-only tools ----------

class ReadFileTool(Tool):
    name = "read_file"
    category = "read"
    description = (
        "Read a file from the repo. Returns up to max_output_chars of text. "
        "Use line_range to read a specific range like '100-150'."
    )
    args_schema = {
        "path": {"type": "string", "required": True,
                 "description": "Repo-relative path to the file (e.g. 'cheater/quality.py')"},
        "line_range": {"type": "string", "required": False,
                       "description": "Optional range like '100-150' or '50-'"},
    }
    requires_repo = True
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        raw = args.get("path", "")
        if not raw:
            return ToolResult(success=False, summary="read_file: no path given",
                              error="missing path", action=self.name, args=args)
        try:
            p = _safe_path(ctx, raw)
        except ValueError as e:
            return ToolResult(success=False, summary=f"read_file: {e}",
                              error=str(e), action=self.name, args=args)
        if not p.is_file():
            return ToolResult(success=False, summary=f"read_file: not found: {p}",
                              error=f"file not found: {p}", action=self.name, args=args)
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError as e:
            return ToolResult(success=False, summary=f"read_file: read error: {e}",
                              error=str(e), action=self.name, args=args)
        # Apply line range
        lr = args.get("line_range")
        if lr:
            lines = text.splitlines()
            try:
                if "-" in lr:
                    a, b = lr.split("-", 1)
                    start_i = max(0, int(a) - 1) if a.strip() else 0
                    end_i = int(b) if b.strip() else len(lines)
                    lines = lines[start_i:end_i]
                    text = "\n".join(lines)
                    # Note line numbers in summary
                    line_count = len(lines)
                    summary_prefix = f"read_file: {raw} (lines {start_i+1}-{start_i+line_count}, {line_count} lines)"
                else:
                    idx = int(lr) - 1
                    text = lines[idx] if 0 <= idx < len(lines) else ""
                    summary_prefix = f"read_file: {raw} line {idx+1}"
            except (ValueError, IndexError) as e:
                return ToolResult(success=False, summary=f"read_file: bad line_range: {lr}",
                                  error=str(e), action=self.name, args=args)
        else:
            summary_prefix = f"read_file: {raw} ({len(text)} chars)"
        truncated = False
        if len(text) > ctx.max_output_chars:
            text = text[:ctx.max_output_chars] + f"\n... [truncated, {len(text) - ctx.max_output_chars} more chars]"
            truncated = True
        return ToolResult(
            success=True,
            summary=summary_prefix + (" (truncated)" if truncated else ""),
            output=text,
            action=self.name,
            args=args,
            files_read=[str(p.relative_to(ctx.repo_root.resolve()))],
            elapsed=time.time() - start,
        )


class ListFilesTool(Tool):
    name = "list_files"
    category = "read"
    description = (
        "List files in the repo matching a glob. Returns up to 100 paths. "
        "Glob is relative to the repo root. Use '**/*.py' for recursive match."
    )
    args_schema = {
        "glob": {"type": "string", "required": True,
                 "description": "Glob pattern (e.g. '**/*.py', 'tests/*.json')"},
    }
    requires_repo = True
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        glob = args.get("glob", "")
        if not glob:
            return ToolResult(success=False, summary="list_files: no glob given",
                              error="missing glob", action=self.name, args=args)
        try:
            paths = sorted(ctx.repo_root.glob(glob))
        except (OSError, ValueError) as e:
            return ToolResult(success=False, summary=f"list_files: bad glob: {glob}",
                              error=str(e), action=self.name, args=args)
        # Filter out forbidden dirs
        from cheater.explorer import DEFAULT_IGNORED_DIRS
        out: list[str] = []
        for p in paths:
            try:
                rel = str(p.relative_to(ctx.repo_root.resolve())).replace("\\", "/")
            except ValueError:
                continue
            if any(part in DEFAULT_IGNORED_DIRS for part in rel.split("/")):
                continue
            out.append(rel)
            if len(out) >= 100:
                break
        if not out:
            return ToolResult(success=True, summary=f"list_files: no matches for '{glob}'",
                              output="(no matches)", action=self.name, args=args,
                              elapsed=time.time() - start)
        return ToolResult(
            success=True,
            summary=f"list_files: {len(out)} match(es) for '{glob}'",
            output="\n".join(out),
            action=self.name,
            args=args,
            elapsed=time.time() - start,
        )


class SearchCodeTool(Tool):
    name = "search_code"
    category = "read"
    description = (
        "Search the repo for code containing a literal query. Returns up to 50 "
        "matches as 'path:line: snippet' lines. Case-sensitive, simple grep."
    )
    args_schema = {
        "query": {"type": "string", "required": True,
                  "description": "Literal string to search for"},
        "file_glob": {"type": "string", "required": False,
                      "description": "Optional glob to limit which files are searched"},
    }
    requires_repo = True
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        query = args.get("query", "")
        if not query:
            return ToolResult(success=False, summary="search_code: no query given",
                              error="missing query", action=self.name, args=args)
        from cheater.explorer import DEFAULT_IGNORED_DIRS, TEXT_EXTENSIONS
        file_glob = args.get("file_glob") or "**/*"
        try:
            candidates = ctx.repo_root.glob(file_glob)
        except (OSError, ValueError) as e:
            return ToolResult(success=False, summary=f"search_code: bad glob: {file_glob}",
                              error=str(e), action=self.name, args=args)
        out: list[str] = []
        files_scanned = 0
        for p in candidates:
            if not p.is_file():
                continue
            if p.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            rel = str(p.relative_to(ctx.repo_root.resolve())).replace("\\", "/")
            if any(part in DEFAULT_IGNORED_DIRS for part in rel.split("/")):
                continue
            files_scanned += 1
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for i, line in enumerate(text.splitlines(), start=1):
                if query in line:
                    out.append(f"{rel}:{i}: {line[:200]}")
                    if len(out) >= 50:
                        break
            if len(out) >= 50:
                break
        if not out:
            return ToolResult(success=True,
                              summary=f"search_code: 0 matches for '{query}' ({files_scanned} files scanned)",
                              output="(no matches)", action=self.name, args=args,
                              elapsed=time.time() - start)
        return ToolResult(
            success=True,
            summary=f"search_code: {len(out)} match(es) for '{query}'",
            output="\n".join(out),
            action=self.name,
            args=args,
            elapsed=time.time() - start,
        )


class RunCommandTool(Tool):
    name = "run_command"
    category = "run"
    description = (
        "Run a shell command in the repo root. Use cautiously. Forbidden commands "
        "(rm -rf, git push --force, sudo, etc.) are blocked. Default timeout 60s."
    )
    args_schema = {
        "cmd": {"type": "string", "required": True, "description": "Shell command"},
        "timeout": {"type": "integer", "required": False, "description": "Timeout in seconds (default 60)"},
    }
    requires_repo = True
    modifies_filesystem = True
    runs_command = True

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        cmd = args.get("cmd", "")
        if not cmd:
            return ToolResult(success=False, summary="run_command: no cmd given",
                              error="missing cmd", action=self.name, args=args)
        if not ctx.runner:
            return ToolResult(success=False, summary="run_command: no runner available",
                              error="runner not configured", action=self.name, args=args)
        timeout = float(args.get("timeout", 60))
        if timeout > 300:
            timeout = 300  # hard cap
        # Within the agent loop, commands are auto-approved (the user already
        # approved the whole loop by running `cheater agent ...`).
        # The runner still blocks forbidden commands (rm -rf, sudo, etc).
        r = ctx.runner(cmd, cwd=ctx.repo_root, timeout=timeout, yes=True)
        elapsed = time.time() - start
        output = (r.stdout or "") + ("\n" + r.stderr if r.stderr else "")
        if len(output) > ctx.max_output_chars:
            output = output[:ctx.max_output_chars] + f"\n... [truncated]"
        return ToolResult(
            success=r.ok,
            summary=f"run_command: exit={r.returncode} ({elapsed:.1f}s)",
            output=output,
            error=r.error,
            action=self.name,
            args=args,
            commands_run=[cmd],
            elapsed=elapsed,
        )


class SearchMemoryTool(Tool):
    name = "search_memory"
    category = "read"
    description = (
        "Search the bug-memory corpus for cards related to a query. Returns "
        "the top-5 cards with id, repo, language, bug_type, and short symptom."
    )
    args_schema = {
        "query": {"type": "string", "required": True, "description": "Search query"},
    }
    requires_repo = False
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        q = args.get("query", "")
        if not q:
            return ToolResult(success=False, summary="search_memory: no query given",
                              error="missing query", action=self.name, args=args)
        if not ctx.memory_search:
            return ToolResult(success=False, summary="search_memory: not configured",
                              error="memory_search not available", action=self.name, args=args)
        if not ctx.cards:
            return ToolResult(success=True, summary="search_memory: no cards loaded",
                              output="(no memory cards in this run)", action=self.name,
                              args=args, elapsed=time.time() - start)
        hits = ctx.memory_search(q, ctx.cards, mode="balanced", top_k_override=5)
        if not hits:
            return ToolResult(success=True, summary=f"search_memory: 0 hits for '{q}'",
                              output="(no hits)", action=self.name, args=args,
                              elapsed=time.time() - start)
        lines: list[str] = []
        card_ids: list[str] = []
        for h in hits:
            c = h.card
            card_ids.append(c.get("id", "?"))
            symptom = (c.get("symptom") or "")[:120]
            lines.append(
                f"- id={c.get('id', '?')}  repo={c.get('repo', '?')}  "
                f"lang={c.get('language', '?')}  bug_type={c.get('bug_type', '?')}\n"
                f"  symptom: {symptom}"
            )
        return ToolResult(
            success=True,
            summary=f"search_memory: {len(hits)} hit(s) for '{q}'",
            output="\n".join(lines),
            action=self.name,
            args=args,
            memory_cards=card_ids,
            elapsed=time.time() - start,
        )


class MemoryRememberTool(Tool):
    """Save a piece of knowledge to the agent's persistent memory.

    Memory entries survive across sessions and are surfaced back into the
    system prompt when relevant. Use for: project conventions, debugging
    lessons, user preferences, fixes that worked, things to avoid.
    """
    name = "memory_remember"
    category = "meta"
    description = (
        "Save a piece of knowledge to the agent's persistent memory. "
        "Examples: 'the user prefers concise answers', 'this project uses "
        "pydantic v2', 'last time we fixed X by doing Y'. "
        "Memory entries survive across sessions and shape future prompts."
    )
    args_schema = {
        "text": {"type": "string", "required": True,
                 "description": "The knowledge to remember. Be concise and specific."},
        "tags": {"type": "string", "required": False,
                 "description": "Comma-separated tags (e.g. 'python,pydantic,test')"},
    }
    requires_repo = False
    modifies_filesystem = True
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        text = (args.get("text") or "").strip()
        if not text:
            return ToolResult(success=False, summary="memory_remember: no text given",
                              error="missing text", action=self.name, args=args)
        tags_str = args.get("tags") or ""
        tags = [t.strip() for t in tags_str.split(",") if t.strip()]
        # Use the store from the context if provided, else create one
        store = getattr(ctx, "memory_store", None)
        if store is None:
            from cheater.memory_store import MemoryStore
            store = MemoryStore()
        try:
            mem_id = store.add(text=text, tags=tags, source="agent")
        except ValueError as e:
            return ToolResult(success=False, summary=f"memory_remember: {e}",
                              error=str(e), action=self.name, args=args)
        return ToolResult(
            success=True,
            summary=f"memory_remember: saved id={mem_id} ({len(text)} chars, {len(tags)} tag(s))",
            output=f"Saved memory {mem_id}",
            action=self.name,
            args=args,
            elapsed=time.time() - start,
        )


class MemoryForgetTool(Tool):
    """Remove a memory entry by id or by query."""
    name = "memory_forget"
    category = "meta"
    description = (
        "Remove a memory entry. Pass either memory_id (exact) or query "
        "(removes top match). Use to clean up outdated knowledge."
    )
    args_schema = {
        "memory_id": {"type": "string", "required": False,
                      "description": "Exact memory id (e.g. 'a1b2c3d4e5f6')"},
        "query": {"type": "string", "required": False,
                  "description": "Search query; removes the top-scoring match"},
    }
    requires_repo = False
    modifies_filesystem = True
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        mem_id = args.get("memory_id")
        query = args.get("query")
        if not mem_id and not query:
            return ToolResult(success=False, summary="memory_forget: need memory_id or query",
                              error="missing both", action=self.name, args=args)
        store = getattr(ctx, "memory_store", None)
        if store is None:
            from cheater.memory_store import MemoryStore
            store = MemoryStore()
        count = store.remove(memory_id=mem_id, query=query)
        if count == 0:
            return ToolResult(success=False,
                              summary=f"memory_forget: no match for {mem_id or query!r}",
                              error="not found", action=self.name, args=args)
        target = mem_id or query
        return ToolResult(
            success=True,
            summary=f"memory_forget: removed {count} entry for {target!r}",
            output=f"Removed {count} entry",
            action=self.name,
            args=args,
            elapsed=time.time() - start,
        )


class MemoryRecallTool(Tool):
    """Search curated memories by query. Returns top matches."""
    name = "memory_recall"
    category = "read"
    description = (
        "Search the agent's curated memory by query. Returns top-5 matches "
        "with id, text, tags, source, and a relevance score. Use to find "
        "relevant prior knowledge before starting a task."
    )
    args_schema = {
        "query": {"type": "string", "required": True, "description": "Search query"},
        "top_k": {"type": "integer", "required": False, "description": "Number of results (default 5)"},
    }
    requires_repo = False
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        q = (args.get("query") or "").strip()
        if not q:
            return ToolResult(success=False, summary="memory_recall: no query given",
                              error="missing query", action=self.name, args=args)
        top_k = int(args.get("top_k", 5))
        store = getattr(ctx, "memory_store", None)
        if store is None:
            from cheater.memory_store import MemoryStore
            store = MemoryStore()
        hits = store.search(q, top_k=top_k)
        if not hits:
            return ToolResult(success=True, summary=f"memory_recall: 0 hits for '{q}'",
                              output="(no memories match)", action=self.name, args=args,
                              elapsed=time.time() - start)
        lines: list[str] = []
        mem_ids: list[str] = []
        for h in hits:
            mem_ids.append(h["id"])
            tags_str = ", ".join(h.get("tags") or [])
            tag_suffix = f"  [tags: {tags_str}]" if tags_str else ""
            text = h["text"]
            if len(text) > 200:
                text = text[:197] + "..."
            lines.append(
                f"- id={h['id']}  score={h.get('_score', '?')}  source={h.get('source', '?')}{tag_suffix}\n"
                f"  {text}"
            )
        return ToolResult(
            success=True,
            summary=f"memory_recall: {len(hits)} hit(s) for '{q}'",
            output="\n".join(lines),
            action=self.name,
            args=args,
            memory_cards=mem_ids,
            elapsed=time.time() - start,
        )


class AskUserTool(Tool):
    name = "ask_user"
    category = "meta"
    description = (
        "Ask the user a clarifying question. Use sparingly. The user's answer "
        "is returned as the tool's output."
    )
    args_schema = {
        "question": {"type": "string", "required": True, "description": "Question to ask the user"},
    }
    requires_repo = False
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        question = args.get("question", "")
        if not question:
            return ToolResult(success=False, summary="ask_user: no question",
                              error="missing question", action=self.name, args=args)
        if ctx.ask_user is None:
            return ToolResult(success=False, summary="ask_user: not configured",
                              error="ask_user callback not set", action=self.name, args=args)
        try:
            answer = ctx.ask_user(question)
        except (EOFError, KeyboardInterrupt):
            return ToolResult(success=False, summary="ask_user: user interrupted",
                              error="user interrupted", action=self.name, args=args)
        if not answer:
            answer = "(no answer)"
        return ToolResult(
            success=True,
            summary=f"ask_user: '{question[:60]}...' → '{answer[:60]}'",
            output=answer,
            action=self.name,
            args=args,
        )


# ---------- Phase B: edit tools ----------

class EditFileTool(Tool):
    name = "edit_file"
    category = "write"
    description = (
        "Replace an EXACT substring in a file. 'old' must match exactly one place. "
        "Returns the unified diff and applies the patch. Forbidden for read-only mode."
    )
    args_schema = {
        "path": {"type": "string", "required": True},
        "old": {"type": "string", "required": True, "description": "Exact text to replace (must be unique in the file)"},
        "new": {"type": "string", "required": True, "description": "Replacement text"},
    }
    requires_repo = True
    modifies_filesystem = True
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        if ctx.read_only:
            return ToolResult(success=False, summary="edit_file: read-only mode",
                              error="read-only mode forbids file edits", action=self.name, args=args)
        raw_path = args.get("path", "")
        old = args.get("old", "")
        new = args.get("new", "")
        if not raw_path or not old:
            return ToolResult(success=False, summary="edit_file: path and old are required",
                              error="missing path or old", action=self.name, args=args)
        try:
            p = _safe_path(ctx, raw_path)
        except ValueError as e:
            return ToolResult(success=False, summary=f"edit_file: {e}",
                              error=str(e), action=self.name, args=args)
        if _is_forbidden_path(str(p), ctx.forbidden_paths):
            return ToolResult(success=False, summary=f"edit_file: forbidden path: {raw_path}",
                              error="forbidden path", action=self.name, args=args)
        from cheater.patch_engine import (
            PatchProposal, apply, list_snapshots, preview, save_snapshots,
        )
        if not p.is_file():
            return ToolResult(success=False, summary=f"edit_file: file not found: {raw_path}",
                              error="file not found", action=self.name, args=args)
        text = p.read_text(encoding="utf-8", errors="ignore")
        n = text.count(old)
        if n == 0:
            return ToolResult(success=False, summary=f"edit_file: 'old' text not found in {raw_path}",
                              error="old text not found", action=self.name, args=args)
        if n > 1:
            return ToolResult(success=False,
                              summary=f"edit_file: 'old' text matches {n} places in {raw_path}; must be unique",
                              error="non-unique old text", action=self.name, args=args)
        prop = PatchProposal(path=str(p), old=old, new=new, description="agent edit")
        diff = preview(prop)
        try:
            snap_id = apply(prop)
        except (ValueError, PermissionError, OSError) as e:
            return ToolResult(success=False, summary=f"edit_file: apply failed: {e}",
                              error=str(e), action=self.name, args=args)
        # Persist snapshots
        snap_path = ctx.repo_root / ".cheater" / "patch_snapshots.json"
        save_snapshots(snap_path)
        return ToolResult(
            success=True,
            summary=f"edit_file: applied to {raw_path} (snapshot={snap_id})",
            output=diff,
            action=self.name,
            args=args,
            files_written=[str(p.relative_to(ctx.repo_root.resolve()))],
            elapsed=time.time() - start,
        )


class CreateFileTool(Tool):
    name = "create_file"
    category = "write"
    description = (
        "Create a new file with the given content. Fails if the file already "
        "exists; use edit_file for existing files. Forbidden for read-only mode."
    )
    args_schema = {
        "path": {"type": "string", "required": True},
        "content": {"type": "string", "required": True, "description": "Full file content"},
    }
    requires_repo = True
    modifies_filesystem = True
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        start = time.time()
        if ctx.read_only:
            return ToolResult(success=False, summary="create_file: read-only mode",
                              error="read-only mode forbids file creation", action=self.name, args=args)
        raw_path = args.get("path", "")
        content = args.get("content", "")
        if not raw_path:
            return ToolResult(success=False, summary="create_file: path is required",
                              error="missing path", action=self.name, args=args)
        try:
            p = _safe_path(ctx, raw_path)
        except ValueError as e:
            return ToolResult(success=False, summary=f"create_file: {e}",
                              error=str(e), action=self.name, args=args)
        if _is_forbidden_path(str(p), ctx.forbidden_paths):
            return ToolResult(success=False, summary=f"create_file: forbidden path: {raw_path}",
                              error="forbidden path", action=self.name, args=args)
        if p.exists():
            return ToolResult(success=False,
                              summary=f"create_file: file already exists: {raw_path}; use edit_file for surgical changes",
                              error="file already exists", action=self.name, args=args)
        from cheater.patch_engine import (
            PatchProposal, apply, save_snapshots,
        )
        prop = PatchProposal(path=str(p), old="", new=content, description="agent create")
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            snap_id = apply(prop)
        except (ValueError, PermissionError, OSError) as e:
            return ToolResult(success=False, summary=f"create_file: apply failed: {e}",
                              error=str(e), action=self.name, args=args)
        snap_path = ctx.repo_root / ".cheater" / "patch_snapshots.json"
        save_snapshots(snap_path)
        return ToolResult(
            success=True,
            summary=f"create_file: wrote {len(content)} chars to {raw_path} (snapshot={snap_id})",
            action=self.name,
            args=args,
            files_written=[str(p.relative_to(ctx.repo_root.resolve()))],
            elapsed=time.time() - start,
        )


# ---------- special tools (always present, no real work) ----------

class FinishTool(Tool):
    """Special tool: signals the end of the loop. The model MUST cite evidence."""
    name = "finish"
    category = "meta"
    description = (
        "End the loop. Provide a 'summary' (what you did) and 'evidence' "
        "(a real artifact: a test that passed, a file you changed, a command output). "
        "The loop will verify the evidence before accepting."
    )
    args_schema = {
        "summary": {"type": "string", "required": True, "description": "What you did"},
        "evidence": {"type": "string", "required": True, "description": "Why you think the task is done"},
    }
    requires_repo = False
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        return ToolResult(
            success=True,
            summary=f"finish: {args.get('summary', '?')[:80]}",
            output=args.get("evidence", ""),
            action=self.name,
            args=args,
        )


class IDontKnowTool(Tool):
    """Special tool: signals the loop could not complete the task. Honest about limits."""
    name = "i_dont_know"
    category = "meta"
    description = (
        "End the loop. The task cannot be completed with the current tools or "
        "within the model's capability. Provide a 'reason' explaining what is missing."
    )
    args_schema = {
        "reason": {"type": "string", "required": True, "description": "Why the task cannot be completed"},
    }
    requires_repo = False
    modifies_filesystem = False
    runs_command = False

    def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        return ToolResult(
            success=True,
            summary=f"i_dont_know: {args.get('reason', '?')[:80]}",
            output=args.get("reason", ""),
            action=self.name,
            args=args,
        )


# ---------- registry ----------

def default_tool_registry(read_only: bool = False) -> "ToolRegistry":
    """Return the default set of tools."""
    tools: list[Tool] = [
        ReadFileTool(),
        ListFilesTool(),
        SearchCodeTool(),
        RunCommandTool(),
        SearchMemoryTool(),
        MemoryRecallTool(),
        AskUserTool(),
        FinishTool(),
        IDontKnowTool(),
    ]
    if not read_only:
        tools.insert(5, EditFileTool())  # before Finish/IDontKnow
        tools.insert(6, CreateFileTool())
    # Memory write tools (always available, including in read-only mode —
    # remembering things is a read operation against the agent's own state)
    tools.insert(7, MemoryRememberTool())
    tools.insert(8, MemoryForgetTool())
    # v0.6: compound ACI tools (repo map, localizer, focused tests, context)
    from cheater.aci_tools import register_aci_tools
    tools = register_aci_tools(tools)
    return ToolRegistry(tools)


class ToolRegistry:
    """Holds the available tools, validates model output, dispatches calls."""

    def __init__(self, tools: list[Tool]) -> None:
        self.tools: dict[str, Tool] = {t.name: t for t in tools}
        self._by_category: dict[str, list[Tool]] = {}
        for t in tools:
            self._by_category.setdefault(t.category, []).append(t)

    def names(self) -> list[str]:
        return list(self.tools.keys())

    def categories(self) -> list[str]:
        return sorted(self._by_category.keys())

    def tools_in_category(self, category: str) -> list[Tool]:
        return list(self._by_category.get(category, []))

    def descriptions(self) -> list[dict[str, Any]]:
        return [
            {"name": t.name, "description": t.description, "args": t.args_schema}
            for t in self.tools.values()
        ]

    def descriptions_for_category(self, category: str) -> list[dict[str, Any]]:
        return [
            {"name": t.name, "description": t.description, "args": t.args_schema}
            for t in self._by_category.get(category, [])
        ]

    def get(self, name: str) -> Tool | None:
        return self.tools.get(name)

    def validate_action(self, action_obj: Any) -> tuple[bool, str, str, dict]:
        """Validate a parsed JSON action. Returns (ok, error, action_name, args)."""
        if not isinstance(action_obj, dict):
            return False, "action must be a JSON object", "", {}
        name = action_obj.get("action")
        if not isinstance(name, str):
            return False, "missing 'action' field", "", {}
        if name not in self.tools:
            return False, f"unknown action: {name!r}. Valid: {', '.join(self.names())}", "", {}
        tool = self.tools[name]
        args = action_obj.get("args", {})
        if not isinstance(args, dict):
            return False, f"{name}: 'args' must be a JSON object", name, {}
        ok, err = tool.validate_args(args)
        if not ok:
            return False, f"{name}: {err}", name, args
        return True, "", name, args

    def run(self, name: str, args: dict, ctx: ToolContext) -> ToolResult:
        tool = self.tools.get(name)
        if not tool:
            return ToolResult(success=False, summary=f"unknown tool: {name}",
                              error="unknown tool", action=name, args=args)
        try:
            return tool.run(args, ctx)
        except Exception as e:
            return ToolResult(success=False, summary=f"{name}: crashed: {e}",
                              error=f"{type(e).__name__}: {e}", action=name, args=args)
