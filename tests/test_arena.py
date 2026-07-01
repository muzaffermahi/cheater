"""Tests for cheater.arena (v0.7)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.arena import (
    ComponentConfig,
    EvalCase,
    RepairConfig,
    compare_reports,
    load_eval_cases,
    read_arena_report,
    render_arena_summary,
    run_component_eval,
    run_repair_eval,
    write_arena_report,
)


def _write_case(
    root: Path,
    case_id: str,
    *,
    task: str,
    expected: list[str] | None = None,
    traceback: str = "",
) -> None:
    d = root / case_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "task.txt").write_text(task, encoding="utf-8")
    if traceback:
        (d / "traceback.txt").write_text(traceback, encoding="utf-8")
    if expected is not None:
        (d / "expected_files.json").write_text(json.dumps(expected), encoding="utf-8")


class TestLoadEvalCases(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _write_case(
            self.tmp,
            "case_a",
            task="Fix the import bug",
            expected=["cheater/memory.py"],
        )
        _write_case(
            self.tmp,
            "case_b",
            task="Fix syntax error",
            expected=["cheater/localizer.py"],
            traceback="SyntaxError: bad",
        )

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_loads_cases(self):
        cases = load_eval_cases(self.tmp)
        self.assertEqual(len(cases), 2)
        ids = {c.case_id for c in cases}
        self.assertIn("case_a", ids)
        self.assertIn("case_b", ids)

    def test_loads_expected_files(self):
        cases = load_eval_cases(self.tmp)
        case_a = next(c for c in cases if c.case_id == "case_a")
        self.assertEqual(case_a.expected_files, ["cheater/memory.py"])

    def test_loads_traceback(self):
        cases = load_eval_cases(self.tmp)
        case_b = next(c for c in cases if c.case_id == "case_b")
        self.assertIn("SyntaxError", case_b.traceback)

    def test_empty_dir(self):
        empty = Path(tempfile.mkdtemp())
        try:
            self.assertEqual(load_eval_cases(empty), [])
        finally:
            import shutil

            shutil.rmtree(empty, ignore_errors=True)

    def test_missing_dir(self):
        self.assertEqual(load_eval_cases("/no/such/dir"), [])


class TestComponentEval(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _write_case(
            self.tmp,
            "c1",
            task="fix import error",
            expected=["cheater/memory.py"],
            traceback="ModuleNotFoundError: No module named 'cheater.budget'",
        )

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unknown_component(self):
        cases = load_eval_cases(self.tmp)
        cfg = ComponentConfig(component="nope", repo_root=str(self.tmp))
        report = run_component_eval(cases, cfg)
        self.assertFalse(report.get("ok"))
        self.assertIn("unknown component", report.get("error", ""))

    def test_localization_eval(self):
        cases = load_eval_cases(self.tmp)
        cfg = ComponentConfig(component="localization", repo_root=str(self.tmp))
        report = run_component_eval(cases, cfg)
        self.assertTrue(report.get("ok"))
        agg = report["aggregate"]
        self.assertIn("localization_hit_at_1", agg)
        self.assertIn("localization_hit_at_3", agg)
        self.assertIn("symbol_hit_at_5", agg)
        # The localizer must return a list of files (may be empty in an
        # empty tmp dir, but the structure must be there).
        loc = report["cases"][0]["localization"]
        self.assertIn("files", loc)
        self.assertIsInstance(loc["files"], list)
        # With an empty tmp dir, hit@k must be 0
        self.assertEqual(agg["localization_hit_at_1"], 0.0)

    def test_failure_compression_eval(self):
        cases = load_eval_cases(self.tmp)
        cfg = ComponentConfig(component="failure_compression", repo_root=str(self.tmp))
        report = run_component_eval(cases, cfg)
        self.assertTrue(report.get("ok"))
        agg = report["aggregate"]
        self.assertEqual(agg["failure_summary_has_error_type"], 1.0)
        self.assertEqual(agg["failure_summary_has_test_name"], 1.0)

    def test_context_pack_eval(self):
        cases = load_eval_cases(self.tmp)
        cfg = ComponentConfig(component="context_pack", repo_root=str(self.tmp))
        report = run_component_eval(cases, cfg)
        self.assertTrue(report.get("ok"))
        agg = report["aggregate"]
        self.assertIn("context_chars", agg)
        self.assertIn("estimated_context_tokens", agg)
        self.assertIn("context_relevance_score", agg)
        # The pack should include the task
        providers = report["cases"][0]["context_pack"]["providers"]
        self.assertIn("task", providers)

    def test_mock_localize(self):
        cases = load_eval_cases(self.tmp)

        def mock_localize(case, cfg):
            return {"files": case.expected_files, "symbols": [], "source": "mock"}

        cfg = ComponentConfig(
            component="localization",
            repo_root=str(self.tmp),
            localize_fn=mock_localize,
        )
        report = run_component_eval(cases, cfg)
        self.assertEqual(report["aggregate"]["localization_hit_at_1"], 1.0)


class TestRepairEval(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _write_case(
            self.tmp, "c1", task="fix import error", expected=["cheater/memory.py"]
        )

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_mock_loop(self):
        cases = load_eval_cases(self.tmp)

        def mock_loop(case, cfg):
            return {
                "ok": True,
                "case_id": case.case_id,
                "success": True,
                "rounds": 3,
                "diff_lines": 12,
                "touched_files": case.expected_files,
                "risk_flags": [],
                "model_call_count": 4,
                "tool_call_count": 6,
                "elapsed": 0.5,
                "finished_by": "finish",
            }

        cfg = RepairConfig(repo_root=str(self.tmp), loop_fn=mock_loop)
        report = run_repair_eval(cases, cfg)
        self.assertTrue(report["ok"])
        agg = report["aggregate"]
        self.assertEqual(agg["successes"], 1)
        self.assertEqual(agg["success_rate"], 1.0)
        self.assertEqual(agg["average_rounds_to_success"], 3.0)
        self.assertEqual(agg["average_diff_lines"], 12.0)
        self.assertEqual(agg["model_call_count"], 4.0)
        self.assertEqual(agg["tool_call_count"], 6.0)

    def test_no_model(self):
        cases = load_eval_cases(self.tmp)
        cfg = RepairConfig(repo_root=str(self.tmp))
        # No loop_fn means the real loop runs; with no model, it returns no_model
        report = run_repair_eval(cases, cfg)
        self.assertTrue(report["ok"])
        # case 1 had finished_by = no_model
        self.assertEqual(report["cases"][0]["finished_by"], "no_model")


class TestReportIO(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_write_and_read(self):
        report = {
            "ok": True,
            "kind": "component",
            "aggregate": {
                "cases": 2,
                "localization_hit_at_1": 0.5,
                "estimated_context_tokens": 4000,
            },
        }
        path = self.tmp / "r.json"
        write_arena_report(report, path)
        self.assertTrue(path.is_file())
        out = read_arena_report(path)
        self.assertEqual(out["aggregate"]["cases"], 2)

    def test_render_summary(self):
        report = {
            "ok": True,
            "kind": "component",
            "elapsed_sec": 1.0,
            "aggregate": {
                "cases": 2,
                "localization_hit_at_1": 0.5,
                "estimated_context_tokens": 4000,
            },
        }
        text = render_arena_summary(report)
        self.assertIn("localization_hit_at_1", text)
        self.assertIn("cases", text)

    def test_compare(self):
        old = {
            "kind": "component",
            "aggregate": {
                "localization_hit_at_1": 0.3,
                "estimated_context_tokens": 5000,
            },
        }
        new = {
            "kind": "component",
            "aggregate": {
                "localization_hit_at_1": 0.5,
                "estimated_context_tokens": 4000,
            },
        }
        cmp = compare_reports(old, new)
        self.assertIn("metrics", cmp)
        # hit rate went up
        for r in cmp["metrics"]:
            if r["metric"] == "localization_hit_at_1":
                self.assertGreater(r["delta"], 0)


if __name__ == "__main__":
    unittest.main()
