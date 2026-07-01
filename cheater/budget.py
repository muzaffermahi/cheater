"""Context budget engine for the Cheater agent loop.

Small models (8B-16k context) can't fit everything. This module tracks
per-source usage, evicts oldest tool results when over budget, and
compresses evicted results into a one-line summary.

Public API:
  ContextBudget(max_chars=20000, tool_cap=4000)
  budget.allocate(source, text)            -- record usage
  budget.evict(needed_chars)               -- free space, return evicted items
  budget.usage_summary() -> str            -- "X/Y chars (N%)"
  budget.estimate_tokens(text) -> int      -- rough token estimate

Source labels (used for diagnostics):
  "system"     -- the system prompt
  "plan"       -- the plan block
  "memory"     -- the working memory
  "tool"       -- a tool result
  "response"   -- the model's response
"""
from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Iterable


# Rough token estimate: ~4 chars per token for English/code.
CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    """Rough token estimate. Not exact, but good enough for budget tracking."""
    if not text:
        return 0
    return (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


@dataclass
class BudgetItem:
    """One item in the context budget. Has a source label so we can evict selectively."""
    source: str
    text: str
    chars: int = 0
    summary: str = ""  # one-line compression if evicted

    def __post_init__(self) -> None:
        if self.chars == 0:
            self.chars = len(self.text)


class ContextBudget:
    """Tracks context usage and evicts oldest items when over budget."""

    def __init__(
        self,
        max_chars: int = 20000,
        tool_cap: int = 4000,
        eviction_policy: str = "fifo",
    ) -> None:
        self.max_chars = max(100, max_chars)
        self.tool_cap = max(50, tool_cap)
        self.eviction_policy = eviction_policy
        self._items: deque[BudgetItem] = deque()
        self._total_chars: int = 0
        self._evicted: list[BudgetItem] = []
        self._compressed_summaries: list[str] = []

    def __len__(self) -> int:
        return len(self._items)

    # ---- usage ----

    @property
    def total_chars(self) -> int:
        return self._total_chars

    @property
    def usage_pct(self) -> float:
        return min(100.0, 100.0 * self._total_chars / self.max_chars)

    def usage_summary(self) -> str:
        return f"{self._total_chars}/{self.max_chars} chars ({self.usage_pct:.0f}%)"

    # ---- allocate / evict ----

    def allocate(self, source: str, text: str) -> BudgetItem:
        """Add an item to the budget. If over budget, evict oldest items first."""
        # Truncate single tool result if too large
        if source == "tool" and len(text) > self.tool_cap:
            text = text[:self.tool_cap] + f"\n... [truncated, {len(text) - self.tool_cap} more chars]"
        item = BudgetItem(source=source, text=text, chars=len(text))
        # If just adding this item overflows the budget, evict until it fits
        # or nothing evictable remains.
        while self._items and self._total_chars + item.chars > self.max_chars:
            if self._evict_oldest() is None:
                break
        # If still doesn't fit, truncate the item to fit (or skip if too small)
        if self._total_chars + item.chars > self.max_chars:
            available = max(0, self.max_chars - self._total_chars)
            if available < 50:
                # Not enough room; compress to one line and skip
                item.summary = self._one_line_summary(item.text)
                self._compressed_summaries.append(item.summary)
                return item
            # Truncate to fit, leaving room for the suffix
            suffix = f"\n... [truncated to fit budget]"
            keep = max(0, available - len(suffix))
            item.text = item.text[:keep] + suffix
            item.chars = len(item.text)
        # If we managed to truncate to fit, add it. Otherwise, just add the
        # summary (already recorded above).
        if self._total_chars + item.chars <= self.max_chars:
            self._items.append(item)
            self._total_chars += item.chars
        return item

    def _evict_oldest(self) -> BudgetItem | None:
        if not self._items:
            return None
        # Find the oldest tool result (don't evict system/plan/memory)
        idx = self._find_evictable_index()
        if idx is None:
            return None
        item = self._items[idx]
        # Compress to one line
        if not item.summary:
            item.summary = self._one_line_summary(item.text)
        # Remove from the live list
        del self._items[idx]
        self._total_chars -= item.chars
        self._evicted.append(item)
        self._compressed_summaries.append(item.summary)
        return item

    def _find_evictable_index(self) -> int | None:
        """Find the oldest tool result to evict. Skip system/plan/memory."""
        for i, item in enumerate(self._items):
            if item.source == "tool" or item.source == "response":
                return i
        return None

    def _one_line_summary(self, text: str) -> str:
        """Compress a piece of text to a one-line summary."""
        if not text:
            return "(empty)"
        # First non-empty line, truncated
        for line in text.splitlines():
            line = line.strip()
            if line and not line.startswith(("#", "//", "---", "===")):
                summary = line[:120].rstrip()
                if len(line) > 120:
                    summary += "..."
                return f"[evicted] {summary}"
        return f"[evicted] ({len(text)} chars)"

    # ---- diagnostics ----

    def evicted_summaries(self) -> list[str]:
        """Return one-line summaries of evicted items, in order."""
        return list(self._compressed_summaries)

    def sources(self) -> dict[str, int]:
        """Return chars used per source label."""
        out: dict[str, int] = {}
        for item in self._items:
            out[item.source] = out.get(item.source, 0) + item.chars
        return out

    def reset(self) -> None:
        self._items.clear()
        self._total_chars = 0
        self._evicted.clear()
        self._compressed_summaries.clear()

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_chars": self.max_chars,
            "tool_cap": self.tool_cap,
            "total_chars": self._total_chars,
            "usage_pct": round(self.usage_pct, 1),
            "sources": self.sources(),
            "evicted_count": len(self._evicted),
        }
