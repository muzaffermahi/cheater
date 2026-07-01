"""Tests for cheater.context_pack (v0.6)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cheater.context_pack import (
    ContextPack,
    ContextProvider,
    FilesProvider,
    InstructionsProvider,
    MemoryProvider,
    RepoMapProvider,
    SkillsProvider,
    TaskProvider,
    TracebackProvider,
    build_context_pack,
    render_for_model,
)
# TestsProvider is imported as an alias to avoid pytest's test-class autodetect.
from cheater.context_pack import TestsProvider as _TestsProvider


def _make_repo(root: Path) -> None:
    (root / "pkg").mkdir()
    (root / "pkg" / "foo.py").write_text(
        '"""Foo module."""\n'
        "def hello(x):\n    return x + 1\n"
        "class Foo:\n    def bar(self):\n        return 1\n",
        encoding="utf-8",
    )
    (root / "tests").mkdir()
    (root / "tests" / "test_foo.py").write_text(
        "from pkg.foo import hello\n",
        encoding="utf-8",
    )
    (root / "AGENTS.md").write_text(
        "# AGENTS\n\n"
        "Run pytest -q before committing.\n"
        "Prefer minimal source edits.\n"
        "Do not edit tests.\n",
        encoding="utf-8",
    )
    (root / "pyproject.toml").write_text(
        '[project]\nname = "x"\n\n[project.scripts]\ncheater-test = "x:t"\n',
        encoding="utf-8",
    )


class TestProviders(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_task_provider(self):
        p = TaskProvider("Fix bug")
        self.assertEqual(p.name, "task")
        self.assertEqual(p.label, "Task")
        self.assertEqual(p.body, "Fix bug")

    def test_traceback_provider(self):
        p = TracebackProvider("Traceback: x")
        self.assertEqual(p.name, "traceback")
        self.assertIn("Traceback", p.body)

    def test_repo_map_provider(self):
        p = RepoMapProvider(self.tmp, query="hello", top_k=5)
        self.assertEqual(p.name, "repo_map")
        self.assertGreater(len(p.body), 0)
        self.assertIn("hello", p.body.lower())

    def test_files_provider(self):
        p = FilesProvider([("x.py", "def hi(): pass\n"), ("y.py", "x = 1\n")])
        self.assertIn("x.py", p.body)
        self.assertIn("y.py", p.body)

    def test_files_provider_empty(self):
        p = FilesProvider([])
        self.assertEqual(p.body, "")

    def test_tests_provider(self):
        p = _TestsProvider(self.tmp, query="hello")
        self.assertGreater(len(p.body), 0)
        self.assertIn("test_foo.py", p.body)

    def test_memory_provider_no_store(self):
        p = MemoryProvider(None, "anything")
        self.assertEqual(p.body, "")

    def test_memory_provider_with_store(self):
        from cheater.memory_store import MemoryStore
        with tempfile.TemporaryDirectory() as d:
            store = MemoryStore(Path(d))
            store.add("pydantic v2 uses field_validator", tags=["python"])
            p = MemoryProvider(store, "pydantic", top_k=3)
            self.assertIn("pydantic", p.body)
            self.assertIn("python", p.body)

    def test_skills_provider_no_op(self):
        p = SkillsProvider(query="x")
        self.assertEqual(p.body, "")

    def test_instructions_provider(self):
        p = InstructionsProvider(self.tmp)
        # AGENTS.md content should be present (filtered for keywords)
        self.assertIn("pytest", p.body.lower())
        # pyproject.toml scripts
        self.assertIn("cheater-test", p.body)


class TestInstructionsFiltering(unittest.TestCase):
    def test_no_agents_md(self):
        with tempfile.TemporaryDirectory() as d:
            p = InstructionsProvider(Path(d))
            # Should be empty or near-empty
            self.assertEqual(p.body, "")

    def test_huge_readme_truncated(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "README.md").write_text("x" * 50000, encoding="utf-8")
            p = InstructionsProvider(root)
            # README head is capped
            self.assertLess(len(p.body), 5000)


class TestContextPackBuilder(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_repo(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_minimal(self):
        pack = build_context_pack("Fix bug", self.tmp)
        names = [p.name for p in pack.providers]
        # Must include task, instructions, repo map, tests
        self.assertIn("task", names)
        self.assertIn("instructions", names)
        self.assertIn("repo_map", names)
        self.assertIn("tests", names)
        # Without memory_store, no memory provider
        self.assertNotIn("memory", names)

    def test_with_traceback(self):
        pack = build_context_pack("Fix bug", self.tmp, traceback="Traceback: x")
        names = [p.name for p in pack.providers]
        self.assertIn("traceback", names)

    def test_with_files(self):
        pack = build_context_pack("Fix bug", self.tmp,
                                  files=[("x.py", "def x(): pass")])
        names = [p.name for p in pack.providers]
        self.assertIn("files", names)

    def test_with_memory(self):
        from cheater.memory_store import MemoryStore
        with tempfile.TemporaryDirectory() as d:
            store = MemoryStore(Path(d))
            store.add("a thing to remember", tags=["x"])
            pack = build_context_pack("Fix bug", self.tmp, memory_store=store)
            names = [p.name for p in pack.providers]
            self.assertIn("memory", names)

    def test_render_for_model(self):
        pack = build_context_pack("Fix bug", self.tmp)
        out = render_for_model(pack)
        self.assertIn("CONTEXT PACK", out)
        self.assertIn("Fix bug", out)
        # At least one provider should appear
        self.assertIn("---", out)

    def test_truncation_enforces_budget(self):
        # Big files + tiny budget should clip
        files = [("a.py", "x" * 20000), ("b.py", "y" * 20000)]
        pack = build_context_pack("task", self.tmp, files=files, max_tokens=200)
        self.assertTrue(len(pack.truncated) > 0,
                        f"expected truncation, got {pack.truncated}")

    def test_no_repo_map_option(self):
        pack = build_context_pack("task", self.tmp, include_repo_map=False)
        names = [p.name for p in pack.providers]
        self.assertNotIn("repo_map", names)

    def test_no_tests_option(self):
        pack = build_context_pack("task", self.tmp, include_tests=False)
        names = [p.name for p in pack.providers]
        self.assertNotIn("tests", names)

    def test_no_instructions_option(self):
        pack = build_context_pack("task", self.tmp, include_instructions=False)
        names = [p.name for p in pack.providers]
        self.assertNotIn("instructions", names)

    def test_no_agents_no_bloat(self):
        with tempfile.TemporaryDirectory() as d:
            # Only a README + pyproject, no AGENTS.md
            root = Path(d)
            (root / "README.md").write_text("Title\n\nSome content\n", encoding="utf-8")
            (root / "pyproject.toml").write_text(
                '[project]\nname = "x"\n[project.scripts]\nx = "x"\n', encoding="utf-8",
            )
            pack = build_context_pack("task", root, include_repo_map=False,
                                      include_tests=False)
            out = render_for_model(pack)
            # Should be compact
            self.assertLess(len(out), 1500)


class TestContextPackAPI(unittest.TestCase):
    def test_add_and_get(self):
        pack = ContextPack(task="t")
        p = ContextProvider(name="x", label="X", body="body")
        pack.add(p)
        self.assertIs(pack.get("x"), p)
        self.assertIsNone(pack.get("missing"))

    def test_total_chars(self):
        pack = ContextPack(task="t")
        pack.add(ContextProvider(name="a", label="A", body="abc"))
        pack.add(ContextProvider(name="b", label="B", body="defg"))
        self.assertEqual(pack.total_chars(), 7)

    def test_to_dict(self):
        pack = ContextPack(task="t", max_tokens=500)
        d = pack.to_dict()
        self.assertEqual(d["task"], "t")
        self.assertEqual(d["max_tokens"], 500)
        self.assertEqual(d["providers"], [])
        self.assertEqual(d["truncated"], [])


if __name__ == "__main__":
    unittest.main()
