"""Tests for cheater.context_optimizer (v0.7)."""

from __future__ import annotations

import unittest

from cheater.context_optimizer import (
    Budget,
    BUDGETS,
    ContextSection,
    estimate_tokens,
    optimize_context_pack,
    rank_sections_for_budget,
    score_context_section,
)


class TestEstimateTokens(unittest.TestCase):
    def test_stable(self):
        # Same input -> same output
        self.assertEqual(estimate_tokens("hello"), estimate_tokens("hello"))
        # Empty -> 0
        self.assertEqual(estimate_tokens(""), 0)
        self.assertEqual(estimate_tokens(None), 0)
        # Roughly 1 token per 4 chars
        self.assertEqual(estimate_tokens("a" * 8), 2)


class TestBudgets(unittest.TestCase):
    def test_known_budgets(self):
        for b in (Budget.TINY, Budget.SMALL, Budget.NORMAL, Budget.LARGE):
            self.assertIn(b, BUDGETS)
            self.assertGreater(BUDGETS[b], 0)

    def test_ordered(self):
        # tiny < small < normal < large
        self.assertLess(BUDGETS[Budget.TINY], BUDGETS[Budget.SMALL])
        self.assertLess(BUDGETS[Budget.SMALL], BUDGETS[Budget.NORMAL])
        self.assertLess(BUDGETS[Budget.NORMAL], BUDGETS[Budget.LARGE])


class TestOptimizePack(unittest.TestCase):
    def _pack(self) -> list[ContextSection]:
        # build a "pack" as a list of sections
        return [
            ContextSection(name="task", body="fix bug" * 5, label="Task", priority=0),
            ContextSection(
                name="traceback",
                body="ModuleNotFoundError" * 20,
                label="Traceback",
                priority=5,
            ),
            ContextSection(
                name="repo_map", body="x" * 4000, label="Repo map", priority=20
            ),
            ContextSection(name="memory", body="y" * 800, label="Memory", priority=25),
            ContextSection(name="skills", body="z" * 800, label="Skills", priority=27),
            ContextSection(
                name="instructions", body="w" * 1500, label="Instructions", priority=15
            ),
        ]

    def test_respects_budget(self):
        sections = self._pack()
        result = optimize_context_pack(sections, budget=Budget.TINY)
        # total chars after must be <= max_chars
        self.assertLessEqual(result.total_chars_after, result.max_chars)

    def test_int_budget(self):
        sections = self._pack()
        result = optimize_context_pack(sections, budget=2000)
        self.assertLessEqual(result.total_chars_after, 2000)
        self.assertEqual(result.budget_name, "custom:2000")

    def test_task_kept(self):
        sections = self._pack()
        result = optimize_context_pack(sections, budget=Budget.TINY)
        kept_names = {s.name for s in result.kept}
        self.assertIn("task", kept_names)

    def test_traceback_kept(self):
        sections = self._pack()
        result = optimize_context_pack(sections, budget=Budget.SMALL)
        kept_names = {s.name for s in result.kept}
        self.assertIn("traceback", kept_names)

    def test_drops_low_value_first(self):
        sections = self._pack()
        # tiny budget forces drops
        result = optimize_context_pack(sections, budget=Budget.TINY)
        dropped = {s.name for s in result.dropped}
        # low-value sections are more likely to be dropped
        # at least one of {instructions, skills, memory, repo_map} must be
        # in dropped OR clipped
        touched = dropped | {s.name for s in result.clipped}
        self.assertTrue(touched & {"instructions", "skills", "memory", "repo_map"})

    def test_caps_section(self):
        # instructions is capped at 1200 by default
        sections = self._pack()
        result = optimize_context_pack(sections, budget=Budget.LARGE)
        for s in result.kept:
            if s.name == "instructions":
                self.assertLessEqual(s.char_len(), 1200 + 50)  # +50 for clip suffix

    def test_works_with_dict_sections(self):
        pack = [
            {"name": "task", "body": "fix bug", "priority": 0, "label": "Task"},
            {"name": "memory", "body": "x" * 200, "priority": 25, "label": "Mem"},
        ]
        result = optimize_context_pack(pack, budget=Budget.NORMAL)
        kept = {s.name for s in result.kept}
        self.assertIn("task", kept)
        self.assertIn("memory", kept)


class TestScoring(unittest.TestCase):
    def test_task_high_score(self):
        s = ContextSection(
            name="task", body="fix import error in foo", label="Task", priority=0
        )
        sc = score_context_section(s, task_signature="fix import error")
        self.assertGreater(sc, 0.5)

    def test_unrelated_low_score(self):
        s = ContextSection(name="random", body="x" * 1000, label="x", priority=50)
        sc = score_context_section(s, task_signature="fix import error")
        self.assertLess(sc, 0.7)


class TestRanking(unittest.TestCase):
    def test_ranking_orders(self):
        sections = [
            ContextSection(name="instructions", body="x" * 500, priority=15),
            ContextSection(
                name="memory", body="fix import error in foo module", priority=25
            ),
        ]
        ranked = rank_sections_for_budget(sections, task_signature="fix import error")
        # memory should rank above instructions for this task
        first_name = ranked[0][0].name
        self.assertEqual(first_name, "memory")


if __name__ == "__main__":
    unittest.main()
