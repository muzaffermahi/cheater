"""Diff review modal + helper for the Cheater Cockpit.

When the agent produces a patch, the TUI opens a :class:`DiffReviewScreen`
modal showing the touched files, added/removed line counts, risk flags,
and a unified diff. The user can:

* accept / apply the patch
* reject
* ask for a revision
* copy the diff to the clipboard (best-effort)
* open the related failure summary (best-effort)

Default behaviour is safe: nothing is applied until the user explicitly
confirms. Risky diffs (high risk_score, forbidden paths) are flagged in
red and the default action is "reject".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static

from cheater.tui.theme import PALETTE


# --- pure helpers (no Textual) ---


@dataclass
class DiffSummary:
    path: str
    added: int = 0
    removed: int = 0
    risk_flags: list[str] = None  # type: ignore[assignment]
    risk_score: float = 0.0
    is_create: bool = False

    def __post_init__(self) -> None:
        if self.risk_flags is None:
            self.risk_flags = []


def summarize_touched_files(
    items: Iterable[dict[str, Any]],
) -> list[DiffSummary]:
    """Compute per-file stats from a list of diff dicts.

    Each input item is expected to have at least ``path``. Optional
    fields: ``old``, ``new``, ``is_create``, ``risk_flags``,
    ``risk_score``. Stats are computed from the unified diff.
    """
    out: list[DiffSummary] = []
    for it in items:
        path = str(it.get("path", "?"))
        is_create = bool(it.get("is_create"))
        old = it.get("old", "") or ""
        new = it.get("new", "") or ""
        added, removed = _count_diff_lines(old, new)
        flags = list(it.get("risk_flags") or [])
        score = float(it.get("risk_score", 0.0))
        out.append(
            DiffSummary(
                path=path,
                added=added,
                removed=removed,
                risk_flags=flags,
                risk_score=score,
                is_create=is_create,
            )
        )
    return out


def _count_diff_lines(old: str, new: str) -> tuple[int, int]:
    """Count lines added and removed using difflib.

    If ``old``/``new`` already look like a unified diff (start with ``+``
    or ``-``), we fall back to a simple count.
    """
    import difflib

    old_lines = (old or "").splitlines()
    new_lines = (new or "").splitlines()
    if not old_lines and not new_lines:
        return 0, 0
    # If both look like unified diffs already, count directly.
    if (
        old_lines
        and new_lines
        and (
            all(
                ln.startswith(("+", "-", " ")) or ln.startswith(("---", "+++"))
                for ln in old_lines[:5]
            )
            and all(
                ln.startswith(("+", "-", " ")) or ln.startswith(("---", "+++"))
                for ln in new_lines[:5]
            )
        )
    ):
        added = sum(
            1 for ln in new_lines if ln.startswith("+") and not ln.startswith("+++")
        )
        removed = sum(
            1 for ln in old_lines if ln.startswith("-") and not ln.startswith("---")
        )
        return added, removed
    # Otherwise compute a real diff so the count is meaningful.
    diff = list(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile="a",
            tofile="b",
            n=1,
            lineterm="",
        )
    )
    added = sum(1 for ln in diff if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in diff if ln.startswith("-") and not ln.startswith("---"))
    return added, removed


def format_unified_diff(
    path: str,
    old: str,
    new: str,
    context: int = 3,
    max_chars: int = 12000,
) -> str:
    """Format a minimal unified diff for display. Truncated for big diffs."""
    import difflib

    diff_iter = difflib.unified_diff(
        (old or "").splitlines(keepends=True),
        (new or "").splitlines(keepends=True),
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
        n=context,
    )
    text = "".join(diff_iter)
    if len(text) > max_chars:
        text = text[: max(0, max_chars - 30)] + "...[truncated]"
    return text


def risk_color(score: float) -> str:
    if score >= 0.7:
        return PALETTE["error"]
    if score >= 0.4:
        return PALETTE["warning"]
    return PALETTE["success"]


def is_risky(summary: DiffSummary) -> bool:
    if summary.risk_score >= 0.4:
        return True
    if any("forbidden" in f.lower() for f in summary.risk_flags):
        return True
    if summary.is_create and ("/secrets" in summary.path or ".env" in summary.path):
        return True
    return False


# --- modal ---


class DiffReviewScreen(ModalScreen):
    """Modal for reviewing one or more proposed diffs.

    Emits a :class:`DiffDecision` message via ``dismiss(decision)`` where
    ``decision`` is a dict: ``{"action": "accept"|"reject"|"revise", "ids": [...], "note": "..."}``.
    """

    BINDINGS = [
        Binding("escape", "dismiss_reject", "Reject"),
        Binding("a", "accept", "Accept"),
        Binding("r", "revise", "Revise"),
        Binding("c", "copy", "Copy"),
        Binding("f", "open_failure", "Open failure"),
    ]

    DEFAULT_CSS = """
    DiffReviewScreen { align: center middle; }
    DiffReviewScreen > .modal {
        width: 92%;
        height: 88%;
        background: #1d2128;
        border: thick #61afef;
        padding: 1 2;
    }
    DiffReviewScreen .title { color: #61afef; text-style: bold; padding: 0 0 1 0; }
    DiffReviewScreen .meta { color: #9ba1ad; padding: 0 0 1 0; }
    DiffReviewScreen .row { height: 1; }
    DiffReviewScreen .diff {
        height: 1fr;
        background: #14161a;
        border: round #3a3f4b;
        padding: 0 1;
    }
    DiffReviewScreen .footer { color: #9ba1ad; padding: 1 0 0 0; }
    DiffReviewScreen .risky { color: #e06c75; }
    DiffReviewScreen .ok { color: #7fc8a9; }
    """

    def __init__(
        self,
        diffs: list[dict[str, Any]],
        failure_summary: str = "",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._diffs = list(diffs)
        self._failure_summary = failure_summary or ""
        self._summaries = summarize_touched_files(self._diffs)
        self._selected = 0

    def compose(self) -> ComposeResult:
        with Container(classes="modal"):
            yield Static(_modal_title(self._summaries), classes="title", id="title")
            yield Static(
                _modal_meta(self._summaries),
                classes="meta",
                id="meta",
            )
            with VerticalScroll(classes="diff", id="diff"):
                yield Static(_format_all_diffs(self._diffs), id="diff-text")
            yield Static(
                "Keys: [A]ccept  [R]evise  [Esc] reject  [C]opy diff  [F]ailure summary",
                classes="footer",
            )

    def on_mount(self) -> None:
        # If risky, change footer to warn
        if any(is_risky(s) for s in self._summaries):
            footer = self.query_one(".footer", Static)
            footer.update(
                "[red]RISKY DIFF[/]  Keys: [A]ccept  [R]evise  [Esc] reject  [C]opy  [F]ailure"
            )

    def action_dismiss_reject(self) -> None:
        self.dismiss(
            {"action": "reject", "ids": [d.get("id", "") for d in self._diffs]}
        )

    def action_accept(self) -> None:
        # Refuse to apply risky diffs by default; require confirmation.
        risky = any(is_risky(s) for s in self._summaries)
        if risky:
            self.app.bell()
            self.notify(
                "Refusing to apply risky diff. Press 'R' to revise, or fix risk first.",
                severity="warning",
            )
            return
        self.dismiss(
            {"action": "accept", "ids": [d.get("id", "") for d in self._diffs]}
        )

    def action_reject(self) -> None:
        self.dismiss(
            {
                "action": "revise",
                "ids": [d.get("id", "") for d in self._diffs],
                "note": "",
            }
        )

    def action_copy(self) -> None:
        text = _format_all_diffs(self._diffs)
        try:
            import pyperclip  # type: ignore

            pyperclip.copy(text)
            self.notify("Diff copied to clipboard.")
        except Exception:
            # Fall back: write to .cheater/last_diff.patch
            try:
                from pathlib import Path

                out = Path(self.app.state.project_root) / ".cheater" / "last_diff.patch"  # type: ignore[attr-defined]
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(text, encoding="utf-8")
                self.notify(f"Diff saved to {out} (no clipboard available).")
            except Exception as e:
                self.notify(f"Copy failed: {e}", severity="error")

    def action_open_failure(self) -> None:
        # Just emit via dismiss; the app can decide what to do.
        self.dismiss(
            {
                "action": "open_failure",
                "ids": [d.get("id", "") for d in self._diffs],
                "summary": self._failure_summary,
            }
        )


# --- helpers used by the modal ---


def _modal_title(summaries: list[DiffSummary]) -> str:
    if not summaries:
        return "Diff review (empty)"
    if len(summaries) == 1:
        s = summaries[0]
        risky = is_risky(s)
        head = "Diff review" + ("  [RISKY]" if risky else "")
        return f"{head}: {s.path}"
    return f"Diff review: {len(summaries)} files"


def _modal_meta(summaries: list[DiffSummary]) -> str:
    total_added = sum(s.added for s in summaries)
    total_removed = sum(s.removed for s in summaries)
    risky = [s for s in summaries if is_risky(s)]
    parts = [f"files: {len(summaries)}", f"+{total_added}", f"-{total_removed}"]
    if risky:
        parts.append(f"RISKY: {len(risky)}")
    return "    ".join(parts)


def _format_all_diffs(diffs: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for d in diffs:
        path = str(d.get("path", "?"))
        old = d.get("old", "") or ""
        new = d.get("new", "") or ""
        flags = d.get("risk_flags") or []
        score = float(d.get("risk_score", 0.0))
        head = f"=== {path}  +{_count_diff_lines(old, new)[0]} -{_count_diff_lines(old, new)[1]}  risk={score:.2f} ==="
        if flags:
            head += f"\n  flags: {'; '.join(flags)}"
        diff_text = format_unified_diff(path, old, new)
        chunks.append(head + "\n" + diff_text)
    return "\n\n".join(chunks) or "(empty diff)"
