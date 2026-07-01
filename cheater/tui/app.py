"""Cheater Cockpit: the main :class:`textual.app.App`.

This is the entry point for the TUI. It wires:

* the AppState (plain Python, no Textual)
* the layout: status bar, sidebar, center, inspector, composer
* the global keybindings (palette, interrupt, mode toggles, etc.)
* the slash command handler
* the command palette
* a single, mockable entry point for the agent loop
* a clean shutdown

The file is intentionally split into small, named methods so each
piece can be unit-tested in isolation.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable

from textual.app import App, ComposeResult
from textual.containers import (
    Container,
    Horizontal,
    Vertical,
    VerticalScroll,
)
from textual.widgets import Footer, Input, Static

from cheater.tui import adapters
from cheater.tui.command_palette import (
    CommandPaletteScreen,
    default_palette_actions,
)
from cheater.tui.diff_viewer import DiffReviewScreen
from cheater.tui.events import MODES
from cheater.tui.keybindings import GLOBAL_BINDINGS
from cheater.tui.screens import HelpScreen
from cheater.tui.slash_commands import (
    parse_slash_command,
    run_slash_command,
    slash_completions,
)
from cheater.tui.state import AppState
from cheater.tui.theme import APP_CSS
from cheater.tui.tool_stream import ToolStream
from cheater.tui.widgets import (
    EventCard,
    InspectorPanel,
    Sidebar,
    SidebarItem,
)


# Sidebar section titles shown in the left column.
SIDEBAR_SECTIONS: list[tuple[str, list[str]]] = [
    ("modes", list(MODES)),
    ("recent", []),  # filled at runtime
]


# --- main app ---


class CheaterCockpit(App):
    """The main Cheater TUI app."""

    CSS = APP_CSS
    BINDINGS = GLOBAL_BINDINGS

    def __init__(
        self,
        project_root: str | Path | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        root = Path(project_root or Path.cwd()).resolve()
        self.state = AppState(project_root=str(root))
        # Quick accessor for widgets that need to push events back to the
        # tool stream. The tool stream widget installs itself on mount.
        self._tool_stream: ToolStream | None = None
        self._inspector: InspectorPanel | None = None
        self._transcript: VerticalScroll | None = None
        self._status_bar: Static | None = None
        self._top_status: Static | None = None
        self._sidebar: Sidebar | None = None
        self._slash_hint: Static | None = None
        self._composer: Input | None = None
        self._last_submitted: str = ""
        # Track whether the worker is alive
        self._worker_active: bool = False
        # Worker result is set by the worker thread, then read by the UI
        # thread when call_from_thread fires the done callback.
        self._worker_result: dict[str, Any] | None = None
        self._worker_done_callback: Callable[[], None] | None = None
        # History (for ↑/↓ recall)
        self._history: list[str] = []
        self._history_idx: int = -1

    # --- layout ---

    def compose(self) -> ComposeResult:
        yield Static(self._top_status_text(), id="status")
        with Horizontal(id="layout"):
            yield Sidebar(self._sidebar_items(), id="sidebar")
            with Vertical(id="center"):
                yield Static(self._center_status_text(), id="tabs")
                with VerticalScroll(id="transcript"):
                    yield Static(self._welcome_text())
                self._tool_stream = ToolStream(id="tool-stream")
                self._tool_stream.display = False  # hidden by default
                yield self._tool_stream
            self._inspector = InspectorPanel(id="inspector")
            yield self._inspector
        with Container(id="composer-wrap"):
            yield Static("", id="slash-hint")
            # We use a single-line Input for the composer. Multi-line
            # pastes work fine; the agent itself can handle newlines.
            # Shift+Enter / Alt+Enter open a multi-line expansion modal.
            from textual.widgets import Input

            self._composer = Input(
                placeholder="Type a task, or / for slash commands. Enter to submit. Shift+Enter = newline.",
                id="composer",
            )
            yield self._composer
        yield Static(self._status_bar_text(), id="status-bar")
        yield Footer()

    def on_mount(self) -> None:
        # Wire up references
        self._status_bar = self.query_one("#status-bar", Static)
        self._top_status = self.query_one("#status", Static)
        self._transcript = self.query_one("#transcript", VerticalScroll)
        self._slash_hint = self.query_one("#slash-hint", Static)
        self._sidebar = self.query_one("#sidebar", Sidebar)
        # Initial focus
        self._composer.focus()
        # Refresh the inspector once so it shows the right section title
        self.refresh_inspector()
        self.refresh_top_status()

    # --- helpers used by compose ---

    def _sidebar_items(self) -> list[SidebarItem]:
        items: list[SidebarItem] = []
        for m in MODES:
            items.append(
                SidebarItem(
                    id=f"mode:{m}",
                    label=m.title(),
                    active=(m == self.state.mode),
                )
            )
        # recent traces (just labels, real list is loaded async)
        return items

    def _welcome_text(self) -> str:
        return (
            "Welcome to Cheater Cockpit.\n"
            "Type a task and press Enter. Try / for slash commands, "
            "Ctrl+P for the command palette, ? for help."
        )

    def _top_status_text(self) -> str:
        mode = self.state.mode
        status = self.state.status
        st_color = {
            "running": "running",
            "interrupted": "warn",
            "done": "ok",
            "error": "err",
        }.get(status, "muted")
        st_text = {
            "running": "running",
            "interrupted": "interrupted",
            "done": "done",
            "error": "error",
        }.get(status, "idle")
        return (
            f"  cheater  │  mode: [accent]{mode}[/]  │  "
            f"state: [{st_color}]{st_text}[/]  │  "
            f"model: {self._provider_status()}  â”‚  "
            f"root: {os.path.basename(self.state.project_root) or '.'}"
        )

    def _center_status_text(self) -> str:
        return "  chat · tools · diff · tests  ".replace(
            "  ", "  "
        )  # placeholder; the actual tab strip is the sidebar

    def _status_bar_text(self) -> str:
        s = self.state
        bits: list[str] = []
        if s.is_busy():
            bits.append("[running]● running[/]")
        else:
            bits.append("[dim]idle[/]")
        bits.append(f"[dim]mode:[/] [accent]{s.mode}[/]")
        bits.append(f"[dim]events:[/] {s.event_count}")
        bits.append(f"[dim]transcript:[/] {len(s.transcript)}")
        bits.append(f"[dim]tools:[/] {len(s.tool_calls)}")
        bits.append(f"[dim]diffs:[/] {len(s.proposed_diffs)}")
        if s.run_id:
            bits.append(f"[dim]run:[/] {s.run_id[:10]}")
        bits.append("[dim]help:[/] ?")
        return "  ".join(bits)

    def _provider_status(self) -> str:
        try:
            from cheater.providers import normalize_provider_name

            cfg = adapters.load_config_for_root(self.state.project_root)
            provider = getattr(cfg, "provider", None)
            name = normalize_provider_name(getattr(provider, "provider", "none"))
            model = getattr(provider, "model", "") or "-"
            return f"[accent]{name}[/]/{model}"
        except Exception:
            return "[err]unknown[/]"

    # --- refresh hooks (called by other widgets / screens) ---

    def refresh_top_status(self) -> None:
        if self._top_status is not None:
            self._top_status.update(self._top_status_text())

    def refresh_status_bar(self) -> None:
        if self._status_bar is not None:
            self._status_bar.update(self._status_bar_text())

    def refresh_inspector(self) -> None:
        if self._inspector is not None:
            self._inspector.render_state(self.state.inspector)

    def refresh_tool_stream(self) -> None:
        # Re-render the last tool card. The ToolStream already updates
        # itself when a tool starts/ends; this hook is for the app to
        # force a refresh after a long task.
        if self._tool_stream is not None:
            # no-op: cards update in place via ToolStream API
            pass

    def push_event_to_tool_stream(self, tc: Any) -> None:
        if self._tool_stream is not None:
            self._tool_stream.add_card(tc)

    def append_transcript(
        self, role: str, text: str, meta: dict[str, Any] | None = None
    ) -> None:
        if self._transcript is None or not self._transcript.is_mounted:
            return
        try:
            card = EventCard(role=role, text=text, meta=meta or {})
            self._transcript.mount(card)
            self._transcript.scroll_end(animate=False)
        except Exception:
            # Avoid crashing the TUI on a layout hiccup.
            pass
        self.refresh_status_bar()

    # --- composer / slash ---

    def on_input_changed(self, event: Any) -> None:
        try:
            if event.input.id != "composer":
                return
            text = event.value or ""
            self.state.composer_text = text
            if text.startswith("/"):
                self._show_slash_hint(text)
            elif self._slash_hint is not None:
                self._slash_hint.update("")
        except Exception as e:
            self._soft_ui_error("composer update", e)

    def on_input_submitted(self, event: Any) -> None:
        """Handle Enter on the composer Input."""
        try:
            if event.input.id != "composer":
                return
            text = event.value or ""
            if text.strip():
                self._submit_composer(text)
                self._composer.value = ""
                event.stop()
        except Exception as e:
            self._soft_ui_error("composer submit", e)

    def on_key(self, event: Any) -> None:
        # The Input widget handles Enter via Submitted; here we handle
        # additional shortcuts when the composer is focused.
        if (
            event.key in ("shift+enter", "ctrl+j")
            and self._composer
            and self._composer.has_focus
        ):
            # In the single-line composer, Shift+Enter opens a small
            # multi-line expansion modal. For most users, regular Enter
            # submits.
            self.action_open_composer_expand()
            event.stop()
            return
        if event.key == "up" and self._composer and self._composer.has_focus:
            if self._history:
                if self._history_idx == -1:
                    self._history_idx = len(self._history) - 1
                else:
                    self._history_idx = max(0, self._history_idx - 1)
                self._composer.value = self._history[self._history_idx]
                event.stop()
        elif event.key == "down" and self._composer and self._composer.has_focus:
            if self._history and self._history_idx >= 0:
                self._history_idx = min(len(self._history) - 1, self._history_idx + 1)
                self._composer.value = self._history[self._history_idx]
                event.stop()

    def _show_slash_hint(self, text: str) -> None:
        if self._slash_hint is None:
            return
        body = _slash_prefix(text)
        try:
            completions = slash_completions(body)
        except Exception as e:
            self._slash_hint.update(f"[red]slash autocomplete failed: {e}[/]")
            return
        if not completions:
            self._slash_hint.update("[dim]no matching slash commands[/]")
            return
        shown = completions[:6]
        parts = []
        for c in shown:
            parts.append(f"[accent]/{c.name}[/] {c.description[:40]}")
        more = (
            f"  [dim]+{len(completions) - len(shown)} more[/]"
            if len(completions) > len(shown)
            else ""
        )
        self._slash_hint.update("  ".join(parts) + more)

    def _soft_ui_error(self, where: str, exc: Exception) -> None:
        """Report a recoverable UI error without tearing down the app."""
        msg = f"{where}: {type(exc).__name__}: {exc}"
        if self._slash_hint is not None:
            try:
                self._slash_hint.update(f"[red]{msg}[/]")
            except Exception:
                pass
        try:
            self.notify(msg, severity="error", timeout=8)
        except Exception:
            pass

    def _submit_composer(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        self._last_submitted = text
        # history
        if not self._history or self._history[-1] != text:
            self._history.append(text)
        self._history_idx = -1
        # slash?
        if text.startswith("/"):
            parsed = parse_slash_command(text)
            if parsed is None:
                self.append_transcript("error", f"could not parse: {text!r}")
                return
            self.append_transcript("user", text)
            res = run_slash_command(self, parsed)
            if not res.ok:
                self.append_transcript("error", res.message)
            elif res.message:
                self.append_transcript("system", res.message)
            return
        # plain task
        self.append_transcript("user", text)
        self.action_run_chat(text)

    # --- chat / agent run ---

    def action_run_chat(self, text: str) -> None:
        """Run a chat-style agent loop on the given text."""
        if self._worker_active:
            self.notify(
                "a run is already in progress; press Ctrl+C to stop it",
                severity="warning",
            )
            return
        self.state.set_status("running")
        self.state.run_id = time.strftime("%Y%m%d-%H%M%S")
        self.refresh_top_status()
        self.refresh_status_bar()
        self.append_transcript("system", f"agent run {self.state.run_id}: {text}")

        def on_event(ev: Any) -> None:
            # called from the worker thread
            self.call_from_thread(self._handle_agent_event, ev)

        def task() -> dict[str, Any]:
            try:
                return adapters.one_shot_chat_answer(
                    text,
                    self.state.project_root,
                    on_event=on_event,
                )
            except Exception as e:
                return {"ok": False, "error": str(e)}

        def on_done() -> None:
            # Look up the result from the running worker via _worker_result
            # (set just before this fires) -- see on_worker_state_changed.
            self._worker_active = False
            result = self._worker_result or {"ok": False, "error": "no result"}
            self._worker_result = None
            self.state.set_status("done" if result.get("ok") else "error")
            self.refresh_top_status()
            self.refresh_status_bar()
            if not result.get("ok"):
                self.append_transcript(
                    "error", f"agent error: {result.get('error', '?')}"
                )
                return
            answer = result.get("answer") or {}
            final = str(answer.get("final") or "").strip()
            if not final:
                final = "No response text was returned."
            self.append_transcript("assistant", final)
            # show final summary in the inspector
            self.state.inspector.state = "done"
            self.state.last_run_summary = final
            self.refresh_inspector()

        self._worker_active = True
        self._worker_done_callback = on_done

        # The worker runs synchronously; it sets _worker_result before returning.
        # We then schedule on_done on the UI thread.
        def thread_task() -> None:
            try:
                self._worker_result = task()
            except Exception as e:
                self._worker_result = {"ok": False, "error": str(e)}
            finally:
                # Schedule the UI-thread callback
                self.call_from_thread(self._worker_done_callback)

        self.run_worker(thread_task, exclusive=True, thread=True, name="agent-run")

    def _handle_agent_event(self, ev: Any) -> None:
        """Apply a TuiEvent to UI state. Always called on the UI thread."""
        kind = ev.kind
        if kind == "tool_start":
            name = ev.get("action") or ev.get("name") or "?"
            args = ev.get("args") or {}
            tc = self.state.begin_tool(str(name), dict(args))
            self.push_event_to_tool_stream(tc)
        elif kind == "tool_end":
            if self.state.tool_calls:
                last = self.state.tool_calls[-1]
                if not last.finished_at:
                    self.state.end_tool(
                        last,
                        success=bool(ev.get("success", True)),
                        output=str(ev.get("result_summary", "")),
                        error=str(ev.get("error", "") or ""),
                    )
                    if self._tool_stream is not None:
                        self._tool_stream.update_last(last)
        elif kind == "plan":
            msg = ev.get("message") or ""
            steps = (
                ev.get("args", {}).get("steps")
                if isinstance(ev.get("args"), dict)
                else None
            )
            if steps:
                self.state.inspector.plan = list(steps)
            else:
                self.state.inspector.plan = [
                    ln for ln in str(msg).splitlines() if ln.strip()
                ]
            self.refresh_inspector()
        elif kind == "run_finished":
            self.state.inspector.state = "done"
            self.refresh_inspector()
        elif kind == "error":
            self.append_transcript("error", str(ev.get("message", "error")))
        elif kind == "system_message":
            self.append_transcript("system", str(ev.get("message", "")))
        elif kind == "budget":
            self.state.inspector.budget_used = int(ev.get("used", 0) or 0)
            self.state.inspector.budget_max = int(ev.get("max", 0) or 0)
            self.refresh_inspector()
        elif kind == "risk_flag":
            flag = str(ev.get("message", ""))
            if flag and flag not in self.state.inspector.risk_flags:
                self.state.inspector.risk_flags.append(flag)
            self.refresh_inspector()
        elif kind == "failure_summary":
            self.state.inspector.last_failure_class = str(ev.get("error_type", ""))
            self.state.inspector.test_status = "failed"
            self.refresh_inspector()
        # refresh the status bar
        self.refresh_status_bar()

    # --- action palette ---

    def action_palette(self) -> None:
        self.push_screen(CommandPaletteScreen(default_palette_actions()))

    # --- global key actions (referenced by BINDINGS) ---

    def action_interrupt(self) -> None:
        if not self._worker_active:
            self.notify("nothing to interrupt", severity="information")
            return
        self.state.set_status("interrupted")
        self.refresh_top_status()
        self.refresh_status_bar()
        self.append_transcript("system", "[yellow]interrupt requested[/]")
        # The actual loop can't be cancelled mid-step; we mark the state
        # so subsequent events are tagged accordingly.

    def action_clear_transcript(self) -> None:
        self.state.clear_transcript()
        # remove all children of the transcript scroller
        if self._transcript is not None:
            for w in list(self._transcript.children):
                w.remove()
            self._transcript.mount(Static(self._welcome_text()))
        if self._tool_stream is not None:
            self._tool_stream.clear()
        self.notify("cleared")

    def action_open_composer_expand(self) -> None:
        """Open a multi-line expansion modal for the composer.

        Useful when the user has a long task to type and wants to use
        newlines. On submit, the text replaces the composer text.
        """
        from textual.containers import Container
        from textual.screen import ModalScreen
        from textual.widgets import TextArea

        if self._composer is None:
            return

        class _ExpandScreen(ModalScreen):
            BINDINGS = [
                ("escape", "dismiss_cancel", "Cancel"),
                ("ctrl+enter", "submit", "Submit"),
            ]

            def __init__(self, initial: str) -> None:
                super().__init__()
                self._initial = initial

            def compose(self) -> ComposeResult:
                with Container(classes="modal"):
                    yield Static("multi-line composer", classes="title")
                    yield Static(
                        "Type a long task. Ctrl+Enter to submit, Esc to cancel.",
                        classes="hint",
                    )
                    yield TextArea(text=self._initial, id="expand-text")

            def action_submit(self) -> None:
                ta = self.query_one("#expand-text", TextArea)
                self.dismiss(ta.text or "")

            def action_dismiss_cancel(self) -> None:
                self.dismiss(None)

        def on_result(text: str | None) -> None:
            if text is not None:
                self._composer.value = text
                self._composer.focus()

        self.push_screen(_ExpandScreen(self._composer.value or ""), on_result)

    def action_open_repair(self) -> None:
        from cheater.tui.repair_panel import RepairScreen

        self.push_screen(RepairScreen(self.state.project_root))

    def action_open_traces(self) -> None:
        from cheater.tui.trace_viewer import TraceScreen

        self.push_screen(TraceScreen(self.state.project_root))

    def action_open_memory(self) -> None:
        from cheater.tui.memory_viewer import MemoryScreen

        self.push_screen(MemoryScreen(self.state.project_root))

    def action_open_skills(self) -> None:
        from cheater.tui.skill_viewer import SkillScreen

        self.push_screen(SkillScreen(self.state.project_root))

    def action_open_arena(self) -> None:
        from cheater.tui.arena_viewer import ArenaScreen

        self.push_screen(ArenaScreen(self.state.project_root))

    def action_open_settings(self) -> None:
        from cheater.tui.settings_viewer import SettingsScreen

        self.push_screen(SettingsScreen(self.state.project_root))

    def action_show_help(self) -> None:
        self.push_screen(HelpScreen())

    def action_toggle_inspector(self) -> None:
        self.state.show_inspector = not self.state.show_inspector
        if self.state.show_inspector:
            self.screen.set_class(True, "with-inspector")
        else:
            self.screen.set_class(False, "with-inspector")
        self.notify(f"inspector: {'on' if self.state.show_inspector else 'off'}")

    def action_toggle_compact(self) -> None:
        self.state.compact = not self.state.compact
        if self.state.compact:
            self.screen.set_class(True, "compact")
        else:
            self.screen.set_class(False, "compact")
        self.notify(f"compact: {'on' if self.state.compact else 'off'}")

    def action_toggle_tool_stream(self) -> None:
        if self._tool_stream is None:
            return
        self._tool_stream.display = not self._tool_stream.display
        self.notify(f"tool stream: {'on' if self._tool_stream.display else 'off'}")

    def action_switch_mode(self, mode: str) -> None:
        if not self.state.set_mode(mode):
            return
        # update sidebar highlight
        if self._sidebar is not None:
            self._sidebar.set_active(f"mode:{mode}")
        self.refresh_top_status()
        # Open the corresponding screen automatically.
        mapping = {
            "chat": None,
            "repair": self.action_open_repair,
            "memory": self.action_open_memory,
            "skills": self.action_open_skills,
            "arena": self.action_open_arena,
            "traces": self.action_open_traces,
            "settings": self.action_open_settings,
        }
        fn = mapping.get(mode)
        if fn is not None:
            fn()
        self.notify(f"mode: {mode}")

    def action_show_status(self) -> None:
        try:
            d = adapters.config_to_safe_dict(
                adapters.load_config_for_root(self.state.project_root)
            )
            prov = d.get("provider", {})
            arena = d.get("arena", {})
            msg = (
                f"provider: {prov.get('provider')}/{prov.get('model') or '-'}  "
                f"trace: {arena.get('trace_enabled')}  "
                f"context: {arena.get('context_budget')}  "
                f"events: {self.state.event_count}  "
                f"transcript: {len(self.state.transcript)}"
            )
        except Exception as e:
            msg = f"status error: {e}"
        self.notify(msg, timeout=8)

    def action_show_diff(self) -> None:
        try:
            d = adapters.git_diff(self.state.project_root)
            files = d.get("files", [])
            msg = f"{len(files)} files changed"
            if files:
                msg += ": " + ", ".join(files[:5])
                if len(files) > 5:
                    msg += f" (+{len(files) - 5} more)"
            self.notify(msg, timeout=8)
        except Exception as e:
            self.notify(f"diff error: {e}", severity="error")

    # --- sidebar click ---

    def on_sidebar_item_selected(self, event: Sidebar.ItemSelected) -> None:
        item_id = event.item_id
        if item_id.startswith("mode:"):
            self.action_switch_mode(item_id.split(":", 1)[1])

    # --- quick actions used by the command palette ---

    def action_quick_repo_map(self) -> None:
        try:
            res = adapters.build_repo_map(self.state.project_root)
            n = len(res.get("files", []))
            self.notify(f"repo map built: {n} files", timeout=6)
        except Exception as e:
            self.notify(f"repo map error: {e}", severity="error")

    def action_quick_search_repo(self) -> None:
        # ask the user for a query via the composer placeholder
        if self._composer is not None:
            self._composer.value = "/map "
            self._composer.focus()
        self.notify("type a query and press Enter")

    def action_quick_run_tests(self) -> None:
        try:
            cmd = adapters.detect_test_command(self.state.project_root)
            if not cmd:
                self.notify("no test command detected", severity="warning")
                return
            r = adapters.run_focused_tests(cmd, self.state.project_root, timeout=120.0)
            status = "PASS" if r.get("ok") else "FAIL"
            self.notify(
                f"test {status}  rc={r.get('returncode')}  cmd={cmd!r}", timeout=6
            )
        except Exception as e:
            self.notify(f"test error: {e}", severity="error")

    # --- diff review entry point ---

    def open_diff_review(
        self,
        diffs: list[dict[str, Any]],
        failure_summary: str = "",
    ) -> None:
        """Open the diff review modal for the given diffs.

        ``diffs`` is a list of dicts with at least ``path``; see
        :mod:`cheater.tui.diff_viewer`.
        """

        def on_decision(decision: dict[str, Any] | None) -> None:
            if not decision:
                return
            action = decision.get("action")
            if action == "accept":
                self._apply_diffs(diffs)
            elif action == "reject":
                self.append_transcript("system", "diff rejected")
            elif action == "revise":
                self.append_transcript("system", "diff marked for revision")
            elif action == "open_failure":
                if failure_summary:
                    self.append_transcript(
                        "system", f"failure:\n{failure_summary[:1500]}"
                    )

        self.push_screen(DiffReviewScreen(diffs, failure_summary), on_decision)

    def _apply_diffs(self, diffs: list[dict[str, Any]]) -> None:
        applied = 0
        for d in diffs:
            try:
                res = adapters.apply_replace_patch(
                    str(d.get("path", "")),
                    str(d.get("old", "")),
                    str(d.get("new", "")),
                    self.state.project_root,
                )
                if res.get("ok"):
                    applied += 1
                else:
                    self.append_transcript("error", f"apply failed: {res.get('error')}")
            except Exception as e:
                self.append_transcript("error", f"apply exception: {e}")
        self.append_transcript("system", f"applied {applied} diff(s)")


# --- entry point ---


def run_cockpit(project_root: str | Path | None = None) -> int:
    """Launch the Cheater Cockpit. Returns the process exit code."""
    root = Path(project_root or Path.cwd()).resolve()
    CheaterCockpit(project_root=root).run()
    return 0


def _slash_prefix(text: str) -> str:
    """Return the command-name prefix from a composer slash string.

    This function is intentionally total: every input string returns a
    string and never raises. A bare "/" returns "" so the full menu is
    shown while the user is deciding.
    """
    if not text or not text.startswith("/"):
        return ""
    body = text[1:].lstrip()
    if not body:
        return ""
    return body.split(None, 1)[0].lower()
