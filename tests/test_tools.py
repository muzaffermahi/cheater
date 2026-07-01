"""Tests for cheater.tools (Phase A + B tools). NO network."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cheater.tools import (
    AskUserTool,
    CreateFileTool,
    EditFileTool,
    IDontKnowTool,
    FinishTool,
    ListFilesTool,
    ReadFileTool,
    RunCommandTool,
    SearchCodeTool,
    SearchMemoryTool,
    ToolContext,
    ToolResult,
    default_tool_registry,
)


def _card(cid: str, **over) -> dict:
    base = {
        "id": cid, "repo": "x/repo", "language": "python",
        "bug_type": "TypeError", "symptom": f"symptom {cid}",
        "root_cause": f"cause {cid}", "fix_pattern": f"fix {cid}",
        "search_keywords": ["k"],
    }
    base.update(over)
    return base


class TestToolBase(unittest.TestCase):
    def test_validate_args_required(self):
        t = ReadFileTool()
        ok, err = t.validate_args({})
        self.assertFalse(ok)
        self.assertIn("path", err)
        ok, err = t.validate_args({"path": "x.py"})
        self.assertTrue(ok, err)

    def test_validate_args_type(self):
        t = RunCommandTool()
        ok, err = t.validate_args({"cmd": "x", "timeout": "60"})
        self.assertFalse(ok)
        self.assertIn("integer", err)
        ok, err = t.validate_args({"cmd": "x", "timeout": 60})
        self.assertTrue(ok, err)

    def test_validate_args_wrong_root_type(self):
        t = ReadFileTool()
        ok, err = t.validate_args("not a dict")
        self.assertFalse(ok)


class TestReadFile(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.f = self.tmp / "x.py"
        self.f.write_text("line1\nline2\nline3\nline4\nline5\n", encoding="utf-8")
        self.ctx = ToolContext(repo_root=self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_full_read(self):
        r = ReadFileTool().run({"path": "x.py"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("line1", r.output)
        self.assertEqual(r.files_read, ["x.py"])

    def test_line_range(self):
        r = ReadFileTool().run({"path": "x.py", "line_range": "2-3"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("line2", r.output)
        self.assertIn("line3", r.output)
        self.assertNotIn("line1", r.output)

    def test_missing_path(self):
        r = ReadFileTool().run({}, self.ctx)
        self.assertFalse(r.success)

    def test_missing_file(self):
        r = ReadFileTool().run({"path": "nope.py"}, self.ctx)
        self.assertFalse(r.success)

    def test_escape_rejected(self):
        r = ReadFileTool().run({"path": "../etc/passwd"}, self.ctx)
        self.assertFalse(r.success)


class TestListFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "a.py").write_text("", encoding="utf-8")
        (self.tmp / "b.py").write_text("", encoding="utf-8")
        (self.tmp / "sub").mkdir()
        (self.tmp / "sub" / "c.py").write_text("", encoding="utf-8")
        self.ctx = ToolContext(repo_root=self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_top_level(self):
        r = ListFilesTool().run({"glob": "*.py"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("a.py", r.output)

    def test_recursive(self):
        r = ListFilesTool().run({"glob": "**/*.py"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("sub/c.py", r.output)

    def test_no_matches(self):
        r = ListFilesTool().run({"glob": "*.nope"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("no matches", r.output)


class TestSearchCode(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "a.py").write_text("def hello():\n    return 1\n", encoding="utf-8")
        (self.tmp / "b.py").write_text("def world():\n    return 2\n", encoding="utf-8")
        self.ctx = ToolContext(repo_root=self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_finds_match(self):
        r = SearchCodeTool().run({"query": "hello"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("a.py:1", r.output)

    def test_no_match(self):
        r = SearchCodeTool().run({"query": "nope"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("no matches", r.output.lower() or "0 matches" in r.summary)

    def test_glob_filter(self):
        r = SearchCodeTool().run({"query": "def", "file_glob": "a.py"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("a.py", r.output)
        self.assertNotIn("b.py", r.output)


class TestRunCommand(unittest.TestCase):
    def setUp(self):
        import sys as _sys
        self.tmp = Path(tempfile.mkdtemp())
        # Use python -c as a portable command
        from cheater.runner import run as runner_run
        self.runner = runner_run
        self.ctx = ToolContext(repo_root=self.tmp, runner=runner_run)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_simple_command(self):
        import sys
        r = RunCommandTool().run({"cmd": f'{sys.executable} -c "print(42)"'}, self.ctx)
        self.assertTrue(r.success, r.error)
        self.assertIn("42", r.output)

    def test_failing_command(self):
        import sys
        r = RunCommandTool().run({"cmd": f'{sys.executable} -c "raise Exception(1)"'}, self.ctx)
        self.assertFalse(r.success)

    def test_no_runner(self):
        ctx = ToolContext(repo_root=self.tmp)
        r = RunCommandTool().run({"cmd": "x"}, ctx)
        self.assertFalse(r.success)


class TestSearchMemory(unittest.TestCase):
    def setUp(self):
        from cheater.memory import memory_search
        self.cards = [_card("x/repo-1"), _card("x/repo-2", symptom="pydantic env var missing")]
        self.ctx = ToolContext(repo_root=Path("/tmp"), cards=self.cards, memory_search=memory_search)

    def test_finds_match(self):
        r = SearchMemoryTool().run({"query": "pydantic env"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("x/repo-2", r.output)

    def test_no_match(self):
        r = SearchMemoryTool().run({"query": "no_such_bug_xyz"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("0 hit", r.summary)

    def test_no_cards(self):
        ctx = ToolContext(repo_root=Path("/tmp"), cards=[], memory_search=self.ctx.memory_search)
        r = SearchMemoryTool().run({"query": "anything"}, ctx)
        self.assertTrue(r.success)
        self.assertIn("no cards", r.summary)


class TestAskUser(unittest.TestCase):
    def test_with_callback(self):
        ctx = ToolContext(repo_root=Path("/tmp"), ask_user=lambda q: "yes")
        r = AskUserTool().run({"question": "do it?"}, ctx)
        self.assertTrue(r.success)
        self.assertEqual(r.output, "yes")

    def test_without_callback(self):
        ctx = ToolContext(repo_root=Path("/tmp"))
        r = AskUserTool().run({"question": "do it?"}, ctx)
        self.assertFalse(r.success)


class TestEditFile(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.f = self.tmp / "x.txt"
        self.f.write_text("hello world\nfoo bar\n", encoding="utf-8")
        self.ctx = ToolContext(repo_root=self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_happy_path(self):
        r = EditFileTool().run({"path": "x.txt", "old": "hello", "new": "goodbye"}, self.ctx)
        self.assertTrue(r.success)
        self.assertEqual(self.f.read_text(encoding="utf-8"), "goodbye world\nfoo bar\n")

    def test_read_only(self):
        ctx = ToolContext(repo_root=self.tmp, read_only=True)
        r = EditFileTool().run({"path": "x.txt", "old": "hello", "new": "goodbye"}, ctx)
        self.assertFalse(r.success)
        self.assertIn("read-only", r.error)

    def test_old_not_found(self):
        r = EditFileTool().run({"path": "x.txt", "old": "missing", "new": "x"}, self.ctx)
        self.assertFalse(r.success)

    def test_old_not_unique(self):
        f = self.tmp / "y.txt"
        f.write_text("a\na\n", encoding="utf-8")
        r = EditFileTool().run({"path": "y.txt", "old": "a", "new": "b"}, self.ctx)
        self.assertFalse(r.success)
        self.assertIn("unique", r.error)

    def test_forbidden_path(self):
        forbidden = self.tmp / "data" / "cards" / "x.jsonl"
        forbidden.parent.mkdir(parents=True)
        forbidden.write_text("forbidden\n", encoding="utf-8")
        r = EditFileTool().run({"path": "data/cards/x.jsonl", "old": "forbidden", "new": "ok"}, self.ctx)
        self.assertFalse(r.success)


class TestCreateFile(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.ctx = ToolContext(repo_root=self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_happy_path(self):
        r = CreateFileTool().run({"path": "new.txt", "content": "hi\n"}, self.ctx)
        self.assertTrue(r.success)
        self.assertEqual((self.tmp / "new.txt").read_text(encoding="utf-8"), "hi\n")

    def test_creates_dirs(self):
        r = CreateFileTool().run({"path": "deep/dir/file.txt", "content": "x"}, self.ctx)
        self.assertTrue(r.success)
        self.assertTrue((self.tmp / "deep" / "dir" / "file.txt").is_file())

    def test_read_only(self):
        ctx = ToolContext(repo_root=self.tmp, read_only=True)
        r = CreateFileTool().run({"path": "x.txt", "content": "x"}, ctx)
        self.assertFalse(r.success)

    def test_refuses_existing_file(self):
        (self.tmp / "x.txt").write_text("old\n", encoding="utf-8")
        r = CreateFileTool().run({"path": "x.txt", "content": "new\n"}, self.ctx)
        self.assertFalse(r.success)
        self.assertIn("already exists", r.error)
        self.assertEqual((self.tmp / "x.txt").read_text(encoding="utf-8"), "old\n")


class TestSpecialTools(unittest.TestCase):
    def test_finish(self):
        r = FinishTool().run({"summary": "done", "evidence": "tests/x.py passed"}, ToolContext(repo_root=Path("/tmp")))
        self.assertTrue(r.success)
        self.assertIn("done", r.summary)

    def test_idontknow(self):
        r = IDontKnowTool().run({"reason": "too hard"}, ToolContext(repo_root=Path("/tmp")))
        self.assertTrue(r.success)
        self.assertIn("too hard", r.summary)


class TestRegistry(unittest.TestCase):
    def test_default_registry_has_all_tools(self):
        r = default_tool_registry(read_only=False)
        for name in ("read_file", "list_files", "search_code", "run_command",
                     "search_memory", "ask_user", "edit_file", "create_file",
                     "finish", "i_dont_know",
                     # v0.6 ACI tools
                     "repo_map_build", "repo_map_search", "inspect_symbol",
                     "run_focused_tests", "read_context_pack", "localize_bug"):
            self.assertIn(name, r.names(), f"missing tool: {name}")

    def test_read_only_omits_edits(self):
        r = default_tool_registry(read_only=True)
        self.assertNotIn("edit_file", r.names())
        self.assertNotIn("create_file", r.names())

    def test_validate_action_happy(self):
        r = default_tool_registry()
        ok, err, name, args = r.validate_action({"action": "read_file", "args": {"path": "x"}})
        self.assertTrue(ok, err)
        self.assertEqual(name, "read_file")
        self.assertEqual(args, {"path": "x"})

    def test_validate_action_unknown(self):
        r = default_tool_registry()
        ok, err, _, _ = r.validate_action({"action": "nope"})
        self.assertFalse(ok)
        self.assertIn("unknown", err.lower())

    def test_validate_action_missing_args(self):
        r = default_tool_registry()
        ok, err, _, _ = r.validate_action({"action": "read_file"})
        self.assertFalse(ok)

    def test_validate_action_wrong_type(self):
        r = default_tool_registry()
        ok, err, _, _ = r.validate_action({"action": "read_file", "args": {"path": 123}})
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
