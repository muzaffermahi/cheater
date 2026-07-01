"""Tests for cheater.lifecycle_controller. NO network, no real processes."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cheater.agent_loop import AgentLoop
from cheater.ledger import CompletionLedger
from cheater.lifecycle import (
    CommandKind,
    FailureClass,
    OwnedProcess,
    ProcessRegistry,
    ProcessStatus,
    classify_command,
)
from cheater.lifecycle_controller import LifecycleController
from cheater.playbooks import (
    Playbook,
    PlaybookKind,
    default_playbooks,
    select_playbook,
)
from cheater.providers import NoModelProvider, ProviderConfig
from cheater.runner import CommandResult
from cheater.stuck import StuckKind
from cheater.verification import (
    RunOutcome,
    StageResult,
    VerificationStage,
    VerificationStatus,
)


class TestLifecycleControllerForTask(unittest.TestCase):
    def test_selects_playbook_from_task(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("Add a Playwright e2e test", d)
            self.assertEqual(c.playbook.kind, PlaybookKind.WEBAPP)
            self.assertEqual(c.ledger.user_goal, "Add a Playwright e2e test")
            self.assertEqual(c.ledger.playbook, PlaybookKind.WEBAPP)

    def test_explicit_playbook_overrides_task(self):
        with tempfile.TemporaryDirectory() as d:
            pb = default_playbooks()[PlaybookKind.CLI_PACKAGE]
            c = LifecycleController.for_task(
                "Add a Playwright e2e test", d, playbook=pb
            )
            self.assertEqual(c.playbook.kind, PlaybookKind.CLI_PACKAGE)


class TestWrapRunner(unittest.TestCase):
    def test_wraps_runner_records_command(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("Run npm test", d)
            calls: list[tuple] = []

            def fake_runner(cmd, *, cwd=None, timeout=None, **kwargs):
                calls.append((cmd, cwd, timeout))
                return CommandResult(
                    cmd=cmd.split(),
                    returncode=0,
                    stdout="ok",
                    stderr="",
                    elapsed=0.1,
                )

            wrapped = c.wrap_runner(fake_runner)
            wrapped("pytest tests/test_x.py -q", cwd=d, timeout=30)
            wrapped("npm test", cwd=d, timeout=30)
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(c.registry.all_commands()), 2)
            kinds = [cmd.kind for cmd in c.registry.all_commands()]
            self.assertEqual(kinds, [CommandKind.TEST, CommandKind.TEST])
            self.assertIn("pytest tests/test_x.py -q", c.ledger.commands_run)

    def test_wrap_runner_records_failure(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("Run npm test", d)

            def fake_runner(cmd, **kwargs):
                return CommandResult(
                    cmd=cmd.split(),
                    returncode=1,
                    stdout="ModuleNotFoundError",
                    stderr="",
                    elapsed=0.1,
                )

            wrapped = c.wrap_runner(fake_runner)
            wrapped("pytest", cwd=d, timeout=30)
            cmd = c.registry.all_commands()[0]
            self.assertEqual(cmd.status, ProcessStatus.FAILED)
            self.assertEqual(cmd.exit_code, 1)


class TestFeedToolResult(unittest.TestCase):
    def test_records_files_written(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("x", d)
            tr = mock.Mock()
            tr.success = True
            tr.summary = "ok"
            tr.files_written = ["cheater/x.py"]
            tr.commands_run = []
            c.feed_tool_result("edit_file", {"path": "cheater/x.py"}, tr)
            self.assertIn("cheater/x.py", c.ledger.changed_files)
            self.assertEqual(c.worker_steps, 1)

    def test_records_commands_run(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("x", d)
            tr = mock.Mock()
            tr.success = True
            tr.summary = "ok"
            tr.files_written = []
            tr.commands_run = ["echo hi"]
            c.feed_tool_result("run_command", {"cmd": "echo hi"}, tr)
            self.assertIn("echo hi", c.ledger.commands_run)


class TestFeedFinishAttempt(unittest.TestCase):
    def test_blocks_finish_without_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("x", d)
            # No commands, no verification -> blocked.
            allowed, reason = c.feed_finish_attempt("done")
            self.assertFalse(allowed)
            self.assertIn("no work was done", reason)

    def test_allows_finish_with_verified_ledger(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("x", d)
            c.ledger.record_command("pytest")
            c.ledger.record_file_change("cheater/x.py")
            c.ledger.record_verification(
                [
                    StageResult(
                        stage=VerificationStage.SMOKE, status=VerificationStatus.OK
                    ),
                    StageResult(
                        stage=VerificationStage.SUMMARIZE, status=VerificationStatus.OK
                    ),
                ]
            )
            allowed, reason = c.feed_finish_attempt("ok")
            self.assertTrue(allowed, reason)


class TestFeedIDK(unittest.TestCase):
    def test_records_reason(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("x", d)
            c.feed_idk("can't fix")
            self.assertIn("idk", [e.kind for e in c.ledger.entries])


class TestRunVerification(unittest.TestCase):
    def test_uses_provided_results(self):
        with tempfile.TemporaryDirectory() as d:
            results = [
                StageResult(
                    stage=VerificationStage.SMOKE,
                    status=VerificationStatus.OK,
                    summary="ok",
                ),
                StageResult(
                    stage=VerificationStage.SUMMARIZE,
                    status=VerificationStatus.OK,
                    summary="ok",
                ),
            ]
            c = LifecycleController.for_task("x", d, verification_results=results)
            c.run_verification()
            self.assertEqual(len(c.ledger.verification), 2)


class TestStopRunningOnFinalize(unittest.TestCase):
    def test_stops_owned_processes(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("x", d)
            stopped: list[str] = []
            c.registry.register_process(
                OwnedProcess(
                    process_id="p",
                    label="p",
                    cmd="p",
                    kind=CommandKind.DEV_SERVER,
                    started_at=0.0,
                    stop=lambda: stopped.append("p"),
                )
            )
            c.finalize(success=True, reason="ok")
            self.assertEqual(stopped, ["p"])
            self.assertEqual(c.registry.get_process("p").status, ProcessStatus.STOPPED)


class TestFinalizeMarksDone(unittest.TestCase):
    def test_done_state_propagates(self):
        with tempfile.TemporaryDirectory() as d:
            c = LifecycleController.for_task("x", d)
            c.ledger.record_command("pytest")
            c.ledger.record_file_change("cheater/x.py")
            c.ledger.record_verification(
                [
                    StageResult(
                        stage=VerificationStage.SMOKE,
                        status=VerificationStatus.OK,
                        summary="ok",
                    ),
                    StageResult(
                        stage=VerificationStage.SUMMARIZE,
                        status=VerificationStatus.OK,
                        summary="ok",
                    ),
                ]
            )
            c.finalize(success=True, reason="ok", confidence="high")
            self.assertTrue(c.ledger.done)
            self.assertEqual(c.ledger.confidence, "high")


class TestAgentLoopWithLifecycle(unittest.TestCase):
    """End-to-end: the agent loop uses the lifecycle controller.

    These tests use FakeProvider to drive the loop through a normal
    finish path and confirm the lifecycle fields appear in LoopResult.
    """

    def _tmp(self) -> Path:
        return Path(tempfile.mkdtemp())

    def test_loop_finishes_with_lifecycle_outputs(self):
        d = self._tmp()
        (d / "x.py").write_text("x = 1\n", encoding="utf-8")
        (d / "test_x.py").write_text("def test_x(): assert True\n", encoding="utf-8")
        try:
            from tests.test_agent_loop import FakeProvider

            provider = FakeProvider(
                [
                    '{"plan": ["Read x.py", "Run pytest", "Finish"]}',
                    '{"action": "read_file", "args": {"path": "x.py"}}',
                    '{"action": "run_command", "args": {"cmd": "echo passed"}}',
                    '{"action": "finish", "args": {"summary": "ok", "evidence": "tests/test_x.py passed"}}',
                ]
            )
            # Pre-populate the verification record so the lifecycle
            # can let the finish through.
            verification_results = [
                StageResult(
                    stage=VerificationStage.SMOKE,
                    status=VerificationStatus.OK,
                    summary="ok",
                ),
                StageResult(
                    stage=VerificationStage.SUMMARIZE,
                    status=VerificationStatus.OK,
                    summary="ok",
                ),
            ]
            controller = LifecycleController.for_task(
                "fix the bug",
                d,
                verification_results=verification_results,
            )
            loop = AgentLoop(
                provider=provider,
                repo_root=d,
                lifecycle_controller=controller,
            )
            r = loop.run("fix the bug")
            self.assertTrue(r.success, r.error)
            # The lifecycle outputs should be present in the result.
            self.assertIsNotNone(r.ledger)
            self.assertIsNotNone(r.robustness)
            self.assertEqual(r.playbook, "cli_package")
            # The ledger must include the recorded command and the
            # verification record we provided.
            self.assertIn("echo passed", r.ledger["commands_run"])
            self.assertEqual(len(r.ledger["verification"]), 2)
        finally:
            import shutil

            shutil.rmtree(d, ignore_errors=True)

    def test_loop_blocks_finish_when_lifecycle_rejects(self):
        """Finish without verification is blocked by the lifecycle."""
        d = self._tmp()
        (d / "x.py").write_text("x = 1\n", encoding="utf-8")
        try:
            from tests.test_agent_loop import FakeProvider

            # 1: plan; 2: read_file; 3: finish (no verification yet) -> blocked
            # 4: run_command (harness records the command); 5: finish again -> still blocked (no verification)
            # 6: finish with vague evidence -> still blocked
            # 7: retry 2 -> i_dont_know
            provider = FakeProvider(
                [
                    '{"plan": ["Read", "Finish"]}',
                    '{"action": "read_file", "args": {"path": "x.py"}}',
                    '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
                    '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
                    '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
                ]
            )
            controller = LifecycleController.for_task("x", d)  # no verification
            loop = AgentLoop(
                provider=provider,
                repo_root=d,
                lifecycle_controller=controller,
            )
            r = loop.run("x")
            self.assertFalse(r.success)
            # Should be i_dont_know because finish kept being rejected.
            self.assertIn(r.finished_by, ("i_dont_know", "max_steps"))
        finally:
            import shutil

            shutil.rmtree(d, ignore_errors=True)

    def test_loop_no_lifecycle_still_works(self):
        """When no controller is provided, the loop is unchanged."""
        d = self._tmp()
        (d / "x.py").write_text("x = 1\n", encoding="utf-8")
        try:
            from tests.test_agent_loop import FakeProvider

            provider = FakeProvider(
                [
                    '{"plan": ["step1"]}',
                    '{"action": "finish", "args": {"summary": "ok", "evidence": "tests/test_x.py passed"}}',
                ]
            )
            loop = AgentLoop(provider=provider, repo_root=d)
            r = loop.run("x")
            self.assertTrue(r.success)
            # No lifecycle outputs.
            self.assertIsNone(r.ledger)
            self.assertIsNone(r.robustness)
            self.assertEqual(r.playbook, "")
        finally:
            import shutil

            shutil.rmtree(d, ignore_errors=True)

    def test_loop_idk_records_in_ledger(self):
        d = self._tmp()
        (d / "x.py").write_text("x = 1\n", encoding="utf-8")
        try:
            from tests.test_agent_loop import FakeProvider

            provider = FakeProvider(
                [
                    '{"plan": ["step1"]}',
                    '{"action": "i_dont_know", "args": {"reason": "model is stuck"}}',
                ]
            )
            controller = LifecycleController.for_task("x", d)
            loop = AgentLoop(
                provider=provider,
                repo_root=d,
                lifecycle_controller=controller,
            )
            r = loop.run("x")
            self.assertFalse(r.success)
            self.assertEqual(r.finished_by, "i_dont_know")
            # Ledger reflects the give-up.
            self.assertIsNotNone(r.ledger)
            self.assertFalse(r.ledger["done"])
        finally:
            import shutil

            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
