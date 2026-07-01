from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.audit import audit_file, format_report
from cheater.cards import CardLineError, read_jsonl
from cheater.schema import normalize_and_validate


def _write(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


class TestCardAudit(unittest.TestCase):
    def test_valid_file_passes(self) -> None:
        card = {
            "id": "a-1", "source": "t", "usable": True,
            "symptom": "s", "fix_pattern": "f", "embedding_text": "e",
        }
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cards.jsonl"
            _write(p, [json.dumps(card)])
            report = audit_file(p)
        self.assertTrue(report["passes"], report["errors"])
        self.assertEqual(report["usable_true"], 1)
        self.assertEqual(report["duplicate_ids"], [])

    def test_invalid_card_missing_required_fails(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cards.jsonl"
            _write(p, [json.dumps({"source": "t", "usable": True})])
            report = audit_file(p)
        self.assertFalse(report["passes"])
        self.assertIn("id", report["missing_required"])

    def test_duplicate_ids_detected(self) -> None:
        card = {"id": "dup-1", "source": "t", "usable": False}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cards.jsonl"
            _write(p, [json.dumps(card), json.dumps(card)])
            report = audit_file(p)
        self.assertFalse(report["passes"])
        self.assertEqual(len(report["duplicate_ids"]), 1)
        self.assertEqual(report["duplicate_ids"][0]["id"], "dup-1")

    def test_invalid_json_reports_line_with_file_and_line_number(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cards.jsonl"
            _write(p, ['{"id": "ok", "source": "t", "usable": false}', "{not valid json"])
            report = audit_file(p)
        self.assertFalse(report["passes"])
        self.assertEqual(len(report["invalid_lines"]), 1)
        self.assertEqual(report["invalid_lines"][0]["line"], 2)
        self.assertIn(str(p), report["errors"][0])

    def test_read_jsonl_raises_cardline_error_with_file_and_line(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cards.jsonl"
            _write(p, ['{"id": "ok"}', "%%%bad%%%"])
            with self.assertRaises(CardLineError) as cm:
                list(read_jsonl(p))
            self.assertEqual(cm.exception.line, 2)
            self.assertTrue(str(p) in str(cm.exception))

    def test_format_report_human_readable(self) -> None:
        report = audit_file("nonexistent-file.jsonl")
        text = format_report(report)
        self.assertIn("FILE NOT FOUND", text)

    def test_quality_mode_adds_quality_section(self) -> None:
        good = {
            "id": "q-good", "source": "t", "usable": True,
            "repo": "r", "language": "py", "bug_type": "TypeError",
            "symptom": "TypeError when importing foo from bar module in production tests.",
            "fix_pattern": "Add __init__.py to bar module and import from bar.foo.",
            "key_files": ["bar/__init__.py"],
            "search_keywords": ["import", "TypeError", "foo"],
            "embedding_text": "typeerror when importing foo from bar module in production tests " * 3,
        }
        junk = {
            "id": "q-junk", "source": "t", "usable": False,
            "symptom": "errors.) command at the end of the file,",
            "fix_pattern": "", "embedding_text": "",
        }
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cards.jsonl"
            _write(p, [json.dumps(good), json.dumps(junk)])
            report = audit_file(p, with_quality=True)
        self.assertIn("quality", report)
        q = report["quality"]
        self.assertEqual(q["total"], 2)
        # The good card should have high quality
        self.assertGreaterEqual(q["above_0_7"], 1)
        # Both should have non-zero avg
        self.assertGreater(q["avg_quality"], 0)

    def test_quality_text_includes_reasons(self) -> None:
        junk = {
            "id": "q-bad", "source": "t", "usable": True,
            "symptom": "errors.) command at the end of the file,",
            "fix_pattern": "", "embedding_text": "",
        }
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cards.jsonl"
            _write(p, [json.dumps(junk)])
            report = audit_file(p, with_quality=True)
        text = format_report(report, with_quality=True)
        self.assertIn("--- Quality ---", text)
        self.assertIn("top filter reasons", text)


if __name__ == "__main__":
    unittest.main()
