"""Mutable app state for the Cheater Cockpit.

We keep this as plain Python objects (no Textual imports) so the
package can be imported in tests without a terminal, and so the same
state can be inspected from threads (the agent loop runs in a worker).

The state is intentionally small and additive: every screen reads
what it needs and never mutates the state directly except through
``AppState`` methods, which validate the transition.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from cheater.tui.events import MODES, STATUS_IDLE


@dataclass
class Message:
    """A single transcript entry."""

    role: str  # "user" | "assistant" | "system" | "error"
    text: str
    ts: float = field(default_factory=lambda: time.time())
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolCall:
    """A single tool invocation in the live stream."""

    name: str
    args: dict[str, Any] = field(default_factory=dict)
    started_at: float = field(default_factory=lambda: time.time())
    finished_at: float = 0.0
    success: bool = True
    output: str = ""
    output_truncated: bool = False
    error: str = ""
    id: str = ""


@dataclass
class ProposedDiff:
    """A diff waiting for user review in the diff modal."""

    path: str
    old: str
    new: str
    description: str = ""
    risk_flags: list[str] = field(default_factory=list)
    risk_score: float = 0.0
    id: str = ""


@dataclass
class SessionInfo:
    """Lightweight session metadata shown in the sidebar."""

    id: str
    task: str
    started_at: float
    status: str = STATUS_IDLE


@dataclass
class InspectorState:
    """Right-panel snapshot shown during a run.

    This is the "Agent Flight Recorder" payload. It is rebuilt by the
    event handler in small, reversible steps. We keep a tiny fixed shape
    so the inspector widget can render predictably.
    """

    plan: list[str] = field(default_factory=list)
    tool_policy: list[str] = field(default_factory=list)
    localized_files: list[tuple[str, float]] = field(default_factory=list)
    memories: list[dict[str, Any]] = field(default_factory=list)
    skills: list[dict[str, Any]] = field(default_factory=list)
    files_touched: list[str] = field(default_factory=list)
    test_status: str = "not_run"  # not_run | running | passed | failed
    test_summary: str = ""
    diff_risk: list[str] = field(default_factory=list)
    budget_used: int = 0
    budget_max: int = 0
    trace_path: str = ""
    last_tool: str = ""
    last_failure_class: str = ""
    risk_flags: list[str] = field(default_factory=list)
    current_memory: str = ""
    current_skill: str = ""
    state: str = "idle"


@dataclass
class RepairConfig:
    """Fields for the Repair screen."""

    task: str = ""
    failing_command: str = ""
    traceback: str = ""
    traceback_file: str = ""
    max_rounds: int = 5
    allow_test_edits: bool = False
    allow_dependency_edits: bool = False


class AppState:
    """Top-level state container. Plain Python, no Textual."""

    def __init__(self, project_root: str) -> None:
        self.project_root: str = project_root
        self.mode: str = "chat"
        self.status: str = STATUS_IDLE
        self.transcript: list[Message] = []
        self.tool_calls: list[ToolCall] = []
        self.proposed_diffs: list[ProposedDiff] = []
        self.sessions: list[SessionInfo] = []
        self.inspector = InspectorState()
        self.repair: RepairConfig = RepairConfig()
        self.compact: bool = False
        self.show_inspector: bool = True
        # Memory/skill feedback is stored in-memory; we never write this
        # to disk unless the user explicitly confirms it.
        self.memory_feedback: dict[
            str, str
        ] = {}  # memory_id -> "useful" | "not_useful"
        self.skill_feedback: dict[
            str, str
        ] = {}  # skill_name -> "useful" | "not_useful"
        # Last-seen item per panel, so the user can pick up where they left off.
        self.selected_trace: str = ""
        self.selected_memory: str = ""
        self.selected_skill: str = ""
        # Current run id (if any)
        self.run_id: str = ""
        # Last submitted text by the composer, used to preserve typing
        # when the user toggles panels.
        self.composer_text: str = ""
        # Free-form notice / banner
        self.notice: str = ""
        # Internal counters
        self.event_count: int = 0
        # Recent run summary
        self.last_run_summary: str = ""

    # --- mode ---
    def set_mode(self, mode: str) -> bool:
        if mode not in MODES:
            return False
        self.mode = mode
        return True

    # --- status ---
    def set_status(self, status: str) -> None:
        self.status = status

    def is_busy(self) -> bool:
        return self.status in ("running", "interrupted")

    # --- transcript ---
    def add_user(self, text: str) -> None:
        self.transcript.append(Message(role="user", text=text))

    def add_assistant(self, text: str, meta: dict[str, Any] | None = None) -> None:
        self.transcript.append(Message(role="assistant", text=text, meta=meta or {}))

    def add_system(self, text: str) -> None:
        self.transcript.append(Message(role="system", text=text))

    def add_error(self, text: str) -> None:
        self.transcript.append(Message(role="error", text=text))

    def clear_transcript(self) -> None:
        self.transcript.clear()
        self.tool_calls.clear()
        self.proposed_diffs.clear()
        self.inspector = InspectorState()
        self.event_count = 0

    # --- tools ---
    def begin_tool(self, name: str, args: dict[str, Any], id: str = "") -> ToolCall:
        tc = ToolCall(name=name, args=args, id=id)
        self.tool_calls.append(tc)
        self.inspector.last_tool = name
        self.event_count += 1
        return tc

    def end_tool(
        self,
        tc: ToolCall,
        *,
        success: bool,
        output: str,
        error: str = "",
    ) -> None:
        tc.finished_at = time.time()
        tc.success = success
        tc.output = output or ""
        tc.error = error or ""
        if len(tc.output) > 1500:
            tc.output = tc.output[:1500] + "...[truncated]"
            tc.output_truncated = True

    # --- diffs ---
    def add_proposed_diff(self, diff: ProposedDiff) -> None:
        self.proposed_diffs.append(diff)

    def pop_proposed_diff(self, diff_id: str) -> ProposedDiff | None:
        for i, d in enumerate(self.proposed_diffs):
            if d.id == diff_id:
                return self.proposed_diffs.pop(i)
        return None

    # --- feedback ---
    def mark_memory(self, memory_id: str, label: str) -> None:
        self.memory_feedback[memory_id] = label

    def mark_skill(self, skill_name: str, label: str) -> None:
        self.skill_feedback[skill_name] = label
