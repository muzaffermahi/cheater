"""Quality monitor for the Cheater agent loop.

Catches four structural failure modes that small models (8B-35B) hit often:

  1. Empty turn (model returned empty)
  2. Blank tool name (action = "")
  3. Hallucinated tool name (action not in registry; suggests closest match)
  4. Exact-repeat tool call across turns (loops on the same broken call)

On a hit, the monitor injects a [QUALITY-MONITOR] steer into the next
prompt. Capped at 2 consecutive corrections to prevent spirals.

Public API:
  QualityMonitor()                     -- the monitor
  monitor.check(action_obj, registry) -> Optional[str]
      Returns the steer text to inject, or None if no problem.
  monitor.record(action_obj)            -- remember this call for repeat detection
  monitor.reset()                       -- call between sessions

Disable via CHEATER_QUALITY_MONITOR=false.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from difflib import get_close_matches
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from cheater.tools import ToolRegistry


MAX_CONSECUTIVE_CORRECTIONS = 2
REPEAT_WINDOW = 5  # last N turns


@dataclass
class QualityMonitor:
    consecutive_corrections: int = 0
    recent_calls: deque[tuple[str, str]] = field(default_factory=lambda: deque(maxlen=REPEAT_WINDOW))

    def reset(self) -> None:
        self.consecutive_corrections = 0
        self.recent_calls.clear()

    def check(self, action_obj: Any, registry: "ToolRegistry") -> str | None:
        """Return a steer string if a problem is detected, else None."""
        if self.consecutive_corrections >= MAX_CONSECUTIVE_CORRECTIONS:
            return None  # stop the spiral
        # Empty turn
        if action_obj is None or action_obj == {} or action_obj == "":
            self.consecutive_corrections += 1
            return "[QUALITY-MONITOR] Your previous turn was empty. Please output a single JSON object describing the next action."
        if not isinstance(action_obj, dict):
            self.consecutive_corrections += 1
            return f"[QUALITY-MONITOR] Expected a JSON object but got {type(action_obj).__name__}. Please output a single JSON object."
        # Blank tool name
        name = action_obj.get("action", "")
        if not name or not isinstance(name, str):
            self.consecutive_corrections += 1
            return "[QUALITY-MONITOR] Missing 'action' field. Please output {\"action\": \"tool_name\", \"args\": {...}}."
        # Hallucinated tool name
        valid_names = registry.names()
        if name not in valid_names:
            suggestion = ""
            close = get_close_matches(name, valid_names, n=1, cutoff=0.5)
            if close:
                suggestion = f" Did you mean '{close[0]}'?"
            self.consecutive_corrections += 1
            return f"[QUALITY-MONITOR] Unknown tool: '{name}'. Valid tools: {', '.join(valid_names)}.{suggestion}"
        # Exact-repeat tool call (same action + same args key, last 5 turns)
        import json
        try:
            sig = (name, json.dumps(action_obj.get("args", {}), sort_keys=True, default=str))
        except (TypeError, ValueError):
            sig = (name, str(action_obj.get("args", {})))
        if sig in self.recent_calls:
            self.consecutive_corrections += 1
            return (
                f"[QUALITY-MONITOR] You just called {name} with the same args. "
                f"This often means you're stuck. Try a different action, or use "
                f"i_dont_know with a reason if the task cannot be completed."
            )
        return None

    def record(self, action_obj: Any) -> None:
        """Remember this call for repeat detection."""
        if not isinstance(action_obj, dict):
            return
        name = action_obj.get("action", "")
        if not name:
            return
        import json
        try:
            args_str = json.dumps(action_obj.get("args", {}), sort_keys=True, default=str)
        except (TypeError, ValueError):
            args_str = str(action_obj.get("args", {}))
        self.recent_calls.append((name, args_str))

    def on_success(self) -> None:
        """Call when a turn produced a valid action. Resets the correction counter."""
        self.consecutive_corrections = 0
