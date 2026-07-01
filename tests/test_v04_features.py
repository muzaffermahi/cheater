"""Tests for v0.4 agent loop features: 2-stage routing, TODO planning, dedup, budget."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cheater.agent_loop import AgentLoop, _evidence_is_concrete
from cheater.budget import ContextBudget
from cheater.tools import default_tool_registry


def _card(cid: str) -> dict:
    return {
        "id": cid, "repo": "x/repo", "language": "python",
        "bug_type": "TypeError", "symptom": f"symptom {cid}",
        "root_cause": f"cause {cid}", "fix_pattern": f"fix {cid}",
        "search_keywords": ["k"],
    }


class FakeProvider:
    """A canned-response provider for tests."""
    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.name = "fake"

    def chat(self, messages, **opts):
        if not self._responses:
            return '{"action": "i_dont_know", "args": {"reason": "no more"}}'
        return self._responses.pop(0)


class TestTwoStageRouting(unittest.TestCase):
    """With 2-stage on, the model first picks a category, then a tool."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")
        (self.tmp / "test_x.py").write_text("def test_x():\n    assert True\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_two_stage_picks_category_then_tool(self):
        # 1: plan
        # 2: pick category "read"
        # 3: pick tool "read_file"
        # 4: pick category "meta"
        # 5: finish
        provider = FakeProvider([
            '{"plan": ["Read x.py", "Finish"]}',
            '{"category": "read"}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=provider, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=False,
            max_steps=10,
        )
        r = loop.run("read x.py")
        self.assertTrue(r.success, r.error)
        # We should have used 5 model calls (plan + 2 categories + 2 tools)
        self.assertGreaterEqual(len(provider._responses) <= 0, True)


class TestTodoPlanning(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_todo_anchoring_marks_progress(self):
        provider = FakeProvider([
            '{"plan": ["Read x.py", "Edit x.py", "Finish"]}',
            # 2-stage: pick read
            '{"category": "read"}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            # 2-stage: pick write
            '{"category": "write"}',
            '{"action": "edit_file", "args": {"path": "x.py", "old": "x = 1", "new": "x = 2"}}',
            # 2-stage: pick meta
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=provider, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=True,
            max_steps=15,
        )
        r = loop.run("edit x.py")
        self.assertTrue(r.success, r.error)
        # The plan has 3 steps; the first 2 should be marked done (read + edit)
        self.assertEqual(loop._plan_step_status[0], "done")
        self.assertEqual(loop._plan_step_status[1], "done")

    def test_plan_status_block_renders(self):
        provider = FakeProvider([])
        loop = AgentLoop(provider=provider, repo_root=self.tmp, todo_anchoring=True)
        loop.memory.set_plan(["step1", "step2", "step3"])
        loop._plan_step_status = ["done", "in_progress", "pending"]
        block = loop._plan_status_block()
        self.assertIn("[x] 1. step1", block)
        self.assertIn("[~] 2. step2", block)
        self.assertIn("[ ] 3. step3", block)
        self.assertIn("1/3", block)


class TestBudgetIntegration(unittest.TestCase):
    """The budget gets populated as the loop runs."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_budget_tracks_tool_results(self):
        provider = FakeProvider([
            '{"plan": ["read"]}',
            '{"category": "read"}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=provider, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=False,
            max_steps=10,
        )
        r = loop.run("test")
        self.assertTrue(r.success, r.error)
        # Budget info should be in the result
        self.assertIn("budget", r.to_dict())
        self.assertGreater(r.budget.get("total_chars", 0), 0)


class TestDedupIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")
        (self.tmp / "y.py").write_text("y = 2\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_repeated_read_uses_cache(self):
        # 1: plan, 2: cat read, 3: read x.py, 4: cat read, 5: read x.py (dedup),
        # 6: cat meta, 7: finish
        provider = FakeProvider([
            '{"plan": ["read x.py", "finish"]}',
            '{"category": "read"}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"category": "read"}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=provider, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=False,
            max_steps=15,
        )
        r = loop.run("test")
        self.assertTrue(r.success, r.error)
        # Find the dedup-cached step
        dedup_steps = [s for s in r.steps if "[dedup-cached]" in s.get("summary", "")]
        self.assertEqual(len(dedup_steps), 1)


class TestAdaptiveTemperature(unittest.TestCase):
    def test_temp_schedule(self):
        provider = FakeProvider([])
        loop = AgentLoop(provider=provider, repo_root=Path("/tmp"))
        # Attempt 0: base - 0.15
        self.assertLess(loop._temp_for_attempt(0), 0.1)
        # Attempt 1: base
        self.assertAlmostEqual(loop._temp_for_attempt(1), 0.1)
        # Attempt 2: base + 0.15
        self.assertGreater(loop._temp_for_attempt(2), 0.1)


class TestForgivingParserInLoop(unittest.TestCase):
    """The agent loop should accept JSON, YAML, XML, Hermes, plain-verb formats."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_yaml_format_accepted(self):
        # 1: plan, 2: cat read, 3: yaml-formatted read_file
        provider = FakeProvider([
            '{"plan": ["read x.py"]}',
            '{"category": "read"}',
            "action: read_file\nargs:\n  path: x.py",
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=provider, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=False,
            max_steps=10,
        )
        r = loop.run("read x.py")
        self.assertTrue(r.success, r.error)

    def test_hermes_format_accepted(self):
        provider = FakeProvider([
            '{"plan": ["read"]}',
            '{"category": "read"}',
            '<|tool_call|>{"name": "read_file", "arguments": {"path": "x.py"}}<|/tool_call|>',
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=provider, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=False,
            max_steps=10,
        )
        r = loop.run("read")
        self.assertTrue(r.success, r.error)


class TestQualityMonitorIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_hallucinated_tool_steers(self):
        # 1: plan, 2: cat read, 3: hallucinated tool name -> monitor steers,
        # 4: cat read, 5: real read_file, 6: cat meta, 7: finish
        provider = FakeProvider([
            '{"plan": ["read"]}',
            '{"category": "read"}',
            '{"action": "read_filex", "args": {}}',  # bad name
            '{"category": "read"}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"category": "meta"}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(
            provider=provider, repo_root=self.tmp,
            two_stage_routing=True, todo_anchoring=False,
            max_steps=15,
        )
        r = loop.run("read")
        # The monitor should have caught the bad name and re-asked
        self.assertTrue(r.success, r.error)


if __name__ == "__main__":
    unittest.main()
