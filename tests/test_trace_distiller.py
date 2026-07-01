"""Tests for cheater.trace_distiller (v0.7)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.trace_distiller import (
    ROLES,
    TrainingRow,
    distill_trace,
    distill_traces,
    suggest_antipatterns,
    suggest_skill_from_trace,
    write_training_rows,
)


def _success_trace(run_id: str = "abc") -> list[dict]:
    return [
        {
            "ts": 1.0,
            "event": "run_start",
            "payload": {
                "task": "fix the import error",
                "repo_root": "/x",
                "run_id": run_id,
            },
        },
        {
            "ts": 1.1,
            "event": "localization_result",
            "payload": {"suspected_files": [{"path": "x/memory.py"}]},
        },
        {
            "ts": 1.2,
            "event": "failure_summary",
            "payload": {
                "error_type": "ModuleNotFoundError",
                "summary": "No module named 'x'",
                "test": "tests/test_x.py::test_foo",
                "top_stack_files": ["x/memory.py"],
            },
        },
        {
            "ts": 1.3,
            "event": "model_output",
            "payload": {
                "parsed_action": {
                    "action": "edit_file",
                    "args": {"path": "x/memory.py"},
                }
            },
        },
        {
            "ts": 1.4,
            "event": "diff_generated",
            "payload": {"path": "x/memory.py", "old": "a", "new": "b", "lines": 1},
        },
        {
            "ts": 1.5,
            "event": "run_finished",
            "payload": {
                "success": True,
                "finished_by": "finish",
                "elapsed": 0.5,
                "steps": 3,
            },
        },
    ]


def _failed_trace() -> list[dict]:
    return [
        {
            "ts": 2.0,
            "event": "run_start",
            "payload": {"task": "fix something", "repo_root": "/x"},
        },
        {
            "ts": 2.1,
            "event": "model_output",
            "payload": {
                "parsed_action": {"action": "edit_file", "args": {"path": "x.py"}}
            },
        },
        {
            "ts": 2.2,
            "event": "failure_summary",
            "payload": {
                "error_type": "AssertionError",
                "summary": "expected 1 got 2",
                "test": "tests/test_x.py",
            },
        },
        {
            "ts": 2.3,
            "event": "run_finished",
            "payload": {
                "success": False,
                "finished_by": "max_steps",
                "elapsed": 1.0,
                "steps": 5,
            },
        },
    ]


class TestDistillSingle(unittest.TestCase):
    def test_successful_trace_creates_patcher_row(self):
        result = distill_trace(_success_trace(), run_id="abc")
        self.assertTrue(result.is_success)
        roles = {r.role for r in result.rows}
        self.assertIn("patcher", roles)
        self.assertIn("localizer", roles)
        self.assertIn("failure_analyst", roles)
        # success flag is in the patcher metadata
        patcher = next(r for r in result.rows if r.role == "patcher")
        self.assertTrue(patcher.metadata.get("success"))

    def test_failed_trace_does_not_create_patcher_row(self):
        result = distill_trace(_failed_trace(), run_id="xyz")
        self.assertFalse(result.is_success)
        roles = {r.role for r in result.rows}
        self.assertNotIn("patcher", roles)
        # failure_analyst may still exist if failure_summary was recorded
        self.assertIn("failure_analyst", roles)

    def test_failed_trace_creates_antipattern(self):
        result = distill_trace(_failed_trace(), run_id="xyz")
        # No skill_suggestion for failed
        self.assertEqual(result.skill_suggestion, {})
        # No bug_card for failed
        self.assertEqual(result.bug_card, {})
        # prompt_suggestion is set
        self.assertNotEqual(result.prompt_suggestion, "")

    def test_skill_suggestion_shape(self):
        result = distill_trace(_success_trace(), run_id="abc")
        s = result.skill_suggestion
        self.assertIn("name", s)
        self.assertIn("trigger", s)
        self.assertIn("steps", s)
        self.assertIn("validation", s)
        self.assertIn("when_not_to_use", s)


class TestSuggestAntipatterns(unittest.TestCase):
    def test_groups_by_first_action(self):
        # 3 failed traces all start with edit_file and end in max_steps
        failed = []
        for _ in range(3):
            tr = _failed_trace()
            failed.append(tr)
        anti = suggest_antipatterns(failed)
        kinds = {a.get("kind") for a in anti}
        # first_action pattern should appear (>=2 occurrences)
        self.assertIn("first_action", kinds)


class TestWriteTrainingRows(unittest.TestCase):
    def test_writes_per_role_jsonl(self):
        rows = [
            TrainingRow(
                role="patcher", input="task1", output="out1", metadata={"success": True}
            ),
            TrainingRow(
                role="patcher", input="task1", output="out1", metadata={"success": True}
            ),  # exact duplicate
            TrainingRow(
                role="localizer",
                input="task2",
                output="out2",
                metadata={"success": True},
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            counts = write_training_rows(rows, out)
            # dedup -> only 2 rows total
            self.assertEqual(counts["patcher"], 1)
            self.assertEqual(counts["localizer"], 1)
            # files exist
            self.assertTrue((out / "patcher_sft.jsonl").is_file())
            self.assertTrue((out / "localizer_sft.jsonl").is_file())
            # parseable
            lines = (
                (out / "patcher_sft.jsonl")
                .read_text(encoding="utf-8")
                .strip()
                .splitlines()
            )
            self.assertEqual(len(lines), 1)
            obj = json.loads(lines[0])
            self.assertEqual(obj["role"], "patcher")
            self.assertEqual(obj["input"], "task1")
            self.assertEqual(obj["output"], "out1")
            self.assertTrue(obj["metadata"]["success"])


class TestDistillTracesDir(unittest.TestCase):
    def test_distills_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            # write 2 success + 1 failed trace
            for i in range(2):
                tr = _success_trace(run_id=f"s{i}")
                (tmp / f"s{i}.jsonl").write_text(
                    "\n".join(json.dumps(e) for e in tr) + "\n", encoding="utf-8"
                )
            tr = _failed_trace()
            (tmp / "f0.jsonl").write_text(
                "\n".join(json.dumps(e) for e in tr) + "\n", encoding="utf-8"
            )
            out = tmp / "out"
            summary = distill_traces(tmp, out, min_success_only=True)
            self.assertTrue(summary["ok"])
            self.assertEqual(summary["traces_distilled"], 2)
            self.assertEqual(summary["failed_traces_seen"], 1)
            self.assertTrue((out / "patcher_sft.jsonl").is_file())
            self.assertTrue((out / "localizer_sft.jsonl").is_file())
            self.assertTrue((out / "antipatterns.json").is_file())
            # summary is written
            self.assertTrue((out / "summary.json").is_file())
            # bug cards file
            self.assertTrue((out / "bug_cards.jsonl").is_file())

    def test_emit_patcher_row_for_success(self):
        tr = _success_trace(run_id="a")
        result = distill_trace(tr, run_id="a")
        patcher = [r for r in result.rows if r.role == "patcher"]
        self.assertEqual(len(patcher), 1)
        self.assertIn("patches", patcher[0].output)

    def test_no_patcher_row_for_failure(self):
        tr = _failed_trace()
        result = distill_trace(tr, run_id="f")
        patcher = [r for r in result.rows if r.role == "patcher"]
        self.assertEqual(len(patcher), 0)

    def test_training_row_jsonl_valid(self):
        rows = [
            TrainingRow(
                role="localizer",
                input="i",
                output="o",
                metadata={"success": True, "tokens_est": 5, "source_trace": "abc"},
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            write_training_rows(rows, tmp)
            line = (tmp / "localizer_sft.jsonl").read_text(encoding="utf-8").strip()
            obj = json.loads(line)
            self.assertEqual(obj["role"], "localizer")
            self.assertIn("metadata", obj)
            self.assertIn("source_trace", obj["metadata"])


if __name__ == "__main__":
    unittest.main()
