"""Tests for cheater.agent_loop + cheater.working_memory. NO network."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cheater.agent_loop import (
    AgentLoop,
    LoopResult,
    _evidence_is_concrete,
    _truncate_args,
)
from cheater.parser import parse_json_loose
from cheater.working_memory import Step, WorkingMemory
from cheater.providers import NoModelProvider, ProviderConfig


def _card(cid: str) -> dict:
    return {
        "id": cid, "repo": "x/repo", "language": "python",
        "bug_type": "TypeError", "symptom": f"symptom {cid}",
        "root_cause": f"cause {cid}", "fix_pattern": f"fix {cid}",
        "search_keywords": ["k"],
    }


class FakeProvider:
    """A canned-response provider for tests. Returns one response per call."""
    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self._calls: list[list[dict]] = []
        self.name = "fake"

    def chat(self, messages, **opts):
        self._calls.append(list(messages))
        if not self._responses:
            return "<<no more canned responses>>"
        return self._responses.pop(0)


class WindowProvider(FakeProvider):
    def __init__(self, responses: list[str], context_window: int) -> None:
        super().__init__(responses)
        self._context_window = context_window

    def get_context_window(self) -> int:
        return self._context_window


class TestParseJson(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_json_loose('{"a": 1}')[0], {"a": 1})

    def test_fenced(self):
        self.assertEqual(parse_json_loose('```json\n{"a": 1}\n```')[0], {"a": 1})

    def test_with_prose(self):
        self.assertEqual(parse_json_loose('Here: {"a": 1} done.')[0], {"a": 1})

    def test_empty(self):
        self.assertIsNone(parse_json_loose("")[0])
        self.assertIsNone(parse_json_loose("not json")[0])

    def test_unbalanced(self):
        self.assertIsNone(parse_json_loose('{"a": 1')[0])


class TestEvidenceIsConcrete(unittest.TestCase):
    def test_test_name(self):
        self.assertTrue(_evidence_is_concrete("test_foo passed"))
        self.assertTrue(_evidence_is_concrete("tests/test_x.py::test_y"))

    def test_file_path(self):
        self.assertTrue(_evidence_is_concrete("cheater/quality.py was changed"))
        self.assertTrue(_evidence_is_concrete("'cheater/foo.py' edited"))

    def test_pytest(self):
        self.assertTrue(_evidence_is_concrete("pytest tests/test_quality.py passed"))
        self.assertTrue(_evidence_is_concrete("exit code 0"))

    def test_too_vague(self):
        self.assertFalse(_evidence_is_concrete("done"))
        self.assertFalse(_evidence_is_concrete(""))
        self.assertFalse(_evidence_is_concrete("I think it works"))

    def test_too_short(self):
        self.assertFalse(_evidence_is_concrete("ok"))


class TestTruncateArgs(unittest.TestCase):
    def test_short(self):
        self.assertEqual(_truncate_args({"path": "x.py"}), "path='x.py'")

    def test_long_string(self):
        s = "x" * 100
        out = _truncate_args({"data": s})
        self.assertIn("...", out)
        self.assertLess(len(out), 80)

    def test_numbers(self):
        self.assertIn("n=42", _truncate_args({"n": 42}))


class TestWorkingMemory(unittest.TestCase):
    def test_record_and_prompt(self):
        m = WorkingMemory()
        s1 = Step(action="read_file", args={"path": "x.py"}, summary="read x.py")
        m.record(s1)
        self.assertEqual(len(m.steps), 1)
        self.assertIn("read_file", m.to_prompt())

    def test_files_tracked(self):
        m = WorkingMemory()
        s = Step(action="read_file", args={"path": "a.py"}, summary="x")
        s.files_read = ["a.py"]
        m.record(s)
        s2 = Step(action="edit_file", args={"path": "b.py"}, summary="x")
        s2.files_written = ["b.py"]
        m.record(s2)
        self.assertIn("a.py", m.files_read)
        self.assertIn("b.py", m.files_written)

    def test_cards_tracked(self):
        m = WorkingMemory()
        s = Step(action="search_memory", args={"query": "x"}, summary="3 hits")
        s.memory_cards = ["c1", "c2", "c3"]
        m.record(s)
        self.assertEqual(m.memory_cards_seen, {"c1", "c2", "c3"})

    def test_set_plan(self):
        m = WorkingMemory()
        m.set_plan(["step1", "step2"])
        self.assertIn("step1", m.to_prompt())
        self.assertIn("step2", m.to_prompt())

    def test_to_dict_round_trip(self):
        m = WorkingMemory()
        m.set_plan(["x"])
        m.record(Step(action="read_file", args={"path": "y"}, summary="ok"))
        d = m.to_dict()
        self.assertEqual(d["plan"], ["x"])
        self.assertEqual(len(d["steps"]), 1)

    def test_compact_old_steps_keeps_recent_tail(self):
        m = WorkingMemory()
        for i in range(5):
            m.record(Step(action="read_file", args={"path": f"x{i}.py"}, summary=f"read {i}"))
        note = m.compact_old_steps(keep_last=2, reason="test pressure")
        self.assertIn("Compacted 3 older step", note)
        self.assertEqual([s.args["path"] for s in m.steps], ["x3.py", "x4.py"])
        self.assertTrue(any("x0.py" in n for n in m.notes))


class TestAgentLoopNoModel(unittest.TestCase):
    def test_no_model_returns_no_model_status(self):
        with tempfile.TemporaryDirectory() as d:
            loop = AgentLoop(
                provider=NoModelProvider(ProviderConfig()),
                repo_root=d,
            )
            r = loop.run("fix the bug")
            self.assertEqual(r.finished_by, "no_model")
            self.assertFalse(r.success)


class TestAgentLoopContextCompaction(unittest.TestCase):
    def test_auto_compacts_when_budget_is_hot(self):
        with tempfile.TemporaryDirectory() as d:
            events = []
            loop = AgentLoop(
                provider=FakeProvider([]),
                repo_root=d,
                budget_max_chars=200,
                context_compact_ratio=0.5,
                compact_keep_last=2,
                on_event=lambda e: events.append(e),
            )
            for i in range(6):
                loop.memory.record(
                    Step(action="read_file", args={"path": f"x{i}.py"}, summary=f"read {i}")
                )
            loop.budget.allocate("tool", "x" * 180)
            loop._maybe_compact_context(step_num=7, reason="test")
            self.assertEqual(len(loop.memory.steps), 2)
            self.assertTrue(any("Compacted 4 older step" in n for n in loop.memory.notes))
            self.assertTrue(any(e.kind == "budget" and e.extra.get("auto_compacted") for e in events))

    def test_effective_context_uses_provider_window_and_clamps_to_100k(self):
        with tempfile.TemporaryDirectory() as d:
            loop = AgentLoop(provider=WindowProvider([], 131072), repo_root=d)
            self.assertEqual(loop.max_context_tokens, 100000)
            small = AgentLoop(provider=WindowProvider([], 32768), repo_root=d)
            self.assertEqual(small.max_context_tokens, 32768)

    def test_outgoing_messages_are_trimmed_under_context_cap(self):
        with tempfile.TemporaryDirectory() as d:
            loop = AgentLoop(
                provider=FakeProvider([]),
                repo_root=d,
                max_context_tokens=1200,
                context_compact_ratio=0.5,
            )
            messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "x" * 10000}]
            fitted = loop._fit_messages_to_context(messages)
            total = sum(len(m["content"]) for m in fitted)
            self.assertLessEqual(total, loop.max_context_tokens * 4 + 200)
            self.assertIn("hard context cap", fitted[-1]["content"])


class TestAgentLoopHappyPath(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        # Source file to edit
        (self.tmp / "x.py").write_text("def hello():\n    return 1\n", encoding="utf-8")
        (self.tmp / "test_x.py").write_text("def test_hello():\n    assert True\n", encoding="utf-8")
        # Canned responses:
        # 1. Plan
        # 2. read_file(x.py)
        # 3. read_file(test_x.py)
        # 4. run_command (with concrete command)
        # 5. finish (with concrete evidence)
        self.provider = FakeProvider([
            '{"plan": ["Read x.py", "Read test_x.py", "Run pytest", "Finish"]}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"action": "read_file", "args": {"path": "test_x.py"}}',
            '{"action": "run_command", "args": {"cmd": "pytest test_x.py -x -q"}}',
            '{"action": "finish", "args": {"summary": "Inspected both files and ran tests", "evidence": "pytest test_x.py passed"}}',
        ])

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_runs_to_finish(self):
        events = []
        loop = AgentLoop(
            provider=self.provider,
            repo_root=self.tmp,
            cards=[_card("x/repo-1")],
            on_event=lambda e: events.append(e),
        )
        r = loop.run("inspect x.py and run the test")
        self.assertTrue(r.success, r.error)
        self.assertEqual(r.finished_by, "finish")
        # 3 actions + 1 finish step
        self.assertEqual(len(r.steps), 4)
        # All step events emitted (3 step + 1 finish)
        step_events = [e for e in events if e.kind == "step"]
        finish_events = [e for e in events if e.kind == "finish"]
        self.assertEqual(len(step_events), 3)
        self.assertEqual(len(finish_events), 1)

    def test_plan_in_result(self):
        loop = AgentLoop(provider=self.provider, repo_root=self.tmp)
        r = loop.run("inspect")
        self.assertEqual(len(r.plan), 4)
        self.assertEqual(r.plan[0], "Read x.py")


class TestAgentLoopInvalidJSONRetries(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x = 1\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_invalid_first_retry_succeeds(self):
        # 1: valid plan
        # 2: invalid JSON
        # 3: valid action
        # 4: finish
        provider = FakeProvider([
            '{"plan": ["step1"]}',
            'not json at all',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"action": "finish", "args": {"summary": "ok", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(provider=provider, repo_root=self.tmp)
        r = loop.run("test")
        self.assertTrue(r.success, r.error)

    def test_invalid_twice_gives_up(self):
        # 1: valid plan
        # 2, 3: invalid JSON twice
        provider = FakeProvider([
            '{"plan": ["step1"]}',
            'not json',
            'still not json',
        ])
        loop = AgentLoop(provider=provider, repo_root=self.tmp)
        r = loop.run("test")
        self.assertFalse(r.success)
        self.assertEqual(r.finished_by, "i_dont_know")
        self.assertIn("valid JSON", r.error)


class TestAgentLoopIDontKnow(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_idontknow_ends_loop(self):
        provider = FakeProvider([
            '{"plan": ["step1"]}',
            '{"action": "i_dont_know", "args": {"reason": "model is confused"}}',
        ])
        loop = AgentLoop(provider=provider, repo_root=self.tmp)
        r = loop.run("test")
        self.assertFalse(r.success)
        self.assertEqual(r.finished_by, "i_dont_know")
        self.assertIn("confused", r.error)


class TestAgentLoopFinishRequiresEvidence(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_vague_evidence_rejected(self):
        provider = FakeProvider([
            '{"plan": ["step1"]}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "looks good"}}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "I think it works"}}',
        ])
        loop = AgentLoop(provider=provider, repo_root=self.tmp)
        r = loop.run("test")
        self.assertFalse(r.success)
        self.assertEqual(r.finished_by, "i_dont_know")
        self.assertIn("evidence", r.error)

    def test_concrete_evidence_accepted(self):
        provider = FakeProvider([
            '{"plan": ["step1"]}',
            '{"action": "finish", "args": {"summary": "done", "evidence": "tests/test_x.py passed"}}',
        ])
        loop = AgentLoop(provider=provider, repo_root=self.tmp)
        r = loop.run("test")
        self.assertTrue(r.success)


class TestAgentLoopMaxSteps(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("x\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_max_steps_reached(self):
        # Plan, then 3 read_file actions (no finish). max_steps=3.
        provider = FakeProvider([
            '{"plan": ["step1", "step2", "step3"]}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
            '{"action": "read_file", "args": {"path": "x.py"}}',
        ])
        loop = AgentLoop(provider=provider, repo_root=self.tmp, max_steps=3)
        r = loop.run("test")
        self.assertFalse(r.success)
        self.assertEqual(r.finished_by, "max_steps")
        self.assertIn("max_steps", r.error)


class TestAgentLoopEditAndVerify(unittest.TestCase):
    """Phase B smoke: edit a file, run a test, finish."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "x.py").write_text("def f():\n    return 1\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_edit_then_test_then_finish(self):
        # Plan, then edit, then test, then finish.
        provider = FakeProvider([
            '{"plan": ["edit", "test", "finish"]}',
            '{"action": "edit_file", "args": {"path": "x.py", "old": "return 1", "new": "return 2"}}',
            f'{{"action": "run_command", "args": {{"cmd": "echo test_passed"}}}}',
            '{"action": "finish", "args": {"summary": "edited x.py", "evidence": "x.py was changed"}}',
        ])
        loop = AgentLoop(provider=provider, repo_root=self.tmp)
        r = loop.run("change return 1 to return 2")
        self.assertTrue(r.success, r.error)
        # The file was actually edited
        self.assertIn("return 2", (self.tmp / "x.py").read_text(encoding="utf-8"))


class TestAgentLoopDryRun(unittest.TestCase):
    """The CLI dry-run path: plan only, no execution."""

    def test_dry_run_returns_plan(self):
        from cheater.agent_loop_cli import run as cli_run
        import argparse
        with tempfile.TemporaryDirectory() as d:
            provider = FakeProvider([
                '{"plan": ["step1", "step2"]}',
            ])
            with mock.patch("cheater.agent_loop_cli._make_provider", return_value=(provider, [])):
                args = argparse.Namespace(
                    task="inspect the repo", repo=d, dry_run=True, json=False,
                    quiet=True, verbose=False, max_steps=20, read_only=False,
                )
                rc = cli_run(args)
                self.assertEqual(rc, 0)
                self.assertEqual(len(provider._responses), 0)  # plan was used


if __name__ == "__main__":
    unittest.main()
