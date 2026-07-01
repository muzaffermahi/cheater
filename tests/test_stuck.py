"""Tests for cheater.stuck. NO network, no real processes."""

from __future__ import annotations

import time
import unittest

from cheater.lifecycle import (
    CommandKind,
    FailureClass,
    ProcessRegistry,
)
from cheater.stuck import (
    AgentEvent,
    CommandEvent,
    StuckKind,
    Watchdog,
    WatchdogConfig,
    looks_like_interactive_prompt,
)


def _now() -> float:
    return 1_000_000.0


class TestInteractivePrompt(unittest.TestCase):
    def test_password_prompt(self):
        self.assertTrue(looks_like_interactive_prompt("Enter password: "))

    def test_yn_prompt(self):
        self.assertTrue(looks_like_interactive_prompt("Are you sure? [y/n]"))

    def test_press_enter(self):
        self.assertTrue(looks_like_interactive_prompt("Press enter to continue"))

    def test_normal_output_is_not_prompt(self):
        self.assertFalse(looks_like_interactive_prompt("1 passed in 0.1s"))
        self.assertFalse(looks_like_interactive_prompt(""))


class TestWatchdogConfig(unittest.TestCase):
    def test_defaults(self):
        cfg = WatchdogConfig()
        self.assertEqual(cfg.no_output_seconds, 90.0)
        self.assertEqual(cfg.repeated_command_window, 4)
        self.assertEqual(cfg.server_no_verify_seconds, 60.0)


class TestWatchdogIdle(unittest.TestCase):
    def test_no_observations_is_idle(self):
        w = Watchdog(now=_now())
        self.assertEqual(w.assess().kind, StuckKind.IDLE)


class TestWatchdogRepeatedCommand(unittest.TestCase):
    def test_same_command_runs_4_times_is_stuck(self):
        w = Watchdog(now=_now())
        # Same command runs 4 times in a row.
        for i in range(4):
            w.observe(
                CommandEvent(
                    kind="command_started",
                    cmd="pytest tests/test_x.py",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                )
            )
            w.observe(
                CommandEvent(
                    kind="command_finished",
                    cmd="pytest tests/test_x.py",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                    finished_at=float(i) + 0.1,
                    exit_code=1,
                    elapsed=0.1,
                )
            )
        state = w.assess()
        self.assertEqual(state.kind, StuckKind.REPEATED_COMMAND)
        self.assertIn("pytest", state.summary)

    def test_different_commands_are_not_repeats(self):
        # Set verify_no_repair_window high so this test only exercises
        # the "different commands" path. Otherwise the test would
        # also trigger verify_no_repair.
        w = Watchdog(cfg=WatchdogConfig(verify_no_repair_window=10), now=_now())
        cmds = [
            "pytest tests/test_a.py",
            "pytest tests/test_b.py",
            "pytest tests/test_c.py",
            "pytest tests/test_d.py",
        ]
        for i, c in enumerate(cmds):
            w.observe(
                CommandEvent(
                    kind="command_started",
                    cmd=c,
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                )
            )
            w.observe(
                CommandEvent(
                    kind="command_finished",
                    cmd=c,
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                    finished_at=float(i) + 0.1,
                    exit_code=1,
                    elapsed=0.1,
                )
            )
        self.assertEqual(w.assess().kind, StuckKind.IDLE)


class TestWatchdogServerNoVerify(unittest.TestCase):
    def test_server_started_never_verified(self):
        w = Watchdog(cfg=WatchdogConfig(server_no_verify_seconds=10.0), now=100.0)
        w.observe(
            CommandEvent(
                kind="command_started",
                cmd="npm run dev",
                cmd_kind=CommandKind.DEV_SERVER,
                cmd_id="d1",
                started_at=50.0,
            )
        )
        # No verify command is ever observed.
        state = w.assess()
        self.assertEqual(state.kind, StuckKind.SERVER_NO_VERIFY)
        self.assertEqual(state.recovery_class, FailureClass.STALE_WORKSPACE)


class TestWatchdogTestsNoScoring(unittest.TestCase):
    def test_tests_finished_scoring_expected_but_not_invoked(self):
        w = Watchdog(cfg=WatchdogConfig(tests_no_scoring_seconds=10.0), now=200.0)
        w.expect_scoring(True)
        w.observe(
            CommandEvent(
                kind="command_started",
                cmd="pytest",
                cmd_kind=CommandKind.TEST,
                cmd_id="t1",
                started_at=100.0,
            )
        )
        w.observe(
            CommandEvent(
                kind="command_finished",
                cmd="pytest",
                cmd_kind=CommandKind.TEST,
                cmd_id="t1",
                started_at=100.0,
                finished_at=110.0,
                exit_code=0,
                elapsed=10.0,
            )
        )
        # No scoring invoked; watchdog fires.
        state = w.assess()
        self.assertEqual(state.kind, StuckKind.TESTS_NO_SCORING)

    def test_scoring_invoked_clears(self):
        w = Watchdog(cfg=WatchdogConfig(tests_no_scoring_seconds=10.0), now=200.0)
        w.expect_scoring(True)
        w.observe(
            CommandEvent(
                kind="command_started",
                cmd="pytest",
                cmd_kind=CommandKind.TEST,
                cmd_id="t1",
                started_at=100.0,
            )
        )
        w.observe(
            CommandEvent(
                kind="command_finished",
                cmd="pytest",
                cmd_kind=CommandKind.TEST,
                cmd_id="t1",
                started_at=100.0,
                finished_at=110.0,
                exit_code=0,
                elapsed=10.0,
            )
        )
        w.observe(
            CommandEvent(
                kind="command_started",
                cmd="python score.py",
                cmd_kind=CommandKind.SCORING,
                cmd_id="s1",
                started_at=115.0,
            )
        )
        w.observe(
            CommandEvent(
                kind="command_finished",
                cmd="python score.py",
                cmd_kind=CommandKind.SCORING,
                cmd_id="s1",
                started_at=115.0,
                finished_at=120.0,
                exit_code=0,
                elapsed=5.0,
            )
        )
        self.assertEqual(w.assess().kind, StuckKind.IDLE)


class TestWatchdogVerifyNoRepair(unittest.TestCase):
    def test_three_failures_no_repair_is_stuck(self):
        w = Watchdog(cfg=WatchdogConfig(verify_no_repair_window=3), now=100.0)
        for i in range(3):
            w.observe(
                CommandEvent(
                    kind="command_started",
                    cmd=f"pytest r{i}",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                )
            )
            w.observe(
                CommandEvent(
                    kind="command_finished",
                    cmd=f"pytest r{i}",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                    finished_at=float(i) + 0.1,
                    exit_code=1,
                    elapsed=0.1,
                )
            )
        state = w.assess()
        self.assertEqual(state.kind, StuckKind.VERIFY_NO_REPAIR)

    def test_repair_action_resets(self):
        w = Watchdog(cfg=WatchdogConfig(verify_no_repair_window=2), now=100.0)
        for i in range(2):
            w.observe(
                CommandEvent(
                    kind="command_started",
                    cmd=f"pytest r{i}",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                )
            )
            w.observe(
                CommandEvent(
                    kind="command_finished",
                    cmd=f"pytest r{i}",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                    finished_at=float(i) + 0.1,
                    exit_code=1,
                    elapsed=0.1,
                )
            )
        # Repair action: model edits a file.
        w.observe(AgentEvent(kind="action", action="edit_file", args={"path": "x.py"}))
        # No longer stuck on verify_no_repair.
        self.assertEqual(w.assess().kind, StuckKind.IDLE)


class TestWatchdogNoOutput(unittest.TestCase):
    def test_long_no_output_is_stuck(self):
        w = Watchdog(cfg=WatchdogConfig(no_output_seconds=30.0), now=200.0)
        w.observe(
            CommandEvent(
                kind="command_no_output_tick",
                cmd="npm run dev",
                cmd_kind=CommandKind.DEV_SERVER,
                cmd_id="d1",
                started_at=100.0,
                last_output_at=100.0,
            )
        )
        state = w.assess()
        self.assertEqual(state.kind, StuckKind.NO_OUTPUT)


class TestWatchdogFinishWithoutEvidence(unittest.TestCase):
    def test_finish_with_vague_summary_is_stuck(self):
        w = Watchdog(now=100.0)
        w.observe(AgentEvent(kind="finish_attempt", summary="done"))
        state = w.assess()
        self.assertEqual(state.kind, StuckKind.FINISH_WITHOUT_EVIDENCE)

    def test_finish_with_concrete_summary_is_idle(self):
        w = Watchdog(now=100.0)
        w.observe(AgentEvent(kind="finish_attempt", summary="tests/test_x.py passed"))
        # reset_finish_tracker clears it
        w.reset_finish_tracker()
        self.assertEqual(w.assess().kind, StuckKind.IDLE)


class TestWatchdogIDontKnowResets(unittest.TestCase):
    def test_idontknow_clears_failure_counter(self):
        w = Watchdog(cfg=WatchdogConfig(verify_no_repair_window=2), now=100.0)
        for i in range(2):
            w.observe(
                CommandEvent(
                    kind="command_started",
                    cmd=f"pytest r{i}",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                )
            )
            w.observe(
                CommandEvent(
                    kind="command_finished",
                    cmd=f"pytest r{i}",
                    cmd_kind=CommandKind.TEST,
                    cmd_id=f"c{i}",
                    started_at=float(i),
                    finished_at=float(i) + 0.1,
                    exit_code=1,
                    elapsed=0.1,
                )
            )
        # Sticky.
        self.assertEqual(w.assess().kind, StuckKind.VERIFY_NO_REPAIR)
        w.observe(AgentEvent(kind="i_dont_know", summary="can't fix"))
        self.assertEqual(w.assess().kind, StuckKind.IDLE)


class TestWatchdogFromDict(unittest.TestCase):
    def test_dict_event_is_accepted(self):
        w = Watchdog(now=100.0)
        w.observe(
            {
                "kind": "command_started",
                "cmd": "npm run dev",
                "cmd_kind": "dev_server",
                "cmd_id": "d1",
                "started_at": 50.0,
            }
        )
        w.observe(
            {
                "kind": "command_finished",
                "cmd": "npm run dev",
                "cmd_kind": "dev_server",
                "cmd_id": "d1",
                "started_at": 50.0,
                "finished_at": 60.0,
                "exit_code": 0,
                "elapsed": 10.0,
            }
        )
        # No stuck state from one event.
        self.assertEqual(w.assess().kind, StuckKind.IDLE)


if __name__ == "__main__":
    unittest.main()
