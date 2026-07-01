"""Live tool stream panel.

The tool stream shows a vertically scrolling list of cards, one per
tool invocation. The card shows:

* the tool name
* a short, safe summary of the args
* duration
* success/failure
* a one-line compressed output preview
* a collapsible raw output region (collapsed by default to keep
  memory and screen real estate small)

The widget intentionally does NOT call any backend module. It just
renders what :class:`~cheater.tui.state.ToolCall` records the app
state gave it.
"""

from __future__ import annotations

import time
from typing import Any

from textual.containers import VerticalScroll
from textual.message import Message
from textual.widgets import Static

from cheater.tui.state import ToolCall
from cheater.tui.theme import PALETTE


class _ToolCard(Static):
    """A single tool call card. Self-contained; rebuilt when the call ends."""

    DEFAULT_CSS = """
    _ToolCard { height: auto; padding: 0 1; margin: 0 0 1 0; border: round #3a3f4b; }
    _ToolCard.success { border: round #7fc8a9; }
    _ToolCard.error { border: round #e06c75; }
    _ToolCard.warning { border: round #e6c07b; }
    _ToolCard.running { border: round #c678dd; }
    _ToolCard .head { color: #61afef; text-style: bold; }
    _ToolCard .meta { color: #9ba1ad; }
    _ToolCard .args { color: #9ba1ad; padding: 0 0 1 0; }
    _ToolCard .body { color: #d4d4d4; padding: 0 0 1 0; }
    _ToolCard.collapsed .body { display: none; }
    _ToolCard .preview { color: #9ba1ad; padding: 0 0 1 0; }
    """

    class Toggled(Message):
        def __init__(self, tool_name: str) -> None:
            super().__init__()
            self.tool_name = tool_name

    def __init__(self, tc: ToolCall, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.tc = tc
        self._collapsed = True
        self.refresh_card()

    def refresh_card(self) -> None:
        tc = self.tc
        elapsed = (
            (tc.finished_at or time.time()) - tc.started_at if tc.started_at else 0.0
        )
        kind = (
            "running" if not tc.finished_at else ("success" if tc.success else "error")
        )
        self.set_class(True, kind)
        head = (
            f"[{PALETTE['accent'] if kind == 'running' else (PALETTE['success'] if kind == 'success' else PALETTE['error'])}]"
            f"{tc.name}[/]  "
            f"[dim]{elapsed:0.2f}s  {'ok' if tc.success else 'failed'}[/]"
        )
        args_str = _summarize_args(tc.args)
        preview = _clip_one_line(tc.output or tc.error or "")
        body = ""
        if tc.error:
            clipped, _ = _clip(tc.error, 4000)
            body = f"[red]{clipped}[/]"
        elif tc.output:
            body, _ = _clip(tc.output, 4000)
        body_text = ""
        if body:
            body_indented = "\n".join("  " + line for line in body.splitlines() or [""])
            body_text = (
                f"\n[b]{'output' if tc.success else 'error'}[/]\n{body_indented}"
            )
        preview_text = f"\n[dim]{preview}[/]" if preview else ""
        full = f"{head}\n[dim]{args_str}[/]{preview_text}{body_text}"
        self.update(full)
        self.set_class(self._collapsed, "collapsed")

    def set_collapsed(self, collapsed: bool) -> None:
        self._collapsed = collapsed
        self.refresh_card()

    def on_click(self, event: Any) -> None:
        self._collapsed = not self._collapsed
        self.refresh_card()
        self.post_message(self.Toggled(self.tc.name))


class ToolStream(VerticalScroll):
    """The right column of the center area: live tool cards."""

    DEFAULT_CSS = """
    ToolStream { height: 1fr; padding: 0 1; }
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._cards: list[_ToolCard] = []
        self._max_cards: int = 200  # hard cap to keep memory small

    def clear(self) -> None:
        for c in self._cards:
            c.remove()
        self._cards.clear()

    def add_card(self, tc: ToolCall) -> _ToolCard:
        # Evict oldest if we hit the cap
        if len(self._cards) >= self._max_cards:
            old = self._cards.pop(0)
            old.remove()
        card = _ToolCard(tc, classes="event-card")
        self._cards.append(card)
        self.mount(card)
        # Scroll to bottom
        self.scroll_end(animate=False)
        return card

    def update_last(self, tc: ToolCall) -> None:
        if not self._cards:
            self.add_card(tc)
            return
        self._cards[-1].tc = tc
        self._cards[-1].refresh_card()
        self.scroll_end(animate=False)

    def cards(self) -> list[_ToolCard]:
        return list(self._cards)


# --- helpers ---


def _clip(s: str, n: int) -> tuple[str, bool]:
    if not s:
        return "", False
    if len(s) <= n:
        return s, False
    return s[: max(0, n - 30)] + "...[truncated]", True


def _clip_one_line(s: str) -> str:
    s = (s or "").splitlines()[0] if s else ""
    if len(s) > 160:
        s = s[:157] + "..."
    return s


def _summarize_args(args: dict[str, Any]) -> str:
    if not args:
        return ""
    parts: list[str] = []
    for k, v in args.items():
        sv = str(v)
        if len(sv) > 60:
            sv = sv[:57] + "..."
        parts.append(f"{k}={sv}")
    s = "  ".join(parts)
    if len(s) > 240:
        s = s[:237] + "..."
    return s
