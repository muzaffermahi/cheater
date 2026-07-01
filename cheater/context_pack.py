"""Cheater context pack — a small, Continue-like context provider.

A ContextPack is a bundle of small, typed context blocks (one per provider).
The LLM only ever sees the rendered pack, not the whole repo.

The pack is built from a fixed set of providers:

  - task:        the user task / issue text
  - traceback:   provided traceback or failing command output
  - repo_map:    a compact, query-relevant subset of the repo map
  - files:       selected file snippets (caller chooses)
  - tests:       likely related tests
  - memory:      relevant memories (from cheater.memory_store)
  - skills:      relevant skills (no-op if skills aren't loaded yet)
  - instructions: a small, task-aware slice of AGENTS.md/CLAUDE.md/README

Each provider is a `ContextProvider` (lightweight ABC). They are independent
and small. The pack builder runs them in a stable order and clips to
`max_tokens` (rough: 4 chars/token). The LLM-friendly renderer emits a
labelled markdown block per provider so the model can see what came from
where.

Public API:
  ContextProvider                -- ABC
  ContextPack                    -- the bundle
  Built-in providers             -- TaskProvider, TracebackProvider, etc.
  build_context_pack(task, ...)  -- main builder
  render_for_model(pack)         -- markdown for the model

AGENTS.md / CLAUDE.md are treated as *guidance*, not enforcement, and we keep
snippets minimal to avoid bloat.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

# Rough heuristic: 1 token ~= 4 chars
CHARS_PER_TOKEN = 4

INSTRUCTION_FILE_CANDIDATES = (
    "AGENTS.md",
    ".cheater/AGENTS.md",
    "CLAUDE.md",
    ".cheater/CLAUDE.md",
)

README_CANDIDATES = (
    "README.md",
    "readme.md",
    "Readme.md",
)

PYPROJECT_CANDIDATES = (
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "package.json",
)

# Instruction excerpts that are always safe to include (short, low-signal)
SAFE_INSTRUCTION_KEYWORDS = (
    "test", "pytest", "lint", "ruff", "mypy", "build", "typecheck",
    "run", "install", "format", "convention", "naming", "module",
    "import", "style", "no ", "do not", "don't", "always", "never",
    "prefer", "avoid", "must", "should",
)


# ---------- data types ----------

@dataclass
class ContextProvider:
    """A single context source. Holds a label, body, and a priority."""
    name: str
    label: str
    body: str
    priority: int = 50          # 0 = highest priority
    metadata: dict[str, Any] = field(default_factory=dict)

    def char_len(self) -> int:
        return len(self.body or "")

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "priority": self.priority,
            "char_len": self.char_len(),
            "metadata": self.metadata,
        }


@dataclass
class ContextPack:
    task: str
    providers: list[ContextProvider] = field(default_factory=list)
    truncated: list[str] = field(default_factory=list)
    max_tokens: int = 12_000
    metadata: dict[str, Any] = field(default_factory=dict)

    def add(self, p: ContextProvider) -> None:
        self.providers.append(p)

    def get(self, name: str) -> ContextProvider | None:
        for p in self.providers:
            if p.name == name:
                return p
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "task": self.task,
            "max_tokens": self.max_tokens,
            "providers": [p.to_dict() for p in self.providers],
            "truncated": self.truncated,
            "metadata": self.metadata,
        }

    def total_chars(self) -> int:
        return sum(p.char_len() for p in self.providers)


# ---------- helpers ----------

def _clip(text: str, max_chars: int) -> str:
    if not text or len(text) <= max_chars:
        return text or ""
    return text[:max(0, max_chars - 30)] + "\n... [truncated]"


def _read_file_safe(path: Path, max_bytes: int = 256_000) -> str:
    try:
        if not path.is_file():
            return ""
        if path.stat().st_size > max_bytes:
            # Read just the head
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                return f.read(max_bytes)
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


# ---------- built-in providers ----------

class TaskProvider(ContextProvider):
    """The user task / issue text. Highest priority, never clipped."""
    def __init__(self, task: str) -> None:
        super().__init__(name="task", label="Task", body=task or "", priority=0)


class TracebackProvider(ContextProvider):
    """Provided traceback or failing command output. Second-highest priority."""
    def __init__(self, traceback: str) -> None:
        super().__init__(name="traceback", label="Traceback / Failure",
                         body=traceback or "", priority=5)


class RepoMapProvider(ContextProvider):
    """Compact, query-relevant repo map."""
    def __init__(self, repo_root: str | Path, query: str = "",
                 traceback: str = "", top_k: int = 12) -> None:
        # Lazy import: repo_map pulls in ast; we want this to be importable
        # even on minimal Python builds.
        from cheater.repo_map import build_repo_map, select_relevant_map
        root = Path(repo_root)
        try:
            m = build_repo_map(root)
        except Exception as e:
            super().__init__(name="repo_map", label="Repo map",
                             body=f"(repo map failed: {e})", priority=20,
                             metadata={"error": str(e)})
            return
        try:
            rendered = select_relevant_map(m, query=query, traceback=traceback,
                                           top_k=top_k)
        except Exception as e:
            rendered = f"(repo map render failed: {e})"
        super().__init__(name="repo_map", label="Relevant repo map",
                         body=rendered, priority=20,
                         metadata={"file_count": len(m.files)})


class FilesProvider(ContextProvider):
    """Selected file snippets. Caller-supplied."""
    def __init__(self, files: list[tuple[str, str]], max_chars_per_file: int = 4000) -> None:
        if not files:
            super().__init__(name="files", label="Selected files", body="")
            return
        parts: list[str] = []
        for path, content in files:
            parts.append(f"### `{path}`")
            parts.append("```")
            parts.append(_clip(content, max_chars_per_file))
            parts.append("```")
        super().__init__(name="files", label="Selected files",
                         body="\n".join(parts), priority=30)


class TestsProvider(ContextProvider):
    """Likely related test files. Cheap: list of test paths from repo map."""
    def __init__(self, repo_root: str | Path, query: str = "",
                 max_paths: int = 10) -> None:
        from cheater.repo_map import build_repo_map
        root = Path(repo_root)
        try:
            m = build_repo_map(root)
        except Exception:
            super().__init__(name="tests", label="Likely tests", body="")
            return
        # Rank test files by query term overlap
        q_tokens = [t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", query or "")
                    if len(t) >= 2]
        qset = set(q_tokens)
        scored: list[tuple[float, str]] = []
        for tf in m.all_test_files():
            s = 0.0
            tlow = tf.path.lower()
            for t in qset:
                if t in tlow:
                    s += 1.0
            for sym in tf.symbol_names():
                if any(t in sym.lower() for t in qset):
                    s += 0.5
            scored.append((s, tf.path))
        scored.sort(key=lambda x: x[0], reverse=True)
        chosen = [p for _, p in scored[:max_paths]] or [p.path for p in m.all_test_files()[:max_paths]]
        body = "\n".join(f"- `{p}`" for p in chosen) if chosen else "(no test files)"
        super().__init__(name="tests", label="Likely tests",
                         body=body, priority=40,
                         metadata={"count": len(chosen)})


class MemoryProvider(ContextProvider):
    """Relevant memories from the persistent store."""
    def __init__(self, store: Any, query: str, top_k: int = 3) -> None:
        if store is None or not query:
            super().__init__(name="memory", label="Curated memories", body="")
            return
        try:
            hits = store.search(query, top_k=top_k)
        except Exception:
            hits = []
        if not hits:
            super().__init__(name="memory", label="Curated memories",
                             body="(no matching memories)")
            return
        lines: list[str] = []
        for h in hits:
            tags = ", ".join(h.get("tags") or [])
            tag_suffix = f"  [tags: {tags}]" if tags else ""
            text = h["text"]
            if len(text) > 200:
                text = text[:197] + "..."
            lines.append(f"- id={h['id']} score={h.get('_score', '?')}{tag_suffix}\n  {text}")
        super().__init__(name="memory", label="Curated memories",
                         body="\n".join(lines), priority=25,
                         metadata={"count": len(hits)})


class SkillsProvider(ContextProvider):
    """Relevant skills. No-op if a skills registry isn't available yet."""
    def __init__(self, query: str = "", skills: Any = None) -> None:
        # Phase A: no skills registry exists yet. This provider is a no-op
        # so the renderer stays stable. Phase B will wire it in.
        super().__init__(name="skills", label="Skills", body="")


class InstructionsProvider(ContextProvider):
    """Project instructions: AGENTS.md, CLAUDE.md, README, pyproject scripts.

    Snippet policy:
      - Read AGENTS.md/CLAUDE.md, but only keep short lines that look like
        actionable instructions (test/lint/build/style keywords).
      - Include pyproject.toml scripts/dependencies as a one-liner.
      - Cap each source at ~800 chars.
    """
    def __init__(self, repo_root: str | Path, query: str = "") -> None:
        root = Path(repo_root)
        parts: list[str] = []
        # AGENTS.md / CLAUDE.md
        for rel in INSTRUCTION_FILE_CANDIDATES:
            content = _read_file_safe(root / rel, max_bytes=64_000)
            if not content:
                continue
            snippet = self._filter_instructions(content, query=query)
            if snippet:
                parts.append(f"### `{rel}` (guidance, not enforcement)")
                parts.append(snippet)
        # README — only the first 25 lines
        for rel in README_CANDIDATES:
            content = _read_file_safe(root / rel, max_bytes=64_000)
            if not content:
                continue
            head = "\n".join(content.splitlines()[:25])
            if head.strip():
                parts.append(f"### `{rel}` (head)")
                parts.append(_clip(head, 1200))
            break
        # pyproject scripts
        for rel in PYPROJECT_CANDIDATES:
            content = _read_file_safe(root / rel, max_bytes=32_000)
            if not content:
                continue
            scripts = self._extract_pyproject_scripts(content)
            if scripts:
                parts.append(f"### `{rel}` (project scripts)")
                parts.append(scripts)
            break
        super().__init__(name="instructions", label="Project instructions",
                         body="\n\n".join(parts), priority=15)

    @staticmethod
    def _filter_instructions(text: str, query: str = "") -> str:
        """Keep short, instruction-like lines."""
        keep: list[str] = []
        seen: set[str] = set()
        kw_re = re.compile("|".join(re.escape(k) for k in SAFE_INSTRUCTION_KEYWORDS),
                           re.IGNORECASE)
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if len(line) > 220:
                continue
            llow = line.lower()
            if not kw_re.search(llow):
                continue
            if llow in seen:
                continue
            seen.add(llow)
            keep.append(line)
            if sum(len(x) for x in keep) > 800:
                break
        return "\n".join(keep) if keep else ""

    @staticmethod
    def _extract_pyproject_scripts(text: str) -> str:
        """Pull the [project.scripts] or [tool.poetry.scripts] block as one-liners."""
        out: list[str] = []
        in_scripts = False
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("[") and s.endswith("]"):
                in_scripts = "script" in s.lower()
                continue
            if in_scripts and "=" in s and not s.startswith("#"):
                k, _, v = s.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and v:
                    out.append(f"  {k}: {v}")
        return "\n".join(out)


# ---------- builder ----------

def build_context_pack(
    task: str,
    repo_root: str | Path,
    *,
    traceback: str = "",
    files: list[tuple[str, str]] | None = None,
    memory_store: Any = None,
    skills: Any = None,
    max_tokens: int = 12_000,
    include_repo_map: bool = True,
    include_tests: bool = True,
    include_instructions: bool = True,
) -> ContextPack:
    """Build a ContextPack from the standard providers.

    Args:
      task:        the user task or issue text (required)
      repo_root:   path to the repo being analyzed
      traceback:   optional failure text to bias repo map selection
      files:       optional list of (path, content) pairs to include verbatim
      memory_store: optional MemoryStore from cheater.memory_store
      skills:      optional skills registry (Phase B)
      max_tokens:  rough cap on the rendered pack size
    """
    pack = ContextPack(task=task, max_tokens=max_tokens)
    pack.add(TaskProvider(task))
    if traceback:
        pack.add(TracebackProvider(traceback))
    if include_instructions:
        pack.add(InstructionsProvider(repo_root, query=task))
    if include_repo_map:
        pack.add(RepoMapProvider(repo_root, query=task, traceback=traceback))
    if memory_store is not None:
        pack.add(MemoryProvider(memory_store, query=task, top_k=3))
    if include_tests:
        pack.add(TestsProvider(repo_root, query=task))
    if files:
        pack.add(FilesProvider(files))
    if skills is not None:
        pack.add(SkillsProvider(query=task, skills=skills))
    _enforce_budget(pack)
    return pack


def _enforce_budget(pack: ContextPack) -> None:
    """Trim low-priority providers to fit max_tokens. Highest priority wins."""
    cap = max(64, pack.max_tokens * CHARS_PER_TOKEN)
    # Task + Traceback are always kept (priority <= 5).
    # Others may be clipped or dropped.
    total = pack.total_chars()
    if total <= cap:
        return
    # Sort by priority ascending (lower number = more important)
    sortable = [p for p in pack.providers if p.priority > 5]
    sortable.sort(key=lambda p: p.priority)
    for p in sortable:
        if total <= cap:
            break
        before = p.char_len()
        if p.priority >= 30 and total - before > cap * 0.2:
            # Drop entirely
            pack.providers = [x for x in pack.providers if x is not p]
            total -= before
            pack.truncated.append(f"dropped:{p.name}")
        else:
            # Clip
            allow = max(0, cap - (total - before))
            if allow < before * 0.4:
                pack.providers = [x for x in pack.providers if x is not p]
                total -= before
                pack.truncated.append(f"dropped:{p.name}")
            else:
                p.body = _clip(p.body, allow)
                total = pack.total_chars()
                pack.truncated.append(f"clipped:{p.name}")


def render_for_model(pack: ContextPack) -> str:
    """Render the pack as a stable, labeled markdown block."""
    parts: list[str] = []
    parts.append("=== CONTEXT PACK ===")
    parts.append(f"Task: {pack.task[:200]}")
    parts.append(f"Providers: {', '.join(p.name for p in pack.providers)}")
    if pack.truncated:
        parts.append(f"Budget actions: {', '.join(pack.truncated)}")
    parts.append("")
    for p in sorted(pack.providers, key=lambda x: (x.priority, x.name)):
        if not p.body:
            continue
        parts.append(f"--- {p.label} ---")
        parts.append(p.body.strip())
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"
