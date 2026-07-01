"""Tests for cheater.lifecycle. NO network, no real processes."""

from __future__ import annotations

import unittest

from cheater.lifecycle import (
    CommandKind,
    FailureClass,
    OwnedCommand,
    OwnedProcess,
    ProcessRegistry,
    ProcessStatus,
    WorkspaceMismatch,
    classify_command,
    classify_failure,
    is_long_running,
    new_id,
    pick_recovery,
    workspace_signature,
)


class TestClassifyCommand(unittest.TestCase):
    def test_pytest_is_test(self):
        self.assertEqual(classify_command("pytest -x -q"), CommandKind.TEST)
        self.assertEqual(classify_command("pytest tests/test_x.py"), CommandKind.TEST)

    def test_npm_test_is_test(self):
        self.assertEqual(classify_command("npm test"), CommandKind.TEST)
        self.assertEqual(classify_command("pnpm test --watch=false"), CommandKind.TEST)

    def test_cargo_and_go_test(self):
        self.assertEqual(
            classify_command("cargo test --no-fail-fast"), CommandKind.TEST
        )
        self.assertEqual(classify_command("go test ./..."), CommandKind.TEST)

    def test_vite_dev_is_dev_server(self):
        self.assertEqual(classify_command("npm run dev"), CommandKind.DEV_SERVER)
        self.assertEqual(classify_command("next dev"), CommandKind.DEV_SERVER)
        self.assertEqual(classify_command("vite"), CommandKind.DEV_SERVER)

    def test_uvicorn_is_dev_server(self):
        self.assertEqual(
            classify_command("uvicorn app:app --reload"), CommandKind.DEV_SERVER
        )
        self.assertEqual(classify_command("gunicorn app:app"), CommandKind.DEV_SERVER)

    def test_curl_is_verify(self):
        self.assertEqual(
            classify_command("curl -s http://localhost:8000/"), CommandKind.VERIFY
        )
        self.assertEqual(classify_command("curl -e /api/health"), CommandKind.VERIFY)

    def test_scoring_keywords(self):
        self.assertEqual(classify_command("python score.py"), CommandKind.SCORING)
        self.assertEqual(classify_command("npm run benchmark"), CommandKind.SCORING)

    def test_unknown_falls_back_to_shell(self):
        self.assertEqual(classify_command("python -c 'print(1)'"), CommandKind.SHELL)
        self.assertEqual(classify_command(""), CommandKind.SHELL)

    def test_git_status_is_one_shot(self):
        self.assertEqual(classify_command("git status"), CommandKind.ONE_SHOT)
        self.assertEqual(classify_command("git diff --stat"), CommandKind.ONE_SHOT)

    def test_long_running_predicate(self):
        self.assertTrue(is_long_running(CommandKind.DEV_SERVER))
        self.assertFalse(is_long_running(CommandKind.TEST))
        self.assertFalse(is_long_running(CommandKind.ONE_SHOT))


class TestProcessRegistry(unittest.TestCase):
    def test_record_and_query_commands(self):
        r = ProcessRegistry()
        c = OwnedCommand(
            cmd_id="cmd-1",
            cmd="pytest",
            kind=CommandKind.TEST,
            cwd="/tmp",
            started_at=0.0,
        )
        r.record_command(c)
        self.assertEqual(len(r.all_commands()), 1)
        self.assertEqual(len(r.commands_by_kind(CommandKind.TEST)), 1)
        self.assertEqual(len(r.commands_by_kind(CommandKind.DEV_SERVER)), 0)

    def test_register_and_stop_processes(self):
        r = ProcessRegistry()
        stopped: list[str] = []
        proc = OwnedProcess(
            process_id="p1",
            label="vite",
            cmd="vite",
            kind=CommandKind.DEV_SERVER,
            started_at=0.0,
            stop=lambda: stopped.append("p1"),
        )
        r.register_process(proc)
        self.assertEqual(len(r.running_processes()), 1)
        r.stop_all_running()
        self.assertEqual(stopped, ["p1"])
        self.assertEqual(proc.status, ProcessStatus.STOPPED)

    def test_is_owned_process(self):
        r = ProcessRegistry()
        self.assertFalse(r.is_owned_process("nope"))
        r.register_process(
            OwnedProcess(
                process_id="owned-1",
                label="x",
                cmd="x",
                kind=CommandKind.DEV_SERVER,
                started_at=0.0,
            )
        )
        self.assertTrue(r.is_owned_process("owned-1"))

    def test_safe_cleanup_targets_only_owned(self):
        r = ProcessRegistry()
        r.register_process(
            OwnedProcess(
                process_id="owned-1",
                label="next-dev",
                cmd="next dev",
                kind=CommandKind.DEV_SERVER,
                started_at=0.0,
                workspace_sig="sig",
            )
        )
        targets = r.safe_cleanup_targets()
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0]["kind"], "process")
        self.assertEqual(targets[0]["id"], "owned-1")

    def test_stop_process_with_no_handle_marks_stopped(self):
        r = ProcessRegistry()
        r.register_process(
            OwnedProcess(
                process_id="p",
                label="p",
                cmd="p",
                kind=CommandKind.DEV_SERVER,
                started_at=0.0,
                stop=None,
            )
        )
        r.stop_all_running()
        # No exception; the registry must not crash. A process without
        # a stop handle is still considered "stopped" once the harness
        # has acknowledged it (the lifecycle is the source of truth).
        self.assertEqual(r.all_processes()[0].status, ProcessStatus.STOPPED)


class TestClassifyFailure(unittest.TestCase):
    def test_timeout_is_server_runtime(self):
        self.assertEqual(
            classify_failure(exit_code=1, stdout="", stderr="", timed_out=True),
            FailureClass.SERVER_RUNTIME,
        )

    def test_zero_exit_is_unknown(self):
        self.assertEqual(
            classify_failure(exit_code=0, stdout="", stderr="", timed_out=False),
            FailureClass.UNKNOWN,
        )

    def test_snapshot_baseline(self):
        cls = classify_failure(
            exit_code=1,
            stdout="FAIL  tests/test_x.py::test_foo\nSnapshot mismatch: + 1 - 0",
            stderr="",
        )
        self.assertEqual(cls, FailureClass.SNAPSHOT_BASELINE)

    def test_dependency(self):
        cls = classify_failure(
            exit_code=1,
            stdout="ModuleNotFoundError: No module named 'foo'",
            stderr="",
        )
        self.assertEqual(cls, FailureClass.DEPENDENCY)

    def test_stale_workspace(self):
        cls = classify_failure(
            exit_code=1,
            stdout="Server is serving a different workspace",
            stderr="",
        )
        self.assertEqual(cls, FailureClass.STALE_WORKSPACE)

    def test_app_bug_via_assertion(self):
        cls = classify_failure(
            exit_code=1,
            stdout="AssertionError: expected 1 to equal 2",
            stderr="",
        )
        self.assertEqual(cls, FailureClass.APP_BUG)

    def test_command_invocation(self):
        cls = classify_failure(
            exit_code=2,
            stdout="usage: pytest [options]",
            stderr="error: bad flag --bogus",
        )
        self.assertEqual(cls, FailureClass.COMMAND_INVOCATION)

    def test_port_in_use(self):
        cls = classify_failure(
            exit_code=1,
            stdout="Error: listen EADDRINUSE: address already in use :::3000",
            stderr="",
        )
        self.assertEqual(cls, FailureClass.SERVER_RUNTIME)

    def test_unknown_when_no_signal(self):
        cls = classify_failure(
            exit_code=1,
            stdout="random garbage that does not match any pattern",
            stderr="",
        )
        self.assertEqual(cls, FailureClass.UNKNOWN)


class TestPickRecovery(unittest.TestCase):
    def test_returns_a_recovery(self):
        for cls in FailureClass:
            action = pick_recovery(cls)
            self.assertTrue(action.name)
            self.assertEqual(action.failure_class, cls)

    def test_unknown_asks_instead_of_spinning(self):
        action = pick_recovery(FailureClass.UNKNOWN)
        self.assertEqual(action.name, "collect_diagnostics_and_ask")


class TestWorkspaceSignature(unittest.TestCase):
    def test_stable_for_same_dir(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            a = workspace_signature(d)
            b = workspace_signature(d)
            self.assertEqual(a, b)

    def test_changes_when_file_added(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            a = workspace_signature(d)
            (Path := __import__("pathlib").Path(d) / "x.py").write_text("x")
            b = workspace_signature(d)
            self.assertNotEqual(a, b)


class TestNewId(unittest.TestCase):
    def test_unique(self):
        a = new_id("cmd")
        b = new_id("cmd")
        self.assertNotEqual(a, b)
        self.assertTrue(a.startswith("cmd-"))


if __name__ == "__main__":
    unittest.main()
