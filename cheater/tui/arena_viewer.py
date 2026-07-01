"""Arena dashboard screen.

The arena runs component / repair evals and writes reports as JSON
under ``.cheater/arena/``. The TUI screen:

* shows the latest report
* shows metric cards: localization hit@1, hit@3, valid diff rate,
  focused test pass rate, avg rounds, avg context tokens
* can list older reports and load them
* can compare two reports (if both paths are available)
"""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.screen import Screen
from textual.widgets import Static

from cheater.tui import adapters


def load_latest(project_root: str) -> dict[str, Any] | None:
    return adapters.latest_arena_report(project_root)


def list_reports(project_root: str) -> list[dict[str, Any]]:
    return adapters.list_arena_reports(project_root)


def render_summary(report: dict[str, Any]) -> str:
    return adapters.render_arena_summary(report)


def extract_metrics(report: dict[str, Any]) -> dict[str, Any]:
    """Extract the headline metrics we want to show as cards."""
    out: dict[str, Any] = {}
    if not report:
        return out
    metrics = report.get("metrics") or {}
    # try common keys
    for k in (
        "localization_hit_at_1",
        "localization_hit@1",
        "localizer_hit@1",
        "localization_top1",
    ):
        if k in metrics:
            out["localization_hit@1"] = metrics[k]
            break
    for k in (
        "localization_hit_at_3",
        "localization_hit@3",
        "localizer_hit@3",
    ):
        if k in metrics:
            out["localization_hit@3"] = metrics[k]
            break
    for k in ("valid_diff_rate", "valid_patch_rate", "diff_valid_rate"):
        if k in metrics:
            out["valid_diff_rate"] = metrics[k]
            break
    for k in ("test_pass_rate", "focused_test_pass_rate", "tests_pass_rate"):
        if k in metrics:
            out["test_pass_rate"] = metrics[k]
            break
    for k in ("avg_rounds", "mean_rounds", "rounds_avg"):
        if k in metrics:
            out["avg_rounds"] = metrics[k]
            break
    for k in ("avg_context_tokens", "avg_ctx_tokens", "mean_context_tokens"):
        if k in metrics:
            out["avg_context_tokens"] = metrics[k]
            break
    # If the report has the flat shape used by arena.py, also try those
    if not out and "summary" in report:
        s = report.get("summary") or {}
        if isinstance(s, dict):
            for k in ("hit@1", "hit@3", "valid_diff", "test_pass"):
                if k in s:
                    out[k] = s[k]
    return out


class ArenaScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("r", "refresh", "Refresh"),
        Binding("c", "compare", "Compare"),
        Binding("o", "open", "Open report"),
    ]

    DEFAULT_CSS = """
    ArenaScreen { layout: vertical; padding: 0 1; }
    ArenaScreen .header { color: #61afef; text-style: bold; padding: 1 0 1 0; }
    ArenaScreen .hint { color: #9ba1ad; padding: 0 0 1 0; }
    ArenaScreen .cards { layout: grid; grid-size: 3; grid-gutter: 1 2; height: auto; }
    ArenaScreen .card {
        height: 5;
        background: #1a1d23;
        border: round #3a3f4b;
        padding: 0 1;
    }
    ArenaScreen .card .name { color: #9ba1ad; }
    ArenaScreen .card .value { color: #61afef; text-style: bold; }
    ArenaScreen .card .unit { color: #9ba1ad; }
    ArenaScreen .summary { padding: 1 0; }
    ArenaScreen .reports { height: 1fr; }
    ArenaScreen .row { height: 1; }
    ArenaScreen .row.active { background: #2a3441; text-style: bold; }
    """

    def __init__(self, project_root: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.project_root = project_root
        self._latest: dict[str, Any] | None = None
        self._reports: list[dict[str, Any]] = []
        self._selected_report: int = 0

    def compose(self) -> ComposeResult:
        yield Static("Arena", classes="header")
        yield Static(
            "Latest arena report metrics. [R]efresh  [O]pen report  [C]ompare",
            classes="hint",
        )
        yield Static("[dim]loading...[/]", id="cards")
        with VerticalScroll(id="summary"):
            yield Static("[dim]no report yet[/]", id="summary-text")
        yield Static("[dim]reports:[/]", classes="hint")
        with VerticalScroll(classes="reports"):
            yield Static("[dim]loading...[/]", id="report-list")

    def on_mount(self) -> None:
        self._reload()

    def _reload(self) -> None:
        self._latest = load_latest(self.project_root)
        self._reports = list_reports(self.project_root)
        self._render_cards()
        self._render_summary()
        self._render_reports()

    def _render_cards(self) -> None:
        c = self.query_one("#cards", Static)
        if not self._latest:
            c.update("[dim]no arena report yet -- run `cheater arena run` first[/]")
            return
        m = extract_metrics(self._latest)
        # 6 cards: hit@1, hit@3, valid diff, test pass, avg rounds, avg ctx
        cards = [
            ("localization hit@1", m.get("localization_hit@1", "-")),
            ("localization hit@3", m.get("localization_hit@3", "-")),
            ("valid diff rate", m.get("valid_diff_rate", "-")),
            ("test pass rate", m.get("test_pass_rate", "-")),
            ("avg rounds", m.get("avg_rounds", "-")),
            ("avg ctx tokens", m.get("avg_context_tokens", "-")),
        ]
        lines: list[str] = []
        # 3 columns; we'll let the Grid CSS do the layout
        for name, value in cards:
            v = value if value not in (None, "-") else "-"
            lines.append(f"[dim]{name}[/]  [bold]{v}[/]")
        c.update("\n".join(lines))
        # The actual grid layout is rendered as a Container in compose;
        # we keep the Static fallback for safety in case Grid is missing.

    def _render_summary(self) -> None:
        s = self.query_one("#summary-text", Static)
        if not self._latest:
            s.update("[dim]no report yet[/]")
            return
        try:
            s.update(render_summary(self._latest))
        except Exception as e:
            s.update(f"[red]could not render: {e}[/]")

    def _render_reports(self) -> None:
        c = self.query_one("#report-list")
        for w in list(c.children):
            w.remove()
        if not self._reports:
            c.mount(Static("[dim]no reports under .cheater/arena/[/]"))
            return
        for i, r in enumerate(self._reports):
            label = f"  {r.get('name', '?')}"
            classes = "row active" if i == self._selected_report else "row"
            w = Static(label, classes=classes, id=f"ar-{i}")
            w.can_focus = True
            c.mount(w)

    def on_click(self, event: Any) -> None:
        w = event.widget
        if isinstance(w, Static) and w.id and w.id.startswith("ar-"):
            try:
                idx = int(w.id[3:])
            except ValueError:
                return
            if 0 <= idx < len(self._reports):
                self._selected_report = idx
                self._render_reports()
                self._open_selected()

    # --- actions ---

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_refresh(self) -> None:
        self._reload()
        self.notify("refreshed")

    def action_open(self) -> None:
        self._open_selected()

    def _open_selected(self) -> None:
        if not self._reports:
            self.notify("no reports to open", severity="warning")
            return
        if not (0 <= self._selected_report < len(self._reports)):
            return
        path = self._reports[self._selected_report].get("path", "")
        try:
            from cheater.arena import read_arena_report

            self._latest = read_arena_report(path)
            self._render_cards()
            self._render_summary()
            self.notify(f"loaded {path}")
        except Exception as e:
            self.notify(f"open failed: {e}", severity="error")

    def action_compare(self) -> None:
        if len(self._reports) < 2:
            self.notify("need at least 2 reports to compare", severity="warning")
            return
        old = self._reports[1].get("path", "")
        new = self._reports[0].get("path", "")
        try:
            cmp = adapters.compare_two_arena_reports(self.project_root, old, new)
            rows = cmp.get("rows", []) if isinstance(cmp, dict) else []
            msg = f"compare: {len(rows)} metric deltas"
            self.notify(msg)
            s = self.query_one("#summary-text", Static)
            try:
                from cheater.arena import render_arena_summary as _r  # noqa: F401

                # re-render the comparison nicely
                lines = ["=== arena compare ==="]
                for r in rows[:20]:
                    lines.append(
                        f"{r.get('metric', '?'):38s} {str(r.get('old', '?')):>8s} -> {str(r.get('new', '?')):>8s}  {r.get('direction', '?')}"
                    )
                s.update("\n".join(lines))
            except Exception:
                pass
        except Exception as e:
            self.notify(f"compare failed: {e}", severity="error")
