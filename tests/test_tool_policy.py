"""Tests for cheater.tool_policy (v0.7)."""

from __future__ import annotations

import unittest

from cheater.tool_policy import (
    ToolPolicyRecommendation,
    ToolState,
    infer_state,
    recommend_tools,
    render_tool_policy_nudge,
)


class TestInferState(unittest.TestCase):
    def test_bug_fix_keywords(self):
        self.assertEqual(infer_state("fix the failing test"), ToolState.BUG_FIX)

    def test_import_error(self):
        self.assertEqual(
            infer_state("traceback: ModuleNotFoundError: No module named foo"),
            ToolState.IMPORT_ERROR,
        )

    def test_syntax_error(self):
        self.assertEqual(
            infer_state("traceback: SyntaxError: invalid syntax"),
            ToolState.SYNTAX_ERROR,
        )

    def test_test_failure(self):
        self.assertEqual(
            infer_state("FAILED tests/test_x.py::test_y"),
            ToolState.TEST_FAILURE,
        )

    def test_failure_summary_event_overrides_task(self):
        ev = {
            "event": "failure_summary",
            "payload": {"is_syntax_error": True, "error_type": "SyntaxError"},
        }
        self.assertEqual(infer_state("anything", ev), ToolState.SYNTAX_ERROR)

    def test_new_task_default(self):
        self.assertEqual(infer_state("hello world"), ToolState.NEW_TASK)


class TestRecommend(unittest.TestCase):
    def test_bug_task_includes_localize_context_memory(self):
        rec = recommend_tools(
            ToolState.BUG_FIX,
            available_tools=[
                "localize_bug",
                "read_context_pack",
                "memory_recall",
                "read_file",
                "search_code",
                "list_files",
                "run_focused_tests",
                "edit_file",
                "create_file",
                "run_command",
                "finish",
                "i_dont_know",
            ],
        )
        names = rec.preferred_next_tools
        # bug fix starts with localize/context/memory, not edit
        self.assertIn("localize_bug", names)
        self.assertIn("read_context_pack", names)
        self.assertIn("memory_recall", names)
        self.assertNotIn("edit_file", names)
        # create_file is forbidden
        self.assertIn("create_file", rec.forbidden_tools)

    def test_patch_ready_recommends_tests(self):
        rec = recommend_tools(
            ToolState.PATCH_READY,
            available_tools=[
                "run_focused_tests",
                "run_command",
                "read_file",
                "edit_file",
                "finish",
                "i_dont_know",
            ],
        )
        names = rec.preferred_next_tools
        self.assertIn("run_focused_tests", names)
        self.assertIn("run_command", names)

    def test_after_failed_patch_prefers_failure_tools(self):
        rec = recommend_tools(
            ToolState.AFTER_FAILED_PATCH,
            available_tools=[
                "run_focused_tests",
                "read_file",
                "localize_bug",
                "memory_recall",
                "edit_file",
                "finish",
                "i_dont_know",
            ],
        )
        names = rec.preferred_next_tools
        # Failure analysis tools come first; edit_file is allowed but not preferred
        self.assertIn("read_file", names)
        self.assertIn("run_focused_tests", names)
        self.assertNotIn("edit_file", names)

    def test_tool_list_capped(self):
        big = [f"tool_{i}" for i in range(50)]
        rec = recommend_tools(ToolState.BUG_FIX, available_tools=big)
        # preferred is at most 6
        self.assertLessEqual(len(rec.preferred_next_tools), 6)
        # allowed is at most 8
        self.assertLessEqual(len(rec.allowed_tools), 8)
        # forbidden is at most 4
        self.assertLessEqual(len(rec.forbidden_tools), 4)

    def test_recommendation_filters_unavailable(self):
        # No matching tools available -> empty recommendation
        rec = recommend_tools(
            ToolState.BUG_FIX, available_tools=["finish", "i_dont_know"]
        )
        self.assertEqual(len(rec.preferred_next_tools), 0)


class TestRenderNudge(unittest.TestCase):
    def test_nudge_contains_state(self):
        rec = recommend_tools(
            ToolState.BUG_FIX,
            available_tools=[
                "localize_bug",
                "memory_recall",
                "read_file",
            ],
        )
        text = render_tool_policy_nudge(rec)
        self.assertIn("state=bug_fix", text)
        self.assertIn("preferred:", text)
        self.assertIn("after ", text)


if __name__ == "__main__":
    unittest.main()
