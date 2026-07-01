"""App-level events used by the Cheater Cockpit.

The TUI has its own lightweight event vocabulary in addition to the
textual :class:`textual.message.Message` protocol. We define dataclasses
for each event kind the TUI cares about. Adapters convert backend
events (``AgentLoop.LoopEvent`` and ``TraceRecorder`` events) into
:class:`TuiEvent` instances, then the app posts them to the UI thread
via ``app.post_message`` / ``app.call_from_thread``.

Why this exists:

* the backend modules know nothing about textual;
* the TUI doesn't want to import ``agent_loop`` at module top level
  (so the package can still be imported for tests without the agent
  loop modules loaded);
* everything that crosses the worker / UI boundary should be a small,
  picklable dataclass.

This module has zero Textual imports on purpose.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


# --- top-level "modes" shown in the sidebar ---

MODES: tuple[str, ...] = (
    "chat",
    "repair",
    "memory",
    "skills",
    "arena",
    "traces",
    "settings",
)


# --- semantic status of the TUI ---

STATUS_IDLE = "idle"
STATUS_RUNNING = "running"
STATUS_INTERRUPTED = "interrupted"
STATUS_DONE = "done"
STATUS_ERROR = "error"


@dataclass
class TuiEvent:
    """A single semantic event in the TUI.

    ``kind`` is a short string tag (see TUI_KINDS). ``payload`` is a
    free-form dict with kind-specific data. ``ts`` is set automatically
    in microseconds.
    """

    kind: str
    payload: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=lambda: time.time())

    def get(self, key: str, default: Any = None) -> Any:
        return self.payload.get(key, default)


# Allowed kind tags. Custom tags are still allowed but flagged in summaries.
TUI_KINDS: frozenset[str] = frozenset(
    {
        # transcript
        "user_message",
        "assistant_message",
        "system_message",
        "error",
        # run lifecycle
        "run_start",
        "run_finished",
        "run_interrupted",
        # tool stream
        "tool_start",
        "tool_end",
        "command_result",
        "diff_generated",
        "failure_summary",
        # panels
        "localization",
        "memory_hit",
        "skill_hit",
        "test_summary",
        "plan",
        "budget",
        # inspector
        "tool_policy",
        "risk_flag",
    }
)


def make_event(kind: str, **payload: Any) -> TuiEvent:
    """Convenience: build a TuiEvent with keyword payload."""
    return TuiEvent(kind=kind, payload=dict(payload))
