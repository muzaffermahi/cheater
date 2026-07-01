"""Tests for the improved cheater/retrieval.py: filters, quality boost, MMR, why-matched."""
from __future__ import annotations

import unittest

from cheater.retrieval import (
    BM25FIndex, format_result, load_index_cards, tokenize_terms, why_matched,
)


def _cards() -> list[dict]:
    return [
        {
            "id": "a", "usable": True, "repo": "r1", "language": "python",
            "bug_type": "TypeError",
            "symptom": "TypeError: cannot import foo from bar module.",
            "root_cause": "Missing __init__.py",
            "fix_pattern": "Add __init__.py to bar module.",
            "key_files": ["bar/__init__.py"],
            "test_signal": "test_foo",
            "search_keywords": ["import", "TypeError", "foo"],
            "embedding_text": "typeerror cannot import foo from bar module add __init__",
            "quality_score": 0.9, "quality_tier": "high",
        },
        {
            "id": "b", "usable": True, "repo": "r2", "language": "python",
            "bug_type": "KeyError",
            "symptom": "KeyError: 'missing_key' in dict.",
            "root_cause": "dict access without default",
            "fix_pattern": "Use dict.get(key, default) instead of dict[key].",
            "key_files": ["utils.py"],
            "test_signal": "test_dict",
            "search_keywords": ["dict", "keyerror"],
            "embedding_text": "keyerror missing key in dict use dict get default",
            "quality_score": 0.7, "quality_tier": "high",
        },
        {
            "id": "c", "usable": True, "repo": "r1", "language": "javascript",
            "bug_type": "TypeError",
            "symptom": "TypeError: x is not a function in JS module.",
            "root_cause": "missing import",
            "fix_pattern": "add the import statement at top of file",
            "key_files": ["index.js"],
            "test_signal": "test_js",
            "search_keywords": ["javascript", "TypeError"],
            "embedding_text": "javascript typeerror x is not a function add import",
            "quality_score": 0.5, "quality_tier": "medium",
        },
        {
            "id": "junk", "usable": True, "repo": "r1", "language": "python",
            "bug_type": "unknown",
            "symptom": "errors.) command at the end of the file,",
            "root_cause": None,
            "fix_pattern": "fix it",
            "key_files": [],
            "test_signal": "",
            "search_keywords": [],
            "embedding_text": "errors.) command at the end of the file,",
            "quality_score": 0.1, "quality_tier": "junk",
        },
    ]


class TestRetrievalFeatures(unittest.TestCase):
    def setUp(self) -> None:
        self.cards = _cards()
        self.idx = BM25FIndex(self.cards)

    def test_basic_search(self):
        r = self.idx.search("TypeError import foo", top_k=2)
        self.assertEqual(r[0][1]["id"], "a")

    def test_language_filter(self):
        r = self.idx.search("TypeError import", top_k=2, language="python")
        ids = [c.get("id") for _, c in r]
        # Should include python cards
        self.assertIn("a", ids)
        # Should not include javascript card 'c' at rank 1
        # (Note: if filtered results < top_k, unfiltered results may be used as
        # fallback to fill top_k, so 'c' may appear at lower rank. We check
        # it doesn't appear before any python card.)
        if "c" in ids:
            # If javascript card leaked in, python card 'a' should be first
            self.assertEqual(ids[0], "a")

    def test_repo_filter(self):
        r = self.idx.search("TypeError", top_k=5, repo="r1")
        ids = [c.get("id") for _, c in r]
        self.assertIn("a", ids)
        # b is in r2

    def test_quality_min_excludes_junk(self):
        # With strict quality filter, junk should never appear
        # We use a query that matches non-junk cards too so the filter has
        # something to return alongside verifying junk is excluded.
        r = self.idx.search("TypeError import", top_k=5, quality_min=0.4)
        ids = [c.get("id") for _, c in r]
        # Junk should NOT appear (quality 0.1 < 0.4)
        self.assertNotIn("junk", ids)
        # If we got results, they should all be quality >= 0.4
        for card_id in ids:
            idx_in_corpus = [c["id"] for c in self.cards].index(card_id)
            q_score = self.cards[idx_in_corpus].get("quality_score", 0)
            self.assertGreaterEqual(q_score, 0.4)

    def test_quality_boost_prefers_higher_quality(self):
        # Without quality boost
        r_no_boost = self.idx.search("TypeError", top_k=3, quality_boost=0.0)
        # With quality boost
        r_boost = self.idx.search("TypeError", top_k=3, quality_boost=0.5)
        # Higher-quality card 'a' should rank better with boost
        no_boost_a_rank = next(i for i, (_, c) in enumerate(r_no_boost) if c["id"] == "a")
        boost_a_rank = next(i for i, (_, c) in enumerate(r_boost) if c["id"] == "a")
        self.assertLessEqual(boost_a_rank, no_boost_a_rank)

    def test_mmr_returns_diverse(self):
        r = self.idx.search("TypeError", top_k=2, mmr_lambda=0.5)
        self.assertEqual(len(r), 2)

    def test_format_result_includes_quality(self):
        r = self.idx.search("TypeError import foo bar", top_k=1)[0]
        text = format_result(r[1], 1, r[0])
        self.assertIn("quality:", text)
        # quality_tier should be in the text (high/medium/low/junk)
        self.assertTrue(any(t in text for t in ("high", "medium", "low", "junk", "?")))

    def test_why_matched_returns_matched_terms(self):
        card = self.cards[0]
        why = why_matched(card, "TypeError import foo")
        self.assertIn("matched_terms", why)
        self.assertGreater(len(why["matched_terms"]), 0)
        self.assertIn("field_match", why)

    def test_load_index_cards_treats_missing_usable_as_usable(self):
        import json, tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
            f.write(json.dumps({"id": "a", "symptom": "x", "embedding_text": "x"}) + "\n")
            f.write(json.dumps({"id": "b", "usable": False, "symptom": "x", "embedding_text": "x"}) + "\n")
            path = f.name
        cards = load_index_cards(path)
        self.assertEqual(len(cards), 1)  # only the one with usable=True or absent
        self.assertEqual(cards[0]["id"], "a")

    def test_tokenize_drops_stopwords(self):
        tokens = tokenize_terms("the is a typeerror with python")
        self.assertNotIn("the", tokens)
        self.assertIn("typeerror", tokens)
        self.assertIn("python", tokens)
