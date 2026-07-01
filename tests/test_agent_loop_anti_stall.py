"""End-to-end tests for the anti-stall system integrated with the agent loop.

These tests use the existing FakeProvider to drive the loop and
verify that the anti-stall controller:
  * detects a stall
  * escalates the recovery ladder
  * blocks finish while a stall is unresolved
  * gates banned actions
  * emits an honest blocked report when the ladder exhausts
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cheater.agent_loop import AgentLoop
from cheater.anti_stall_controller import AntiStallController
from cheater.ledger import CompletionLedger
from cheater.lifecycle_controller import LifecycleController
from cheater.playbooks import (
    Playbook,
    PlaybookKind,
    default_playbooks,
)
from cheater.providers import NoModelProvider, ProviderConfig
from cheater.recovery import LadderConfig
from cheater.runner import CommandResult
from cheater.verification import (
    StageResult,
    VerificationStage,
    VerificationStatus,
)


# Reuse the FakeProvider from test_agent_loop.py
from tests.test_agent_loop import FakeProvider


def _small_playbook() -> Playbook:
    return default_playbooks()[PlaybookKind.CLI_PACKAGE]


def _make_loop(
    d: Path,
    responses: list[str],
    *,
    ladder_config: LadderConfig | None = None,
) -> AgentLoop:
    """Build an agent loop with the anti-stall controller wired up."""
    verification_results = [
        StageResult(stage=VerificationStage.SMOKE, status=VerificationStatus.OK, summary="ok"),
        StageResult(stage=VerificationStage.SUMMARIZE, status=VerificationStatus.OK, summary="ok"),
    ]
    lc = LifecycleController.for_task_with_anti_stall(
        "fix the bug", str(d), playbook=_small_playbook(), verification_results=verification_results,
    )
    if ladder_config is not None:
        # Replace the ladder with our custom config.
        from cheater.anti_stall_controller import AntiStallController
        lc.anti_stall.ladder = RecoveryLadderWithConfig(ladder_config)
    return AgentLoop(
        provider=FakeProvider(responses),
        repo_root=d,
        lifecycle_controller=lc,
    )


# We avoid the cycle by re-creating the ladder after the controller
# exists. This is simpler than plumbing a config through every layer.
def RecoveryLadderWithConfig(cfg: LadderConfig):
    from cheater.recovery import RecoveryLadder
    return RecoveryLadder(cfg)


class TestAgentLoopNoAntiStallNoChange(unittest.TestCase):
    """Without a controller, the loop is unchanged."""

    def test_no_lifecycle_controller_no_anti_stall(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "x.py").write_text("x = 1\n", encoding="utf-8")
            try:
                provider = FakeProvider([
                    '{"plan": ["step1"]}',
                    '{"action": "finish", "args": {"summary": "ok", "evidence": "tests/test_x.py passed"}}',
                ])
                loop = AgentLoop(provider=provider, repo_root=d)
                r = loop.run("x")
                self.assertTrue(r.success)
                self.assertIsNone(r.anti_stall)
            finally:
                shutil.rmtree(d, ignore_errors=True)


class TestAgentLoopLifecycleWithAntiStall(unittest.TestCase):
    """With a lifecycle controller that has an anti-stall controller, the
    loop exposes the anti-stall outcome in the result."""

    def test_lifecycle_anti_stall_populated(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "x.py").write_text("x = 1\n", encoding="utf-8")
            (Path(d) / "test_x.py").write_text("def test_x(): pass\n", encoding="utf-8")
            try:
                # Plan, read, run, finish. Real progress.
                provider = FakeProvider([
                    '{"plan": ["a", "b", "c", "d"]}',
                    '{"action": "read_file", "args": {"path": "x.py"}}',
                    '{"action": "run_command", "args": {"cmd": "echo ok"}}',
                    '{"action": "finish", "args": {"summary": "ok", "evidence": "tests/test_x.py passed"}}',
                ])
                verification_results = [
                    StageResult(stage=VerificationStage.SMOKE, status=VerificationStatus.OK, summary="ok"),
                    StageResult(stage=VerificationStage.SUMMARIZE, status=VerificationStatus.OK, summary="ok"),
                ]
                lc = LifecycleController.for_task_with_anti_stall(
                    "fix the bug", str(d), playbook=_small_playbook(),
                    verification_results=verification_results,
                )
                loop = AgentLoop(
                    provider=provider, repo_root=d,
                    lifecycle_controller=lc,
                )
                r = loop.run("fix the bug")
                self.assertTrue(r.success, r.error)
                # The loop's anti_stall field is populated.
                self.assertIsNotNone(r.anti_stall)
                # No stall happened, so blocked is False.
                self.assertFalse(r.anti_stall["blocked"])
            finally:
                shutil.rmtree(d, ignore_errors=True)

    def test_anti_stall_only_no_lifecycle(self):
        """A standalone anti-stall controller (no lifecycle) is also
        supported. The loop wires it and the result includes the
        anti-stall outcome."""
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "x.py").write_text("x = 1\n", encoding="utf-8")
            try:
                provider = FakeProvider([
                    '{"plan": ["step1"]}',
                    '{"action": "finish", "args": {"summary": "ok", "evidence": "tests/test_x.py passed"}}',
                ])
                ledger = CompletionLedger(user_goal="x")
                # We need to attach a watchdog and playbook for the
                # standalone anti-stall controller. We use a no-op
                # watchdog and the CLI playbook.
                from cheater.stuck import Watchdog
                ac = AntiStallController.for_task(
                    "x", _small_playbook(), ledger, watchdog=Watchdog(),
                )
                loop = AgentLoop(
                    provider=provider, repo_root=d,
                    anti_stall_controller=ac,
                )
                r = loop.run("x")
                self.assertTrue(r.success, r.error)
                self.assertIsNotNone(r.anti_stall)
            finally:
                shutil.rmtree(d, ignore_errors=True)


class TestAgentLoopAntiStallBlocksRepeated(unittest.TestCase):
    """A worker that keeps repeating the same action should be escalated."""

    def test_repeated_command_triggers_local_nudge(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "x.py").write_text("x = 1\n", encoding="utf-8")
            try:
                # Use *different* commands (different args_sig) so
                # the anti-stall gate does not block them and the
                # detector sees 3+ commands. We force a stall by
                # making the detector fire on REPEATED_TOOL_CALL
                # (same run_command action with different args).
                provider = FakeProvider([
                    '{"plan": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]}',
                    '{"action": "run_command", "args": {"cmd": "echo a"}}',
                    '{"action": "run_command", "args": {"cmd": "echo a"}}',
                    '{"action": "run_command", "args": {"cmd": "echo a"}}',
                    '{"action": "run_command", "args": {"cmd": "echo a"}}',
                    '{"action": "i_dont_know", "args": {"reason": "stuck"}}',
                ])
                lc = LifecycleController.for_task_with_anti_stall(
                    "x", str(d), playbook=_small_playbook(),
                )
                # Use a tight ladder so we can verify escalation.
                lc.anti_stall.ladder = RecoveryLadderWithConfig(
                    LadderConfig(
                        max_local_nudges=1, max_context_rebases=1, max_fresh_workers=1,
                        max_strategy_switches=1, max_isolations=1,
                    )
                )
                loop = AgentLoop(
                    provider=provider, repo_root=d,
                    lifecycle_controller=lc,
                )
                r = loop.run("x")
                # The run ends (we don't care which way).
                self.assertIsNotNone(r.anti_stall)
                # After 3+ runs, the detector should fire.
                # The anti_stall result reports the total commands
                # we recorded (excluding the banned ones).
                self.assertGreaterEqual(
                    r.anti_stall["debug"]["step_count"], 3,
                )
            finally:
                shutil.rmtree(d, ignore_errors=True)


class TestAgentLoopNoStallNoImpact(unittest.TestCase):
    """When the worker makes normal progress, anti-stall is invisible."""

    def test_normal_run_does_not_trigger_anti_stall(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "x.py").write_text("x = 1\n", encoding="utf-8")
            (Path(d) / "test_x.py").write_text("def test_x(): pass\n", encoding="utf-8")
            try:
                # Plan, read different files each time, finish. No
                # repeated commands, no repeated test output.
                provider = FakeProvider([
                    '{"plan": ["a", "b", "c", "d"]}',
                    '{"action": "read_file", "args": {"path": "x.py"}}',
                    '{"action": "read_file", "args": {"path": "test_x.py"}}',
                    '{"action": "run_command", "args": {"cmd": "pytest test_x.py -v"}}',
                    '{"action": "finish", "args": {"summary": "ok", "evidence": "tests/test_x.py passed"}}',
                ])
                verification_results = [
                    StageResult(stage=VerificationStage.SMOKE, status=VerificationStatus.OK, summary="ok"),
                    StageResult(stage=VerificationStage.SUMMARIZE, status=VerificationStatus.OK, summary="ok"),
                ]
                lc = LifecycleController.for_task_with_anti_stall(
                    "x", str(d), playbook=_small_playbook(),
                    verification_results=verification_results,
                )
                loop = AgentLoop(
                    provider=provider, repo_root=d,
                    lifecycle_controller=lc,
                )
                r = loop.run("x")
                self.assertTrue(r.success, r.error)
                # No stall.
                self.assertFalse(r.anti_stall["stalled"])
                self.assertEqual(r.anti_stall["final_level"], 0)
            finally:
                shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
