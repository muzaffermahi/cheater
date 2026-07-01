"""Tests for cheater.quality_monitor."""
from __future__ import annotations

import unittest

from cheater.quality_monitor import QualityMonitor
from cheater.tools import default_tool_registry


class TestQualityMonitor(unittest.TestCase):
    def setUp(self):
        self.monitor = QualityMonitor()
        self.registry = default_tool_registry()

    def test_empty_action(self):
        steer = self.monitor.check(None, self.registry)
        self.assertIsNotNone(steer)
        self.assertIn("empty", steer.lower())

    def test_empty_dict(self):
        steer = self.monitor.check({}, self.registry)
        self.assertIsNotNone(steer)

    def test_blank_tool_name(self):
        steer = self.monitor.check({"action": "", "args": {}}, self.registry)
        self.assertIsNotNone(steer)
        self.assertIn("missing", steer.lower())

    def test_hallucinated_tool_name(self):
        steer = self.monitor.check({"action": "nope_tool", "args": {}}, self.registry)
        self.assertIsNotNone(steer)
        self.assertIn("unknown tool", steer.lower())

    def test_hallucinated_suggests_closest(self):
        steer = self.monitor.check({"action": "read_filex", "args": {}}, self.registry)
        self.assertIsNotNone(steer)
        self.assertIn("read_file", steer)  # suggests the real name

    def test_repeat_tool_call(self):
        action = {"action": "read_file", "args": {"path": "x.py"}}
        # First call: no steer
        self.assertIsNone(self.monitor.check(action, self.registry))
        # Record it
        self.monitor.record(action)
        # Same call again: steer
        steer = self.monitor.check(action, self.registry)
        self.assertIsNotNone(steer)
        self.assertIn("stuck", steer.lower())

    def test_max_corrections(self):
        # After 2 consecutive corrections, the monitor stops steering
        for _ in range(3):
            self.monitor.check(None, self.registry)
        steer = self.monitor.check(None, self.registry)
        self.assertIsNone(steer)  # hit cap, no more steers

    def test_reset(self):
        self.monitor.check({"action": "nope"}, self.registry)
        self.monitor.reset()
        # After reset, a fresh check works again
        steer = self.monitor.check({"action": "nope"}, self.registry)
        self.assertIsNotNone(steer)

    def test_on_success_resets_counter(self):
        for _ in range(2):
            self.monitor.check(None, self.registry)
        self.monitor.on_success()
        # Counter reset, new bad call still gets a steer
        steer = self.monitor.check(None, self.registry)
        self.assertIsNotNone(steer)


if __name__ == "__main__":
    unittest.main()
