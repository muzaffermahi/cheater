"""Tests for cheater.budget (context budget engine)."""
from __future__ import annotations

import unittest

from cheater.budget import ContextBudget, estimate_tokens


class TestEstimateTokens(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(estimate_tokens(""), 0)

    def test_short(self):
        # ~4 chars per token
        n = estimate_tokens("hello world")  # 11 chars
        self.assertEqual(n, 3)  # ceil(11/4)

    def test_long(self):
        n = estimate_tokens("a" * 1000)
        self.assertEqual(n, 250)


class TestContextBudget(unittest.TestCase):
    def test_empty(self):
        b = ContextBudget(max_chars=1000)
        self.assertEqual(b.total_chars, 0)
        self.assertEqual(b.usage_pct, 0.0)

    def test_allocate(self):
        b = ContextBudget(max_chars=1000)
        b.allocate("system", "x" * 100)
        b.allocate("plan", "y" * 200)
        self.assertEqual(b.total_chars, 300)
        self.assertEqual(b.usage_pct, 30.0)
        self.assertEqual(b.sources(), {"system": 100, "plan": 200})

    def test_tool_cap_truncates(self):
        b = ContextBudget(max_chars=10000, tool_cap=100)
        b.allocate("tool", "x" * 500)
        # Tool result truncated to ~100 chars + suffix
        self.assertLess(b.total_chars, 200)
        self.assertIn("truncated", b._items[0].text)

    def test_eviction_when_over_budget(self):
        b = ContextBudget(max_chars=200)
        b.allocate("system", "sys")  # 3
        b.allocate("plan", "plan")  # 4 -> 7
        b.allocate("tool", "x" * 100)  # 100 -> would put us at 107
        b.allocate("tool", "y" * 200)  # would put us over
        # Some tool result should have been evicted
        self.assertLessEqual(b.total_chars, 200)
        self.assertGreater(len(b.evicted_summaries()), 0)

    def test_no_evict_for_system(self):
        b = ContextBudget(max_chars=100)
        b.allocate("system", "sys")
        b.allocate("system", "x" * 200)  # system is truncated, not evicted
        # The system source is still there (truncated to fit)
        self.assertIn("system", b.sources())
        # Total fits within budget (possibly truncated)
        self.assertLessEqual(b.total_chars, 200)

    def test_reset(self):
        b = ContextBudget(max_chars=1000)
        b.allocate("tool", "x" * 500)
        b.reset()
        self.assertEqual(b.total_chars, 0)
        self.assertEqual(len(b.evicted_summaries()), 0)

    def test_summary_format(self):
        b = ContextBudget(max_chars=1000)
        b.allocate("plan", "x" * 500)
        s = b.usage_summary()
        self.assertIn("500", s)
        self.assertIn("1000", s)
        self.assertIn("%", s)

    def test_to_dict(self):
        b = ContextBudget(max_chars=1000)
        b.allocate("tool", "x" * 200)
        d = b.to_dict()
        self.assertEqual(d["max_chars"], 1000)
        self.assertEqual(d["total_chars"], 200)
        self.assertIn("sources", d)


if __name__ == "__main__":
    unittest.main()
