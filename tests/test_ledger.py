"""Tests for cheater.ledger. NO network, no real processes."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.ledger import (
    CompletionLedger,
    LedgerEntry,
    ledger_allows_finish,
)
from cheater.lifecycle import FailureClass
from cheater.playbooks import PlaybookKind
from cheater.verification import (
    StageResult,
    VerificationStage,
    VerificationStatus,
)


def _ok_result(stage: VerificationStage) -> StageResult:
    return StageResult(stage=stage, status=VerificationStatus.OK, summary="ok")


def _fail_result(stage: VerificationStage) -> StageResult:
    return StageResult(
        stage=stage,
        status=VerificationStatus.FAILED,
        summary="bad",
        failure_class=FailureClass.APP_BUG,
    )


class TestCompletionLedger(unittest.TestCase):
    def test_empty_ledger_is_not_verified(self):
        l = CompletionLedger(user_goal="x")
        self.assertFalse(l.is_verified())

    def test_records_command_and_change(self):
        l = CompletionLedger(user_goal="x")
        l.record_command("pytest tests/test_x.py")
        l.record_file_change("cheater/x.py")
        self.assertIn("pytest tests/test_x.py", l.commands_run)
        self.assertIn("cheater/x.py", l.changed_files)
        # Re-recording is idempotent.
        l.record_command("pytest tests/test_x.py")
        self.assertEqual(len(l.commands_run), 1)

    def test_records_verification_results(self):
        l = CompletionLedger(user_goal="x")
        l.record_verification(
            [
                _ok_result(VerificationStage.SMOKE),
                _ok_result(VerificationStage.SUMMARIZE),
            ]
        )
        self.assertEqual(len(l.verification), 2)
        self.assertTrue(l.is_verified())

    def test_unresolved_failures_drain_on_recovery(self):
        l = CompletionLedger(user_goal="x")
        l.record_failure("boom", failure_class=FailureClass.APP_BUG)
        self.assertTrue(l.has_unresolved_failures())
        l.record_recovery(
            "replan_with_focus_on_failure", failure_class=FailureClass.APP_BUG
        )
        self.assertFalse(l.has_unresolved_failures())

    def test_to_human_includes_status(self):
        l = CompletionLedger(
            user_goal="add a feature", playbook=PlaybookKind.CLI_PACKAGE
        )
        l.record_command("pytest")
        l.record_file_change("cheater/x.py")
        l.record_verification(
            [
                _ok_result(VerificationStage.SMOKE),
                _ok_result(VerificationStage.SUMMARIZE),
            ]
        )
        l.finalize(done=True, reason="ok", confidence="high")
        out = l.to_human()
        self.assertIn("GOAL: add a feature", out)
        self.assertIn("DONE", out)
        self.assertIn("pytest", out)
        self.assertIn("cheater/x.py", out)
        self.assertIn("high", out)

    def test_to_json_round_trip(self):
        l = CompletionLedger(user_goal="x", playbook=PlaybookKind.CLI_PACKAGE)
        l.record_command("pytest")
        l.record_file_change("cheater/x.py")
        l.record_verification([_ok_result(VerificationStage.SMOKE)])
        l.finalize(done=True, reason="ok")
        data = json.loads(l.to_json())
        self.assertEqual(data["user_goal"], "x")
        self.assertEqual(data["playbook"], "cli_package")
        self.assertEqual(data["done"], True)
        self.assertEqual(len(data["verification"]), 1)
        # entries: command, edit, verification_stage, done = 4
        self.assertEqual(len(data["entries"]), 4)

    def test_save_to_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "ledger.json"
            l = CompletionLedger(user_goal="x", playbook=PlaybookKind.CLI_PACKAGE)
            l.record_command("pytest")
            l.finalize(done=True, reason="ok")
            l.save(path)
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["user_goal"], "x")
            self.assertEqual(data["done"], True)


class TestLedgerAllowsFinish(unittest.TestCase):
    def test_empty_run_is_rejected(self):
        l = CompletionLedger(user_goal="x")
        ok, reason = ledger_allows_finish(l)
        self.assertFalse(ok)
        self.assertIn("no work was done", reason)

    def test_no_verification_is_rejected(self):
        l = CompletionLedger(user_goal="x")
        l.record_command("pytest")
        ok, _ = ledger_allows_finish(l)
        self.assertFalse(ok)
        self.assertIn("no verification", _ or "")

    def test_unresolved_failure_is_rejected(self):
        l = CompletionLedger(user_goal="x")
        l.record_command("pytest")
        l.record_verification([_ok_result(VerificationStage.SMOKE)])
        l.record_failure("boom", failure_class=FailureClass.APP_BUG)
        ok, reason = ledger_allows_finish(l)
        self.assertFalse(ok)
        self.assertIn("unresolved", reason)

    def test_failed_verification_is_rejected(self):
        l = CompletionLedger(user_goal="x")
        l.record_command("pytest")
        l.record_verification(
            [
                _ok_result(VerificationStage.SMOKE),
                _fail_result(VerificationStage.SUMMARIZE),
            ]
        )
        ok, reason = ledger_allows_finish(l)
        self.assertFalse(ok)
        self.assertIn("verification not terminal", reason)

    def test_verified_run_is_accepted(self):
        l = CompletionLedger(user_goal="x")
        l.record_command("pytest")
        l.record_verification(
            [
                _ok_result(VerificationStage.SMOKE),
                _ok_result(VerificationStage.SUMMARIZE),
            ]
        )
        ok, reason = ledger_allows_finish(l)
        self.assertTrue(ok, reason)


if __name__ == "__main__":
    unittest.main()
