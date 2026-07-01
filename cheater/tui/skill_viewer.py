"""Skill browser screen for the Cheater Cockpit.

A "skill" in Cheater is a ``.md`` file with YAML-ish front matter under
``.cheater/skills/`` (or ``data/skills/``). The TUI screen:

* lists available skills
* searches by name / trigger / summary
* shows the full SKILL.md body
* lets the user mark a skill useful / not useful
* runs the janitor audit on the skills
"""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, VerticalScroll
from textual.screen import Screen
from textual.widgets import Input, Static

from cheater.tui import adapters


def list_skills_for_root(project_root: str) -> list[dict[str, Any]]:
    return adapters.list_skills(project_root)


class SkillScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("r", "refresh", "Refresh"),
        Binding("u", "useful", "Useful"),
        Binding("x", "not_useful", "Not useful"),
        Binding("j", "janitor", "Run janitor"),
        Binding("j", "next", "Next", show=False),
        Binding("k", "prev", "Prev", show=False),
    ]

    DEFAULT_CSS = """
    SkillScreen { layout: vertical; padding: 0 1; }
    SkillScreen .header { color: #61afef; text-style: bold; padding: 1 0 1 0; }
    SkillScreen .toolbar { height: 3; padding: 0 0 1 0; }
    SkillScreen .toolbar Input { width: 1fr; }
    SkillScreen #body { height: 1fr; }
    SkillScreen #left {
        width: 40%;
        border-right: tall #3a3f4b;
        padding: 0 1;
    }
    SkillScreen #right {
        width: 1fr;
        padding: 0 1;
    }
    SkillScreen .row { height: 1; }
    SkillScreen .row.active { background: #2a3441; text-style: bold; }
    SkillScreen .hint { color: #9ba1ad; padding: 0 0 1 0; }
    """

    def __init__(self, project_root: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.project_root = project_root
        self._items: list[dict[str, Any]] = []
        self._filtered: list[dict[str, Any]] = []
        self._selected: int = 0
        self._filter: str = ""

    def compose(self) -> ComposeResult:
        yield Static("Skills", classes="header")
        yield Static(
            "Cheater skills. Type to filter. [J] run janitor  [U]seful  [X] not useful  [R]efresh",
            classes="hint",
        )
        with Container(classes="toolbar"):
            yield Input(placeholder="filter / search", id="filter")
        with Horizontal(id="body"):
            with VerticalScroll(id="left"):
                yield Static("[dim]loading...[/]", id="list")
            with VerticalScroll(id="right"):
                yield Static("[dim]select a skill[/]", id="detail")

    def on_mount(self) -> None:
        self._reload()

    def _reload(self) -> None:
        self._items = list_skills_for_root(self.project_root)
        self._apply_filter()

    def _apply_filter(self) -> None:
        q = (self._filter or "").strip().lower()
        if not q:
            self._filtered = list(self._items)
        else:
            self._filtered = []
            for it in self._items:
                if q in (it.get("name", "")).lower():
                    self._filtered.append(it)
                    continue
                if q in (it.get("trigger", "")).lower():
                    self._filtered.append(it)
                    continue
                if q in (it.get("summary", "")).lower():
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
            c.mount(Static("[dim]no skills found[/]"))
            return
        for i, s in enumerate(self._filtered):
            name = s.get("name", "?")
            trigger = s.get("trigger", "")
            label = f"  {name}" + (f"  [dim]({trigger})[/]" if trigger else "")
            classes = "row active" if i == self._selected else "row"
            w = Static(label, classes=classes, id=f"sk-{i}")
            w.can_focus = True
            c.mount(w)

    def _render_detail(self) -> None:
        c = self.query_one("#right", VerticalScroll)
        for w in list(c.children):
            w.remove()
        if not self._filtered:
            c.mount(Static("[dim]no skill selected[/]"))
            return
        if not (0 <= self._selected < len(self._filtered)):
            return
        s = self._filtered[self._selected]
        c.mount(Static(f"[bold]name[/]    {s.get('name', '?')}"))
        c.mount(Static(f"[bold]trigger[/] {s.get('trigger', '-')}"))
        c.mount(Static(f"[bold]path[/]    {s.get('path', '-')}"))
        c.mount(Static(""))
        if s.get("summary"):
            c.mount(Static("[bold]summary[/]"))
            for line in (s.get("summary") or "").splitlines():
                c.mount(Static(f"  {line}"))
            c.mount(Static(""))
        if s.get("front_matter"):
            c.mount(Static("[bold]front matter[/]"))
            for k, v in (s.get("front_matter") or {}).items():
                c.mount(Static(f"  {k}: {v}"))
            c.mount(Static(""))
        raw = s.get("raw", "")
        if raw:
            c.mount(Static("[bold]SKILL.md[/]"))
            # Truncate very long bodies
            if len(raw) > 5000:
                raw = raw[:4970] + "\n...[truncated]"
            for line in raw.splitlines():
                c.mount(Static(f"  {line}"))

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "filter":
            self._filter = event.value
            self._apply_filter()

    def on_click(self, event: Any) -> None:
        w = event.widget
        if isinstance(w, Static) and w.id and w.id.startswith("sk-"):
            try:
                idx = int(w.id[3:])
            except ValueError:
                return
            if 0 <= idx < len(self._filtered):
                self._selected = idx
                self._render_list()
                self._render_detail()

    def on_key(self, event: Any) -> None:
        # avoid hijacking 'j' (also bound to janitor)
        if event.key == "j" and not self._filter:
            self.action_janitor()
            event.stop()
        elif event.key == "down":
            self.action_next()
            event.stop()
        elif event.key == "up":
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
        s = self._current()
        if not s:
            return
        self.app.state.mark_skill(s.get("name", ""), "useful")
        self.notify(f"marked useful: {s.get('name', '?')}")

    def action_not_useful(self) -> None:
        s = self._current()
        if not s:
            return
        self.app.state.mark_skill(s.get("name", ""), "not_useful")
        self.notify(f"marked not useful: {s.get('name', '?')}")

    def action_janitor(self) -> None:
        try:
            store = adapters.open_memory_store()
            report = adapters.run_skill_janitor(self.project_root, store)
            n_skills = len(report.get("skills", []))
            self.notify(f"janitor: scanned {n_skills} skills", severity="information")
        except Exception as e:
            self.notify(f"janitor failed: {e}", severity="error")

    def _current(self) -> dict[str, Any] | None:
        if 0 <= self._selected < len(self._filtered):
            return self._filtered[self._selected]
        return None
