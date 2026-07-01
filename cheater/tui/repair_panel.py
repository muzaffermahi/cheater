"""Repair panel: the focused UI for bug fixing.

The repair screen is a form-style mode. The user fills in:

* task (required)
* failing command (required)
* traceback / file (optional)
* max rounds
* allow test edits / dependency edits

When the user starts the repair, the screen flips to a "live" view
that shows localization, memory matches, attempts, diff and test
status using the other widgets (tool stream, inspector).

The form lives in the upper half, the live view in the lower half.
"""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import Button, Input, Static, Switch, TextArea

from cheater.tui import adapters
from cheater.tui.state import RepairConfig


class RepairScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("ctrl+r", "start", "Start"),
        Binding("ctrl+s", "stop", "Stop"),
    ]

    DEFAULT_CSS = """
    RepairScreen { layout: vertical; padding: 0 1; }
    RepairScreen .header { color: #61afef; text-style: bold; padding: 1 0 1 0; }
    RepairScreen .hint { color: #9ba1ad; padding: 0 0 1 0; }
    RepairScreen #form { height: auto; padding: 0 0 1 0; }
    RepairScreen .field { height: 3; padding: 0 0 1 0; }
    RepairScreen .field .label { color: #9ba1ad; padding: 0 0 0 0; }
    RepairScreen .row { height: 3; }
    RepairScreen .row .field { width: 1fr; padding: 0 1 0 0; }
    RepairScreen #buttons { height: 3; padding: 0 0 1 0; }
    RepairScreen #live { height: 1fr; border: round #3a3f4b; padding: 0 1; }
    RepairScreen #live .section { color: #61afef; text-style: bold; padding: 1 0 0 0; }
    """

    def __init__(self, project_root: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.project_root = project_root
        self.cfg = RepairConfig()
        self._running: bool = False

    def compose(self) -> ComposeResult:
        yield Static("Repair", classes="header")
        yield Static(
            "Fill the form, then [Ctrl+R] start. [Ctrl+S] stop. [Esc] back.",
            classes="hint",
        )
        with Container(id="form"):
            with Vertical(classes="field"):
                yield Static("task", classes="label")
                yield TextArea(id="task", text="")
            with Horizontal(classes="row"):
                with Vertical(classes="field"):
                    yield Static("failing command", classes="label")
                    yield Input(id="cmd", placeholder="e.g. pytest -x tests/test_x.py")
                with Vertical(classes="field"):
                    yield Static("max rounds", classes="label")
                    yield Input(id="rounds", value="5")
            with Vertical(classes="field"):
                yield Static("traceback (optional, paste here)", classes="label")
                yield TextArea(id="tb", text="")
            with Horizontal(classes="row"):
                with Horizontal(classes="field"):
                    yield Static("  allow test edits: ", classes="label")
                    yield Switch(id="allow_tests", value=False)
                with Horizontal(classes="field"):
                    yield Static("  allow dependency edits: ", classes="label")
                    yield Switch(id="allow_deps", value=False)
        with Horizontal(id="buttons"):
            yield Button("Start repair  (Ctrl+R)", id="start", variant="primary")
            yield Button("Stop  (Ctrl+S)", id="stop", variant="error", disabled=True)
        with VerticalScroll(id="live"):
            yield Static("[dim]repair not started yet[/]", id="live-text")

    # --- actions ---

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_start(self) -> None:
        if self._running:
            self.notify("already running", severity="warning")
            return
        self._read_form()
        if not self.cfg.task.strip():
            self.notify("task is required", severity="warning")
            return
        if not self.cfg.failing_command.strip():
            self.notify("failing command is required", severity="warning")
            return
        self._running = True
        self.query_one("#start", Button).disabled = True
        self.query_one("#stop", Button).disabled = False
        self._update_live("[bold]starting repair...[/]")
        self.run_worker(self._run_repair, exclusive=True, thread=True)

    def action_stop(self) -> None:
        if not self._running:
            return
        self._update_live("[yellow]stop requested[/]")
        # The actual loop does not support mid-run cancellation, but we
        # mark the state so the inspector and status reflect it.
        self.app.state.set_status("interrupted")
        self.notify("interrupt requested", severity="warning")

    # --- internals ---

    def _read_form(self) -> None:
        self.cfg.task = self.query_one("#task", TextArea).text.strip()
        self.cfg.failing_command = self.query_one("#cmd", Input).value.strip()
        self.cfg.traceback = self.query_one("#tb", TextArea).text.strip()
        try:
            self.cfg.max_rounds = int(self.query_one("#rounds", Input).value or "5")
        except ValueError:
            self.cfg.max_rounds = 5
        self.cfg.allow_test_edits = bool(self.query_one("#allow_tests", Switch).value)
        self.cfg.allow_dependency_edits = bool(
            self.query_one("#allow_deps", Switch).value
        )
        # also write into the global state so other panels can use it
        self.app.state.repair = self.cfg

    def _run_repair(self) -> None:
        """Worker: orchestrate localize -> memory -> tests -> agent loop.

        The whole flow runs in a worker thread. We push progress into
        the app via ``call_from_thread`` so the UI never blocks.
        """
        from pathlib import Path

        root = Path(self.project_root)
        self.app.call_from_thread(self._update_live, "[dim]localizing...[/]")
        try:
            loc = adapters.localize_task(
                self.cfg.task, root, traceback=self.cfg.traceback
            )
            self.app.call_from_thread(self._render_localization, loc)
        except Exception as e:
            self.app.call_from_thread(self._update_live, f"[red]localize error: {e}[/]")
            loc = {"ok": False, "suspected": []}

        # memory matches
        try:
            store = adapters.open_memory_store()
            hits = adapters.memory_search(store, self.cfg.task, top_k=5)
            self.app.call_from_thread(self._render_memory_hits, hits)
        except Exception as e:
            self.app.call_from_thread(self._update_live, f"[dim]memory: {e}[/]")

        # run failing command first to capture baseline
        self.app.call_from_thread(
            self._update_live, "[dim]running failing command...[/]"
        )
        try:
            fr = adapters.run_focused_tests(
                self.cfg.failing_command, root, timeout=120.0
            )
            self.app.call_from_thread(self._render_test, fr)
        except Exception as e:
            self.app.call_from_thread(self._update_live, f"[red]test error: {e}[/]")
            fr = {"ok": False}

        # if it already passes, we're done
        if fr.get("ok"):
            self.app.call_from_thread(
                self._update_live, "[green]command already passes -- nothing to fix[/]"
            )
            self.app.call_from_thread(self._finish, True, "command already passes")
            return

        # otherwise: run the agent loop with the failing command as a tool goal.
        self.app.call_from_thread(self._update_live, "[dim]running agent loop...[/]")
        task_text = self.cfg.task
        if self.cfg.failing_command:
            task_text += f"\n\nFailing command: {self.cfg.failing_command}"
        if self.cfg.traceback:
            task_text += f"\n\nTraceback:\n{self.cfg.traceback[:2000]}"

        def on_event(ev: Any) -> None:
            # called from the worker thread
            self.app.call_from_thread(self._handle_agent_event, ev)

        try:
            res = adapters.one_shot_agent_run(
                task_text,
                root,
                max_steps=self.cfg.max_rounds,
                read_only=False,
                on_event=on_event,
            )
            self.app.call_from_thread(self._render_agent_result, res)
            self.app.call_from_thread(
                self._finish,
                bool(res.get("ok")),
                "agent finished",
            )
        except Exception as e:
            self.app.call_from_thread(self._update_live, f"[red]agent error: {e}[/]")
            self.app.call_from_thread(self._finish, False, f"agent error: {e}")

    def _handle_agent_event(self, ev: Any) -> None:
        kind = ev.kind
        if kind == "tool_start":
            name = ev.get("action") or ev.get("name") or "?"
            args = ev.get("args") or {}
            tc = self.app.state.begin_tool(str(name), dict(args))
            self.app.push_event_to_tool_stream(tc)
        elif kind == "tool_end":
            # close the last tool
            if self.app.state.tool_calls:
                last = self.app.state.tool_calls[-1]
                if not last.finished_at:
                    self.app.state.end_tool(
                        last,
                        success=bool(ev.get("success", True)),
                        output=str(ev.get("result_summary", "")),
                        error=str(ev.get("error", "") or ""),
                    )
                    self.app.refresh_tool_stream()
        elif kind == "plan":
            self.app.state.inspector.plan = list(
                ev.get("args", {}).get("steps") or ev.get("message", "").splitlines()
            )
            self.app.refresh_inspector()
        elif kind == "run_finished":
            self.app.state.inspector.state = "done"
            self.app.refresh_inspector()
        elif kind == "error":
            self.app.state.add_error(str(ev.get("message", "error")))

    def _render_localization(self, loc: dict[str, Any]) -> None:
        if not loc.get("ok"):
            self._update_live(f"[dim]localization: {loc.get('error', 'no result')}[/]")
            return
        sus = loc.get("suspected", []) or []
        if not sus:
            self._update_live("[dim]localization: no suspects[/]")
            return
        # The localizer returns a list of dicts; we only need path + score
        # for the inspector.
        pairs: list[tuple[str, float]] = []
        for s in sus[:8]:
            if isinstance(s, dict):
                pairs.append((str(s.get("path", "?")), float(s.get("score", 0.0))))
            else:
                pairs.append((str(s), 0.0))
        self.app.state.inspector.localized_files = pairs
        self.app.refresh_inspector()
        lines = ["[bold]localized files[/]"]
        for p, sc in pairs:
            lines.append(f"  {p}  [dim]({sc:.2f})[/]")
        self._append_live("\n".join(lines))

    def _render_memory_hits(self, hits: list[dict[str, Any]]) -> None:
        if not hits:
            self._append_live("[dim]memory: no hits[/]")
            return
        # normalize for inspector
        normalized = []
        for h in hits:
            normalized.append(
                {
                    "id": h.get("id", "?"),
                    "text": (h.get("text") or "")[:120],
                }
            )
        self.app.state.inspector.memories = normalized
        self.app.refresh_inspector()
        lines = [f"[bold]memory hits[/]  ({len(hits)})"]
        for h in hits[:5]:
            text = (h.get("text") or "").splitlines()[0]
            if len(text) > 80:
                text = text[:77] + "..."
            lines.append(f"  [{h.get('id', '?')}] {text}")
        self._append_live("\n".join(lines))

    def _render_test(self, fr: dict[str, Any]) -> None:
        ok = bool(fr.get("ok"))
        rc = fr.get("returncode", "?")
        self.app.state.inspector.test_status = "passed" if ok else "failed"
        # try to compress the failure
        if not ok:
            try:
                cs = adapters.compress_failure(fr)
                self.app.state.inspector.test_summary = cs.get("summary", "")[:600]
            except Exception:
                self.app.state.inspector.test_summary = (
                    fr.get("stderr") or fr.get("stdout") or ""
                )[:600]
        self.app.refresh_inspector()
        status = "[green]PASS[/]" if ok else "[red]FAIL[/]"
        self._append_live(f"[bold]test[/]  {status}  rc={rc}")

    def _render_agent_result(self, res: dict[str, Any]) -> None:
        if not res.get("ok"):
            self._append_live(f"[red]agent error: {res.get('error', '?')}[/]")
            return
        result = res.get("result") or {}
        self._append_live(
            f"[bold]agent done[/]  success={result.get('success')}  "
            f"by={result.get('finished_by')}  steps={len(result.get('steps') or [])}  "
            f"elapsed={result.get('elapsed')}s"
        )

    def _finish(self, ok: bool, message: str) -> None:
        self._running = False
        self.query_one("#start", Button).disabled = False
        self.query_one("#stop", Button).disabled = True
        self._append_live(f"\n[bold]{'DONE' if ok else 'FAILED'}[/]  {message}")
        self.app.state.set_status("done" if ok else "error")

    # --- live view helpers ---

    def _update_live(self, text: str) -> None:
        s = self.query_one("#live-text", Static)
        s.update(text)

    def _append_live(self, text: str) -> None:
        s = self.query_one("#live-text", Static)
        current = s.renderable if hasattr(s, "renderable") else str(s.render())
        s.update(f"{current}\n{text}")
