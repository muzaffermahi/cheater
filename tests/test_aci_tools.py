"""Tests for cheater.aci_tools (v0.6 compound tools)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cheater.aci_tools import (
    InspectSymbolTool,
    LocalizeBugTool,
    ReadContextPackTool,
    RepoMapBuildTool,
    RepoMapSearchTool,
    RunFocusedTestsTool,
    register_aci_tools,
)
from cheater.runner import run as runner_run
from cheater.tools import (
    ToolContext,
    ToolResult,
    default_tool_registry,
)


def _make_repo(root: Path) -> None:
    (root / "pkg").mkdir()
    (root / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (root / "pkg" / "calc.py").write_text(
        "def add(a, b):\n    return a + b\n"
        "def sub(a, b):\n    return a - b\n"
        "class Calculator:\n    def add(self, x, y):\n        return x + y\n",
        encoding="utf-8",
    )
    (root / "tests").mkdir()
    (root / "tests" / "test_calc.py").write_text(
        "from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )


def _ctx(root: Path, **kwargs) -> ToolContext:
    return ToolContext(
        repo_root=root, runner=runner_run,
        max_output_chars=8000,
        **kwargs,
    )


class TestRepoMapBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_happy(self):
        t = RepoMapBuildTool()
        r = t.run({"out_dir": ".cheater"}, _ctx(self.tmp))
        self.assertTrue(r.success, r.error)
        self.assertIn("indexed", r.summary)
        # Files written
        self.assertTrue((self.tmp / ".cheater" / "repo_map.json").is_file())
        self.assertTrue((self.tmp / ".cheater" / "repo_map.md").is_file())

    def test_default_out_dir(self):
        t = RepoMapBuildTool()
        r = t.run({}, _ctx(self.tmp))
        self.assertTrue(r.success, r.error)
        self.assertTrue((self.tmp / ".cheater" / "repo_map.json").is_file())


class TestRepoMapSearch(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_basic_query(self):
        t = RepoMapSearchTool()
        r = t.run({"query": "Calculator"}, _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("Calculator", r.output)
        # Should suggest next actions
        self.assertIn("NEXT SUGGESTED ACTIONS", r.output)

    def test_traceback_boost(self):
        t = RepoMapSearchTool()
        r = t.run({"query": "fix", "traceback": 'File "pkg/calc.py", line 5'},
                   _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("calc.py", r.output)

    def test_no_query(self):
        t = RepoMapSearchTool()
        r = t.run({}, _ctx(self.tmp))
        self.assertFalse(r.success)
        self.assertIn("query", r.error)


class TestInspectSymbol(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_inspect_by_symbol(self):
        t = InspectSymbolTool()
        r = t.run({"symbol": "add"}, _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("def add", r.output)
        # Test file should be listed as related
        self.assertIn("test_calc", r.output)
        # Next actions present
        self.assertIn("NEXT SUGGESTED ACTIONS", r.output)

    def test_inspect_by_path(self):
        t = InspectSymbolTool()
        r = t.run({"path": "pkg/calc.py"}, _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("pkg/calc.py", r.output)
        # Both functions shown
        self.assertIn("def add", r.output)
        self.assertIn("def sub", r.output)

    def test_no_inputs(self):
        t = InspectSymbolTool()
        r = t.run({}, _ctx(self.tmp))
        self.assertFalse(r.success)

    def test_nonexistent_path(self):
        t = InspectSymbolTool()
        r = t.run({"path": "nope.py"}, _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("not found", r.output)

    def test_unknown_symbol(self):
        t = InspectSymbolTool()
        r = t.run({"symbol": "definitelyNotInThisRepo_zzz"}, _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("not found", r.output)


class TestRunFocusedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)
        # Use a deterministic, always-available command:
        # python -c "print('ok')" -> success
        # python -c "raise Exception('boom')" -> failure

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_passing(self):
        import sys
        # Avoid shell-quoting issues by writing a tiny script
        (self.tmp / "ok.py").write_text("print(42)\n", encoding="utf-8")
        t = RunFocusedTestsTool()
        r = t.run({"cmd": f"{sys.executable} ok.py"}, _ctx(self.tmp))
        self.assertTrue(r.success, r.error)
        self.assertIn("passed=True", r.summary)
        self.assertIn("42", r.output)

    def test_failing(self):
        import sys
        (self.tmp / "boom.py").write_text("raise ValueError('boom')\n", encoding="utf-8")
        t = RunFocusedTestsTool()
        r = t.run({"cmd": f"{sys.executable} boom.py"}, _ctx(self.tmp))
        self.assertFalse(r.success)
        self.assertIn("ValueError", r.output)
        # Localizer hint should be present
        self.assertIn("localize_bug", r.output)

    def test_no_cmd(self):
        t = RunFocusedTestsTool()
        r = t.run({}, _ctx(self.tmp))
        self.assertFalse(r.success)

    def test_no_runner(self):
        import sys
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")
        t = RunFocusedTestsTool()
        ctx = ToolContext(repo_root=self.tmp, max_output_chars=4000)
        r = t.run({"cmd": f"{sys.executable} x.py"}, ctx)
        self.assertFalse(r.success)


class TestReadContextPack(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_basic(self):
        t = ReadContextPackTool()
        r = t.run({"task": "Fix Calculator.add"}, _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("CONTEXT PACK", r.output)
        self.assertIn("Calculator", r.output)
        # Next actions
        self.assertIn("NEXT SUGGESTED ACTIONS", r.output)

    def test_with_traceback(self):
        t = ReadContextPackTool()
        r = t.run({"task": "Fix bug", "traceback": "Traceback: x"},
                  _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("Traceback", r.output)

    def test_no_task(self):
        t = ReadContextPackTool()
        r = t.run({}, _ctx(self.tmp))
        self.assertFalse(r.success)


class TestLocalizeBug(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_basic(self):
        t = LocalizeBugTool()
        r = t.run({"task": "Fix add function"}, _ctx(self.tmp))
        self.assertTrue(r.success)
        self.assertIn("suspected_files", r.output)
        self.assertIn("pkg/calc.py", r.output)
        self.assertIn("NEXT SUGGESTED ACTIONS", r.output)

    def test_with_traceback(self):
        t = LocalizeBugTool()
        r = t.run({
            "task": "Fix bug",
            "traceback": 'File "pkg/calc.py", line 5, in add\n    return x',
        }, _ctx(self.tmp))
        self.assertTrue(r.success)
        # calc.py should be the top suspect
        import json as _json
        d = _json.loads(r.output.split("\n\nNEXT SUGGESTED ACTIONS")[0])
        self.assertGreater(len(d["suspected_files"]), 0)
        self.assertEqual(d["suspected_files"][0]["path"], "pkg/calc.py")

    def test_no_task(self):
        t = LocalizeBugTool()
        r = t.run({}, _ctx(self.tmp))
        self.assertFalse(r.success)


class TestRegistryIntegration(unittest.TestCase):
    def test_aci_tools_registered(self):
        reg = default_tool_registry()
        for name in ("repo_map_build", "repo_map_search", "inspect_symbol",
                     "run_focused_tests", "read_context_pack", "localize_bug"):
            self.assertIn(name, reg.names())

    def test_register_helper(self):
        from cheater.tools import RunCommandTool
        tools = [RunCommandTool()]
        out = register_aci_tools(tools)
        # 1 original + 6 ACI = 7
        self.assertEqual(len(out), 7)
        self.assertIn("repo_map_build", [t.name for t in out])


class TestNextActions(unittest.TestCase):
    def test_compact_output_no_huge_log(self):
        import sys
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            _make_repo(root)
            t = RunFocusedTestsTool()
            # Command that produces lots of output
            (root / "noisy.py").write_text(
                "for i in range(1000): print(i)\n", encoding="utf-8",
            )
            r = t.run({
                "cmd": f"{sys.executable} noisy.py",
            }, _ctx(root))
            # Output is truncated
            self.assertLess(len(r.output), 8000)


if __name__ == "__main__":
    unittest.main()
