"""Tests for cheater.agent (agent loop)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cheater.agent import (
    Agent,
    Answer,
    BuildResult,
    Plan,
    ReviewResult,
    _build_memory_brief,
    _build_plan,
    _extract_diff,
    _maybe_ask_provider,
    _provider_from_config,
    _review_suggestions,
)
from cheater.config import CheaterConfig
from cheater.providers import NoModelProvider, ProviderConfig


def _sample_cards() -> list[dict]:
    return [
        {
            "id": "x/repo-1",
            "repo": "x/repo",
            "language": "python",
            "bug_type": "TypeError",
            "symptom": "pydantic env var missing",
            "root_cause": "env_names not in dict",
            "fix_pattern": "check explode_env_vars",
            "failed_approaches": ["add try/except"],
            "key_files": ["x/y.py"],
            "test_signal": "test_pydantic_env",
            "search_keywords": ["pydantic", "env", "validation"],
            "quality_score": 0.9,
        },
    ]


class TestProviderFromConfig(unittest.TestCase):
    def test_no_model(self):
        cfg = CheaterConfig()
        p = _provider_from_config(cfg)
        self.assertIsInstance(p, NoModelProvider)

    def test_openai_unconfigured(self):
        cfg = CheaterConfig()
        cfg.provider.provider = "openai"
        cfg.provider.model = ""
        cfg.provider.base_url = ""
        p = _provider_from_config(cfg)
        self.assertIsInstance(p, NoModelProvider)

    def test_openai_configured(self):
        cfg = CheaterConfig()
        cfg.provider.provider = "openai"
        cfg.provider.model = "x"
        cfg.provider.base_url = "http://localhost:1234/v1"
        from cheater.providers import OpenAIProvider
        p = _provider_from_config(cfg)
        self.assertIsInstance(p, OpenAIProvider)


class TestMaybeAskProvider(unittest.TestCase):
    def test_no_model_returns_none(self):
        # _maybe_ask_provider catches ModelNotConfigured and returns None
        # so the caller can fall back to deterministic mode.
        r = _maybe_ask_provider(NoModelProvider(ProviderConfig()), "sys", "user")
        self.assertIsNone(r)


class TestExtractDiff(unittest.TestCase):
    def test_fenced_diff(self):
        text = "Here's a patch:\n```diff\n--- a/x\n+++ b/x\n@@\n-old\n+new\n```\n"
        d = _extract_diff(text)
        self.assertIn("--- a/x", d)

    def test_no_diff(self):
        text = "I think the bug is..."
        self.assertIsNone(_extract_diff(text))

    def test_bare_diff(self):
        text = "--- a/x\n+++ b/x\n@@\n-old\n+new"
        d = _extract_diff(text)
        self.assertIn("--- a/x", d)


class TestBuildPlan(unittest.TestCase):
    def test_basic(self):
        ex = {"top_files": [{"path": "x.py"}], "test_files": ["t.py"]}
        plan = _build_plan("fix bug", ex, "memory brief")
        self.assertIsInstance(plan, Plan)
        self.assertIn("x.py", plan.files_to_inspect)
        self.assertIn("pytest t.py", plan.tests_to_run)
        self.assertGreater(len(plan.steps), 3)


class TestBuildMemoryBrief(unittest.TestCase):
    def test_no_cards(self):
        text, hits = _build_memory_brief("foo", [], CheaterConfig())
        self.assertIn("no memory hits", text.lower())


class TestReviewSuggestions(unittest.TestCase):
    def test_no_diff(self):
        self.assertEqual(_review_suggestions("", []), [])

    def test_detects_print(self):
        diff = "+print('debug')\n+    print(x)"
        sugs = _review_suggestions(diff, ["x.py"])
        self.assertTrue(any("print" in s.lower() for s in sugs))

    def test_no_test_in_diff(self):
        diff = "+def f(): pass\n" * 20
        sugs = _review_suggestions(diff, ["x.py"])
        self.assertTrue(any("test" in s.lower() for s in sugs))

    def test_large_diff_warning(self):
        diff = ("+x\n" * 250)
        sugs = _review_suggestions(diff, ["x.py"])
        self.assertTrue(any("large" in s.lower() for s in sugs))


class TestAgent(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "src").mkdir()
        (self.tmp / "src" / "main.py").write_text("def hello():\n    return 1\n", encoding="utf-8")
        # sample cards next to project
        (self.tmp / "data" / "samples").mkdir(parents=True)
        (self.tmp / "data" / "samples" / "sample_cards.v1.jsonl").write_text("", encoding="utf-8")
        # Write a real sample card
        import json
        cards = _sample_cards()
        with (self.tmp / "data" / "samples" / "sample_cards.v1.jsonl").open("w", encoding="utf-8") as f:
            for c in cards:
                f.write(json.dumps(c) + "\n")
        cfg = CheaterConfig()
        cfg.project_root = str(self.tmp)
        cfg.cards_path = "data/cards/cards.v1.jsonl"
        cfg.sample_cards_path = "data/samples/sample_cards.v1.jsonl"
        self.agent = Agent(cfg, project_root=self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_ask_no_model(self):
        ans = self.agent.ask("pydantic env bug")
        self.assertIsInstance(ans, Answer)
        self.assertGreater(len(ans.memory_brief), 10)
        self.assertIn("pydantic", ans.memory_brief.lower())

    def test_plan(self):
        p = self.agent.plan("fix the bug")
        self.assertIsInstance(p, Plan)
        self.assertGreater(len(p.steps), 0)

    def test_build_no_model(self):
        br = self.agent.build("fix the bug", dry_run=True)
        self.assertIsInstance(br, BuildResult)
        # No model -> no patch
        self.assertIsNone(br.proposed_patch)

    def test_review_clean(self):
        rr = self.agent.review()
        self.assertIsInstance(rr, ReviewResult)


if __name__ == "__main__":
    unittest.main()
