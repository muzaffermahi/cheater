"""Reusable Textual widgets for the Cheater Cockpit.

This module contains small building blocks used by multiple screens:

* :class:`Sidebar` -- the left mode list
* :class:`InspectorPanel` -- the right "Agent Flight Recorder" panel
* :class:`EventCard` -- a single transcript card
* :class:`KVRow` -- a label/value row used in the inspector
* :class:`EmptyState` -- a styled "nothing here yet" message
* :class:`Pill` -- a tiny colored chip

These widgets are intentionally dumb: they render whatever they are
given and emit Textual messages when the user interacts. No business
logic lives here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from textual.containers import Container, VerticalScroll
from textual.message import Message
from textual.widgets import Static

from cheater.tui.state import InspectorState
from cheater.tui.theme import PALETTE


# --- Sidebar ---


@dataclass
class SidebarItem:
    id: str
    label: str
    badge: str = ""
    active: bool = False


class Sidebar(Container):
    """Left-side mode selector. Emits ``ItemSelected`` on click/enter."""

    DEFAULT_CSS = """
    Sidebar { height: auto; layout: vertical; }
    Sidebar .section { color: #61afef; text-style: bold; padding: 1 0 0 0; }
    Sidebar .row { height: 1; padding: 0 1; }
    Sidebar .row.active { background: #2a3441; color: #d4d4d4; text-style: bold; }
    Sidebar .row:hover { background: #2a2f37; }
    Sidebar .badge { color: #9ba1ad; }
    """

    class ItemSelected(Message):
        def __init__(self, item_id: str) -> None:
            super().__init__()
            self.item_id = item_id

    def __init__(self, items: Iterable[SidebarItem] = (), **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._items: list[SidebarItem] = list(items)
        self._row_widgets: list[Static] = []
        self._row_item_ids: dict[int, str] = {}

    def set_items(self, items: Iterable[SidebarItem]) -> None:
        self._items = list(items)
        self.rebuild()

    def set_active(self, item_id: str) -> None:
        for it in self._items:
            it.active = it.id == item_id
        self.rebuild()

    def rebuild(self) -> None:
        # Remove old rows
        for w in self._row_widgets:
            w.remove()
        self._row_widgets.clear()
        self._row_item_ids.clear()
        # Add new rows
        for it in self._items:
            label = f"  {it.label}"
            text = label + (f"  [dim]{it.badge}[/]" if it.badge else "")
            classes = "row active" if it.active else "row"
            # Avoid DOM ids here. Textual removes widgets asynchronously, so
            # rebuilding with the same ids can race and trigger DuplicateIds.
            w = Static(text, classes=classes)
            w.can_focus = True
            self._row_widgets.append(w)
            self._row_item_ids[id(w)] = it.id
            self.mount(w)

    def on_mount(self) -> None:
        self.rebuild()

    def on_click(self, event: Any) -> None:
        w = event.widget
        if isinstance(w, Static):
            item_id = self._row_item_ids.get(id(w))
            if item_id:
                self.post_message(self.ItemSelected(item_id))

    def on_key(self, event: Any) -> None:
        if event.key == "enter":
            for it in self._items:
                if it.active:
                    self.post_message(self.ItemSelected(it.id))
                    event.stop()
                    return


# --- Inspector ---


class KVRow(Static):
    """Two-column key/value row."""

    def __init__(self, key: str, value: str = "", **kwargs: Any) -> None:
        text = f"[dim]{key}[/]  {value}" if value else f"[dim]{key}[/]  [dim]-[/]"
        super().__init__(text, **kwargs)
        self._key = key
        self._value = value

    def update_value(self, value: str) -> None:
        self._value = value
        if value:
            self.update(f"[dim]{self._key}[/]  {value}")
        else:
            self.update(f"[dim]{self._key}[/]  [dim]-[/]")


class InspectorPanel(VerticalScroll):
    """Right-side 'Flight Recorder' panel.

    Renders the current :class:`InspectorState`. Designed to be called
    once per state change rather than re-rendered on every keystroke.
    """

    DEFAULT_CSS = """
    InspectorPanel { padding: 0 1; height: auto; }
    InspectorPanel .section { color: #61afef; text-style: bold; padding: 1 0 0 0; }
    InspectorPanel .k { color: #9ba1ad; }
    InspectorPanel .pill { padding: 0 1; }
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._rows: dict[str, KVRow] = {}
        self._sections: list[Static] = []

    def render_state(self, state: InspectorState) -> None:
        """Re-render the inspector from a fresh state snapshot."""
        # Remove all children to keep the layout simple. The inspector is
        # short; full re-render is fine.
        for child in list(self.children):
            child.remove()
        self._rows.clear()
        self._sections.clear()

        def section(title: str) -> None:
            self._sections.append(Static(title, classes="section"))
            self.mount(self._sections[-1])

        def kv(key: str, value: str) -> None:
            row = KVRow(key, value)
            self._rows[key] = row
            self.mount(row)

        # --- Current state ---
        section("flight recorder")
        kv("state", _state_label(state.state))
        kv("last tool", state.last_tool or "-")
        kv("test", state.test_status or "not_run")
        kv(
            "budget",
            f"{state.budget_used:,} / {state.budget_max:,}"
            if state.budget_max
            else "-",
        )
        kv("trace", _short_path(state.trace_path))

        # --- Plan ---
        if state.plan:
            section("plan")
            for i, step in enumerate(state.plan[:8], start=1):
                self.mount(Static(f"  {i}. {step}"))

        # --- Tool policy ---
        if state.tool_policy:
            section("tool policy")
            for t in state.tool_policy[:6]:
                self.mount(Static(f"  {t}"))

        # --- Localized files ---
        if state.localized_files:
            section("suspected files")
            for path, score in state.localized_files[:8]:
                self.mount(Static(f"  {path}  [dim]({score:.2f})[/]"))

        # --- Memories ---
        if state.memories:
            section("memories")
            for m in state.memories[:5]:
                mid = m.get("id", "?")
                text = (m.get("text") or "")[:80]
                self.mount(Static(f"  [{mid}] {text}"))

        # --- Skills ---
        if state.skills:
            section("skills")
            for s in state.skills[:5]:
                name = s.get("name", "?")
                trigger = s.get("trigger", "")
                self.mount(
                    Static(f"  {name}" + (f"  [dim]({trigger})[/]" if trigger else ""))
                )

        # --- Files touched ---
        if state.files_touched:
            section("files touched")
            for f in state.files_touched[:10]:
                self.mount(Static(f"  {f}"))

        # --- Failure class / risk ---
        if state.last_failure_class or state.risk_flags:
            section("risk")
            if state.last_failure_class:
                self.mount(Static(f"  [red]{state.last_failure_class}[/]"))
            for rf in state.risk_flags[:6]:
                self.mount(Static(f"  [yellow]![/] {rf}"))

        # --- Test summary ---
        if state.test_summary:
            section("test summary")
            self.mount(Static(_clip(state.test_summary, 400)))


# --- Event card (transcript entry) ---


class EventCard(Static):
    """A single transcript entry: user / assistant / system / error.

    The card has a header and an optional body. We don't use a fancy
    collapsible here; the entire card simply shows the role, time,
    and message. Tool cards live in their own panel
    (:mod:`cheater.tui.tool_stream`).
    """

    DEFAULT_CSS = """
    EventCard { height: auto; padding: 0 1; margin: 0 0 1 0; }
    EventCard.role-user { border-left: thick #61afef; background: #1f242c; }
    EventCard.role-assistant { border-left: thick #c678dd; background: #1a1d23; }
    EventCard.role-system { color: #9ba1ad; }
    EventCard.role-error { border-left: thick #e06c75; color: #e06c75; background: #2a1f1f; }
    EventCard .role { color: #61afef; text-style: bold; }
    EventCard .time { color: #9ba1ad; }
    EventCard .body { padding: 0 0 1 0; }
    """

    def __init__(
        self, role: str, text: str, meta: dict[str, Any] | None = None, **kwargs: Any
    ) -> None:
        classes = (
            f"role-{role}" if role in ("user", "assistant", "system", "error") else ""
        )
        # Build the initial markup; Static will wrap it in a Content on
        # the first render. We do NOT call self.update() here because
        # doing so before mount breaks the layout pass.
        head = f"[{PALETTE['accent']}]{role.upper()}[/]  [dim]{_short_time()}[/]"
        body = _clip(text or "", 4000)
        body_indented = "\n".join("  " + line for line in body.splitlines() or [""])
        super().__init__(f"{head}\n{body_indented}", classes=classes, **kwargs)
        self.role = role
        self.text = text
        self.meta = meta or {}

    def update_text(self, text: str) -> None:
        """Update the body text while keeping the role header."""
        self.text = text
        body = _clip(text or "", 4000)
        body_indented = "\n".join("  " + line for line in body.splitlines() or [""])
        head = f"[{PALETTE['accent']}]{self.role.upper()}[/]  [dim]{_short_time()}[/]"
        self.update(f"{head}\n{body_indented}")


# --- Empty state ---


class EmptyState(Static):
    def __init__(self, text: str, **kwargs: Any) -> None:
        super().__init__(text, classes="empty", **kwargs)


# --- helpers ---


def _clip(s: str, n: int) -> str:
    if not s:
        return ""
    if len(s) <= n:
        return s
    return s[: max(0, n - 30)] + "...[truncated]"


def _short_time() -> str:
    import time

    return time.strftime("%H:%M:%S")


def _short_path(p: str) -> str:
    if not p:
        return "-"
    parts = p.replace("\\", "/").split("/")
    if len(parts) <= 3:
        return p
    return ".../" + "/".join(parts[-3:])


def _state_label(state: str) -> str:
    return {
        "idle": "idle",
        "running": "[purple]running[/]",
        "interrupted": "[yellow]interrupted[/]",
        "done": "[green]done[/]",
        "error": "[red]error[/]",
    }.get(state, state or "-")
