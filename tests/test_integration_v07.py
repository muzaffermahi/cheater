"""Integration tests for the v0.7 self-improvement layer.

These tests verify that the new modules work together:
- TraceRecorder + tool_policy + context_optimizer + arena + distiller
- AgentLoop + TraceRecorder + ToolPolicy nudge
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path


class TestEndToEndTraceDistill(unittest.TestCase):
    def test_record_distill_loop(self):
        from cheater.trace_recorder import TraceRecorder, load_trace, summarize_trace
        from cheater.trace_distiller import distill_trace, distill_traces
        from cheater.tool_policy import infer_state, recommend_tools

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            # Record a successful trace
            rec = TraceRecorder("e2e_01", root_dir=tmp)
            rec.record(
                "run_start",
                {
                    "task": "fix failing pytest import error",
                    "repo_root": "/test",
                },
            )
            rec.record(
                "localization_result",
                {
                    "suspected_files": [{"path": "x/foo.py"}],
                },
            )
            rec.record(
                "failure_summary",
                {
                    "error_type": "ModuleNotFoundError",
                    "summary": "No module named x",
                    "test": "tests/test_x.py::test_a",
                    "top_stack_files": ["x/foo.py"],
                },
            )
            rec.record(
                "model_output",
                {
                    "parsed_action": {
                        "action": "read_file",
                        "args": {"path": "x/foo.py"},
                    },
                },
            )
            rec.record(
                "diff_generated",
                {
                    "path": "x/foo.py",
                    "old": "old",
                    "new": "new",
                    "lines": 1,
                },
            )
            rec.record(
                "run_finished",
                {
                    "success": True,
                    "finished_by": "finish",
                    "elapsed": 1.0,
                    "steps": 3,
                },
            )
            rec.close()

            # Load + summarize
            events = load_trace(rec.path)
            summary = summarize_trace(events)
            self.assertEqual(summary["event_count"], 6)
            self.assertTrue(summary["success"])
            self.assertEqual(summary["finished_by"], "finish")

            # Distill single
            result = distill_trace(events, run_id="e2e_01")
            self.assertTrue(result.is_success)
            roles = {r.role for r in result.rows}
            self.assertIn("patcher", roles)
            self.assertIn("localizer", roles)

            # State inference
            fs = {"error_type": "ModuleNotFoundError", "summary": "..."}
            state = infer_state("fix import", None, fs)
            self.assertEqual(state, "import_error")
            rec_obj = recommend_tools(
                state,
                available_tools=[
                    "run_focused_tests",
                    "localize_bug",
                    "read_file",
                    "memory_recall",
                    "edit_file",
                    "finish",
                    "i_dont_know",
                ],
            )
            self.assertIn("run_focused_tests", rec_obj.preferred_next_tools)

            # Bulk distill
            summary2 = distill_traces(tmp / ".cheater" / "traces", tmp / "out")
            self.assertTrue(summary2["ok"])
            self.assertEqual(summary2["traces_distilled"], 1)


class TestArenaWithTraces(unittest.TestCase):
    def test_arena_run_with_cases(self):
        from cheater.arena import load_eval_cases, run_component_eval, ComponentConfig

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            # Create a tiny eval case
            case = tmp / "case1"
            case.mkdir()
            (case / "task.txt").write_text("fix the failing test", encoding="utf-8")
            (case / "traceback.txt").write_text(
                "AssertionError: expected 1 got 2", encoding="utf-8"
            )
            (case / "expected_files.json").write_text(
                json.dumps(["x/foo.py"]), encoding="utf-8"
            )

            cases = load_eval_cases(tmp)
            self.assertEqual(len(cases), 1)

            # Run a single component
            report = run_component_eval(
                cases,
                ComponentConfig(component="failure_compression", repo_root=str(tmp)),
            )
            self.assertTrue(report["ok"])
            self.assertIn("failure_summary_has_error_type", report["aggregate"])


class TestContextOptimizerIntegration(unittest.TestCase):
    def test_optimize_then_render(self):
        from cheater.context_optimizer import optimize_context_pack, Budget
        from cheater.context_pack import build_context_pack, render_for_model
        from cheater.context_optimizer import ContextSection

        # Build a synthetic pack as a list of sections
        pack = [
            ContextSection(
                name="task", body="fix import error", priority=0, label="Task"
            ),
            ContextSection(
                name="traceback",
                body="ModuleNotFoundError: foo",
                priority=5,
                label="Traceback",
            ),
            ContextSection(
                name="repo_map", body="x" * 5000, priority=20, label="Repo map"
            ),
            ContextSection(name="memory", body="y" * 1000, priority=25, label="Memory"),
            ContextSection(name="skills", body="z" * 1000, priority=27, label="Skills"),
            ContextSection(
                name="instructions", body="w" * 2000, priority=15, label="Instructions"
            ),
        ]
        result = optimize_context_pack(
            pack, budget=Budget.SMALL, task_signature="fix import error"
        )
        # Task + traceback are protected
        kept = {s.name for s in result.kept}
        self.assertIn("task", kept)
        self.assertIn("traceback", kept)
        # Result must fit in budget
        self.assertLessEqual(result.total_chars_after, result.max_chars)


if __name__ == "__main__":
    unittest.main()
