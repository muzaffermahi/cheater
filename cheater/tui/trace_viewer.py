"""Trace browser / replay screen.

The Cheater trace format is one JSON object per line, where each line
has ``ts``, ``event`` (the event type), ``payload``. The full schema
lives in :mod:`cheater.trace_recorder`.

The TUI screen has three columns:

* left: list of recent traces (run_id, time, event count)
* center: chronological event timeline for the selected trace
* right: payload of the currently focused event (Agent Flight Recorder)

Up/down navigate events. Enter on a trace selects it.
"""

from __future__ import annotations

import json
import time
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.screen import Screen
from textual.widgets import Static

from cheater.tui import adapters
from cheater.tui.theme import PALETTE


# Known event types in display order, used to colour the timeline.
EVENT_COLORS: dict[str, str] = {
    "run_start": PALETTE["accent"],
    "task_received": PALETTE["accent"],
    "repo_map_selected": PALETTE["accent"],
    "context_pack_built": PALETTE["accent"],
    "localization_result": PALETTE["accent"],
    "memory_retrieved": PALETTE["muted"],
    "skill_used": PALETTE["muted"],
    "model_prompt": PALETTE["muted"],
    "model_output": PALETTE["muted"],
    "tool_call": PALETTE["running"],
    "command_run": PALETTE["running"],
    "diff_generated": PALETTE["warning"],
    "diff_guard_result": PALETTE["warning"],
    "failure_summary": PALETTE["error"],
    "repair_attempt": PALETTE["running"],
    "run_finished": PALETTE["success"],
    "learned_card_written": PALETTE["success"],
}


def load_trace_events(project_root: str, run_id: str) -> list[dict[str, Any]]:
    return adapters.load_trace(project_root, run_id)


def list_traces(project_root: str) -> list[dict[str, Any]]:
    return adapters.list_traces(project_root)


def summarize_trace(project_root: str, run_id: str) -> dict[str, Any]:
    return adapters.summarize_trace_file(project_root, run_id)


# --- screen ---


class TraceScreen(Screen):
    """Trace browser / replay."""

    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("r", "refresh", "Refresh"),
        Binding("e", "export", "Export"),
        Binding("d", "distill", "Distill"),
        Binding("k", "create_skill", "From trace -> skill"),
        Binding("m", "create_memory", "From trace -> memory"),
        Binding("up", "prev_event", "Prev event", show=False),
        Binding("down", "next_event", "Next event", show=False),
    ]

    DEFAULT_CSS = """
    TraceScreen { layout: vertical; padding: 0 1; }
    TraceScreen .header { color: #61afef; text-style: bold; padding: 1 0 1 0; }
    TraceScreen #body { height: 1fr; }
    TraceScreen #left {
        width: 32;
        min-width: 24;
        border-right: tall #3a3f4b;
        padding: 0 1;
    }
    TraceScreen #center {
        width: 1fr;
        border-right: tall #3a3f4b;
        padding: 0 1;
    }
    TraceScreen #right {
        width: 44;
        min-width: 32;
        padding: 0 1;
    }
    TraceScreen .row { height: 1; }
    TraceScreen .row.active { background: #2a3441; text-style: bold; }
    TraceScreen .event-row { height: 1; }
    TraceScreen .event-row.active { background: #2a3441; text-style: bold; }
    TraceScreen .hint { color: #9ba1ad; padding: 0 0 1 0; }
    """

    def __init__(self, project_root: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.project_root = project_root
        self._traces: list[dict[str, Any]] = []
        self._events: list[dict[str, Any]] = []
        self._selected_trace: str = ""
        self._selected_event: int = 0
        self._row_widgets: list[Static] = []
        self._event_widgets: list[Static] = []

    def compose(self) -> ComposeResult:
        yield Static("Traces", classes="header")
        yield Static(
            "Browse and replay Cheater traces. ↑/↓ events, [E]xport, [D]istill, [K] -> skill, [M] -> memory.",
            classes="hint",
        )
        with Horizontal(id="body"):
            with VerticalScroll(id="left"):
                yield Static("[dim]loading...[/]", id="trace-list")
            with VerticalScroll(id="center"):
                yield Static("[dim]select a trace on the left[/]", id="event-list")
            with VerticalScroll(id="right"):
                yield Static("[dim]event payload[/]", id="event-payload")

    def on_mount(self) -> None:
        self._reload_traces()

    def _reload_traces(self) -> None:
        self._traces = list_traces(self.project_root)
        container = self.query_one("#left", VerticalScroll)
        for w in self._row_widgets:
            w.remove()
        self._row_widgets.clear()
        if not self._traces:
            container.mount(Static("[dim]no traces found[/]"))
            return
        for i, t in enumerate(self._traces):
            run_id = t.get("run_id", "?")
            size = t.get("size", 0)
            n = t.get("event_count", 0)
            mt = t.get("mtime", 0)
            when = time.strftime("%m-%d %H:%M", time.localtime(mt)) if mt else "?"
            label = f"  {run_id[:18]:18s}  {when}  n={n:>3d}  {size}b"
            classes = "row active" if run_id == self._selected_trace else "row"
            w = Static(label, classes=classes, id=f"tr-{i}")
            w.can_focus = True
            self._row_widgets.append(w)
            container.mount(w)

    def _select_trace(self, run_id: str) -> None:
        self._selected_trace = run_id
        self._events = load_trace_events(self.project_root, run_id)
        self._selected_event = 0
        self._highlight_trace()
        self._render_events()
        self._render_payload()

    def _highlight_trace(self) -> None:
        for i, t in enumerate(self._traces):
            classes = "row active" if t.get("run_id") == self._selected_trace else "row"
            wid = self.query_one(f"#tr-{i}", Static)
            wid.set_classes(classes)

    def _render_events(self) -> None:
        c = self.query_one("#center", VerticalScroll)
        for w in list(c.children):
            w.remove()
        self._event_widgets.clear()
        if not self._events:
            c.mount(Static("[dim]no events[/]"))
            return
        for i, ev in enumerate(self._events):
            kind = str(ev.get("event", "?"))
            ts = ev.get("ts", "")
            payload = ev.get("payload") or {}
            label = _summarize_event(kind, payload)
            color = EVENT_COLORS.get(kind, PALETTE["text"])
            text = f"  [{i + 1:>3d}] [{color}]{kind:<22s}[/] [dim]{ts}[/]  {label}"
            classes = "event-row active" if i == self._selected_event else "event-row"
            w = Static(text, classes=classes, id=f"ev-{i}")
            w.can_focus = True
            self._event_widgets.append(w)
            c.mount(w)

    def _render_payload(self) -> None:
        c = self.query_one("#right", VerticalScroll)
        for w in list(c.children):
            w.remove()
        if not self._events:
            c.mount(Static("[dim]no event selected[/]"))
            return
        if not (0 <= self._selected_event < len(self._events)):
            return
        ev = self._events[self._selected_event]
        try:
            text = json.dumps(ev, indent=2, default=str)
        except Exception:
            text = str(ev)
        if len(text) > 8000:
            text = text[:7970] + "...[truncated]"
        c.mount(Static(text))

    # --- input handling ---

    def on_click(self, event: Any) -> None:
        w = event.widget
        if isinstance(w, Static) and w.id:
            if w.id.startswith("tr-"):
                idx = int(w.id[3:])
                if 0 <= idx < len(self._traces):
                    self._select_trace(self._traces[idx]["run_id"])
            elif w.id.startswith("ev-"):
                idx = int(w.id[3:])
                self._selected_event = idx
                self._highlight_event()
                self._render_payload()

    def on_key(self, event: Any) -> None:
        if event.key == "up":
            self.action_prev_event()
            event.stop()
        elif event.key == "down":
            self.action_next_event()
            event.stop()
        elif event.key == "enter":
            # focus the selected trace (if trace list is focused)
            if self._traces and not self._selected_trace:
                self._select_trace(self._traces[0]["run_id"])
            event.stop()

    def _highlight_event(self) -> None:
        for i, w in enumerate(self._event_widgets):
            classes = "event-row active" if i == self._selected_event else "event-row"
            w.set_classes(classes)

    # --- actions ---

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_refresh(self) -> None:
        self._reload_traces()
        if self._selected_trace:
            self._events = load_trace_events(self.project_root, self._selected_trace)
            self._render_events()
            self._render_payload()
        self.notify("refreshed")

    def action_export(self) -> None:
        if not self._selected_trace:
            self.notify("select a trace first", severity="warning")
            return
        from pathlib import Path

        out = (
            Path(self.project_root)
            / ".cheater"
            / "exported_traces"
            / f"{self._selected_trace}.json"
        )
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(
                json.dumps(self._events, indent=2, default=str), encoding="utf-8"
            )
            self.notify(f"exported to {out}")
        except Exception as e:
            self.notify(f"export failed: {e}", severity="error")

    def action_distill(self) -> None:
        if not self._selected_trace:
            self.notify("select a trace first", severity="warning")
            return
        try:
            res = adapters.distill_trace_to_training(
                self.project_root, self._selected_trace
            )
            n = res.get("rows", 0) if isinstance(res, dict) else 0
            self.notify(f"distilled: {n} training rows")
        except Exception as e:
            self.notify(f"distill failed: {e}", severity="error")

    def action_create_skill(self) -> None:
        if not self._selected_trace:
            self.notify("select a trace first", severity="warning")
            return
        try:
            res = adapters.distill_trace_to_skill(
                self.project_root, self._selected_trace
            )
            name = (res or {}).get("name") or (res or {}).get("skill") or "?"
            self.notify(f"skill suggestion: {name}")
        except Exception as e:
            self.notify(f"failed: {e}", severity="error")

    def action_create_memory(self) -> None:
        if not self._selected_trace:
            self.notify("select a trace first", severity="warning")
            return
        try:
            store = adapters.open_memory_store()
            text = f"Trace {self._selected_trace} reviewed at {time.strftime('%Y-%m-%d %H:%M')}"
            mid = adapters.memory_add(store, text, ["trace", "tui"])
            self.notify(f"memory added: {mid}")
        except Exception as e:
            self.notify(f"failed: {e}", severity="error")

    def action_prev_event(self) -> None:
        if not self._events:
            return
        self._selected_event = max(0, self._selected_event - 1)
        self._highlight_event()
        self._render_payload()

    def action_next_event(self) -> None:
        if not self._events:
            return
        self._selected_event = min(len(self._events) - 1, self._selected_event + 1)
        self._highlight_event()
        self._render_payload()


# --- helpers ---


def _summarize_event(kind: str, payload: dict[str, Any]) -> str:
    if not payload:
        return ""
    if kind == "command_run":
        cmd = payload.get("cmd", "")
        rc = payload.get("returncode", "?")
        return f"cmd={cmd!r} rc={rc}"
    if kind == "diff_generated":
        return f"path={payload.get('path', '?')}  lines={payload.get('lines', '?')}"
    if kind == "failure_summary":
        return (
            f"error={payload.get('error_type', '?')}  test={payload.get('test', '?')}"
        )
    if kind == "run_finished":
        return f"success={payload.get('success')}  by={payload.get('finished_by', '?')}"
    if kind == "memory_retrieved":
        ids = payload.get("ids") or []
        return f"ids={','.join(str(x) for x in ids[:5])}"
    if kind == "skill_used":
        return f"skill={payload.get('skill', '?')}"
    if kind == "localization_result":
        files = payload.get("suspected_files") or []
        return f"top={','.join(str(x) for x in files[:3])}"
    if kind == "tool_call":
        name = payload.get("name") or payload.get("action", "?")
        return f"name={name}"
    if kind == "model_prompt":
        return f"tokens_est={payload.get('tokens_est', '?')}"
    if kind == "model_output":
        return f"finish={payload.get('finish', '?')}"
    # default
    items = []
    for k, v in list(payload.items())[:3]:
        sv = str(v)
        if len(sv) > 40:
            sv = sv[:37] + "..."
        items.append(f"{k}={sv}")
    return " ".join(items)
