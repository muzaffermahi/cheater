"""Nudge system for the Cheater memory layer.

A nudge is a low-priority system message that prompts the agent to think
about memory at the right moments:
  - At session start: "You have N memories. Last session: ... Consider consolidating."
  - When a tool result is large: "This output is large. If anything is worth
    remembering, use memory_remember."

Public API:
  format_session_start_nudge(store) -> str
  format_tool_size_nudge(output_text) -> str
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cheater.memory_store import MemoryStore


# Threshold: only nudge on tool output this large
TOOL_OUTPUT_NUDGE_THRESHOLD = 2000


def format_session_start_nudge(store: "MemoryStore") -> str:
    """Build a nudge to include in the system prompt at session start.

    Asks the agent to consider consolidating memories: writing things that
    worked, removing things that no longer apply, recalling relevant prior
    knowledge.
    """
    count = len(store)
    if count == 0:
        return (
            "NUDGE: No curated memories yet. As you work, use memory_remember to "
            "save anything worth keeping (project conventions, debugging lessons, "
            "user preferences). Memories persist across sessions and shape future prompts."
        )
    most_recent = store.all()[0] if store.all() else None
    recent_text = ""
    if most_recent and most_recent.text:
        t = most_recent.text
        if len(t) > 150:
            t = t[:147] + "..."
        recent_text = f' Most recent memory: "{t}"'
    return (
        f"NUDGE: You have {count} curated memory entries.{recent_text} "
        f"Use memory_recall to find relevant prior knowledge before starting work. "
        f"Use memory_remember to save anything worth keeping. "
        f"Use memory_forget to remove anything that no longer applies."
    )


def format_tool_size_nudge(output_text: str) -> str:
    """Build a nudge to add to a tool result when the output is large.

    The agent is encouraged to extract just the important parts and remember
    them rather than carrying the full output forward in the conversation.
    """
    if not output_text or len(output_text) < TOOL_OUTPUT_NUDGE_THRESHOLD:
        return ""
    return (
        f"NUDGE: This tool output is {len(output_text)} chars. "
        f"If anything here is worth remembering for future sessions, "
        f"extract a 1-sentence summary and call memory_remember with it. "
        f"Do NOT re-include the full output in your response."
    )
