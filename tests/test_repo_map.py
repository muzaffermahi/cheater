"""Tests for cheater.repo_map (v0.6 AST-based repo map)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.repo_map import (
    DEFAULT_IGNORED_DIRS,
    FunctionInfo,
    ClassInfo,
    RepoFile,
    RepoMap,
    build_repo_map,
    load_repo_map,
    render_repo_map_markdown,
    save_repo_map,
    select_relevant_map,
)


def _make_fake_repo(root: Path) -> None:
    """Create a small fake Python repo for testing."""
    (root / "src").mkdir()
    (root / "src" / "pkg").mkdir()
    (root / "src" / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (root / "src" / "pkg" / "calc.py").write_text(
        '"""Calculator module."""\n'
        "from typing import Optional\n"
        "PI = 3.14\n"
        "MAX_DEPTH = 10\n"
        "def add(a: int, b: int) -> int:\n"
        '    """Add two ints."""\n'
        "    return a + b\n"
        "async def slow_add(a, b):\n"
        "    return a + b\n"
        "class Calculator:\n"
        '    """A simple calculator."""\n'
        "    def __init__(self, base=0):\n"
        "        self.base = base\n"
        "    def add(self, x):\n"
        "        return self.base + x\n",
        encoding="utf-8",
    )
    (root / "src" / "pkg" / "broken.py").write_text(
        "def f(:\n    pass\n", encoding="utf-8",
    )
    (root / "tests").mkdir()
    (root / "tests" / "test_calc.py").write_text(
        "from src.pkg.calc import add, Calculator\n"
        "def test_add():\n"
        "    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )
    (root / "tests" / "test_smoke.py").write_text(
        "def test_smoke():\n    assert True\n", encoding="utf-8",
    )
    # Things that should be ignored
    (root / ".venv").mkdir()
    (root / ".venv" / "lib.py").write_text("SHOULD_NOT_PARSE = True\n", encoding="utf-8")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "x.py").write_text("X = 1\n", encoding="utf-8")
    (root / "__pycache__").mkdir()
    (root / "__pycache__" / "junk.py").write_text("", encoding="utf-8")
    (root / ".git").mkdir()
    (root / ".git" / "config.py").write_text("", encoding="utf-8")


class TestBuildRepoMap(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_fake_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_basic_build(self):
        m = build_repo_map(self.tmp)
        self.assertGreater(len(m.files), 0)
        paths = {f.path for f in m.files}
        # All real source/test files are included
        self.assertIn("src/pkg/calc.py", paths)
        self.assertIn("src/pkg/__init__.py", paths)
        self.assertIn("tests/test_calc.py", paths)
        self.assertIn("tests/test_smoke.py", paths)
        # Broken file is still present (with parse_error)
        self.assertIn("src/pkg/broken.py", paths)

    def test_ignores_venv_node_modules_git(self):
        m = build_repo_map(self.tmp)
        paths = {f.path for f in m.files}
        for p in paths:
            self.assertNotIn(".venv", p.split("/"))
            self.assertNotIn("node_modules", p.split("/"))
            self.assertNotIn("__pycache__", p.split("/"))
            self.assertNotIn(".git", p.split("/"))

    def test_extracts_functions(self):
        m = build_repo_map(self.tmp)
        calc = m.get("src/pkg/calc.py")
        self.assertIsNotNone(calc)
        names = {f.name for f in calc.functions}
        self.assertIn("add", names)
        self.assertIn("slow_add", names)
        # slow_add is async
        slow = next(f for f in calc.functions if f.name == "slow_add")
        self.assertTrue(slow.is_async)

    def test_extracts_classes_and_methods(self):
        m = build_repo_map(self.tmp)
        calc = m.get("src/pkg/calc.py")
        cls_names = {c.name for c in calc.classes}
        self.assertIn("Calculator", cls_names)
        c = next(c for c in calc.classes if c.name == "Calculator")
        self.assertIn("add", c.methods)
        self.assertIn("__init__", c.methods)
        # Class docstring
        self.assertIn("simple", c.doc)

    def test_extracts_imports(self):
        m = build_repo_map(self.tmp)
        calc = m.get("src/pkg/calc.py")
        imp_modules = {i.module for i in calc.imports}
        self.assertIn("typing", imp_modules)
        # typing.Optional was imported via names
        opt = [i for i in calc.imports if i.module == "typing"]
        self.assertTrue(any("Optional" in i.names for i in opt))

    def test_extracts_constants(self):
        m = build_repo_map(self.tmp)
        calc = m.get("src/pkg/calc.py")
        consts = {c.name: c.value_repr for c in calc.constants}
        self.assertIn("PI", consts)
        self.assertIn("MAX_DEPTH", consts)
        self.assertEqual(consts["PI"], "3.14")

    def test_docstrings_capped(self):
        m = build_repo_map(self.tmp)
        calc = m.get("src/pkg/calc.py")
        add_fn = next(f for f in calc.functions if f.name == "add")
        self.assertIn("two", add_fn.doc)

    def test_is_test_flag(self):
        m = build_repo_map(self.tmp)
        for f in m.files:
            if "test" in f.path:
                self.assertTrue(f.is_test, f.path)

    def test_parse_error_recorded(self):
        m = build_repo_map(self.tmp)
        broken = m.get("src/pkg/broken.py")
        self.assertIsNotNone(broken)
        self.assertNotEqual(broken.parse_error, "")


class TestTestToSourceMapping(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_fake_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_filename_mapping(self):
        m = build_repo_map(self.tmp)
        # test_calc.py -> calc.py (via filename similarity)
        candidates = m.test_to_source.get("tests/test_calc.py", [])
        self.assertTrue(any("calc.py" in c for c in candidates),
                        f"expected calc.py in {candidates}")

    def test_import_mapping(self):
        m = build_repo_map(self.tmp)
        # test_calc.py imports Calculator -> calc.py should appear
        candidates = m.test_to_source.get("tests/test_calc.py", [])
        self.assertTrue(any("calc.py" in c for c in candidates))

    def test_unknown_test_no_match(self):
        m = build_repo_map(self.tmp)
        # test_smoke.py has no obvious source
        candidates = m.test_to_source.get("tests/test_smoke.py", [])
        # Should be empty or limited; we don't fail if empty
        self.assertIsInstance(candidates, list)


class TestSaveLoad(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_fake_repo(self.tmp)
        self.out = self.tmp / "out"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_save_and_load_round_trip(self):
        m = build_repo_map(self.tmp)
        paths = save_repo_map(m, self.out)
        self.assertTrue(Path(paths["json"]).is_file())
        self.assertTrue(Path(paths["md"]).is_file())
        m2 = load_repo_map(paths["json"])
        self.assertEqual(m2.repo_root, m.repo_root)
        self.assertEqual(len(m2.files), len(m.files))
        # Spot-check a file
        f = m2.get("src/pkg/calc.py")
        self.assertIsNotNone(f)
        self.assertEqual({c.name for c in f.classes}, {"Calculator"})

    def test_render_markdown(self):
        m = build_repo_map(self.tmp)
        md = render_repo_map_markdown(m, max_tokens=2000)
        self.assertIn("Cheater repo map", md)
        self.assertIn("src/pkg/calc.py", md)
        self.assertIn("Calculator", md)


class TestSelectRelevantMap(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_fake_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_relevant_files_selected(self):
        m = build_repo_map(self.tmp)
        out = select_relevant_map(m, query="add two numbers", top_k=5)
        self.assertIn("Relevant repo map", out)
        # calc.py should be in the top picks
        self.assertIn("calc.py", out)

    def test_traceback_boost(self):
        m = build_repo_map(self.tmp)
        tb = 'File "src/pkg/calc.py", line 10, in add\n    return x + y'
        out = select_relevant_map(m, query="fix bug", traceback=tb, top_k=3)
        # calc.py must be in the top because of traceback boost
        self.assertIn("calc.py", out)

    def test_empty_repo(self):
        with tempfile.TemporaryDirectory() as d:
            m = build_repo_map(d)
            out = select_relevant_map(m, query="anything", top_k=3)
            self.assertIn("empty repo map", out)


class TestDataClasses(unittest.TestCase):
    def test_repo_file_to_dict(self):
        rf = RepoFile(
            path="x.py",
            imports=[],
            classes=[ClassInfo(name="C", line=1, methods=["m"])],
            functions=[FunctionInfo(name="f", line=2)],
        )
        d = rf.to_dict()
        self.assertEqual(d["path"], "x.py")
        self.assertEqual(d["classes"][0]["name"], "C")
        self.assertEqual(d["functions"][0]["name"], "f")
        self.assertIn("m", rf.symbol_names())


if __name__ == "__main__":
    unittest.main()
