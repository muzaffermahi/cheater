"""Tests for cheater.explorer (FastContext-style repo explorer)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.explorer import (
    ExplorerResult,
    explore,
    format_explorer,
    save_explorer,
)
from cheater.patch_engine import is_forbidden


class TestForbiddenPaths(unittest.TestCase):
    def test_forbidden(self):
        self.assertTrue(is_forbidden(".git/config"))
        self.assertTrue(is_forbidden("data/cards/foo.jsonl"))
        self.assertTrue(is_forbidden("data/indexes/foo.npy"))
        self.assertTrue(is_forbidden("_archive/old.py"))
        self.assertTrue(is_forbidden("venv/lib/foo.py"))
        self.assertTrue(is_forbidden(".cheater/sessions/x/task.txt"))
        self.assertFalse(is_forbidden("cheater/foo.py"))
        self.assertFalse(is_forbidden("data/samples/sample.jsonl"))


class TestExploreBasic(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "src").mkdir()
        (self.tmp / "src" / "main.py").write_text(
            "def hello():\n    return 'world'\n\nclass Foo:\n    pass\n", encoding="utf-8"
        )
        (self.tmp / "src" / "util.py").write_text(
            "def add(a, b):\n    return a + b\n", encoding="utf-8"
        )
        (self.tmp / "tests").mkdir()
        (self.tmp / "tests" / "test_main.py").write_text(
            "def test_hello():\n    assert True\n", encoding="utf-8"
        )
        (self.tmp / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
        (self.tmp / "README.md").write_text("# Test\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_explore_finds_python_file(self):
        r = explore("hello function", repo_root=self.tmp)
        paths = {tf.get("path", "") for tf in r.top_files}
        self.assertTrue(any("main.py" in p for p in paths), paths)

    def test_explore_finds_test_file(self):
        r = explore("anything", repo_root=self.tmp)
        self.assertTrue(any("test_main.py" in t for t in r.test_files))

    def test_explore_finds_config_file(self):
        r = explore("anything", repo_root=self.tmp)
        self.assertTrue(any("pyproject.toml" in c for c in r.config_files))

    def test_explore_extracts_symbols(self):
        r = explore("hello", repo_root=self.tmp)
        # The explorer filters symbols to those that match the query
        names = {s.get("name") for s in r.symbols}
        self.assertIn("hello", names)
        # The Foo symbol is extracted but only included in r.symbols if its
        # name matches a query term. Test the underlying extractor directly.
        from cheater.explorer import _extract_symbols
        all_syms = _extract_symbols(self.tmp / "src" / "main.py", ".py")
        all_names = {s.get("name") for s in all_syms}
        self.assertIn("hello", all_names)
        self.assertIn("Foo", all_names)

    def test_explore_no_query_terms(self):
        r = explore("###", repo_root=self.tmp)
        # No useful results but no crash
        self.assertIsInstance(r, ExplorerResult)

    def test_explore_nonexistent_dir(self):
        r = explore("foo", repo_root="/nonexistent/path/xyz")
        self.assertGreater(len(r.warnings), 0)

    def test_format_explorer_smoke(self):
        r = explore("hello", repo_root=self.tmp)
        text = format_explorer(r, text=True)
        self.assertIn("Repo Explorer", text)
        self.assertIn("hello", text.lower() or "main.py" in text)

    def test_save_explorer(self):
        r = explore("hello", repo_root=self.tmp)
        out = self.tmp / "ex.json"
        save_explorer(r, out)
        self.assertTrue(out.is_file())
        d = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(d["query"], "hello")
        self.assertIn("top_files", d)


class TestExploreIgnores(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "src").mkdir()
        (self.tmp / "src" / "main.py").write_text("def foo():\n    pass\n", encoding="utf-8")
        # Create forbidden dirs
        (self.tmp / "data" / "cards").mkdir(parents=True)
        (self.tmp / "data" / "cards" / "big.jsonl").write_text("ignored", encoding="utf-8")
        (self.tmp / "_archive").mkdir()
        (self.tmp / "_archive" / "old.py").write_text("ignored", encoding="utf-8")
        (self.tmp / "__pycache__").mkdir()
        (self.tmp / "__pycache__" / "x.py").write_text("ignored", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_ignores_forbidden_dirs(self):
        r = explore("foo", repo_root=self.tmp)
        paths = [tf.get("path", "") for tf in r.top_files]
        # None of the forbidden dir files should appear
        for p in paths:
            self.assertFalse("data/cards" in p, p)
            self.assertFalse("_archive" in p, p)
            self.assertFalse("__pycache__" in p, p)


if __name__ == "__main__":
    unittest.main()
