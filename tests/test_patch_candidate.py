"""Tests for cheater.patch_candidate (v0.6 Phase B scaffold)."""
from __future__ import annotations

import unittest

from cheater.patch_candidate import (
    PatchCandidate,
    ScoredCandidate,
    ScoringContext,
    rank_candidates,
    score_candidate,
    validate_candidate,
)


def _c(id_: str = "c1", diff: str = "-x\n+y\n", files: list[str] | None = None,
       focused: bool = True, related: bool = True,
       applies: bool = True, syntax: bool = True,
       strategy: str = "edit") -> PatchCandidate:
    if files is None:
        files = ["pkg/foo.py"]
    return PatchCandidate(
        id=id_, diff=diff, strategy=strategy,
        touched_files=files,
        applies_cleanly=applies, syntax_ok=syntax,
        focused_tests_passed=focused, related_tests_passed=related,
    )


class TestValidation(unittest.TestCase):
    def test_valid(self):
        ok, err = validate_candidate(_c())
        self.assertTrue(ok, err)
        self.assertEqual(err, "")

    def test_missing_id(self):
        c = _c()
        c.id = ""
        ok, err = validate_candidate(c)
        self.assertFalse(ok)
        self.assertIn("id", err)

    def test_missing_diff(self):
        c = _c()
        c.diff = ""
        ok, err = validate_candidate(c)
        self.assertFalse(ok)
        self.assertIn("diff", err)

    def test_no_files(self):
        c = _c(files=[])
        ok, err = validate_candidate(c)
        self.assertFalse(ok)
        self.assertIn("files", err)


class TestScoringBasics(unittest.TestCase):
    def test_passing_localized_wins_over_passing_unrelated(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        good = _c(files=["pkg/foo.py"], diff="-x\n+y\n")
        bad = _c(id_="c2", files=["pkg/other.py"], diff="-x\n+y\n")
        s_good = score_candidate(good, ctx)
        s_bad = score_candidate(bad, ctx)
        self.assertGreater(s_good.score, s_bad.score)

    def test_smaller_diff_wins(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        small = _c(id_="c1", files=["pkg/foo.py"], diff="-a\n+b\n")
        big = _c(id_="c2", files=["pkg/foo.py"], diff=("\n".join(f"-l{i}\n+l{i}\n" for i in range(30))))
        s_small = score_candidate(small, ctx)
        s_big = score_candidate(big, ctx)
        self.assertGreater(s_small.score, s_big.score)

    def test_failing_tests_dominated_by_passing(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        passing = _c(focused=True, related=True)
        failing = _c(id_="c2", focused=False, related=False)
        s_pass = score_candidate(passing, ctx)
        s_fail = score_candidate(failing, ctx)
        self.assertGreater(s_pass.score, s_fail.score)

    def test_test_edit_penalty(self):
        ctx = ScoringContext(localized_files={"tests/test_foo.py"})
        # Passing but edits a test
        test_edit = _c(files=["tests/test_foo.py"], diff="-x\n+y\n")
        ctx_disallow = ScoringContext(
            localized_files={"tests/test_foo.py"}, allow_test_edits=False,
        )
        ctx_allow = ScoringContext(
            localized_files={"tests/test_foo.py"}, allow_test_edits=True,
        )
        s_no = score_candidate(test_edit, ctx_disallow)
        s_yes = score_candidate(test_edit, ctx_allow)
        self.assertGreater(s_yes.score, s_no.score)

    def test_dependency_edit_penalty(self):
        ctx = ScoringContext(
            localized_files={"pyproject.toml"},
            allow_dependency_edits=False,
        )
        c = _c(files=["pyproject.toml"], diff="-x\n+y\n")
        s = score_candidate(c, ctx)
        breakdown = s.score_breakdown
        self.assertIn("dependency_edit", breakdown)
        self.assertLess(breakdown["dependency_edit"], 0)

    def test_dependency_edit_allowed(self):
        ctx = ScoringContext(
            localized_files={"pyproject.toml"},
            allow_dependency_edits=True,
        )
        c = _c(files=["pyproject.toml"], diff="-x\n+y\n")
        s = score_candidate(c, ctx)
        self.assertNotIn("dependency_edit", s.score_breakdown)

    def test_broad_refactor_penalty(self):
        # >4 files or >80 diff lines -> broad penalty
        ctx = ScoringContext(localized_files=set())
        big = _c(id_="c1", files=["a.py", "b.py", "c.py", "d.py", "e.py"],
                 diff=("\n".join("-x\n" for _ in range(100))))
        s = score_candidate(big, ctx)
        self.assertIn("broad_refactor", s.score_breakdown)
        self.assertLess(s.score_breakdown["broad_refactor"], 0)

    def test_unrelated_files_penalty(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        unrelated = _c(id_="c2", files=["pkg/totally_other.py"], diff="-x\n+y\n")
        s = score_candidate(unrelated, ctx)
        self.assertIn("unrelated", s.score_breakdown)
        self.assertLess(s.score_breakdown["unrelated"], 0)

    def test_applies_cleanly_failure_penalized(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        c = _c(applies=False, diff="-x\n+y\n")
        s = score_candidate(c, ctx)
        self.assertIn("applies_failed", s.score_breakdown)
        self.assertLess(s.score_breakdown["applies_failed"], 0)

    def test_syntax_failure_penalized(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        c = _c(syntax=False, diff="-x\n+y\n")
        s = score_candidate(c, ctx)
        self.assertIn("syntax_failed", s.score_breakdown)
        self.assertLess(s.score_breakdown["syntax_failed"], 0)

    def test_invalid_candidate_gets_huge_penalty(self):
        ctx = ScoringContext()
        c = _c()
        c.diff = ""
        s = score_candidate(c, ctx)
        self.assertLess(s.score, 0)


class TestIsTestEdit(unittest.TestCase):
    def test_underscore_pattern(self):
        c = _c(files=["tests/test_foo.py"])
        self.assertTrue(c.is_test_edit())

    def test_underscore_suffix(self):
        c = _c(files=["foo_test.py"])
        self.assertTrue(c.is_test_edit())

    def test_tests_dir(self):
        c = _c(files=["tests/integration/test_x.py"])
        self.assertTrue(c.is_test_edit())

    def test_source_file(self):
        c = _c(files=["pkg/foo.py"])
        self.assertFalse(c.is_test_edit())


class TestIsDependencyChange(unittest.TestCase):
    def test_pyproject(self):
        c = _c(files=["pyproject.toml"])
        self.assertTrue(c.is_dependency_change())

    def test_requirements(self):
        c = _c(files=["requirements.txt"])
        self.assertTrue(c.is_dependency_change())

    def test_setup(self):
        c = _c(files=["setup.py"])
        self.assertTrue(c.is_dependency_change())

    def test_normal_source(self):
        c = _c(files=["pkg/foo.py"])
        self.assertFalse(c.is_dependency_change())


class TestIsBroadRefactor(unittest.TestCase):
    def test_single_file_small_diff(self):
        c = _c(files=["pkg/foo.py"], diff="-x\n+y\n")
        self.assertFalse(c.is_broad_refactor())

    def test_many_files(self):
        c = _c(files=[f"f{i}.py" for i in range(5)], diff="-x\n+y\n")
        self.assertTrue(c.is_broad_refactor())

    def test_big_diff(self):
        c = _c(files=["pkg/foo.py"], diff="\n".join(["-x"] * 100))
        self.assertTrue(c.is_broad_refactor())


class TestDiffSize(unittest.TestCase):
    def test_counts_only_changes(self):
        c = _c(diff="--- a\n+++ b\n-x\n+y\n context\n")
        # Should not count "--- a" or "+++ b"; just -x and +y (2 lines)
        self.assertEqual(c.diff_size(), 2)

    def test_empty_diff(self):
        c = _c(diff="")
        self.assertEqual(c.diff_size(), 0)


class TestRankCandidates(unittest.TestCase):
    def test_orders_by_score(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        c1 = _c(id_="c1", files=["pkg/other.py"], diff="-x\n+y\n", focused=False)
        c2 = _c(id_="c2", files=["pkg/foo.py"], diff="-x\n+y\n", focused=True)
        ranked = rank_candidates([c1, c2], ctx)
        self.assertEqual(ranked[0].candidate.id, "c2")
        self.assertGreater(ranked[0].score, ranked[1].score)


class TestScoringContextFromLocalization(unittest.TestCase):
    def test_extracts_paths(self):
        from cheater.localizer import LocalizationResult, SuspectedFile
        r = LocalizationResult(suspected_files=[
            SuspectedFile(path="a.py", confidence=0.5),
            SuspectedFile(path="b.py", confidence=0.7),
        ])
        ctx = ScoringContext.from_localization(r)
        self.assertEqual(ctx.localized_files, {"a.py", "b.py"})

    def test_empty_localization(self):
        ctx = ScoringContext.from_localization(None)
        self.assertEqual(ctx.localized_files, set())


class TestToDict(unittest.TestCase):
    def test_candidate_to_dict(self):
        c = _c(files=["pkg/foo.py"], diff="-x\n+y\n")
        d = c.to_dict()
        self.assertEqual(d["id"], "c1")
        self.assertEqual(d["touched_files"], ["pkg/foo.py"])
        self.assertEqual(d["diff_size"], 2)

    def test_scored_to_dict(self):
        ctx = ScoringContext(localized_files={"pkg/foo.py"})
        sc = score_candidate(_c(), ctx)
        d = sc.to_dict()
        self.assertIn("candidate", d)
        self.assertIn("score", d)
        self.assertIn("score_breakdown", d)


if __name__ == "__main__":
    unittest.main()
