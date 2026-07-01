"""Tests for cheater/guide.py"""
from __future__ import annotations

import unittest

from cheater.guide import (
    _aggregate_patterns, _build_warnings, _detect_signals, _format_text,
    generate_guide,
)


CARDS = [
    {
        "id": "a", "source": "t", "repo": "owner/repo", "language": "python",
        "bug_type": "TypeError",
        "symptom": "TypeError: cannot import foo from bar.",
        "root_cause": "Missing __init__.py",
        "fix_pattern": "Add __init__.py to bar module and import from bar.foo correctly.",
        "failed_approaches": ["hardcoding"],
        "key_files": ["bar/__init__.py", "bar/foo.py"],
        "test_signal": "test_foo",
        "search_keywords": ["import", "TypeError"],
        "embedding_text": "typeerror cannot import foo from bar. add __init__ to bar module.",
        "usable": True, "quality_score": 0.9, "quality_tier": "high",
    },
    {
        "id": "b", "source": "t", "repo": "other/repo", "language": "python",
        "bug_type": "KeyError",
        "symptom": "KeyError when accessing dict.",
        "fix_pattern": "Use dict.get() to avoid KeyError.",
        "failed_approaches": ["try/except KeyError"],
        "key_files": ["other/utils.py"],
        "test_signal": "test_dict",
        "search_keywords": ["dict", "keyerror"],
        "embedding_text": "keyerror when accessing dict. use dict.get() to avoid.",
        "usable": True, "quality_score": 0.8, "quality_tier": "high",
    },
]


class TestGuide(unittest.TestCase):
    def test_detect_signals_finds_error_types(self):
        sig = _detect_signals("TypeError: cannot import foo from bar.py")
        self.assertIn("TypeError", sig["error_types"])
        self.assertIn("bar.py", sig["file_paths"])

    def test_aggregate_patterns_collects_unique(self):
        patterns = _aggregate_patterns([(1.0, CARDS[0]), (0.5, CARDS[1])])
        self.assertIn("TypeError", [bt for bt, _ in patterns["bug_types"]])
        self.assertIn("KeyError", [bt for bt, _ in patterns["bug_types"]])
        self.assertEqual(len(patterns["fix_patterns"]), 2)
        self.assertEqual(len(patterns["failed_approaches"]), 2)

    def test_generate_guide_returns_structure(self):
        g = generate_guide("TypeError import foo", CARDS, top_k=3)
        self.assertEqual(g["query"], "TypeError import foo")
        self.assertIn("results", g)
        self.assertIn("patterns", g)
        self.assertIn("signals", g)
        self.assertIn("warnings", g)
        self.assertIn("next_steps", g)
        self.assertGreater(len(g["results"]), 0)
        # The TypeError card should be top-1
        self.assertEqual(g["results"][0]["id"], "a")

    def test_warnings_for_low_confidence(self):
        g = generate_guide("completely unrelated nonsense", CARDS, top_k=2)
        # Top score should be low -> warning
        warnings = g["warnings"]
        self.assertTrue(any("low" in w.lower() for w in warnings))

    def test_warnings_for_cross_project(self):
        # Add a 3rd card from different repo
        cards3 = CARDS + [{
            "id": "c", "source": "t", "repo": "another/repo", "language": "go",
            "bug_type": "goroutine", "symptom": "goroutine leak.",
            "fix_pattern": "use context cancellation.", "failed_approaches": [],
            "key_files": [], "test_signal": "",
            "search_keywords": ["goroutine", "leak"],
            "embedding_text": "goroutine leak in production.", "usable": True,
            "quality_score": 0.7, "quality_tier": "high",
        }]
        g = generate_guide("TypeError import", cards3, top_k=3)
        warnings = g["warnings"]
        # Should warn about cross-project (3 different repos)
        self.assertTrue(any("span" in w for w in warnings))

    def test_format_text_includes_all_sections(self):
        g = generate_guide("TypeError import", CARDS, top_k=2)
        results = [(r["score"], next((c for sc, c in [(1.0, CARDS[0])] if sc == r["score"]), None)) for r in g["results"]]
        # Build the actual (score, card) pairs from the results
        cards_by_id = {c["id"]: c for c in CARDS}
        results = [(r["score"], cards_by_id[r["id"]]) for r in g["results"]]
        text = _format_text(g["query"], results, g["patterns"], g["signals"], g["warnings"])
        self.assertIn("1. Query summary", text)
        self.assertIn("2. Top relevant cards", text)
        self.assertIn("3. Likely bug classes", text)
        self.assertIn("4. Repair patterns", text)
        self.assertIn("5. Failed approaches to avoid", text)
        self.assertIn("6. Concrete next debugging steps", text)
        self.assertIn("7. Relevant files / signals to inspect", text)
        self.assertIn("8. Warnings", text)
        self.assertIn("Cheater does not claim to know the fix", text)

    def test_no_results_warning(self):
        g = generate_guide("xyzzy qqqq", [], top_k=5)
        # With no cards there should be a no-results warning
        warnings = g["warnings"]
        self.assertTrue(any("no matching cards" in w.lower() for w in warnings))
