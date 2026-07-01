"""Memory browser screen for the Cheater Cockpit.

The curated memory store lives at
``~/.config/cheater/memory/curated.jsonl`` (or wherever the user
configured it). The TUI screen:

* lists all memories
* searches by free text
* filters by tag, source, or "useful" status
* shows use_count, success/failure counters
* lets the user mark a memory useful / not useful
* lets the user delete a memory (with confirmation)
"""

from __future__ import annotations

import time
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, VerticalScroll
from textual.screen import Screen
from textual.widgets import Input, Static

from cheater.tui import adapters


def list_memories(memory_dir: str | None = None) -> list[dict[str, Any]]:
    store = adapters.open_memory_store(memory_dir)
    return adapters.memory_list(store)


def search_memories(q: str, memory_dir: str | None = None) -> list[dict[str, Any]]:
    if not q.strip():
        return list_memories(memory_dir)
    store = adapters.open_memory_store(memory_dir)
    return adapters.memory_search(store, q, top_k=50)


def add_memory(text: str, tags: list[str], memory_dir: str | None = None) -> str:
    store = adapters.open_memory_store(memory_dir)
    return adapters.memory_add(store, text, tags)


def forget_memory(memory_id: str, memory_dir: str | None = None) -> int:
    store = adapters.open_memory_store(memory_dir)
    return adapters.memory_forget(store, memory_id, None)


def redact_memory(m: dict[str, Any]) -> dict[str, Any]:
    """Defensive redaction before showing in the TUI."""
    return adapters.redact(m)


class MemoryScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("a", "add", "Add"),
        Binding("d", "delete", "Delete"),
        Binding("u", "useful", "Useful"),
        Binding("x", "not_useful", "Not useful"),
        Binding("r", "refresh", "Refresh"),
        Binding("j", "next", "Next", show=False),
        Binding("k", "prev", "Prev", show=False),
    ]

    DEFAULT_CSS = """
    MemoryScreen { layout: vertical; padding: 0 1; }
    MemoryScreen .header { color: #61afef; text-style: bold; padding: 1 0 1 0; }
    MemoryScreen .toolbar { height: 3; padding: 0 0 1 0; }
    MemoryScreen .toolbar Input { width: 1fr; }
    MemoryScreen #body { height: 1fr; }
    MemoryScreen #left {
        width: 50%;
        border-right: tall #3a3f4b;
        padding: 0 1;
    }
    MemoryScreen #right {
        width: 1fr;
        padding: 0 1;
    }
    MemoryScreen .row { height: 1; }
    MemoryScreen .row.active { background: #2a3441; text-style: bold; }
    MemoryScreen .pill-useful { color: #7fc8a9; }
    MemoryScreen .pill-bad { color: #e06c75; }
    MemoryScreen .hint { color: #9ba1ad; padding: 0 0 1 0; }
    """

    def __init__(
        self, project_root: str, memory_dir: str | None = None, **kwargs: Any
    ) -> None:
        super().__init__(**kwargs)
        self.project_root = project_root
        self.memory_dir = memory_dir
        self._items: list[dict[str, Any]] = []
        self._filtered: list[dict[str, Any]] = []
        self._selected: int = 0
        self._filter: str = ""

    def compose(self) -> ComposeResult:
        yield Static("Memory", classes="header")
        yield Static(
            "Curated memory. Type to filter. [A]dd  [D]elete  [U]seful  [X] not useful  [R]efresh",
            classes="hint",
        )
        with Container(classes="toolbar"):
            yield Input(placeholder="filter / search", id="filter")
        with Horizontal(id="body"):
            with VerticalScroll(id="left"):
                yield Static("[dim]loading...[/]", id="list")
            with VerticalScroll(id="right"):
                yield Static("[dim]select a memory[/]", id="detail")

    def on_mount(self) -> None:
        self._reload()

    def _reload(self) -> None:
        self._items = list_memories(self.memory_dir)
        self._apply_filter()

    def _apply_filter(self) -> None:
        q = (self._filter or "").strip().lower()
        if not q:
            self._filtered = list(self._items)
        else:
            self._filtered = []
            for it in self._items:
                if q in (it.get("text", "")).lower():
                    self._filtered.append(it)
                    continue
                if any(q in t.lower() for t in (it.get("tags") or [])):
                    self._filtered.append(it)
                    continue
                if q in (it.get("source", "")).lower():
                    self._filtered.append(it)
                    continue
        self._selected = 0
        self._render_list()
        self._render_detail()

    def _render_list(self) -> None:
        c = self.query_one("#left", VerticalScroll)
        for w in list(c.children):
            w.remove()
        if not self._filtered:
            c.mount(Static("[dim]no memories match[/]"))
            return
        for i, m in enumerate(self._filtered):
            mid = m.get("id", "?")
            text = m.get("text", "")
            one = text.splitlines()[0] if text else ""
            if len(one) > 60:
                one = one[:57] + "..."
            tags = ",".join(m.get("tags") or []) or "-"
            use = m.get("use_count", 0)
            label = f"  [{mid[:8]}] {one}  [dim]({use}x, {tags})[/]"
            classes = "row active" if i == self._selected else "row"
            w = Static(label, classes=classes, id=f"mem-{i}")
            w.can_focus = True
            c.mount(w)

    def _render_detail(self) -> None:
        c = self.query_one("#right", VerticalScroll)
        for w in list(c.children):
            w.remove()
        if not self._filtered:
            c.mount(Static("[dim]no memory selected[/]"))
            return
        if not (0 <= self._selected < len(self._filtered)):
            return
        m = self._filtered[self._selected]
        m = redact_memory(m)
        c.mount(Static(f"[bold]id[/]      {m.get('id', '?')}"))
        c.mount(Static(f"[bold]source[/]  {m.get('source', '-')}"))
        c.mount(Static(f"[bold]tags[/]    {','.join(m.get('tags') or []) or '-'}"))
        c.mount(Static(f"[bold]use[/]     {m.get('use_count', 0)}"))
        c.mount(Static(f"[bold]created[/] {_fmt_ts(m.get('created_at', 0))}"))
        c.mount(Static(f"[bold]used[/]    {_fmt_ts(m.get('last_used_at', 0))}"))
        c.mount(Static(""))
        c.mount(Static("[bold]text[/]"))
        for line in (m.get("text") or "").splitlines():
            c.mount(Static(f"  {line}"))

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "filter":
            self._filter = event.value
            self._apply_filter()

    def on_click(self, event: Any) -> None:
        w = event.widget
        if isinstance(w, Static) and w.id and w.id.startswith("mem-"):
            try:
                idx = int(w.id[4:])
            except ValueError:
                return
            if 0 <= idx < len(self._filtered):
                self._selected = idx
                self._render_list()
                self._render_detail()

    def on_key(self, event: Any) -> None:
        if event.key == "j":
            self.action_next()
            event.stop()
        elif event.key == "k":
            self.action_prev()
            event.stop()

    # --- actions ---

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_refresh(self) -> None:
        self._reload()
        self.notify("refreshed")

    def action_next(self) -> None:
        if not self._filtered:
            return
        self._selected = (self._selected + 1) % len(self._filtered)
        self._render_list()
        self._render_detail()

    def action_prev(self) -> None:
        if not self._filtered:
            return
        self._selected = (self._selected - 1) % len(self._filtered)
        self._render_list()
        self._render_detail()

    def action_useful(self) -> None:
        m = self._current()
        if not m:
            return
        self.app.state.mark_memory(m.get("id", ""), "useful")
        self.notify(f"marked useful: {m.get('id', '?')[:12]}")

    def action_not_useful(self) -> None:
        m = self._current()
        if not m:
            return
        self.app.state.mark_memory(m.get("id", ""), "not_useful")
        self.notify(f"marked not useful: {m.get('id', '?')[:12]}")

    def action_add(self) -> None:
        # Switch focus to the filter input and pre-fill with "add:"
        i = self.query_one("#filter", Input)
        i.value = "add:"
        i.focus()

    def action_delete(self) -> None:
        m = self._current()
        if not m:
            return
        mid = m.get("id", "")
        # Soft confirmation: ask the user to press 'd' twice
        if self.app.state.memory_feedback.get(f"__confirm_delete_{mid}"):
            try:
                forget_memory(mid, self.memory_dir)
                self.app.state.memory_feedback.pop(f"__confirm_delete_{mid}", None)
                self._reload()
                self.notify(f"deleted: {mid[:12]}")
            except Exception as e:
                self.notify(f"delete failed: {e}", severity="error")
            return
        self.app.state.memory_feedback[f"__confirm_delete_{mid}"] = "1"
        self.notify(
            f"press [D] again within 5s to confirm delete: {mid[:12]}",
            severity="warning",
        )

    # --- helpers ---

    def _current(self) -> dict[str, Any] | None:
        if 0 <= self._selected < len(self._filtered):
            return self._filtered[self._selected]
        return None


def _fmt_ts(ts: float) -> str:
    if not ts:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
