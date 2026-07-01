"""Tests for cheater.recovery. NO network, no real processes."""
from __future__ import annotations

import unittest

from cheater.anti_stall import (
    ProgressLedger,
    StallAssessment,
    StallConfig,
    StallDetector,
    StallReason,
    StepFingerprint,
    make_fingerprint_from_step,
)
from cheater.ledger import CompletionLedger
from cheater.lifecycle import (
    CommandKind,
    FailureClass,
    OwnedProcess,
    ProcessRegistry,
)
from cheater.playbooks import Playbook, PlaybookKind, default_playbooks
from cheater.recovery import (
    BannedAction,
    BannedActionSet,
    BlockedReport,
    LadderConfig,
    RecoveryAction,
    RecoveryCapsule,
    RecoveryLadder,
    RecoveryLevel,
    build_capsule,
    render_capsule_for_model,
)
from cheater.strategy import Strategy, StrategyKind, StrategyRecord


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


class TestBannedActionSet(unittest.TestCase):
    def test_ban_and_query(self):
        b = BannedActionSet()
        b.ban("run_command", "sig-1", reason="repeated")
        self.assertTrue(b.is_banned("run_command", "sig-1"))
        self.assertFalse(b.is_banned("run_command", "sig-2"))
        self.assertFalse(b.is_banned("read_file", "sig-1"))

    def test_wildcard_ban(self):
        b = BannedActionSet()
        b.ban("finish", "*", reason="no finish yet")
        self.assertTrue(b.is_banned("finish", "anything"))
        self.assertTrue(b.is_banned("finish", ""))

    def test_lift_all(self):
        b = BannedActionSet()
        b.ban("run_command", "sig")
        self.assertTrue(b.is_banned("run_command", "sig"))
        b.lift_all()
        self.assertFalse(b.is_banned("run_command", "sig"))

    def test_dedup_repeat_ban(self):
        b = BannedActionSet()
        b.ban("run_command", "sig")
        b.ban("run_command", "sig")
        self.assertEqual(len(b.active()), 1)

    def test_max_bans(self):
        b = BannedActionSet(max_bans=2)
        b.ban("a", "1")
        b.ban("b", "2")
        b.ban("c", "3")
        # The oldest is dropped.
        items = b.active()
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0].action, "b")
        self.assertEqual(items[1].action, "c")


class TestRecoveryCapsule(unittest.TestCase):
    def test_to_dict_includes_key_fields(self):
        pb = _small_playbook()
        ledger = CompletionLedger(user_goal="fix the bug", playbook=PlaybookKind.CLI_PACKAGE)
        ledger.record_command("pytest")
        ledger.record_file_change("cheater/x.py")
        ledger.record_failure("fail", failure_class=FailureClass.APP_BUG)
        d = StallDetector()
        banned = BannedActionSet()
        banned.ban("run_command", "pytest-sig", reason="repeated")
        record = StrategyRecord()
        strategy = Strategy(
            kind=StrategyKind.DIAGNOSE,
            hypothesis="re-examine the test",
            smallest_next_action="read_file cheater/x.py",
            verification_target="pytest passes",
        )
        capsule = build_capsule(
            user_goal="fix the bug",
            playbook=pb,
            ledger=ledger,
            detector=d,
            banned=banned,
            strategy_record=record,
            next_strategy=strategy,
        )
        d_dict = capsule.to_dict()
        self.assertEqual(d_dict["user_goal"], "fix the bug")
        self.assertEqual(d_dict["playbook"], "cli_package")
        self.assertIn("cheater/x.py", d_dict["files_changed"])
        self.assertIn("pytest", d_dict["commands_tried"])
        self.assertEqual(d_dict["current_failure_class"], "app_bug")
        self.assertEqual(len(d_dict["banned_actions"]), 1)
        self.assertEqual(d_dict["new_strategy"]["kind"], "diagnose")

    def test_render_capsule_for_model_is_bounded(self):
        pb = _small_playbook()
        ledger = CompletionLedger(user_goal="x", playbook=PlaybookKind.CLI_PACKAGE)
        ledger.record_command("pytest")
        d = StallDetector()
        capsule = build_capsule(
            user_goal="x",
            playbook=pb,
            ledger=ledger,
            detector=d,
            banned=BannedActionSet(),
            strategy_record=StrategyRecord(),
        )
        text = render_capsule_for_model(capsule)
        # Bounded: not a full conversation dump.
        self.assertLess(len(text), 4000)
        # Contains the key sections.
        self.assertIn("ANTI-STALL HANDOFF CAPSULE", text)
        self.assertIn("END CAPSULE", text)


class TestRecoveryLadder(unittest.TestCase):
    def test_starts_at_none(self):
        l = RecoveryLadder()
        self.assertEqual(l.level, RecoveryLevel.NONE)
        self.assertFalse(l.is_blocked())

    def test_first_escalation_is_local_nudge(self):
        l = RecoveryLadder(LadderConfig(max_local_nudges=2))
        action = l.escalate(
            assessment=_assessment(),
            user_goal="x",
            playbook=_small_playbook(),
            ledger=CompletionLedger(user_goal="x"),
            detector=StallDetector(),
            banned=BannedActionSet(),
            strategy_record=StrategyRecord(),
        )
        self.assertEqual(action.level, RecoveryLevel.LOCAL_NUDGE)
        self.assertEqual(l.level, RecoveryLevel.LOCAL_NUDGE)

    def test_escalation_climbs(self):
        l = RecoveryLadder(LadderConfig(
            max_local_nudges=1, max_context_rebases=1, max_fresh_workers=1,
            max_strategy_switches=1, max_isolations=1,
        ))
        levels = []
        for _ in range(5):
            action = l.escalate(
                assessment=_assessment(),
                user_goal="x",
                playbook=_small_playbook(),
                ledger=CompletionLedger(user_goal="x"),
                detector=StallDetector(),
                banned=BannedActionSet(),
                strategy_record=StrategyRecord(),
            )
            levels.append(action.level)
        # First five: local_nudge, context_rebase, fresh_worker,
        # strategy_switch, isolate.
        self.assertEqual(levels, [
            RecoveryLevel.LOCAL_NUDGE,
            RecoveryLevel.CONTEXT_REBASE,
            RecoveryLevel.FRESH_WORKER,
            RecoveryLevel.STRATEGY_SWITCH,
            RecoveryLevel.ISOLATE,
        ])

    def test_exhaustion_emits_blocked(self):
        l = RecoveryLadder(LadderConfig(
            max_local_nudges=1, max_context_rebases=1, max_fresh_workers=1,
            max_strategy_switches=1, max_isolations=1,
        ))
        for _ in range(5):
            l.escalate(
                assessment=_assessment(),
                user_goal="x",
                playbook=_small_playbook(),
                ledger=CompletionLedger(user_goal="x"),
                detector=StallDetector(),
                banned=BannedActionSet(),
                strategy_record=StrategyRecord(),
            )
        action = l.escalate(
            assessment=_assessment(),
            user_goal="x",
            playbook=_small_playbook(),
            ledger=CompletionLedger(user_goal="x"),
            detector=StallDetector(),
            banned=BannedActionSet(),
            strategy_record=StrategyRecord(),
        )
        self.assertEqual(action.level, RecoveryLevel.HONEST_BLOCKED)
        self.assertTrue(l.is_blocked())
        self.assertIsNotNone(l.blocked_report)

    def test_total_recoveries_capped(self):
        l = RecoveryLadder(LadderConfig(
            max_local_nudges=10, max_context_rebases=10, max_fresh_workers=10,
            max_strategy_switches=10, max_isolations=10,
            max_total_recoveries=3,
        ))
        for _ in range(3):
            l.escalate(
                assessment=_assessment(),
                user_goal="x",
                playbook=_small_playbook(),
                ledger=CompletionLedger(user_goal="x"),
                detector=StallDetector(),
                banned=BannedActionSet(),
                strategy_record=StrategyRecord(),
            )
        action = l.escalate(
            assessment=_assessment(),
            user_goal="x",
            playbook=_small_playbook(),
            ledger=CompletionLedger(user_goal="x"),
            detector=StallDetector(),
            banned=BannedActionSet(),
            strategy_record=StrategyRecord(),
        )
        # After 3 recoveries, the next one is HONEST_BLOCKED.
        self.assertEqual(action.level, RecoveryLevel.HONEST_BLOCKED)

    def test_repeated_command_ban_applied(self):
        l = RecoveryLadder(LadderConfig())
        banned = BannedActionSet()
        a = StallAssessment(
            is_stalled=True,
            reason=StallReason.REPEATED_COMMAND,
            summary="x",
            evidence={"command_sig": "pytest"},
        )
        l.escalate(
            assessment=a,
            user_goal="x",
            playbook=_small_playbook(),
            ledger=CompletionLedger(user_goal="x"),
            detector=StallDetector(),
            banned=banned,
            strategy_record=StrategyRecord(),
        )
        self.assertTrue(banned.is_banned("run_command", "pytest"))

    def test_finish_ban_applied(self):
        l = RecoveryLadder(LadderConfig())
        banned = BannedActionSet()
        a = StallAssessment(
            is_stalled=True,
            reason=StallReason.REPEATED_FINISH,
            summary="x",
        )
        l.escalate(
            assessment=a,
            user_goal="x",
            playbook=_small_playbook(),
            ledger=CompletionLedger(user_goal="x"),
            detector=StallDetector(),
            banned=banned,
            strategy_record=StrategyRecord(),
        )
        self.assertTrue(banned.is_banned("finish", "*"))

    def test_blocked_report_to_human(self):
        l = RecoveryLadder(LadderConfig(
            max_local_nudges=1, max_context_rebases=1, max_fresh_workers=1,
            max_strategy_switches=1, max_isolations=1,
        ))
        for _ in range(5):
            l.escalate(
                assessment=_assessment(),
                user_goal="x",
                playbook=_small_playbook(),
                ledger=CompletionLedger(user_goal="x"),
                detector=StallDetector(),
                banned=BannedActionSet(),
                strategy_record=StrategyRecord(),
            )
        l.escalate(
            assessment=_assessment(),
            user_goal="x",
            playbook=_small_playbook(),
            ledger=CompletionLedger(user_goal="x"),
            detector=StallDetector(),
            banned=BannedActionSet(),
            strategy_record=StrategyRecord(),
        )
        text = l.blocked_report.to_human()
        self.assertIn("BLOCKED: x", text)
        self.assertIn("honest_blocked", text)


def _assessment() -> StallAssessment:
    return StallAssessment(
        is_stalled=True,
        reason=StallReason.NO_PROGRESS,
        summary="no progress",
    )


if __name__ == "__main__":
    unittest.main()
