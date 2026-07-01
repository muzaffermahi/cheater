"""Command palette for the Cheater Cockpit.

A Textual modal that lets the user fuzzy-search and execute any
"command palette action". Actions are defined as a list of dicts with
``id``, ``title``, ``section``, ``keywords``, and ``run(app)`` callable.

The palette is opened with Ctrl+P by default.
"""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Input, Static



# --- action registry ---

# Each action has:
#   id          : stable identifier
#   title       : human-friendly label (shown in palette)
#   section     : grouping (Start, Open, Toggle, etc.)
#   keywords    : list of extra search terms
#   run(app)    : callable, runs when activated
PaletteAction = dict[str, Any]


def default_palette_actions() -> list[PaletteAction]:
    """Return the list of palette actions. Wired against the app instance."""
    return [
        {
            "id": "start_repair",
            "title": "Start repair (open repair screen)",
            "section": "Start",
            "keywords": ["repair", "fix", "bug"],
            "run": lambda app: app.action_open_repair(),
        },
        {
            "id": "build_repo_map",
            "title": "Build repo map",
            "section": "Build",
            "keywords": ["map", "repo", "index"],
            "run": lambda app: app.action_quick_repo_map(),
        },
        {
            "id": "search_repo_map",
            "title": "Search repo map",
            "section": "Build",
            "keywords": ["map", "search"],
            "run": lambda app: app.action_quick_search_repo(),
        },
        {
            "id": "run_focused_tests",
            "title": "Run focused tests (detect + run)",
            "section": "Run",
            "keywords": ["test", "pytest", "run"],
            "run": lambda app: app.action_quick_run_tests(),
        },
        {
            "id": "open_memory",
            "title": "Open memory browser",
            "section": "Open",
            "keywords": ["memory", "curated", "store"],
            "run": lambda app: app.action_open_memory(),
        },
        {
            "id": "open_skills",
            "title": "Open skills browser",
            "section": "Open",
            "keywords": ["skill", "janitor"],
            "run": lambda app: app.action_open_skills(),
        },
        {
            "id": "open_traces",
            "title": "Open trace browser",
            "section": "Open",
            "keywords": ["trace", "replay", "jsonl"],
            "run": lambda app: app.action_open_traces(),
        },
        {
            "id": "open_arena",
            "title": "Open arena dashboard",
            "section": "Open",
            "keywords": ["arena", "eval", "benchmark"],
            "run": lambda app: app.action_open_arena(),
        },
        {
            "id": "open_settings",
            "title": "Open settings",
            "section": "Open",
            "keywords": ["config", "settings", "preferences"],
            "run": lambda app: app.action_open_settings(),
        },
        {
            "id": "toggle_inspector",
            "title": "Toggle inspector (right panel)",
            "section": "Toggle",
            "keywords": ["inspector", "right", "panel"],
            "run": lambda app: app.action_toggle_inspector(),
        },
        {
            "id": "toggle_compact",
            "title": "Toggle compact mode",
            "section": "Toggle",
            "keywords": ["compact", "small", "density"],
            "run": lambda app: app.action_toggle_compact(),
        },
        {
            "id": "toggle_tool_stream",
            "title": "Toggle tool stream",
            "section": "Toggle",
            "keywords": ["tool", "stream", "cards"],
            "run": lambda app: app.action_toggle_tool_stream(),
        },
        {
            "id": "interrupt",
            "title": "Interrupt current run",
            "section": "Run",
            "keywords": ["stop", "interrupt", "cancel"],
            "run": lambda app: app.action_interrupt(),
        },
        {
            "id": "clear_transcript",
            "title": "Clear transcript",
            "section": "Toggle",
            "keywords": ["clear", "reset", "transcript"],
            "run": lambda app: app.action_clear_transcript(),
        },
        {
            "id": "show_help",
            "title": "Show help overlay",
            "section": "Help",
            "keywords": ["help", "?", "keybindings"],
            "run": lambda app: app.action_show_help(),
        },
        {
            "id": "show_diff",
            "title": "Show git diff",
            "section": "Open",
            "keywords": ["diff", "git", "review"],
            "run": lambda app: app.action_show_diff(),
        },
        {
            "id": "show_status",
            "title": "Show status (config + budget)",
            "section": "Open",
            "keywords": ["status", "budget", "config"],
            "run": lambda app: app.action_show_status(),
        },
    ]


def _score(query: str, action: PaletteAction) -> int:
    """A tiny fuzzy score. Lower is better; -1 means no match."""
    if not query:
        return 0
    q = query.lower()
    if q in action.get("title", "").lower():
        return 1
    if any(q in k.lower() for k in action.get("keywords", [])):
        return 2
    if q in action.get("id", "").lower():
        return 3
    # substring in title
    if q in action.get("title", "").lower():
        return 4
    return -1


class CommandPaletteScreen(ModalScreen):
    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
        Binding("enter", "select", "Run"),
    ]

    DEFAULT_CSS = """
    CommandPaletteScreen { align: center middle; }
    CommandPaletteScreen > .modal {
        width: 70%;
        max-width: 100;
        height: auto;
        max-height: 60%;
        background: #1d2128;
        border: thick #61afef;
        padding: 1 2;
    }
    CommandPaletteScreen Input { width: 1fr; }
    CommandPaletteScreen .row { height: 1; padding: 0 1; }
    CommandPaletteScreen .row.active { background: #2a3441; text-style: bold; }
    CommandPaletteScreen .section { color: #9ba1ad; padding: 1 0 0 0; }
    """

    def __init__(
        self, actions: list[PaletteAction] | None = None, **kwargs: Any
    ) -> None:
        super().__init__(**kwargs)
        self._all_actions: list[PaletteAction] = actions or default_palette_actions()
        self._filtered: list[PaletteAction] = list(self._all_actions)
        self._selected: int = 0
        self._row_widgets: list[Static] = []

    def compose(self) -> ComposeResult:
        with Container(classes="modal"):
            yield Input(placeholder="Type a command...", id="search")
            with VerticalScroll(id="results"):
                yield Static("[dim]loading...[/]", id="results-placeholder")

    def on_mount(self) -> None:
        self.refresh_results()
        self.query_one("#search", Input).focus()

    def refresh_results(self) -> None:
        c = self.query_one("#results", VerticalScroll)
        for w in list(c.children):
            w.remove()
        self._row_widgets.clear()
        if not self._filtered:
            c.mount(Static("[dim]no matches[/]"))
            return
        # Group by section
        current_section = None
        for i, a in enumerate(self._filtered):
            sec = a.get("section", "")
            if sec != current_section:
                current_section = sec
                c.mount(Static(f"[dim]{sec}[/]", classes="section"))
            text = f"  {a.get('title', a.get('id', '?'))}"
            classes = "row active" if i == self._selected else "row"
            w = Static(text, classes=classes, id=f"pa-{i}")
            w.can_focus = True
            self._row_widgets.append(w)
            c.mount(w)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "search":
            return
        q = event.value.strip()
        if not q:
            self._filtered = list(self._all_actions)
        else:
            scored = []
            for a in self._all_actions:
                s = _score(q, a)
                if s >= 0:
                    scored.append((s, a))
            scored.sort(key=lambda x: x[0])
            self._filtered = [a for _, a in scored]
        self._selected = 0
        self.refresh_results()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.action_select()

    def on_click(self, event: Any) -> None:
        w = event.widget
        if isinstance(w, Static) and w.id and w.id.startswith("pa-"):
            try:
                idx = int(w.id[3:])
            except ValueError:
                return
            if 0 <= idx < len(self._filtered):
                self._selected = idx
                self.refresh_results()
                self.action_select()

    def on_key(self, event: Any) -> None:
        if event.key == "down":
            if self._filtered:
                self._selected = (self._selected + 1) % len(self._filtered)
                self.refresh_results()
            event.stop()
        elif event.key == "up":
            if self._filtered:
                self._selected = (self._selected - 1) % len(self._filtered)
                self.refresh_results()
            event.stop()

    # --- actions ---

    def action_dismiss(self) -> None:
        self.dismiss(None)

    def action_select(self) -> None:
        if not self._filtered:
            return
        if not (0 <= self._selected < len(self._filtered)):
            return
        action = self._filtered[self._selected]
        run = action.get("run")
        self.dismiss(action.get("id"))
        if run is not None:
            try:
                run(self.app)
            except Exception as e:
                self.app.notify(f"action failed: {e}", severity="error")
