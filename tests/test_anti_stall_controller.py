"""Tests for cheater.anti_stall_controller. NO network, no real processes."""
from __future__ import annotations

import unittest
from unittest import mock

from cheater.anti_stall import (
    ProgressLedger,
    StallAssessment,
    StallDetector,
    StallReason,
    compute_test_fingerprint,
    make_fingerprint_from_step,
)
from cheater.anti_stall_controller import (
    AntiStallController,
    AntiStallOutcome,
    DebugSnapshot,
    StrategyNoveltyPolicy,
)
from cheater.ledger import CompletionLedger
from cheater.lifecycle import FailureClass
from cheater.playbooks import Playbook, PlaybookKind
from cheater.recovery import (
    BannedActionSet,
    LadderConfig,
    RecoveryLevel,
    StrategyRecord,
)
from cheater.strategy import Strategy, StrategyKind


def _small_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.CLI_PACKAGE,
        title="CLI / package test",
        description="A CLI tool or library package with a unit-test suite.",
        worker_brief="You are a small-model worker for a CLI / package task.",
        invariants=["Run only the project's declared test command."],
        focus_paths=["src/**", "tests/**"],
        plan=[],
        artifacts=["test-output.txt"],
        failure_hints={},
        recoveries={},
        expect_scoring=False,
        tags=["cli"],
    )


class TestAntiStallControllerConstruction(unittest.TestCase):
    def test_for_task_picks_playbook(self):
        c = AntiStallController.for_task(
            "Add a Playwright test",
            _small_playbook(),
            CompletionLedger(user_goal="x"),
        )
        self.assertEqual(c.playbook.kind, PlaybookKind.CLI_PACKAGE)
        self.assertEqual(c.user_goal, "Add a Playwright test")
        self.assertIsNotNone(c.initial_strategy)

    def test_initial_strategy_is_recorded(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        self.assertEqual(len(c.strategy_record.strategies), 1)
        self.assertEqual(c.strategy_record.last.kind, StrategyKind.IMPLEMENT)


class TestObserveStep(unittest.TestCase):
    def test_observe_step_returns_fingerprint(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        fp = c.observe_step(
            action="read_file", args={"path": "x.py"},
            success=True, summary="ok", files_read=["x.py"],
        )
        self.assertEqual(fp.action, "read_file")
        self.assertEqual(c.step_count, 1)

    def test_observe_step_keeps_running_assessment(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        c.observe_step(action="read_file", args={"path": "x.py"},
                      success=True, summary="ok", files_read=["x.py"])
        self.assertEqual(c.last_assessment.reason, StallReason.NONE)

    def test_observe_step_detects_repeats(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest tests/test_x.py"},
                success=False, summary="fail",
                commands_run=["pytest tests/test_x.py"],
            )
        self.assertTrue(c.last_assessment.is_stalled)


class TestIsActionAllowed(unittest.TestCase):
    def test_default_always_allows(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        allowed, _ = c.is_action_allowed("read_file", {"path": "x.py"})
        self.assertTrue(allowed)

    def test_ban_blocks_action(self):
        from cheater.anti_stall import tool_args_sig
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        sig = tool_args_sig("run_command", {"cmd": "x"})
        c.banned.ban("run_command", sig, reason="repeat")
        allowed, reason = c.is_action_allowed("run_command", {"cmd": "x"})
        self.assertFalse(allowed)
        self.assertIn("banned", reason)


class TestCommitStrategy(unittest.TestCase):
    def test_commit_records_in_strategy_record(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        s = Strategy(kind=StrategyKind.DIAGNOSE, hypothesis="h")
        c.commit_strategy(s)
        self.assertEqual(c.strategy_record.last, s)


class TestStrategyIsNovel(unittest.TestCase):
    def test_first_strategy_is_always_novel(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        # Clear the initial strategy so we have a clean slate.
        c.strategy_record = StrategyRecord()
        s = Strategy(kind=StrategyKind.IMPLEMENT)
        ok, _ = c.strategy_is_novel(s)
        self.assertTrue(ok)

    def test_same_kind_same_args_is_not_novel(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        s1 = Strategy(
            kind=StrategyKind.IMPLEMENT,
            smallest_next_action="read_file x.py",
        )
        c.commit_strategy(s1)
        s2 = Strategy(
            kind=StrategyKind.IMPLEMENT,
            smallest_next_action="read_file x.py",
        )
        ok, _ = c.strategy_is_novel(s2)
        self.assertFalse(ok)

    def test_different_kind_is_novel(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        s1 = Strategy(kind=StrategyKind.IMPLEMENT, smallest_next_action="x")
        c.commit_strategy(s1)
        s2 = Strategy(kind=StrategyKind.DIAGNOSE, smallest_next_action="y")
        ok, _ = c.strategy_is_novel(s2)
        self.assertTrue(ok)


class TestRecoveryEscalation(unittest.TestCase):
    def test_on_stall_returns_none_when_idle(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        # No steps observed.
        self.assertIsNone(c.on_stall())

    def test_on_stall_returns_action_on_repeat(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        action = c.on_stall()
        self.assertIsNotNone(action)
        self.assertEqual(action.level, RecoveryLevel.LOCAL_NUDGE)
        self.assertEqual(c.recovery_history, [action])

    def test_escalation_climbs_levels(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
            ladder_config=LadderConfig(
                max_local_nudges=1, max_context_rebases=1, max_fresh_workers=1,
                max_strategy_switches=1, max_isolations=1,
            ),
        )
        # Force a stall.
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        levels = []
        for _ in range(5):
            action = c.on_stall()
            if action is None:
                break
            levels.append(action.level)
        self.assertEqual(levels, [
            RecoveryLevel.LOCAL_NUDGE,
            RecoveryLevel.CONTEXT_REBASE,
            RecoveryLevel.FRESH_WORKER,
            RecoveryLevel.STRATEGY_SWITCH,
            RecoveryLevel.ISOLATE,
        ])

    def test_honest_blocked_after_exhaustion(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
            ladder_config=LadderConfig(
                max_local_nudges=1, max_context_rebases=1, max_fresh_workers=1,
                max_strategy_switches=1, max_isolations=1,
            ),
        )
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        for _ in range(5):
            action = c.on_stall()
            if action is None:
                break
        # One more escalation -> blocked.
        action = c.on_stall()
        self.assertIsNotNone(action)
        self.assertEqual(action.level, RecoveryLevel.HONEST_BLOCKED)
        self.assertTrue(c.ladder.is_blocked())

    def test_blocked_report_contains_attempts(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(),
            CompletionLedger(user_goal="x"),
            ladder_config=LadderConfig(
                max_local_nudges=1, max_context_rebases=1, max_fresh_workers=1,
                max_strategy_switches=1, max_isolations=1,
            ),
        )
        # Give the ladder something to report.
        ledger = c.ledger
        ledger.record_command("pytest")
        ledger.record_file_change("cheater/x.py")
        ledger.record_failure("boom", failure_class=FailureClass.APP_BUG)
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        for _ in range(5):
            action = c.on_stall()
            if action is None:
                break
        action = c.on_stall()
        self.assertIsNotNone(action)
        self.assertIsNotNone(c.ladder.blocked_report)
        # The blocked report mentions the failure class.
        report = c.ladder.blocked_report
        self.assertIn("cheater/x.py", report.files_changed)
        self.assertIn("pytest", report.tried)

    def test_fresh_worker_spawned_at_level_3(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
            ladder_config=LadderConfig(
                max_local_nudges=1, max_context_rebases=1,
            ),
        )
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        # Two escalations: local_nudge, context_rebase. Fresh worker not yet.
        c.on_stall()
        c.on_stall()
        # Third escalation: fresh_worker.
        action = c.on_stall()
        self.assertEqual(action.level, RecoveryLevel.FRESH_WORKER)
        self.assertEqual(c.fresh_workers_spawned, 1)


class TestCapsuleBuilding(unittest.TestCase):
    def test_capsule_built_on_stall(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        c.on_stall()
        self.assertIsNotNone(c.last_capsule)

    def test_capsule_lists_banned_actions(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        c.banned.ban("run_command", "pytest", reason="repeat")
        # Force a stall so the controller builds a capsule.
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        c.on_stall()
        self.assertIsNotNone(c.last_capsule)
        # The controller pre-banned run_command "pytest" and the
        # ladder also banned it after the stall. We just check
        # that the pre-ban is in the capsule.
        actions = [b.action for b in c.last_capsule.banned_actions]
        self.assertIn("run_command", actions)

    def test_render_capsule_is_bounded(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        c.observe_step(action="read_file", args={"path": "x.py"},
                      success=True, summary="ok", files_read=["x.py"])
        text = c.render_capsule()
        self.assertLess(len(text), 5000)


class TestOutcome(unittest.TestCase):
    def test_outcome_includes_final_level(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
            ladder_config=LadderConfig(
                max_local_nudges=1, max_context_rebases=1,
            ),
        )
        for _ in range(3):
            c.observe_step(
                action="run_command", args={"cmd": "pytest"},
                success=False, summary="fail", commands_run=["pytest"],
            )
        c.on_stall()
        c.on_stall()
        outcome = c.outcome()
        self.assertEqual(outcome.final_level, RecoveryLevel.CONTEXT_REBASE.value)
        self.assertEqual(outcome.total_recoveries, 2)
        self.assertTrue(outcome.stalled)

    def test_outcome_when_not_stalled(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        outcome = c.outcome()
        self.assertEqual(outcome.final_level, 0)
        self.assertFalse(outcome.stalled)
        self.assertFalse(outcome.blocked)


class TestDebugSnapshot(unittest.TestCase):
    def test_debug_snapshot_contains_banned(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        c.banned.ban("run_command", "pytest", reason="repeat")
        snap = c.debug_snapshot()
        self.assertEqual(len(snap.banned), 1)


class TestLiftBans(unittest.TestCase):
    def test_lift_bans_clears_all(self):
        c = AntiStallController.for_task(
            "x", _small_playbook(), CompletionLedger(user_goal="x"),
        )
        c.banned.ban("run_command", "x")
        c.banned.ban("finish", "*")
        c.lift_bans()
        self.assertEqual(len(c.banned.active()), 0)


if __name__ == "__main__":
    unittest.main()
