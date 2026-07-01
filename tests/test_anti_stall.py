"""Tests for cheater.anti_stall. NO network, no real processes."""
from __future__ import annotations

import unittest

from cheater.anti_stall import (
    ProgressKind,
    ProgressLedger,
    StallAssessment,
    StallConfig,
    StallDetector,
    StallReason,
    StepFingerprint,
    command_args_sig,
    edit_diff_sig,
    error_fingerprint,
    make_fingerprint_from_step,
    model_message_fingerprint,
    compute_test_fingerprint,
    tool_args_sig,
)


def _fp(*, action="read_file", args=None, success=True, summary="ok",
        files_read=None, files_changed=None, commands_run=None,
        stdout="", stderr="", failure_class="", verification_stage="",
        model_message="", artifact_paths=None, step=1, test_fp="",
        error_fp="", args_sig="", progress=None):
    if progress is None:
        progress = ["file_changed"] if files_changed else (["new_repo_evidence"] if files_read else ["none"])
    return StepFingerprint(
        step=step,
        at=0.0,
        action=action,
        args_sig=args_sig or tool_args_sig(action, args),
        success=success,
        summary=summary,
        files_read=list(files_read or []),
        files_changed=list(files_changed or []),
        commands_run=list(commands_run or []),
        test_fp=test_fp,
        error_fp=error_fp,
        artifact_paths=list(artifact_paths or []),
        failure_class=failure_class,
        verification_stage=verification_stage,
        model_message_fp=model_message_fingerprint(model_message),
        progress=progress,
    )


class TestFingerprints(unittest.TestCase):
    def test_command_args_sig_stable(self):
        a = command_args_sig("pytest tests/test_x.py -x -q")
        b = command_args_sig("pytest tests/test_x.py")
        # Different flag sets, same intent -> same signature.
        self.assertEqual(a, b)

    def test_command_args_sig_different_paths_differ(self):
        a = command_args_sig("pytest tests/test_x.py")
        b = command_args_sig("pytest tests/test_y.py")
        self.assertNotEqual(a, b)

    def test_command_args_sig_different_commands_differ(self):
        a = command_args_sig("pytest tests/test_x.py")
        b = command_args_sig("ruff check .")
        self.assertNotEqual(a, b)

    def test_tool_args_sig_uses_behaviour_keys(self):
        # Same path, different line_range -> same signature for read_file.
        a = tool_args_sig("read_file", {"path": "x.py", "line_range": "1-50"})
        b = tool_args_sig("read_file", {"path": "x.py", "line_range": "60-100"})
        self.assertEqual(a, b)
        # Different path -> different signature.
        c = tool_args_sig("read_file", {"path": "y.py"})
        self.assertNotEqual(a, c)

    def test_test_fingerprint_stable(self):
        out = """FAILED tests/test_x.py::test_a - assert 1 == 2
FAILED tests/test_x.py::test_b - assert 3 == 4
2 failed, 1 passed"""
        a = compute_test_fingerprint(out)
        b = compute_test_fingerprint(out)
        self.assertEqual(a, b)

    def test_test_fingerprint_different_for_different_output(self):
        a = compute_test_fingerprint("FAILED tests/test_x.py::test_a")
        b = compute_test_fingerprint("FAILED tests/test_y.py::test_b")
        self.assertNotEqual(a, b)

    def test_test_fingerprint_includes_counts(self):
        a = compute_test_fingerprint("1 passed, 2 failed")
        b = compute_test_fingerprint("3 passed, 0 failed")
        self.assertNotEqual(a, b)

    def test_error_fingerprint_strips_line_numbers(self):
        a = error_fingerprint("TypeError: cannot read property 'x' of undefined at line 42")
        b = error_fingerprint("TypeError: cannot read property 'x' of undefined at line 99")
        self.assertEqual(a, b)

    def test_error_fingerprint_different_for_different_error(self):
        a = error_fingerprint("TypeError: cannot read property 'x'")
        b = error_fingerprint("ValueError: bad value")
        self.assertNotEqual(a, b)

    def test_edit_diff_sig_no_diff(self):
        self.assertEqual(edit_diff_sig("x", "x"), "no-diff")

    def test_edit_diff_sig_create_vs_edit(self):
        a = edit_diff_sig("", "hello")
        b = edit_diff_sig("old", "new")
        self.assertNotEqual(a, b)

    def test_model_message_fingerprint_stable(self):
        a = model_message_fingerprint("I am looking at the file x.py and reading it")
        b = model_message_fingerprint("I am looking at the file x.py and reading it")
        self.assertEqual(a, b)

    def test_model_message_fingerprint_differs_by_intent(self):
        a = model_message_fingerprint("I am looking at the file x.py and reading it")
        b = model_message_fingerprint("I am editing the file x.py to fix the bug")
        self.assertNotEqual(a, b)


class TestProgressClassification(unittest.TestCase):
    def test_new_repo_evidence_first_read(self):
        # Use the detector.ledger so the progress classification
        # observes the same state the detector will.
        d = StallDetector()
        fp = make_fingerprint_from_step(
            step=1, action="read_file", args={"path": "x.py"},
            success=True, summary="ok", files_read=["x.py"],
        )
        d.observe(fp)
        self.assertIn(ProgressKind.NEW_REPO_EVIDENCE.value, fp.progress)

    def test_no_new_repo_evidence_on_second_read(self):
        d = StallDetector()
        # First read counts as new evidence.
        fp1 = make_fingerprint_from_step(
            step=1, action="read_file", args={"path": "x.py"},
            success=True, summary="ok", files_read=["x.py"],
        )
        d.observe(fp1)
        # Second read of the same file is NOT new evidence.
        fp2 = make_fingerprint_from_step(
            step=2, action="read_file", args={"path": "x.py"},
            success=True, summary="ok", files_read=["x.py"],
        )
        d.observe(fp2)
        self.assertNotIn(ProgressKind.NEW_REPO_EVIDENCE.value, fp2.progress)

    def test_file_changed_counts(self):
        d = StallDetector()
        fp = make_fingerprint_from_step(
            step=1, action="edit_file", args={"path": "x.py", "old": "a", "new": "b"},
            success=True, summary="ok", files_changed=["x.py"],
        )
        d.observe(fp)
        self.assertIn(ProgressKind.FILE_CHANGED.value, fp.progress)

    def test_new_test_result_first_time(self):
        d = StallDetector()
        fp = make_fingerprint_from_step(
            step=1, action="run_command", args={"cmd": "pytest x"},
            success=False, summary="1 failed", stdout="FAILED test_x",
        )
        d.observe(fp)
        self.assertIn(ProgressKind.NEW_TEST_RESULT.value, fp.progress)

    def test_different_strategy(self):
        d = StallDetector()
        # First action: read.
        fp1 = make_fingerprint_from_step(
            step=1, action="read_file", args={"path": "x.py"},
            success=True, summary="ok", files_read=["x.py"],
        )
        d.observe(fp1)
        # Second action: search_code, different strategy.
        fp2 = make_fingerprint_from_step(
            step=2, action="search_code", args={"query": "x"},
            success=True, summary="3 hits",
        )
        d.observe(fp2)
        self.assertIn(ProgressKind.DIFFERENT_STRATEGY.value, fp2.progress)

    def test_no_progress_classified_correctly(self):
        d = StallDetector()
        # First, record a "real" step.
        fp1 = make_fingerprint_from_step(
            step=1, action="read_file", args={"path": "x.py"},
            success=True, summary="ok", files_read=["x.py"],
        )
        d.observe(fp1)
        # Now re-read the same file with no other change -> no progress.
        fp2 = make_fingerprint_from_step(
            step=2, action="read_file", args={"path": "x.py"},
            success=True, summary="ok", files_read=["x.py"],
        )
        d.observe(fp2)
        self.assertEqual(fp2.progress, [ProgressKind.NONE.value])


class TestStallDetector(unittest.TestCase):
    def test_idle_when_nothing_happens(self):
        d = StallDetector()
        self.assertEqual(d.assess().reason, StallReason.NONE)

    def test_repeated_command_with_same_output(self):
        d = StallDetector()
        for _ in range(3):
            d.observe(_fp(action="run_command", args={"cmd": "pytest tests/test_x.py"},
                         success=False, summary="fail", commands_run=["pytest tests/test_x.py"]))
        a = d.assess()
        self.assertEqual(a.reason, StallReason.REPEATED_COMMAND)
        self.assertTrue(a.is_stalled)

    def test_repeated_tool_call_with_same_args(self):
        d = StallDetector()
        for _ in range(3):
            d.observe(_fp(action="read_file", args={"path": "x.py"},
                         success=True, summary="ok", files_read=["x.py"]))
        a = d.assess()
        self.assertEqual(a.reason, StallReason.REPEATED_TOOL_CALL)

    def test_repeated_file_read_without_edits(self):
        d = StallDetector()
        for _ in range(3):
            d.observe(_fp(action="read_file", args={"path": "x.py"},
                         success=True, summary="ok", files_read=["x.py"]))
        a = d.assess()
        self.assertTrue(a.is_stalled)
        # The detector may flag either REPEATED_TOOL_CALL or REPEATED_FILE_READ
        # depending on the ordering. Both are correct; the key is that
        # a stall fires.
        self.assertIn(a.reason, [StallReason.REPEATED_FILE_READ, StallReason.REPEATED_TOOL_CALL])

    def test_new_file_change_resets_progress(self):
        d = StallDetector()
        # 3 no-op steps
        for i in range(3):
            fp = make_fingerprint_from_step(
                step=i+1, action="read_file", args={"path": "x.py"},
                success=True, summary="ok", files_read=["x.py"],
            )
            d.observe(fp)
        self.assertTrue(d.assess().is_stalled)
        # A real change resets the progress streak.
        fp = make_fingerprint_from_step(
            step=4, action="edit_file",
            args={"path": "x.py", "old": "a", "new": "b"},
            success=True, summary="ok", files_changed=["x.py"],
        )
        d.observe(fp)
        a = d.assess()
        self.assertFalse(a.is_stalled)

    def test_repeated_test_result_fingerprint(self):
        d = StallDetector()
        for _ in range(3):
            d.observe(_fp(action="run_command", args={"cmd": "pytest"},
                         success=False, summary="fail",
                         commands_run=["pytest"], test_fp="same-test-fp"))
        a = d.assess()
        self.assertEqual(a.reason, StallReason.REPEATED_TEST_RESULT)

    def test_oscillation_detection(self):
        d = StallDetector()
        # Alternate between read_file and search_code 6 times.
        for i in range(6):
            if i % 2 == 0:
                d.observe(_fp(step=i+1, action="read_file", args={"path": "x.py"},
                             success=True, summary="ok", files_read=["x.py"]))
            else:
                d.observe(_fp(step=i+1, action="search_code", args={"query": "x"},
                             success=True, summary="ok"))
        a = d.assess()
        self.assertEqual(a.reason, StallReason.OSCILLATION)

    def test_finish_without_evidence(self):
        d = StallDetector()
        for _ in range(2):
            d.observe(_fp(action="finish", success=True, summary="done"))
        a = d.assess()
        self.assertEqual(a.reason, StallReason.REPEATED_FINISH)

    def test_no_diff_edit_counted_as_no_progress(self):
        d = StallDetector()
        # No-diff edit (same old and new).
        for _ in range(3):
            d.observe(_fp(action="edit_file", args={"path": "x.py", "old": "x", "new": "x"},
                         success=True, summary="ok", stdout="no-diff"))
        a = d.assess()
        # Either NO_DIFF_EDIT or another reason; the key is that a stall fires.
        self.assertTrue(a.is_stalled)

    def test_repeated_model_message(self):
        d = StallDetector()
        msg = "I am looking at the file x.py and reading it"
        for _ in range(3):
            d.observe(_fp(action="read_file", args={"path": "x.py"},
                         success=True, summary="ok", model_message=msg))
        a = d.assess()
        # Repeated message is just one of several signals; the stall should
        # at least fire on the repeated tool/file read.
        self.assertTrue(a.is_stalled)

    def test_server_no_verify_signal(self):
        d = StallDetector()
        d.note_server_started()
        a = d.assess()
        self.assertEqual(a.reason, StallReason.SERVER_NO_VERIFY)
        d.note_verify_attempt()
        a = d.assess()
        self.assertNotEqual(a.reason, StallReason.SERVER_NO_VERIFY)

    def test_scoring_skipped_signal(self):
        d = StallDetector()
        d.note_test_finished()
        d.note_scoring_skipped()
        a = d.assess()
        # The scoring skipped signal should fire.
        self.assertEqual(a.reason, StallReason.SCORING_SKIPPED)

    def test_no_progress_streak(self):
        cfg = StallConfig(stall_window=2)
        d = StallDetector(cfg=cfg)
        # First, give it a "real" step.
        d.observe(_fp(action="read_file", args={"path": "x.py"},
                      success=True, summary="ok", files_read=["x.py"]))
        # Then 2 non-progress steps.
        d.observe(_fp(step=2, action="read_file", args={"path": "x.py"},
                      success=True, summary="ok", files_read=["x.py"]))
        d.observe(_fp(step=3, action="read_file", args={"path": "x.py"},
                      success=True, summary="ok", files_read=["x.py"]))
        a = d.assess()
        self.assertTrue(a.is_stalled)

    def test_assessment_summarises_recent_progress(self):
        d = StallDetector()
        d.observe(_fp(action="read_file", args={"path": "x.py"},
                      success=True, summary="ok", files_read=["x.py"]))
        d.observe(_fp(step=2, action="edit_file", args={"path": "x.py", "old": "a", "new": "b"},
                      success=True, summary="ok", files_changed=["x.py"]))
        a = d.assess()
        self.assertIn("new_repo_evidence", a.recent_progress)
        self.assertIn("file_changed", a.recent_progress)


if __name__ == "__main__":
    unittest.main()
