"""Tests for cheater.skill_janitor (v0.7)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cheater.skill_janitor import (
    AuditReport,
    audit_memories,
    audit_skills,
    compress_skill,
    parse_skill,
    suggest_merges,
    suggest_deletions,
)


def _write_skill(
    d: Path,
    name: str,
    body: str,
    *,
    triggers: list[str] | None = None,
    tags: list[str] | None = None,
    success: int = 0,
    failure: int = 0,
) -> None:
    fm_lines = [f"name: {name}"]
    if triggers:
        fm_lines.append(f"triggers: [{', '.join(triggers)}]")
    if tags:
        fm_lines.append(f"tags: [{', '.join(tags)}]")
    fm_lines.append(f"success: {success}")
    fm_lines.append(f"failure: {failure}")
    fm = "\n".join(fm_lines)
    (d / f"{name}.md").write_text(f"---\n{fm}\n---\n{body}\n", encoding="utf-8")


class TestParseSkill(unittest.TestCase):
    def test_basic(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            _write_skill(
                d,
                "import-fix",
                "Use python -m pip install foo.",
                triggers=["import", "modulenotfound"],
                tags=["python", "import"],
                success=3,
                failure=0,
            )
            item = parse_skill(d / "import-fix.md")
            self.assertIsNotNone(item)
            self.assertEqual(item.name, "import-fix")
            self.assertEqual(item.triggers, ["import", "modulenotfound"])
            self.assertEqual(item.success, 3)
            self.assertEqual(item.failure, 0)
            self.assertIn("python -m pip install", item.body)


class TestAuditSkills(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_detects_duplicate_triggers(self):
        _write_skill(
            self.tmp, "fix1", "body one", triggers=["import", "modulenotfound"]
        )
        _write_skill(
            self.tmp, "fix2", "body two", triggers=["import", "modulenotfound"]
        )
        report = audit_skills(self.tmp)
        self.assertGreaterEqual(len(report.merges), 1)
        names = sorted([report.merges[0].a, report.merges[0].b])
        self.assertEqual(names, ["fix1", "fix2"])

    def test_detects_conflicting_advice(self):
        # Two skills with overlapping triggers but opposite advice
        _write_skill(
            self.tmp, "use_x", "Should always use X.", triggers=["python", "build"]
        )
        _write_skill(
            self.tmp, "avoid_x", "Should never use X.", triggers=["python", "build"]
        )
        report = audit_skills(self.tmp)
        # Should detect at least one conflict
        self.assertGreaterEqual(len(report.conflicts), 1)

    def test_detects_low_success(self):
        _write_skill(self.tmp, "weak", "body", triggers=["rare"], success=1, failure=5)
        report = audit_skills(self.tmp)
        self.assertGreaterEqual(len(report.low_success), 1)
        self.assertEqual(report.low_success[0]["name"], "weak")

    def test_suggests_deletions_for_short_unused(self):
        _write_skill(self.tmp, "tiny", "x" * 10, triggers=["a"])
        report = audit_skills(self.tmp)
        names = [d.name for d in report.deletions]
        self.assertIn("tiny", names)

    def test_skill_audit_suggestions_human_readable(self):
        _write_skill(self.tmp, "a", "body", triggers=["x"])
        _write_skill(self.tmp, "b", "body", triggers=["x"])
        report = audit_skills(self.tmp)
        # All suggestions must be dataclass .to_dict() serializable
        d = report.to_dict()
        for k in ("merges", "deletions", "conflicts", "low_success", "items"):
            self.assertIn(k, d)


class TestSuggestMerges(unittest.TestCase):
    def test_no_merges_when_distinct(self):
        from cheater.skill_janitor import SkillItem

        items = [
            SkillItem(
                name="a",
                path=Path("/a.md"),
                triggers=["one", "two"],
                body="body one",
            ),
            SkillItem(
                name="b",
                path=Path("/b.md"),
                triggers=["three", "four"],
                body="body two",
            ),
        ]
        m = suggest_merges(items)
        self.assertEqual(m, [])


class TestSuggestDeletions(unittest.TestCase):
    def test_does_not_suggest_healthy_skills(self):
        from cheater.skill_janitor import SkillItem

        items = [
            SkillItem(
                name="ok",
                path=Path("/ok.md"),
                triggers=["x"],
                body="x" * 200,
                success=5,
                failure=1,
            ),
        ]
        d = suggest_deletions(items)
        self.assertEqual(d, [])


class TestCompressSkill(unittest.TestCase):
    def test_compresses_long_skill(self):
        body = "# Title\n\n" + ("This is a sentence. " * 50)
        out = compress_skill(body, max_chars=200)
        self.assertLessEqual(len(out), 200 + 50)
        self.assertIn("Title", out)

    def test_short_skill_unchanged(self):
        body = "# Title\n\nShort body."
        out = compress_skill(body, max_chars=1000)
        self.assertEqual(out, body)


class TestAuditMemory(unittest.TestCase):
    def test_audit_with_empty_store(self):
        # Build an in-memory MemoryStore at a tmp dir
        from cheater.memory_store import MemoryStore

        with tempfile.TemporaryDirectory() as tmp:
            store = MemoryStore(Path(tmp))
            report = audit_memories(store)
            self.assertIsInstance(report, AuditReport)
            self.assertEqual(len(report.items), 0)


if __name__ == "__main__":
    unittest.main()
