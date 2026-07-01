"""Tests for cheater.dedup (tool-call deduplication)."""
from __future__ import annotations

import unittest

from cheater.dedup import ToolCallDedup


class FakeResult:
    def __init__(self, summary="x", success=True, files_read=None):
        self.summary = summary
        self.success = success
        self.files_read = files_read or []


class TestDedup(unittest.TestCase):
    def test_read_only_tools(self):
        d = ToolCallDedup()
        self.assertTrue(d.is_read_only("read_file"))
        self.assertTrue(d.is_read_only("list_files"))
        self.assertTrue(d.is_read_only("search_code"))
        self.assertTrue(d.is_read_only("search_memory"))

    def test_side_effect_tools_not_cached(self):
        d = ToolCallDedup()
        self.assertFalse(d.is_read_only("edit_file"))
        self.assertFalse(d.is_read_only("create_file"))
        self.assertFalse(d.is_read_only("run_command"))

    def test_first_call_not_cached(self):
        d = ToolCallDedup()
        self.assertIsNone(d.check("read_file", {"path": "x.py"}))

    def test_repeat_cached(self):
        d = ToolCallDedup()
        r = FakeResult(summary="42 chars")
        d.store("read_file", {"path": "x.py"}, r)
        cached = d.check("read_file", {"path": "x.py"})
        self.assertIs(cached, r)

    def test_different_args_not_cached(self):
        d = ToolCallDedup()
        r1 = FakeResult(summary="first")
        d.store("read_file", {"path": "x.py"}, r1)
        cached = d.check("read_file", {"path": "y.py"})
        self.assertIsNone(cached)

    def test_window_eviction(self):
        d = ToolCallDedup(window=2)
        for i in range(5):
            d.store("read_file", {"path": f"x{i}.py"}, FakeResult(summary=str(i)))
        # Only last 2 should be cached
        self.assertIsNotNone(d.check("read_file", {"path": "x4.py"}))
        self.assertIsNotNone(d.check("read_file", {"path": "x3.py"}))
        self.assertIsNone(d.check("read_file", {"path": "x0.py"}))

    def test_side_effect_never_cached(self):
        d = ToolCallDedup()
        d.store("edit_file", {"path": "x", "old": "a", "new": "b"}, FakeResult())
        self.assertIsNone(d.check("edit_file", {"path": "x", "old": "a", "new": "b"}))

    def test_reset(self):
        d = ToolCallDedup()
        d.store("read_file", {"path": "x.py"}, FakeResult())
        d.reset()
        self.assertIsNone(d.check("read_file", {"path": "x.py"}))

    def test_stats(self):
        d = ToolCallDedup()
        d.store("read_file", {"path": "x.py"}, FakeResult())
        s = d.stats()
        self.assertEqual(s["cached_calls"], 1)
        self.assertEqual(s["window"], 5)


if __name__ == "__main__":
    unittest.main()
