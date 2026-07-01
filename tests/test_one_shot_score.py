"""Tests for cheater.one_shot_score. NO network, no real processes."""

from __future__ import annotations

import unittest

from cheater.ledger import CompletionLedger
from cheater.lifecycle import (
    CommandKind,
    FailureClass,
    OwnedProcess,
    ProcessRegistry,
    ProcessStatus,
)
from cheater.one_shot_score import (
    RobustnessCheck,
    RobustnessReport,
    _looks_irrelevant,
    score_run,
)
from cheater.playbooks import PlaybookKind
from cheater.stuck import StuckKind, Watchdog
from cheater.verification import (
    StageResult,
    VerificationStage,
    VerificationStatus,
)


def _ok(stage: VerificationStage) -> StageResult:
    return StageResult(stage=stage, status=VerificationStatus.OK, summary="ok")


class TestScoreRun(unittest.TestCase):
    def test_empty_ledger_fails_terminal_check(self):
        l = CompletionLedger(user_goal="x")
        r = score_run(l)
        names = {c.name for c in r.checks}
        self.assertIn("task_reached_terminal_verified_state", names)
        self.assertFalse(r.passed)

    def test_fully_verified_run_passes(self):
        l = CompletionLedger(user_goal="x", playbook=PlaybookKind.CLI_PACKAGE)
        l.record_command("pytest")
        l.record_file_change("cheater/x.py")
        l.record_verification(
            [
                _ok(VerificationStage.SMOKE),
                _ok(VerificationStage.FOCUSED_TESTS),
                _ok(VerificationStage.FULL_TESTS),
                _ok(VerificationStage.SUMMARIZE),
            ]
        )
        l.finalize(done=True, reason="ok", confidence="high")
        registry = ProcessRegistry()
        watchdog = Watchdog(registry)
        r = score_run(
            l, registry=registry, watchdog=watchdog, worker_steps=5, worker_max_steps=20
        )
        self.assertTrue(r.passed, [c.to_dict() for c in r.checks if not c.passed])
        self.assertGreater(r.score, 0.8)

    def test_stuck_state_penalises(self):
        l = CompletionLedger(user_goal="x", playbook=PlaybookKind.CLI_PACKAGE)
        l.record_command("pytest")
        l.record_file_change("cheater/x.py")
        l.record_verification(
            [
                _ok(VerificationStage.SMOKE),
                _ok(VerificationStage.SUMMARIZE),
            ]
        )
        l.finalize(done=True, reason="ok")
        registry = ProcessRegistry()
        watchdog = Watchdog(registry)

        # Fake a stuck state by overriding assess. We could also
        # observe repeated failed commands to make the watchdog
        # return a real stuck state.
        class _FakeWatchdog:
            def assess(self):
                from cheater.stuck import StuckState

                return StuckState(kind=StuckKind.REPEATED_COMMAND, summary="x")

        r = score_run(l, registry=registry, watchdog=_FakeWatchdog())
        names = {c.name for c in r.checks}
        self.assertIn("no_stuck_command", names)
        self.assertFalse(r.passed)

    def test_uncontrolled_running_process_penalises(self):
        l = CompletionLedger(user_goal="x", playbook=PlaybookKind.CLI_PACKAGE)
        l.record_command("pytest")
        l.record_file_change("cheater/x.py")
        l.record_verification([_ok(VerificationStage.SUMMARIZE)])
        l.finalize(done=True, reason="ok")
        registry = ProcessRegistry()
        registry.register_process(
            OwnedProcess(
                process_id="p",
                label="p",
                cmd="p",
                kind=CommandKind.DEV_SERVER,
                started_at=0.0,
                status=ProcessStatus.RUNNING,
            )
        )
        r = score_run(l, registry=registry)
        check_names = {c.name: c.passed for c in r.checks}
        self.assertFalse(check_names["no_uncontrolled_environment_mutation"])

    def test_irrelevant_files_penalise(self):
        l = CompletionLedger(user_goal="x", playbook=PlaybookKind.CLI_PACKAGE)
        l.record_command("pytest")
        l.record_file_change("cheater/x.py")
        l.record_file_change("/tmp/repo/.cheater/scratch.py")
        l.record_verification([_ok(VerificationStage.SUMMARIZE)])
        l.finalize(done=True, reason="ok")
        r = score_run(l)
        check_names = {c.name: c.passed for c in r.checks}
        self.assertFalse(check_names["no_irrelevant_files_touched"])

    def test_irrelevant_helper(self):
        self.assertEqual(_looks_irrelevant(["src/x.py"]), [])
        self.assertEqual(
            _looks_irrelevant(["/repo/.cheater/x.py"]), ["/repo/.cheater/x.py"]
        )


class TestRobustnessReport(unittest.TestCase):
    def test_empty_report_passes(self):
        r = RobustnessReport()
        self.assertTrue(r.passed)
        self.assertEqual(r.score, 1.0)

    def test_one_failure_drops_score(self):
        r = RobustnessReport()
        r.add("x", passed=True, weight=1.0)
        r.add("y", passed=False, weight=1.0)
        self.assertFalse(r.passed)
        self.assertEqual(r.score, 0.5)

    def test_to_dict(self):
        r = RobustnessReport()
        r.add("x", passed=True)
        d = r.to_dict()
        self.assertIn("checks", d)
        self.assertIn("score", d)


if __name__ == "__main__":
    unittest.main()
