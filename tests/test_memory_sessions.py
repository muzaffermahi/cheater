"""Tests for cheater.sessions and cheater.memory."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cheater.memory import (
    MemoryHit,
    diversity_filter,
    format_brief,
    memory_search,
)
from cheater.sessions import (
    format_session_list,
    list_sessions,
    load_session,
    new_session,
    session_root_for,
)


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
            "search_keywords": ["pydantic", "env", "validation"],
            "quality_score": 0.9,
        },
        {
            "id": "x/repo-2",
            "repo": "x/repo",
            "language": "python",
            "bug_type": "TypeError",
            "symptom": "missing field in model",
            "root_cause": "field not declared",
            "fix_pattern": "add field",
            "failed_approaches": [],
            "search_keywords": ["pydantic", "model"],
            "quality_score": 0.7,
        },
        {
            "id": "y/other-1",
            "repo": "y/other",
            "language": "javascript",
            "bug_type": "TypeError",
            "symptom": "undefined is not a function",
            "root_cause": "method missing",
            "fix_pattern": "add method",
            "failed_approaches": [],
            "search_keywords": ["js", "function"],
            "quality_score": 0.6,
        },
    ]


class TestMemorySearch(unittest.TestCase):
    def setUp(self):
        self.cards = _sample_cards()

    def test_balanced(self):
        hits = memory_search("pydantic env", self.cards, mode="balanced")
        self.assertGreater(len(hits), 0)
        self.assertIsInstance(hits[0], MemoryHit)
        self.assertEqual(hits[0].card.get("id"), "x/repo-1")

    def test_off_returns_empty(self):
        hits = memory_search("pydantic env", self.cards, mode="off")
        self.assertEqual(hits, [])

    def test_compact(self):
        hits = memory_search("pydantic", self.cards, mode="compact", top_k_override=1)
        self.assertLessEqual(len(hits), 1)

    def test_aggressive(self):
        hits = memory_search("pydantic", self.cards, mode="aggressive", top_k_override=10)
        self.assertGreaterEqual(len(hits), 1)

    def test_language_filter(self):
        hits = memory_search("pydantic", self.cards, mode="balanced", language="python")
        for h in hits:
            self.assertEqual(h.card.get("language"), "python")

    def test_empty_query(self):
        hits = memory_search("", self.cards, mode="balanced")
        self.assertEqual(hits, [])

    def test_no_cards(self):
        hits = memory_search("pydantic", [], mode="balanced")
        self.assertEqual(hits, [])


class TestDiversityFilter(unittest.TestCase):
    def test_limits_per_repo(self):
        cards = _sample_cards()
        hits = memory_search("pydantic", cards, mode="aggressive", top_k_override=10)
        filtered = diversity_filter(hits, max_per_repo=1)
        # Should be <= 1 per repo
        repo_counts: dict[str, int] = {}
        for h in filtered:
            repo_counts[h.card.get("repo", "?")] = repo_counts.get(h.card.get("repo", "?"), 0) + 1
        for c in repo_counts.values():
            self.assertLessEqual(c, 1)


class TestFormatBrief(unittest.TestCase):
    def test_no_hits(self):
        text = format_brief([], "foo", repo_context=None)
        self.assertIn("no memory hits", text.lower())

    def test_with_hits(self):
        cards = _sample_cards()
        hits = memory_search("pydantic", cards, mode="balanced")
        text = format_brief(hits, "pydantic env validation", repo_context="pydantic project")
        self.assertIn("Memory Brief", text)
        self.assertIn("pydantic", text.lower())


class TestSessions(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_new_and_load(self):
        s = new_session(self.tmp, "fix the bug", mode="ask")
        self.assertTrue(s.path.is_dir())
        s.task = "fix the bug"
        s.plan = "step 1\nstep 2"
        s.save()
        s2 = load_session(self.tmp, s.id)
        self.assertEqual(s2.task, "fix the bug")
        self.assertEqual(s2.plan, "step 1\nstep 2")

    def test_list_sessions(self):
        new_session(self.tmp, "task a")
        new_session(self.tmp, "task b")
        items = list_sessions(self.tmp)
        self.assertEqual(len(items), 2)
        # Newest first
        self.assertIn("task a", items[0]["task"] + items[1]["task"])

    def test_session_root_for(self):
        p = session_root_for(self.tmp)
        self.assertEqual(p, self.tmp / ".cheater" / "sessions")

    def test_format_session_list(self):
        self.assertIn("No sessions", format_session_list([]))
        new_session(self.tmp, "test task")
        items = list_sessions(self.tmp)
        text = format_session_list(items)
        self.assertIn("test task", text)


if __name__ == "__main__":
    unittest.main()
