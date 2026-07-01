from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.legacy.bug_memory import (
    BM25Index,
    LegacyIndex,
    inspect_cards_corpus,
    search_cards,
    search_cards_with_diagnostics,
)
from cheater.legacy.compare_retrieval import evaluate_holdout
from cheater.legacy.cheater_core import console_safe, format_cheater_memories


class RetrievalTests(unittest.TestCase):
    def test_corpus_inspection_distinguishes_supported_cards_from_source_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            compact = root / "compact.jsonl"
            solved_raw = root / "solved_raw.jsonl"
            trajectory = root / "trajectory.jsonl"
            raw_preview = root / "raw_preview.jsonl"
            compact.write_text(
                json.dumps(
                    {
                        "id": "compact",
                        "title": "Bug",
                        "root_cause": "Cause",
                        "fix_pattern": "Fix",
                        "search_text": "bug cause fix",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            solved_raw.write_text(
                json.dumps(
                    {
                        "id": "raw",
                        "issue": "ISSUE:\nRaw bug",
                        "error_excerpt": "TypeError",
                        "patch_summary": "Changed x.py",
                        "search_text": "raw bug TypeError",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            trajectory.write_text(
                json.dumps({"id": "source", "trajectory": [{"role": "user"}]}) + "\n",
                encoding="utf-8",
            )
            raw_preview.write_text(
                json.dumps({"id": "preview", "error_excerpt": "x", "raw_preview": "y"})
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(inspect_cards_corpus(compact)["format"], "compact_cards")
            self.assertEqual(
                inspect_cards_corpus(solved_raw)["format"], "solved_trajectory_cards"
            )
            source_info = inspect_cards_corpus(trajectory)
            self.assertEqual(source_info["format"], "raw_trajectory_rows")
            self.assertFalse(source_info["supported"])
            self.assertIn("Convert", source_info["error"])
            preview_info = inspect_cards_corpus(raw_preview)
            self.assertEqual(preview_info["format"], "raw_preview_rows")
            self.assertFalse(preview_info["supported"])
            self.assertIn("not searchable", preview_info["error"])

    def test_raw_solved_card_prompt_is_explicit_and_contains_raw_evidence(self) -> None:
        card = {
            "id": "raw-one",
            "issue": "ISSUE:\nParser rejects a valid alias",
            "error_excerpt": "TypeError: alias",
            "patch_summary": "Changed parser.py. Added lines: 2.",
            "trajectory_preview": "ASSISTANT: inspect parser branch",
            "changed_files": ["parser.py"],
            "patch": "diff --git a/parser.py b/parser.py",
        }
        block = format_cheater_memories([(12.5, card)], include_patch=False)
        self.assertIn("solved_trajectory_card (raw", block)
        self.assertIn("Parser rejects a valid alias", block)
        self.assertIn("TypeError: alias", block)
        self.assertIn("inspect parser branch", block)
        self.assertNotIn("diff --git", block)

    def test_console_safe_escapes_unencodable_card_text(self) -> None:
        self.assertEqual(console_safe("style \x80 value", "ascii"), "style \\x80 value")

    def test_bm25_prefers_rare_error_terms_over_generic_python_terms(self) -> None:
        cards = [
            {
                "id": "generic",
                "title": "Python error in parser",
                "search_text": "python error parser failure value test",
                "error_signature": "ValueError",
            },
            {
                "id": "specific",
                "title": "Reject negative signature age",
                "search_text": "future timestamp NegativeSignatureAge signed token",
                "error_signature": "SignatureExpired: age -10",
            },
        ]
        results = BM25Index(cards).search(
            "Python signed token has future timestamp and negative signature age", 2
        )
        self.assertEqual(results[0][1]["id"], "specific")
        self.assertGreater(results[0][0], results[1][0])

    def test_search_strategy_is_explicit_and_unknown_strategy_is_rejected(self) -> None:
        cards = [{"id": "one", "search_text": "rare token"}]
        self.assertEqual(search_cards("rare", cards, strategy="legacy")[0][1]["id"], "one")
        self.assertEqual(search_cards("rare", cards, strategy="bm25")[0][1]["id"], "one")
        with self.assertRaisesRegex(ValueError, "Unknown retrieval strategy"):
            search_cards("rare", cards, strategy="magic")

    def test_filtered_bm25_records_acceptance_and_rejection_reasons(self) -> None:
        cards = [
            {"id": "specific", "search_text": "negative future timestamp signature age"},
            {"id": "generic", "search_text": "generic timestamp value"},
        ]
        accepted, accepted_diagnostics = search_cards_with_diagnostics(
            "negative future timestamp signature age",
            cards,
            strategy="bm25_filtered",
            minimum_anchor_matches=1,
            minimum_score_margin=0,
        )
        self.assertEqual(accepted[0][1]["id"], "specific")
        self.assertEqual(accepted_diagnostics["reason"], "confidence_filter_passed")
        rejected, rejected_diagnostics = search_cards_with_diagnostics(
            "negative future timestamp signature age",
            cards,
            strategy="bm25_filtered",
            minimum_anchor_matches=99,
            minimum_score_margin=0,
        )
        self.assertEqual(rejected, [])
        self.assertIn("insufficient_anchor_matches", rejected_diagnostics["reason"])

    def test_cross_field_holdout_reports_both_strategies(self) -> None:
        cards = [
            {
                "id": "one",
                "title": "Future timestamp rejected",
                "error_signature": "negative signature age",
                "symptoms": ["future signed token accepted"],
                "root_cause": "negative age was not checked",
                "fix_pattern": "reject negative age",
                "patch_essence": "add age below zero guard",
                "bug_type": "validation",
            },
            {
                "id": "two",
                "title": "Parser alias failure",
                "error_signature": "unexpected alias",
                "symptoms": ["SQL parser rejects alias"],
                "root_cause": "alias token classified as keyword",
                "fix_pattern": "accept alias token",
                "patch_essence": "adjust parser keyword branch",
                "bug_type": "parser",
            },
        ]
        summary = evaluate_holdout(cards)
        self.assertEqual(summary["evaluated"], 2)
        self.assertIn("recall_at_1", summary["legacy"])
        self.assertIn("recall_at_1", summary["bm25"])
        self.assertGreaterEqual(summary["bm25"]["recall_at_1"], 0.5)

    def test_legacy_index_matches_legacy_search_order(self) -> None:
        cards = [
            {"id": "first", "search_text": "same token"},
            {"id": "second", "search_text": "same token"},
        ]
        self.assertEqual(LegacyIndex(cards).search("same", 2)[0][1]["id"], "first")


if __name__ == "__main__":
    unittest.main()
