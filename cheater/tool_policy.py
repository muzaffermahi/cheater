"""Cheater tool policy: state-based tool recommendations for 9B models.

A 9B model that has to choose from 25 tools is overwhelmed. The tool policy
sits between the agent loop and the model's prompt: it classifies the
current "state" (bug_fix, after_failed_patch, patch_ready, ...) and emits
a small ToolPolicyRecommendation (allowed / preferred / forbidden tools,
plus a max_tool_calls_before_reflection hint).

This module is pure-Python, dependency-free, and small. It does not call
the model.

Public API:
    ToolState                  -- enum-like string constants
    ToolPolicyRecommendation   -- dataclass
    infer_state(task, last_event, failure_summary) -> str
    recommend_tools(state, available_tools) -> ToolPolicyRecommendation
    render_tool_policy_nudge(rec) -> str

The recommendation never includes more than 6 preferred tools and 8
allowed tools. The forbidden list is at most 4. This is intentional:
the model is better at choosing from a tiny list than from the union
of all Cheater tools.

CLI:
    cheater tool-policy "<task>"
    cheater tool-policy --from-trace <run_id>
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable


# ---- state ----


class ToolState:
    NEW_TASK = "new_task"
    BUG_FIX = "bug_fix"
    TEST_FAILURE = "test_failure"
    IMPORT_ERROR = "import_error"
    SYNTAX_ERROR = "syntax_error"
    LOCALIZATION_UNCERTAIN = "localization_uncertain"
    PATCH_READY = "patch_ready"
    AFTER_FAILED_PATCH = "after_failed_patch"
    AFTER_SUCCESS = "after_success"

    ALL: tuple[str, ...] = (
        NEW_TASK,
        BUG_FIX,
        TEST_FAILURE,
        IMPORT_ERROR,
        SYNTAX_ERROR,
        LOCALIZATION_UNCERTAIN,
        PATCH_READY,
        AFTER_FAILED_PATCH,
        AFTER_SUCCESS,
    )


# Regexes for state inference. Cheap, no model required.
_IMPORT_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:ModuleNotFoundError|ImportError)\b|"
    r"no module named\b|cannot import name\b",
)
_SYNTAX_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:SyntaxError|IndentationError|TabError)\b|"
    r"invalid syntax\b|unexpected eof\b",
)
_TEST_FAIL_RE = re.compile(
    r"(?im)\bFAILED\s+\S+|\b\d+\s+failed\b|^=+\s*FAILURES\s*=+",
)
_BUG_HINTS = (
    "fix",
    "bug",
    "failing",
    "broken",
    "error",
    "wrong",
    "regress",
    "doesn't work",
    "does not work",
    "traceback",
)


# ---- recommendation ----


@dataclass
class ToolPolicyRecommendation:
    state: str
    allowed_tools: list[str] = field(default_factory=list)
    preferred_next_tools: list[str] = field(default_factory=list)
    forbidden_tools: list[str] = field(default_factory=list)
    reason: str = ""
    max_tool_calls_before_reflection: int = 6

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "allowed_tools": list(self.allowed_tools),
            "preferred_next_tools": list(self.preferred_next_tools),
            "forbidden_tools": list(self.forbidden_tools),
            "reason": self.reason,
            "max_tool_calls_before_reflection": self.max_tool_calls_before_reflection,
        }


# ---- state inference ----


def infer_state(
    task: str = "",
    last_event: dict[str, Any] | None = None,
    failure_summary: dict[str, Any] | None = None,
) -> str:
    """Heuristically determine the current state.

    Args:
        task: the user task text.
        last_event: the most recent trace event (dict) or None.
        failure_summary: a failure_compressor-style summary dict, or None.
    """
    # 1. Hard evidence from failure_summary
    if failure_summary:
        if failure_summary.get("is_syntax_error"):
            return ToolState.SYNTAX_ERROR
        if failure_summary.get("is_import_error"):
            return ToolState.IMPORT_ERROR
        if failure_summary.get("is_test_failure"):
            return ToolState.TEST_FAILURE
        et = str(failure_summary.get("error_type") or "")
        if et:
            et_l = et.lower()
            if "syntax" in et_l or "indent" in et_l or "tab" in et_l:
                return ToolState.SYNTAX_ERROR
            if "import" in et_l or "modulenotfound" in et_l.replace(" ", ""):
                return ToolState.IMPORT_ERROR
            return ToolState.TEST_FAILURE
        if failure_summary.get("passed") is False:
            return ToolState.TEST_FAILURE
    # 2. Traceback text in last_event (failure_summary event, command_run, etc.)
    if last_event:
        ev_type = str(last_event.get("event", ""))
        payload = (
            last_event.get("payload")
            if isinstance(last_event.get("payload"), dict)
            else {}
        )
        if ev_type == "failure_summary":
            return _state_from_failure_payload(payload)
        if ev_type in ("command_run", "diff_guard_result"):
            cmd = str(payload.get("cmd") or payload.get("command") or "")
            stderr = str(payload.get("stderr") or "")
            stdout = str(payload.get("stdout") or "")
            blob = "\n".join([cmd, stderr, stdout])
            if _SYNTAX_RE.search(blob):
                return ToolState.SYNTAX_ERROR
            if _IMPORT_RE.search(blob):
                return ToolState.IMPORT_ERROR
            if _TEST_FAIL_RE.search(blob):
                return ToolState.TEST_FAILURE
        if ev_type == "repair_attempt":
            if not payload.get("success", True):
                return ToolState.AFTER_FAILED_PATCH
            if payload.get("success"):
                return ToolState.AFTER_SUCCESS
        if ev_type == "diff_generated":
            return ToolState.PATCH_READY
    # 3. Task text heuristics
    text = (task or "").lower()
    if text:
        if _SYNTAX_RE.search(text):
            return ToolState.SYNTAX_ERROR
        if _IMPORT_RE.search(text):
            return ToolState.IMPORT_ERROR
        if _TEST_FAIL_RE.search(text):
            return ToolState.TEST_FAILURE
        if any(h in text for h in _BUG_HINTS):
            return ToolState.BUG_FIX
    return ToolState.NEW_TASK


def _state_from_failure_payload(p: dict[str, Any]) -> str:
    if p.get("is_syntax_error"):
        return ToolState.SYNTAX_ERROR
    if p.get("is_import_error"):
        return ToolState.IMPORT_ERROR
    if p.get("is_test_failure"):
        return ToolState.TEST_FAILURE
    et = str(p.get("error_type") or "")
    if "Syntax" in et or "Indentation" in et or "TabError" in et:
        return ToolState.SYNTAX_ERROR
    if "Import" in et or "ModuleNotFound" in et:
        return ToolState.IMPORT_ERROR
    if et:
        return ToolState.TEST_FAILURE
    return ToolState.BUG_FIX


# ---- recommendation per state ----

# Per-state policy. Each entry is:
#   preferred:   what the model should consider first (max 6)
#   allowed:     the broader set it may use (max 8)
#   forbidden:   things to avoid in this state (max 4)
#   max_calls:   how many tool calls before the loop should ask for reflection
#   reason:      one-line explanation
#
# Tool names match cheater.tools default registry. Generic placeholders
# (e.g. "test_summary", "diff_guard", "apply_patch") are kept when not in
# the registry so the recommendation is still useful, but the renderer
# will only show them if available.

_POLICIES: dict[str, dict[str, Any]] = {
    ToolState.NEW_TASK: {
        "preferred": [
            "list_files",
            "search_code",
            "memory_recall",
            "read_context_pack",
        ],
        "allowed": [
            "list_files",
            "search_code",
            "memory_recall",
            "read_context_pack",
            "read_file",
            "ask_user",
            "finish",
            "i_dont_know",
        ],
        "forbidden": ["edit_file", "create_file", "run_command"],
        "max_calls": 4,
        "reason": "new task: explore first, do not edit yet",
    },
    ToolState.BUG_FIX: {
        "preferred": [
            "localize_bug",
            "read_context_pack",
            "memory_recall",
            "read_file",
        ],
        "allowed": [
            "localize_bug",
            "read_context_pack",
            "memory_recall",
            "read_file",
            "search_code",
            "list_files",
            "run_focused_tests",
            "edit_file",
            "run_command",
            "finish",
            "i_dont_know",
        ],
        "forbidden": ["create_file"],
        "max_calls": 6,
        "reason": "bug fix: localize and gather context before patching",
    },
    ToolState.TEST_FAILURE: {
        "preferred": [
            "run_focused_tests",
            "localize_bug",
            "read_file",
            "memory_recall",
        ],
        "allowed": [
            "run_focused_tests",
            "localize_bug",
            "read_file",
            "memory_recall",
            "search_code",
            "list_files",
            "edit_file",
            "run_command",
            "finish",
            "i_dont_know",
        ],
        "forbidden": ["create_file"],
        "max_calls": 6,
        "reason": "test failure: compress the failure, locate, then patch",
    },
    ToolState.IMPORT_ERROR: {
        "preferred": [
            "run_focused_tests",
            "localize_bug",
            "read_file",
            "memory_recall",
        ],
        "allowed": [
            "run_focused_tests",
            "localize_bug",
            "read_file",
            "memory_recall",
            "search_code",
            "list_files",
            "edit_file",
            "run_command",
            "finish",
            "i_dont_know",
        ],
        "forbidden": ["create_file"],
        "max_calls": 4,
        "reason": "import error: usually a missing symbol or install; inspect then edit",
    },
    ToolState.SYNTAX_ERROR: {
        "preferred": ["read_file", "localize_bug", "run_focused_tests"],
        "allowed": [
            "read_file",
            "localize_bug",
            "run_focused_tests",
            "search_code",
            "edit_file",
            "run_command",
            "finish",
            "i_dont_know",
        ],
        "forbidden": ["create_file"],
        "max_calls": 4,
        "reason": "syntax error: read the file and fix the line",
    },
    ToolState.LOCALIZATION_UNCERTAIN: {
        "preferred": ["search_code", "list_files", "read_file", "memory_recall"],
        "allowed": [
            "search_code",
            "list_files",
            "read_file",
            "memory_recall",
            "read_context_pack",
            "localize_bug",
            "finish",
            "i_dont_know",
        ],
        "forbidden": ["edit_file", "create_file"],
        "max_calls": 4,
        "reason": "uncertain where the bug is: search and read, do not edit",
    },
    ToolState.PATCH_READY: {
        "preferred": ["run_focused_tests", "run_command", "read_file"],
        "allowed": [
            "run_focused_tests",
            "run_command",
            "read_file",
            "edit_file",
            "create_file",
            "finish",
            "i_dont_know",
        ],
        "forbidden": [],
        "max_calls": 4,
        "reason": "patch ready: run focused tests, then finish",
    },
    ToolState.AFTER_FAILED_PATCH: {
        "preferred": [
            "run_focused_tests",
            "read_file",
            "localize_bug",
            "memory_recall",
        ],
        "allowed": [
            "run_focused_tests",
            "read_file",
            "localize_bug",
            "memory_recall",
            "search_code",
            "list_files",
            "read_context_pack",
            "edit_file",
            "run_command",
            "finish",
            "i_dont_know",
        ],
        "forbidden": ["create_file"],
        "max_calls": 5,
        "reason": "after a failed patch: re-read failure summary before editing again",
    },
    ToolState.AFTER_SUCCESS: {
        "preferred": ["run_focused_tests", "finish"],
        "allowed": ["run_focused_tests", "finish", "memory_recall", "read_file"],
        "forbidden": ["edit_file", "create_file"],
        "max_calls": 3,
        "reason": "after a successful fix: confirm with tests, then finish",
    },
}


def recommend_tools(
    state: str,
    available_tools: Iterable[str] | None = None,
) -> ToolPolicyRecommendation:
    """Return a recommendation for the given state.

    `available_tools` filters the policy lists down to what the agent
    registry actually exposes. Tools that aren't available are dropped.
    """
    policy = _POLICIES.get(state) or _POLICIES[ToolState.NEW_TASK]
    available = set(available_tools or [])

    def _keep(items: list[str]) -> list[str]:
        if not available:
            return list(items)
        return [t for t in items if t in available]

    rec = ToolPolicyRecommendation(
        state=state,
        allowed_tools=_keep(policy["allowed"])[:8],
        preferred_next_tools=_keep(policy["preferred"])[:6],
        forbidden_tools=_keep(policy["forbidden"])[:4],
        reason=str(policy["reason"]),
        max_tool_calls_before_reflection=int(policy["max_calls"]),
    )
    return rec


# ---- nudge renderer ----


def render_tool_policy_nudge(rec: ToolPolicyRecommendation) -> str:
    """Return a short text block to inject into the model prompt."""
    parts: list[str] = [f"[TOOL-POLICY] state={rec.state}"]
    if rec.preferred_next_tools:
        parts.append("  preferred: " + ", ".join(rec.preferred_next_tools))
    if rec.forbidden_tools:
        parts.append("  avoid:     " + ", ".join(rec.forbidden_tools))
    parts.append(f"  reason:    {rec.reason}")
    parts.append(
        f"  hint:      after {rec.max_tool_calls_before_reflection} tool calls "
        "without progress, re-read the failure or use i_dont_know"
    )
    return "\n".join(parts)
