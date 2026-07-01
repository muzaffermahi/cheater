"""Tests for the Cheater Cockpit TUI module.

These tests cover:

* state machine (mode switching, transcript, tool stream)
* slash command parsing
* slash command lookup
* command palette filtering
* diff viewer touched-file parsing
* tool stream collapsing
* trace viewer ordering
* memory viewer filter
* settings redaction
* adapter sanity (no network)
* that the TUI module imports cleanly
* that the CLI entry point still works
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import pytest


# --- import smoke ---


def test_tui_package_imports() -> None:
    import cheater.tui

    assert cheater.tui.run_cockpit is not None
    assert "CheaterCockpit" in cheater.tui.__all__
    assert "MODES" in cheater.tui.__all__


def test_app_imports() -> None:
    from cheater.tui.app import CheaterCockpit, run_cockpit

    assert callable(run_cockpit)
    assert CheaterCockpit.__name__ == "CheaterCockpit"


# --- state machine ---


def test_state_mode_switching() -> None:
    from cheater.tui.state import AppState
    from cheater.tui.events import MODES

    s = AppState(project_root=".")
    for m in MODES:
        assert s.set_mode(m) is True
        assert s.mode == m
    assert s.set_mode("nonexistent") is False
    assert s.mode == MODES[-1]


def test_state_status_transitions() -> None:
    from cheater.tui.state import AppState

    s = AppState(project_root=".")
    assert s.status == "idle"
    assert s.is_busy() is False
    s.set_status("running")
    assert s.is_busy() is True
    s.set_status("done")
    assert s.is_busy() is False


def test_state_transcript_preserves_typed_text() -> None:
    """The composer text lives in state.composer_text; it must not be cleared
    when panels change."""
    from cheater.tui.state import AppState

    s = AppState(project_root=".")
    s.composer_text = "draft of my task"
    # switching mode does not clobber it
    s.set_mode("memory")
    assert s.composer_text == "draft of my task"
    s.set_mode("chat")
    assert s.composer_text == "draft of my task"


def test_state_begin_and_end_tool() -> None:
    from cheater.tui.state import AppState

    s = AppState(project_root=".")
    tc = s.begin_tool("read_file", {"path": "x.py"})
    assert tc.name == "read_file"
    assert tc.finished_at == 0.0
    assert s.inspector.last_tool == "read_file"
    s.end_tool(tc, success=True, output="hello\n" * 500)  # 3000 chars
    assert tc.finished_at > 0
    assert tc.success is True
    assert tc.output_truncated is True  # >1500 chars triggers truncation


def test_state_tool_long_output_is_truncated() -> None:
    from cheater.tui.state import AppState

    s = AppState(project_root=".")
    tc = s.begin_tool("read_file", {"path": "huge.py"})
    big = "x" * 5000
    s.end_tool(tc, success=True, output=big)
    assert len(tc.output) < len(big)
    assert tc.output_truncated is True


def test_state_transcript_messages() -> None:
    from cheater.tui.state import AppState

    s = AppState(project_root=".")
    s.add_user("hi")
    s.add_assistant("hello", {"ok": True})
    s.add_system("note")
    s.add_error("oops")
    assert len(s.transcript) == 4
    assert s.transcript[0].role == "user"
    assert s.transcript[1].role == "assistant"
    assert s.transcript[2].role == "system"
    assert s.transcript[3].role == "error"


def test_state_clear_resets() -> None:
    from cheater.tui.state import AppState, ProposedDiff

    s = AppState(project_root=".")
    s.add_user("hi")
    s.begin_tool("read_file", {})
    s.add_proposed_diff(ProposedDiff(path="a.py", old="", new=""))
    s.clear_transcript()
    assert s.transcript == []
    assert s.tool_calls == []
    assert s.proposed_diffs == []
    assert s.event_count == 0


# --- slash commands ---


def test_slash_parse_simple() -> None:
    from cheater.tui.slash_commands import parse_slash_command

    p = parse_slash_command("/help")
    assert p is not None
    assert p.name == "help"
    assert p.arg == ""

    p = parse_slash_command("/localize my bug")
    assert p is not None
    assert p.name == "localize"
    assert p.arg == "my bug"


def test_slash_parse_bare_slash() -> None:
    from cheater.tui.slash_commands import parse_slash_command

    p = parse_slash_command("/")
    assert p is not None
    assert p.name == ""
    assert p.arg == ""


def test_slash_parse_not_a_command() -> None:
    from cheater.tui.slash_commands import parse_slash_command

    assert parse_slash_command("hello") is None
    assert parse_slash_command("") is None
    assert parse_slash_command("not a slash /help") is None  # not at the start


def test_slash_lookup() -> None:
    from cheater.tui.slash_commands import find_command

    assert find_command("help") is not None
    assert find_command("?") is not None  # alias
    assert find_command("repair") is not None
    assert find_command("unknown_xyz") is None
    assert find_command("") is None


def test_slash_known_commands_complete() -> None:
    """All required commands are present."""
    from cheater.tui.slash_commands import KNOWN_COMMANDS

    names = {c.name for c in KNOWN_COMMANDS}
    required = {
        "help",
        "repair",
        "map",
        "localize",
        "test",
        "memory",
        "skills",
        "trace",
        "arena",
        "clear",
        "settings",
        "quit",
    }
    assert required.issubset(names), f"missing: {required - names}"


def test_slash_completions() -> None:
    from cheater.tui.slash_commands import slash_completions

    out = slash_completions("/rep")
    assert any(c.name == "repair" for c in out)
    out = slash_completions("/")
    assert len(out) == len(slash_completions(""))


def test_app_slash_prefix_is_total() -> None:
    from cheater.tui.app import _slash_prefix

    assert _slash_prefix("") == ""
    assert _slash_prefix("hello") == ""
    assert _slash_prefix("/") == ""
    assert _slash_prefix("/   ") == ""
    assert _slash_prefix("/rep") == "rep"
    assert _slash_prefix("/repair fix this") == "repair"


def test_slash_run_unknown_returns_error() -> None:
    from cheater.tui.slash_commands import (
        parse_slash_command,
        run_slash_command,
        SlashResult,
    )

    class FakeApp:
        def notify(self, *a: Any, **kw: Any) -> None:
            pass

        def exit(self) -> None:
            pass

        state = type("S", (), {"is_busy": staticmethod(lambda: False)})()

    p = parse_slash_command("/nonsense_xyz")
    assert p is not None
    res = run_slash_command(FakeApp(), p)
    assert isinstance(res, SlashResult)
    assert res.ok is False
    assert "unknown" in res.message


def test_slash_run_help_uses_notify() -> None:
    """Help should call app.notify with the help text; it must not raise."""
    from cheater.tui.slash_commands import parse_slash_command, run_slash_command

    captured: list[str] = []

    class FakeApp:
        def notify(self, msg: str, *a: Any, **kw: Any) -> None:
            captured.append(msg)

    p = parse_slash_command("/help")
    res = run_slash_command(FakeApp(), p)
    assert res.ok is True
    assert any("slash commands" in c for c in captured)


# --- command palette ---


def test_palette_actions_present() -> None:
    from cheater.tui.command_palette import default_palette_actions

    actions = default_palette_actions()
    ids = {a["id"] for a in actions}
    expected = {
        "start_repair",
        "build_repo_map",
        "search_repo_map",
        "run_focused_tests",
        "open_memory",
        "open_skills",
        "open_traces",
        "open_arena",
        "toggle_inspector",
        "toggle_compact",
        "interrupt",
    }
    assert expected.issubset(ids), f"missing: {expected - ids}"


def test_palette_actions_unique_ids() -> None:
    from cheater.tui.command_palette import default_palette_actions

    ids = [a["id"] for a in default_palette_actions()]
    assert len(ids) == len(set(ids)), "duplicate palette action ids"


# --- diff viewer ---


def test_diff_summarize_empty() -> None:
    from cheater.tui.diff_viewer import summarize_touched_files

    assert summarize_touched_files([]) == []


def test_diff_summarize_counts_lines() -> None:
    from cheater.tui.diff_viewer import summarize_touched_files

    items = [
        {
            "path": "a.py",
            "old": "x = 1\ny = 2\nz = 3\n",
            "new": "x = 1\ny = 22\nz = 3\n",
        }
    ]
    s = summarize_touched_files(items)
    assert len(s) == 1
    assert s[0].added == 1
    assert s[0].removed == 1
    assert s[0].path == "a.py"


def test_diff_format_unified_diff() -> None:
    from cheater.tui.diff_viewer import format_unified_diff

    text = format_unified_diff("a.py", "x = 1\n", "x = 2\n")
    assert "--- a/a.py" in text
    assert "+++ b/a.py" in text
    assert "-x = 1" in text
    assert "+x = 2" in text


def test_diff_is_risky() -> None:
    from cheater.tui.diff_viewer import summarize_touched_files, is_risky

    s = summarize_touched_files(
        [
            {
                "path": "a.py",
                "old": "",
                "new": "x",
                "risk_score": 0.9,
            }
        ]
    )[0]
    assert is_risky(s) is True

    s = summarize_touched_files(
        [
            {
                "path": "a.py",
                "old": "x",
                "new": "y",
                "risk_score": 0.1,
            }
        ]
    )[0]
    assert is_risky(s) is False

    s = summarize_touched_files(
        [
            {
                "path": "a.py",
                "old": "",
                "new": "secret=ABCDEFG",
                "is_create": True,
                "risk_flags": ["forbidden path"],
            }
        ]
    )[0]
    assert is_risky(s) is True


# --- tool stream ---


def test_tool_stream_summary_args_truncates() -> None:
    from cheater.tui.tool_stream import _summarize_args, _clip_one_line

    long_value = "x" * 100
    out = _summarize_args({"path": long_value})
    assert "..." in out
    assert len(out) < 200
    assert _clip_one_line("hello\nworld") == "hello"


# --- trace viewer ---


def test_trace_viewer_orders_events_by_index() -> None:
    """The trace viewer must walk events in order; here we just verify the
    summarizer keeps the input ordering intact."""
    from cheater.tui import adapters

    # Use a temp dir; no traces expected
    events = [
        {"ts": 1, "event": "run_start", "payload": {"task": "x"}},
        {"ts": 2, "event": "tool_call", "payload": {"name": "read_file"}},
        {"ts": 3, "event": "run_finished", "payload": {"success": True}},
    ]
    # write a fake trace
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp) / ".cheater" / "traces"
        d.mkdir(parents=True, exist_ok=True)
        p = d / "fake.jsonl"
        p.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
        loaded = adapters.load_trace(str(Path(tmp)), "fake")
        assert [e["event"] for e in loaded] == [
            "run_start",
            "tool_call",
            "run_finished",
        ]


def test_trace_viewer_list_empty_for_missing_dir(tmp_path: Path) -> None:
    from cheater.tui import adapters

    assert adapters.list_traces(str(tmp_path)) == []


# --- memory viewer ---


def test_memory_adapter_roundtrip(tmp_path: Path) -> None:
    from cheater.tui import adapters

    store = adapters.open_memory_store(str(tmp_path))
    # 'pytest' is not a stopword; 'tests' is, so we use a unique token.
    mid = adapters.memory_add(
        store, "remember to add pytest coverage", ["pytest", "rule"]
    )
    assert mid
    items = adapters.memory_list(store)
    assert any(it["id"] == mid for it in items)
    hits = adapters.memory_search(store, "pytest", top_k=5)
    assert any(h["id"] == mid for h in hits)
    n = adapters.memory_forget(store, mid, None)
    assert n == 1
    assert adapters.memory_list(store) == []


def test_memory_redact() -> None:
    from cheater.tui import adapters

    out = adapters.redact(
        {
            "id": "x",
            "text": "the api_key=sk-abcdefghijklmnop is leaked",
            "tags": ["secret"],
        }
    )
    # secret substring scrubbed
    assert "sk-***REDACTED***" in out["text"]
    assert "sk-abcdefghijklmnop" not in out["text"]


# --- settings / config ---


def test_settings_redacts_api_key(tmp_path: Path) -> None:
    from cheater.tui import adapters
    from cheater.config import CheaterConfig

    cfg = CheaterConfig()
    cfg.project_root = str(tmp_path)
    cfg.provider.api_key = "sk-supersecret"
    d = adapters.config_to_safe_dict(cfg)
    # redacted in to_dict; should not contain the real key
    assert d["provider"]["api_key"] != "sk-supersecret"
    assert "REDACTED" in d["provider"]["api_key"]


# --- adapters sanity (no network) ---


def test_adapter_localize_returns_dict(tmp_path: Path) -> None:
    from cheater.tui import adapters

    # Even on an empty dir, localize_task should return a small dict
    # without raising.
    out = adapters.localize_task("nothing to find", tmp_path)
    assert "ok" in out
    assert "suspected" in out


def test_adapter_repo_map_on_empty_dir(tmp_path: Path) -> None:
    from cheater.tui import adapters

    out = adapters.build_repo_map(tmp_path)
    assert "files" in out
    assert isinstance(out["files"], list)


def test_adapter_traces_on_empty_dir(tmp_path: Path) -> None:
    from cheater.tui import adapters

    assert adapters.list_traces(tmp_path) == []


def test_adapter_arena_on_empty_dir(tmp_path: Path) -> None:
    from cheater.tui import adapters

    assert adapters.latest_arena_report(tmp_path) is None
    assert adapters.list_arena_reports(tmp_path) == []


def test_adapter_git_diff_handles_non_git(tmp_path: Path) -> None:
    from cheater.tui import adapters

    out = adapters.git_diff(tmp_path)
    # non-git dirs may return ok=False or ok=True with empty diff
    assert "files" in out
    assert "diff" in out


def test_adapter_chat_answer_calls_openai_compatible_local_llm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    from cheater.tui import adapters

    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            seen.append(body)
            payload = {
                "choices": [
                    {"message": {"content": "hello from local llm"}},
                ]
            }
            data = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("CHEATER_PROVIDER", "openai")
        monkeypatch.setenv("CHEATER_MODEL", "local-test-model")
        monkeypatch.setenv(
            "CHEATER_BASE_URL",
            f"http://127.0.0.1:{server.server_port}/v1",
        )
        monkeypatch.delenv("CHEATER_API_KEY", raising=False)

        out = adapters.one_shot_chat_answer("say hello", tmp_path)
        assert out["ok"] is True
        assert out["answer"]["final"] == "hello from local llm"
        assert seen
        assert "local-test-model" in seen[0]
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_adapter_chat_answer_accepts_lm_studio_typo_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    from cheater.tui import adapters

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            _ = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            data = json.dumps(
                {"choices": [{"message": {"content": "actual qwen response"}}]}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("CHEATER_PROVIDER", "nonelm_studios")
        monkeypatch.setenv("CHEATER_MODEL", "qwen")
        monkeypatch.setenv(
            "CHEATER_BASE_URL",
            f"http://127.0.0.1:{server.server_port}/v1",
        )
        monkeypatch.delenv("CHEATER_API_KEY", raising=False)

        out = adapters.one_shot_chat_answer("hi", tmp_path)
        assert out["ok"] is True
        assert out["answer"]["final"] == "actual qwen response"
    finally:
        server.shutdown()
        thread.join(timeout=5)


# --- modes enumeration ---


def test_modes_list_complete() -> None:
    from cheater.tui.events import MODES

    assert set(MODES) == {
        "chat",
        "repair",
        "memory",
        "skills",
        "arena",
        "traces",
        "settings",
    }


# --- keybindings ---


def test_global_bindings_include_core() -> None:
    from cheater.tui.keybindings import GLOBAL_BINDINGS

    keys = {b.key for b in GLOBAL_BINDINGS}
    # Required: palette, interrupt, clear, repair, traces, memory, skills,
    # arena, inspector, help.
    required = {
        "ctrl+p",
        "ctrl+c",
        "ctrl+l",
        "ctrl+r",
        "ctrl+t",
        "ctrl+m",
        "ctrl+s",
        "ctrl+a",
        "ctrl+i",
        "question_mark",
    }
    assert required.issubset(keys), f"missing: {required - keys}"


# --- CLI integration ---


def test_cheater_tui_command_callable() -> None:
    from cheater.__main__ import main

    assert callable(main)
    assert main(["tui"]) == 2


def test_cheater_help_still_works() -> None:
    """The CLI must still respond to --help and not break."""
    from cheater.__main__ import main

    assert main(["--help"]) == 0


# --- Pilot tests (use Textual's testing API) ---


@pytest.mark.skipif(
    os.environ.get("CI") == "1",
    reason="skip in CI; requires textual to render in a headless terminal",
)
def test_cockpit_mounts_and_quits() -> None:
    """The simplest pilot smoke test: mount the app and quit."""
    from cheater.tui.app import CheaterCockpit

    async def run() -> None:
        app = CheaterCockpit(project_root=os.getcwd())
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            composer = app.query_one("#composer")
            composer.text = "/quit"
            await pilot.press("enter")
            await pilot.pause(0.2)

    asyncio.run(run())


@pytest.mark.skipif(
    os.environ.get("CI") == "1",
    reason="skip in CI; requires textual to render in a headless terminal",
)
def test_cockpit_palette_opens_and_closes() -> None:
    from cheater.tui.app import CheaterCockpit

    async def run() -> None:
        app = CheaterCockpit(project_root=os.getcwd())
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            await pilot.press("ctrl+p")
            await pilot.pause(0.2)
            await pilot.press("escape")
            await pilot.pause(0.2)

    asyncio.run(run())


@pytest.mark.skipif(
    os.environ.get("CI") == "1",
    reason="skip in CI; requires textual to render in a headless terminal",
)
def test_cockpit_bare_slash_autocomplete_does_not_crash() -> None:
    from cheater.tui.app import CheaterCockpit
    from textual.widgets import Static

    async def run() -> None:
        app = CheaterCockpit(project_root=os.getcwd())
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            composer = app.query_one("#composer")
            composer.value = "/"
            await pilot.pause(0.2)
            hint = app.query_one("#slash-hint", Static)
            assert "/help" in str(hint.render())
            composer.value = "/quit"
            await pilot.press("enter")
            await pilot.pause(0.2)

    asyncio.run(run())


@pytest.mark.skipif(
    os.environ.get("CI") == "1",
    reason="skip in CI; requires textual to render in a headless terminal",
)
def test_cockpit_switching_to_settings_does_not_duplicate_sidebar_ids() -> None:
    from cheater.tui.app import CheaterCockpit

    async def run() -> None:
        app = CheaterCockpit(project_root=os.getcwd())
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.3)
            app.action_switch_mode("settings")
            await pilot.pause(0.3)
            app.pop_screen()
            await pilot.pause(0.2)
            app.action_switch_mode("settings")
            await pilot.pause(0.3)
            app.exit()

    asyncio.run(run())


@pytest.mark.skipif(
    os.environ.get("CI") == "1",
    reason="skip in CI; requires textual to render in a headless terminal",
)
def test_cockpit_chat_flow_with_mocked_agent() -> None:
    """Send a chat message, run a mocked ask-mode agent, observe state changes."""
    import cheater.tui.adapters as adapters

    def fake_run(task, *args: Any, **kwargs: Any) -> dict[str, Any]:
        on_event = kwargs.get("on_event")
        if on_event is not None:
            from cheater.tui.events import make_event

            on_event(make_event("plan", message="Step 1\nStep 2"))
        return {
            "ok": True,
            "answer": {
                "task": task,
                "final": "mock local LLM answer",
                "plan": "Step 1\nStep 2",
            },
        }

    # Direct replacement because run_test interferes with context-managed
    # mocks. This is a quirk of Textual's test harness, not a real bug.
    original = adapters.one_shot_chat_answer
    adapters.one_shot_chat_answer = fake_run
    try:

        async def run() -> None:
            from cheater.tui.app import CheaterCockpit

            app = CheaterCockpit(project_root=os.getcwd())
            async with app.run_test(size=(120, 40)) as pilot:
                await pilot.pause(0.3)
                composer = app.query_one("#composer")
                composer.value = "fix the bug"
                await pilot.press("enter")
                # wait for the worker to finish
                await pilot.pause(2.0)
                assert app.state.status == "done"
                assert "Step 1" in app.state.inspector.plan
                assert app.state.last_run_summary == "mock local LLM answer"
                # submit /quit to exit
                composer.value = "/quit"
                await pilot.press("enter")
                await pilot.pause(0.3)

        asyncio.run(run())
    finally:
        adapters.one_shot_chat_answer = original
