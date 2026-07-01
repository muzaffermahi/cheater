"""Tests for cheater.strategy. NO network, no real processes."""
from __future__ import annotations

import unittest

from cheater.anti_stall import StallReason
from cheater.lifecycle import FailureClass
from cheater.playbooks import PlaybookKind
from cheater.strategy import (
    Strategy,
    StrategyKind,
    StrategyRecord,
    SwitchKind,
    strategy_differs,
    switch_strategy_for,
    valid_kinds_for,
)


class TestStrategyDiffers(unittest.TestCase):
    def test_different_kinds_always_differ(self):
        a = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="x")
        b = Strategy(kind=StrategyKind.DIAGNOSE, hypothesis="x")
        self.assertTrue(strategy_differs(a, b))

    def test_same_kind_same_hypothesis_same(self):
        a = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="fix the bug",
                     next_args_sig="abc")
        b = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="fix the bug",
                     next_args_sig="abc")
        self.assertFalse(strategy_differs(a, b))

    def test_same_kind_different_hypothesis_differs_when_policy_on(self):
        a = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="fix the bug",
                     next_args_sig="abc")
        b = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="add a test",
                     next_args_sig="abc")
        # With the strict policy, different hypothesis means
        # different strategy.
        self.assertTrue(strategy_differs(a, b, same_hypothesis_means_same=True))
        # Without the policy, they are the same.
        self.assertFalse(strategy_differs(a, b, same_hypothesis_means_same=False))

    def test_same_kind_different_args_sig_differs(self):
        a = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="x",
                     next_args_sig="abc")
        b = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="x",
                     next_args_sig="xyz")
        self.assertTrue(strategy_differs(a, b))

    def test_same_kind_different_smallest_action_differs(self):
        a = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="x",
                     smallest_next_action="read_file x.py")
        b = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="x",
                     smallest_next_action="read_file y.py")
        self.assertTrue(strategy_differs(a, b))

    def test_same_kind_same_action_same_hypothesis_same(self):
        a = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="x",
                     smallest_next_action="read_file x.py",
                     verification_target="y")
        b = Strategy(kind=StrategyKind.IMPLEMENT, hypothesis="x",
                     smallest_next_action="read_file x.py",
                     verification_target="y")
        self.assertFalse(strategy_differs(a, b))


class TestSwitchStrategyFor(unittest.TestCase):
    def test_repeated_command_picks_diagnose(self):
        s = switch_strategy_for(
            reason=StallReason.REPEATED_COMMAND,
            playbook=PlaybookKind.CLI_PACKAGE,
        )
        self.assertEqual(s.kind, StrategyKind.DIAGNOSE)

    def test_oscillation_picks_isolate(self):
        s = switch_strategy_for(
            reason=StallReason.OSCILLATION,
            playbook=PlaybookKind.WEBAPP,
        )
        self.assertEqual(s.kind, StrategyKind.ISOLATE)

    def test_dependency_failure_picks_dependency_inspect(self):
        s = switch_strategy_for(
            reason=StallReason.NO_PROGRESS,
            playbook=PlaybookKind.CLI_PACKAGE,
            failure_class=FailureClass.DEPENDENCY,
        )
        # The failure class picks a more specific strategy.
        self.assertEqual(s.kind, StrategyKind.DEPENDENCY_INSPECT)

    def test_snapshot_baseline_picks_baseline_workflow(self):
        s = switch_strategy_for(
            reason=StallReason.NO_PROGRESS,
            playbook=PlaybookKind.VISUAL_SNAPSHOT,
            failure_class=FailureClass.SNAPSHOT_BASELINE,
        )
        self.assertEqual(s.kind, StrategyKind.BASELINE_WORKFLOW)

    def test_playbook_restricts_kinds(self):
        # VISUAL_SNAPSHOT does not allow IMPLEMENT.
        s = switch_strategy_for(
            reason=StallReason.REPEATED_COMMAND,
            playbook=PlaybookKind.VISUAL_SNAPSHOT,
        )
        kinds = valid_kinds_for(PlaybookKind.VISUAL_SNAPSHOT)
        # Whatever the controller returns, it must be valid for
        # the playbook (the controller may fall back to DIAGNOSE).
        self.assertIn(s.kind, kinds)

    def test_no_playbook_falls_back_to_cli(self):
        s = switch_strategy_for(
            reason=StallReason.NO_PROGRESS,
            playbook=None,
        )
        self.assertIsNotNone(s)


class TestStrategyRecord(unittest.TestCase):
    def test_add_and_last(self):
        r = StrategyRecord()
        s1 = Strategy(kind=StrategyKind.IMPLEMENT)
        s2 = Strategy(kind=StrategyKind.DIAGNOSE)
        r.add(s1)
        r.add(s2)
        self.assertEqual(r.last, s2)
        self.assertEqual(len(r.strategies), 2)

    def test_to_dict(self):
        r = StrategyRecord()
        r.add(Strategy(kind=StrategyKind.IMPLEMENT))
        d = r.to_dict()
        self.assertEqual(d["count"], 1)
        self.assertEqual(d["last"]["kind"], "implement")
        self.assertEqual(d["kinds_tried"], ["implement"])


if __name__ == "__main__":
    unittest.main()
