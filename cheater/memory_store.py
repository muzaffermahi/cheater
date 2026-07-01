"""Persistent memory store for the Cheater agent.

The agent-curated memory is the user's "external brain": the agent decides
what's worth remembering across sessions, writes it here, and the system
prompt surfaces it back when relevant.

Storage: JSONL at `~/.config/cheater/memory/curated.jsonl`. Each entry
has id, text, tags, source (skill/session/manual), created_at, last_used_at,
use_count. Search is simple token-overlap scoring (no FTS5 native dep).

Public API:
  MemoryStore(root_dir=None)              -- resolves to ~/.config/cheater/memory
  store.add(text, tags, source)           -- append entry; returns the id
  store.remove(memory_id=None, query=None) -- by id or by query
  store.search(query, top_k=5)            -- token-overlap ranking
  store.for_prompt(top_k=3)               -- formatted for system prompt
  store.all()                             -- list all entries (newest first)
  store.stats()                           -- counts, top sources
  store.touch(memory_id)                  -- bump last_used_at + use_count
  store.persist()                         -- flush to disk (auto on every write)
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable


# Token regex (matches identifier-like words AND standalone numbers)
_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+")

# Stopwords (very small; matches what retrieval.py uses)
_STOPWORDS: set[str] = {
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "but",
    "in", "with", "to", "for", "of", "as", "by", "this", "that", "it",
    "from", "be", "are", "was", "were", "not", "have", "has", "had",
    "if", "then", "else", "when", "all", "any", "some", "no", "nor",
    "you", "your", "i", "we", "they", "he", "she", "them", "us", "me",
    "do", "does", "did", "doing", "would", "could", "should",
    "will", "shall", "may", "might", "must", "can",
    "fix", "make", "use", "used", "test", "tests", "run", "runs",
    "file", "files", "line", "lines", "code", "agent", "task",
    "work", "works", "step", "steps", "error", "errors",
}


def _default_root() -> Path:
    return Path.home() / ".config" / "cheater" / "memory"


def _tokenize(text: str) -> list[str]:
    """Lowercase tokens, drop stopwords and very-short tokens."""
    if not text:
        return []
    return [t.lower() for t in _TOKEN_RE.findall(text) if len(t) >= 2 and t.lower() not in _STOPWORDS]


@dataclass
class MemoryEntry:
    """A single curated memory entry."""
    id: str
    text: str
    tags: list[str] = field(default_factory=list)
    source: str = "manual"  # "manual" | "session" | "skill" | "agent"
    created_at: float = field(default_factory=time.time)
    last_used_at: float = 0.0
    use_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MemoryEntry":
        # Tolerate older entries that don't have all fields
        return cls(
            id=d.get("id") or uuid.uuid4().hex[:12],
            text=d.get("text", ""),
            tags=list(d.get("tags") or []),
            source=d.get("source", "manual"),
            created_at=float(d.get("created_at", time.time())),
            last_used_at=float(d.get("last_used_at", 0.0)),
            use_count=int(d.get("use_count", 0)),
        )

    def tokens(self) -> set[str]:
        """Tokens for search, including tags."""
        toks = set(_tokenize(self.text))
        toks.update(t.lower() for t in self.tags if t)
        return toks


class MemoryStore:
    """Persistent agent-curated memory.

    Stored as JSONL at `<root>/curated.jsonl`. Each write is flushed
    immediately so the store survives crashes.
    """

    FILENAME = "curated.jsonl"

    def __init__(self, root_dir: str | Path | None = None) -> None:
        self.root = Path(root_dir) if root_dir else _default_root()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / self.FILENAME
        self._entries: dict[str, MemoryEntry] = {}
        self._load()

    # ---- IO ----

    def _load(self) -> None:
        if not self.path.is_file():
            return
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    entry = MemoryEntry.from_dict(obj)
                    self._entries[entry.id] = entry
                except (json.JSONDecodeError, KeyError, TypeError):
                    continue

    def persist(self) -> None:
        """Write all entries to disk (JSONL, one per line)."""
        with self.path.open("w", encoding="utf-8") as f:
            for entry in self._entries.values():
                f.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")

    # ---- CRUD ----

    def add(self, text: str, tags: list[str] | None = None, source: str = "manual") -> str:
        """Add a memory entry. If the same text already exists, return its id
        and bump the use count instead of creating a duplicate."""
        text = (text or "").strip()
        if not text:
            raise ValueError("memory text cannot be empty")
        # Dedup: exact text match
        for e in self._entries.values():
            if e.text.strip() == text:
                self.touch(e.id)
                return e.id
        entry = MemoryEntry(
            id=uuid.uuid4().hex[:12],
            text=text,
            tags=[t.strip() for t in (tags or []) if t and t.strip()],
            source=source if source in ("manual", "session", "skill", "agent") else "manual",
        )
        self._entries[entry.id] = entry
        self.persist()
        return entry.id

    def remove(self, memory_id: str | None = None, query: str | None = None) -> int:
        """Remove entries. If memory_id is given, remove that one. Otherwise
        remove all entries that match the query (token overlap >= 0.5). Returns
        the count removed.
        """
        if memory_id:
            if memory_id in self._entries:
                del self._entries[memory_id]
                self.persist()
                return 1
            return 0
        if query:
            matches = self.search(query, top_k=100)
            count = 0
            for m in matches:
                # Only auto-remove if score is high
                if m.get("_score", 0) >= 0.5:
                    if m["id"] in self._entries:
                        del self._entries[m["id"]]
                        count += 1
            if count:
                self.persist()
            return count
        return 0

    def get(self, memory_id: str) -> MemoryEntry | None:
        return self._entries.get(memory_id)

    def all(self) -> list[MemoryEntry]:
        return sorted(self._entries.values(), key=lambda e: e.created_at, reverse=True)

    def touch(self, memory_id: str) -> None:
        """Bump last_used_at and use_count for the given id."""
        e = self._entries.get(memory_id)
        if e is not None:
            e.last_used_at = time.time()
            e.use_count += 1
            self.persist()

    # ---- search ----

    def search(self, query: str, top_k: int = 5) -> list[dict[str, Any]]:
        """Token-overlap ranking. Returns a list of dicts with id, text, tags,
        source, created_at, last_used_at, use_count, plus an internal _score
        (0..1) used for ranking.
        """
        q_tokens = _tokenize(query)
        if not q_tokens:
            return []
        results: list[tuple[float, MemoryEntry]] = []
        for entry in self._entries.values():
            entry_tokens = entry.tokens()
            if not entry_tokens:
                continue
            overlap = len(entry_tokens & set(q_tokens))
            # Score: ratio of query tokens matched, weighted by entry's
            # use_count so frequently-used memories rank higher.
            score = overlap / max(1, len(q_tokens))
            if entry.use_count > 0:
                score += min(0.2, 0.02 * entry.use_count)  # small recency bonus
            if score > 0:
                results.append((score, entry))
        results.sort(key=lambda x: x[0], reverse=True)
        out: list[dict[str, Any]] = []
        for score, entry in results[:top_k]:
            d = entry.to_dict()
            d["_score"] = round(score, 3)
            out.append(d)
        return out

    def for_prompt(self, top_k: int = 3, query: str | None = None) -> str:
        """Render the top-k most relevant memories as a system-prompt block.
        If query is given, ranks by relevance; otherwise returns the most
        recently used/created.
        """
        if not self._entries:
            return ""
        if query:
            hits = self.search(query, top_k=top_k)
        else:
            # Most recently used, then most recent
            sorted_entries = sorted(
                self._entries.values(),
                key=lambda e: (e.last_used_at or e.created_at),
                reverse=True,
            )
            hits = [e.to_dict() for e in sorted_entries[:top_k]]
        if not hits:
            return ""
        lines = ["CURATED MEMORIES (from previous sessions):"]
        for h in hits:
            tags_str = ", ".join(h.get("tags") or [])
            tag_suffix = f"  [tags: {tags_str}]" if tags_str else ""
            text = h["text"]
            if len(text) > 200:
                text = text[:197] + "..."
            lines.append(f"  - {text}{tag_suffix}")
        return "\n".join(lines)

    # ---- stats ----

    def stats(self) -> dict[str, Any]:
        sources: Counter[str] = Counter()
        total_use = 0
        most_recent: float = 0.0
        for e in self._entries.values():
            sources[e.source] += 1
            total_use += e.use_count
            most_recent = max(most_recent, e.created_at)
        return {
            "count": len(self._entries),
            "total_uses": total_use,
            "top_sources": dict(sources.most_common(5)),
            "most_recent_ts": most_recent,
            "path": str(self.path),
        }

    def __len__(self) -> int:
        return len(self._entries)

    def __contains__(self, memory_id: str) -> bool:
        return memory_id in self._entries
