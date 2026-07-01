"""Tool-call deduplication cache for the Cheater agent loop.

Small models often loop on the same broken tool call (e.g. repeatedly
asking for the same file). This module caches results for read-only
tools and short-circuits identical calls within a sliding window.

Only applies to pure read-only tools:
  - read_file
  - list_files
  - search_code
  - search_memory

Never to side-effect tools (edit_file, create_file, run_command).

Public API:
  ToolCallDedup(window=5)
  dedup.check(action, args) -> Optional[ToolResult]
      Returns cached result if this call is a duplicate, else None.
  dedup.store(action, args, result) -> None
      Remember this result for future duplicate detection.
  dedup.reset() -> None
      Clear the cache.

Disable via CHEATER_DEDUP=false.
"""
from __future__ import annotations

import json
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional


# Tools that are safe to dedup. Anything not in this set is never cached.
READ_ONLY_TOOLS: frozenset[str] = frozenset({
    "read_file",
    "list_files",
    "search_code",
    "search_memory",
})


@dataclass
class ToolCallDedup:
    window: int = 5
    _cache: OrderedDict[tuple[str, str], Any] = field(default_factory=OrderedDict)

    def is_read_only(self, action: str) -> bool:
        return action in READ_ONLY_TOOLS

    def _key(self, action: str, args: dict) -> tuple[str, str]:
        try:
            args_str = json.dumps(args or {}, sort_keys=True, default=str)
        except (TypeError, ValueError):
            args_str = str(args)
        return (action, args_str)

    def check(self, action: str, args: dict) -> Optional[Any]:
        """Return cached result if duplicate, else None."""
        if not self.is_read_only(action):
            return None
        key = self._key(action, args)
        if key in self._cache:
            # Move to end (LRU)
            self._cache.move_to_end(key)
            return self._cache[key]
        return None

    def store(self, action: str, args: dict, result: Any) -> None:
        """Cache a result. Only for read-only tools."""
        if not self.is_read_only(action):
            return
        key = self._key(action, args)
        self._cache[key] = result
        # Trim to window
        while len(self._cache) > self.window:
            self._cache.popitem(last=False)

    def reset(self) -> None:
        self._cache.clear()

    def stats(self) -> dict[str, Any]:
        return {
            "cached_calls": len(self._cache),
            "window": self.window,
        }
