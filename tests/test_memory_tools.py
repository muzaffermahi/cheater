"""Tests for the v0.5 memory tools and nudge integration."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from cheater.memory_nudges import (
    format_session_start_nudge,
    format_tool_size_nudge,
)
from cheater.memory_store import MemoryStore
from cheater.tools import (
    MemoryForgetTool,
    MemoryRecallTool,
    MemoryRememberTool,
    ToolContext,
)


class TestMemoryRememberTool(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)
        self.ctx = ToolContext(repo_root=Path("/tmp"), memory_store=self.store)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_happy_path(self):
        r = MemoryRememberTool().run({"text": "pydantic v2 uses field_validator"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("id=", r.summary)

    def test_with_tags(self):
        r = MemoryRememberTool().run(
            {"text": "user prefers concise answers", "tags": "user,style"}, self.ctx,
        )
        self.assertTrue(r.success)
        items = self.store.all()
        self.assertEqual(len(items), 1)
        self.assertIn("user", items[0].tags)
        self.assertIn("style", items[0].tags)

    def test_missing_text(self):
        r = MemoryRememberTool().run({}, self.ctx)
        self.assertFalse(r.success)
        self.assertIn("missing", r.error)

    def test_empty_text(self):
        r = MemoryRememberTool().run({"text": "   "}, self.ctx)
        self.assertFalse(r.success)

    def test_creates_store_if_missing(self):
        ctx = ToolContext(repo_root=Path("/tmp"))  # no memory_store
        r = MemoryRememberTool().run({"text": "test"}, ctx)
        self.assertTrue(r.success)


class TestMemoryForgetTool(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)
        self.ctx = ToolContext(repo_root=Path("/tmp"), memory_store=self.store)
        self.id1 = self.store.add("first memory")
        self.id2 = self.store.add("second memory")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_by_id(self):
        r = MemoryForgetTool().run({"memory_id": self.id1}, self.ctx)
        self.assertTrue(r.success)
        self.assertEqual(len(self.store), 1)
        self.assertIsNone(self.store.get(self.id1))

    def test_by_query(self):
        r = MemoryForgetTool().run({"query": "second"}, self.ctx)
        self.assertTrue(r.success)
        self.assertEqual(len(self.store), 1)
        self.assertIsNone(self.store.get(self.id2))

    def test_no_match(self):
        r = MemoryForgetTool().run({"query": "nonexistent_xyz_qwerty"}, self.ctx)
        self.assertFalse(r.success)
        self.assertIn("no match", r.summary)

    def test_no_args(self):
        r = MemoryForgetTool().run({}, self.ctx)
        self.assertFalse(r.success)


class TestMemoryRecallTool(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)
        self.store.add("django migration fails on python 3.12", tags=["python", "django"])
        self.store.add("pydantic v2 uses field_validator", tags=["python", "pydantic"])
        self.store.add("user prefers concise answers", tags=["user"])
        self.ctx = ToolContext(repo_root=Path("/tmp"), memory_store=self.store)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_finds_match(self):
        r = MemoryRecallTool().run({"query": "django"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("django", r.output)
        self.assertEqual(len(r.memory_cards), 1)

    def test_no_match(self):
        r = MemoryRecallTool().run({"query": "nonexistent_xyz_qwerty"}, self.ctx)
        self.assertTrue(r.success)
        self.assertIn("0 hits", r.summary)

    def test_top_k(self):
        r = MemoryRecallTool().run({"query": "python", "top_k": 1}, self.ctx)
        self.assertTrue(r.success)
        # At most 1 hit
        self.assertLessEqual(len(r.memory_cards), 1)

    def test_missing_query(self):
        r = MemoryRecallTool().run({}, self.ctx)
        self.assertFalse(r.success)


class TestNudgeFormatting(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_nudge_empty_store(self):
        text = format_session_start_nudge(self.store)
        self.assertIn("NUDGE", text)
        self.assertIn("No curated memories", text)

    def test_nudge_with_entries(self):
        self.store.add("user prefers concise answers")
        text = format_session_start_nudge(self.store)
        self.assertIn("NUDGE", text)
        self.assertIn("1 curated", text)
        self.assertIn("user prefers", text)

    def test_tool_size_nudge_below_threshold(self):
        text = format_tool_size_nudge("small output")
        self.assertEqual(text, "")

    def test_tool_size_nudge_above_threshold(self):
        big = "x" * 3000
        text = format_tool_size_nudge(big)
        self.assertIn("NUDGE", text)
        self.assertIn("3000 chars", text)


class TestAgentLoopMemoryIntegration(unittest.TestCase):
    """Test that the agent loop wires the memory store into prompts."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")
        self.store = MemoryStore(self.tmp)
        self.store.add("user prefers concise answers", tags=["user"])

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_memory_appears_in_prompt(self):
        from cheater.agent_loop import AgentLoop

        class FakeProvider:
            def __init__(self, r):
                self.r = list(r)
            def chat(self, m, **o):
                return self.r.pop(0) if self.r else "{}"

        p = FakeProvider([
            '{"plan": ["finish"]}',
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        captured = []

        # Patch the chat to capture the prompt
        orig_chat = AgentLoop._chat
        def capture_chat(self, messages, **opts):
            captured.append(messages[-1].get("content", ""))
            return orig_chat(self, messages, **opts)
        with mock.patch.object(AgentLoop, "_chat", capture_chat):
            loop = AgentLoop(
                provider=p, repo_root=self.tmp,
                two_stage_routing=True, todo_anchoring=False,
                max_steps=10, memory_store=self.store,
            )
            r = loop.run("test")
        self.assertTrue(r.success, r.error)
        # The first prompt (plan call) should have the memory block
        self.assertGreater(len(captured), 0)
        first_prompt = captured[0]
        # The memory block contains the stored memory
        # (Note: plan call uses PLAN_PROMPT which is shorter; the memory
        # block only appears in _next_action prompts.)
        # So we check the action-pick prompt instead.
        action_prompts = [c for c in captured if "CURATED MEMORIES" in c or "NUDGE" in c]
        self.assertGreater(len(action_prompts), 0,
                           f"no prompt contained memory block; prompts: {captured[:2]}")

    def test_memory_recall_touch_bumps_use_count(self):
        from cheater.agent_loop import AgentLoop

        class FakeProvider:
            def __init__(self, r):
                self.r = list(r)
            def chat(self, m, **o):
                return self.r.pop(0) if self.r else "{}"

        mem_id = self.store.add("django migration fails", tags=["django"])
        initial_count = self.store.get(mem_id).use_count

        p = FakeProvider([
            '{"plan": ["recall"]}',
            '{"category": "read"}',
            '{"action": "memory_recall", "args": {"query": "django"}}',
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=p, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=False,
            max_steps=10, memory_store=self.store,
        )
        r = loop.run("test")
        self.assertTrue(r.success, r.error)
        # use_count should be bumped
        new_count = self.store.get(mem_id).use_count
        self.assertGreater(new_count, initial_count)


if __name__ == "__main__":
    unittest.main()
