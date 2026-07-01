"""Tests for cheater/quality.py"""
from __future__ import annotations

import unittest

from cheater.quality import quality_summary, quality_tier, score_card


def _good_card() -> dict:
    return {
        "id": "good-1",
        "source": "nebius/SWE-agent-trajectories",
        "repo": "owner/repo",
        "language": "Python",
        "bug_type": "TypeError",
        "symptom": "TypeError: cannot import foo from bar in production tests.",
        "root_cause": "Missing __init__.py",
        "fix_pattern": "Add __init__.py to the bar module and import from bar.foo correctly.",
        "failed_approaches": ["hardcoding the value"],
        "key_files": ["bar/__init__.py", "bar/foo.py"],
        "test_signal": "test_foo",
        "search_keywords": ["import", "TypeError", "foo"],
        "embedding_text": "This is a long enough embedding text describing the bug fix in production. " * 2,
        "usable": True,
    }


def _junk_card() -> dict:
    return {
        "id": "junk-1",
        "source": "nebius/SWE-agent-trajectories",
        "usable": False,
        "symptom": "errors.) command at the end of the file,",
        "fix_pattern": "",
        "embedding_text": "",
    }


def _medium_card() -> dict:
    return {
        "id": "med-1",
        "source": "nebius/SWE-agent-trajectories",
        "repo": "owner/repo",
        "language": "Python",
        "symptom": "KeyError when accessing dict with missing key.",
        "fix_pattern": "Use dict.get(key) instead of dict[key] to avoid KeyError.",
        "embedding_text": "KeyError occurs in production because code uses dict[key] instead of dict.get(key).",
        "usable": True,
    }


class TestQualityScoring(unittest.TestCase):
    def test_good_card_scores_high(self):
        c = _good_card()
        q = score_card(c)
        self.assertGreaterEqual(q["score"], 0.8)
        self.assertEqual(quality_tier(q["score"]), "high")
        self.assertEqual(q["reasons"], [])

    def test_junk_card_scores_low(self):
        c = _junk_card()
        q = score_card(c)
        self.assertLess(q["score"], 0.5)
        self.assertIn(quality_tier(q["score"]), ("junk", "low"))
        self.assertTrue(len(q["reasons"]) > 0)
        self.assertIn("repo missing (cross-project ambiguity risk)", q["reasons"])

    def test_medium_card_scores_medium(self):
        c = _medium_card()
        q = score_card(c)
        self.assertGreaterEqual(q["score"], 0.3)

    def test_missing_fields_flagged(self):
        c = {"id": "x", "source": "y", "usable": True}
        q = score_card(c)
        # Should have many reasons
        self.assertTrue(len(q["reasons"]) >= 2)

    def test_tier_labels(self):
        self.assertEqual(quality_tier(0.9), "high")
        self.assertEqual(quality_tier(0.6), "medium")
        self.assertEqual(quality_tier(0.4), "low")
        self.assertEqual(quality_tier(0.1), "junk")
        self.assertEqual(quality_tier(0.0), "junk")

    def test_garbage_text_detected(self):
        c = _good_card()
        c["symptom"] = "errors.) command at the end of the file,"
        q = score_card(c)
        self.assertIn("symptom looks like boilerplate/truncation", q["reasons"])

    def test_quality_summary_aggregates(self):
        cards = [_good_card(), _medium_card(), _junk_card()]
        s = quality_summary(cards)
        self.assertEqual(s["total"], 3)
        self.assertGreater(s["avg_quality"], 0.0)
        self.assertIn("top_languages", s)
        self.assertIn("top_repositories", s)
        self.assertIn("embedding_text_length", s)

    def test_summary_detects_duplicates(self):
        c1 = _good_card()
        c2 = _good_card()
        c2["id"] = "good-2"
        c2["embedding_text"] = c1["embedding_text"]  # same embedding text
        s = quality_summary([c1, c2])
        self.assertGreater(len(s["duplicate_groups"]), 0)

    def test_no_duplicate_groups_when_unique(self):
        c1 = _good_card()
        c2 = _good_card()
        c2["id"] = "good-2"
        c2["embedding_text"] = "Completely different text that is not a duplicate of anything."
        s = quality_summary([c1, c2])
        self.assertEqual(len(s["duplicate_groups"]), 0)
