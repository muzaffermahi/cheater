from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.benchmark import evaluate, evaluate_compare, read_benchmark
from cheater.retrieval import BM25FIndex

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_BENCH = REPO_ROOT / "data" / "benchmarks" / "sample_benchmark.jsonl"
SAMPLE_CARDS = REPO_ROOT / "data" / "samples" / "sample_cards.v1.jsonl"


class TestBenchmarkSmoke(unittest.TestCase):
    def setUp(self) -> None:
        if not (SAMPLE_BENCH.is_file() and SAMPLE_CARDS.is_file()):
            self.skipTest("sample benchmark/cards not checked in")
        from cheater.retrieval import load_index_cards
        self.cards = load_index_cards(SAMPLE_CARDS)
        self.index = BM25FIndex(self.cards)

    def test_sample_benchmark_passes_with_perfect_recall(self) -> None:
        cases = read_benchmark(SAMPLE_BENCH)
        summary = evaluate(cases, self.index, top_k=5)
        self.assertEqual(summary["cases"], 5)
        self.assertEqual(summary["no_hit"], 0)
        self.assertEqual(summary["recall_at_1"], 1.0)
        self.assertEqual(summary["recall_at_5"], 1.0)
        self.assertEqual(summary["mrr"], 1.0)

    def test_metrics_compute_correctly_on_synthetic_corpus(self) -> None:
        cards = [
            {"id": "a", "usable": True, "embedding_text": "parser TypeError alias",
             "symptom": "TypeError", "fix_pattern": "fix alias", "search_keywords": [],
             "root_cause": None, "bug_type": None, "language": None, "key_files": []},
            {"id": "b", "usable": True, "embedding_text": "sort order regression reverse",
             "symptom": "wrong order", "fix_pattern": "fix sort", "search_keywords": [],
             "root_cause": None, "bug_type": None, "language": None, "key_files": []},
            {"id": "c", "usable": True, "embedding_text": "network timeout retry",
             "symptom": "timeout", "fix_pattern": "add retry", "search_keywords": [],
             "root_cause": None, "bug_type": None, "language": None, "key_files": []},
        ]
        index = BM25FIndex(cards)
        cases = [
            {"id": "q1", "query": "parser TypeError alias", "expected_card_ids": ["a"]},
            {"id": "q2", "query": "sort order regression", "expected_card_ids": ["b"]},
            {"id": "q3", "query": "completely unrelated nonsense xyz", "expected_card_ids": ["c"]},
        ]
        summary = evaluate(cases, index, top_k=5)
        self.assertEqual(summary["cases"], 3)
        self.assertEqual(summary["no_hit"], 1)
        self.assertAlmostEqual(summary["recall_at_1"], 2 / 3, places=3)
        self.assertLess(summary["mrr"], 1.0)

    def test_read_benchmark_rejects_missing_fields(self) -> None:
        from cheater.cards import CardError
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bench.jsonl"
            p.write_text(json.dumps({"id": "q", "query": "q"}) + "\n", encoding="utf-8")
            with self.assertRaises(CardError):
                read_benchmark(p)

    def test_ndcg_metric_present(self) -> None:
        from cheater.retrieval import BM25FIndex
        cards = [
            {"id": "a", "usable": True, "symptom": "TypeError foo bar", "fix_pattern": "fix", "embedding_text": "typeerror foo bar", "search_keywords": [], "root_cause": None, "bug_type": None, "language": None, "key_files": []},
        ]
        cases = [
            {"id": "q1", "query": "TypeError foo bar", "expected_card_ids": ["a"]},
        ]
        index = BM25FIndex(cards)
        summary = evaluate(cases, index, top_k=5)
        self.assertIn("ndcg_at_5", summary)
        # Perfect retrieval -> nDCG should be 1.0
        self.assertEqual(summary["ndcg_at_5"], 1.0)

    def test_per_difficulty_metrics(self) -> None:
        from cheater.retrieval import BM25FIndex
        cards = [
            {"id": "a", "usable": True, "symptom": "TypeError foo", "fix_pattern": "fix", "embedding_text": "typeerror foo", "search_keywords": [], "root_cause": None, "bug_type": None, "language": None, "key_files": []},
        ]
        cases = [
            {"id": "q1", "query": "TypeError foo", "expected_card_ids": ["a"], "difficulty": "easy", "language": "python"},
            {"id": "q2", "query": "TypeError bar", "expected_card_ids": ["a"], "difficulty": "hard", "language": "python"},
        ]
        index = BM25FIndex(cards)
        summary = evaluate(cases, index, top_k=5)
        self.assertIn("by_difficulty", summary)
        self.assertIn("easy", summary["by_difficulty"])
        self.assertIn("hard", summary["by_difficulty"])
        self.assertIn("by_language", summary)
        self.assertIn("python", summary["by_language"])

    def test_compare_mode_returns_multiple_configs(self) -> None:
        from cheater.retrieval import BM25FIndex
        cards = [
            {"id": "a", "usable": True, "symptom": "TypeError foo", "fix_pattern": "fix foo", "embedding_text": "typeerror foo", "search_keywords": [], "root_cause": None, "bug_type": None, "language": None, "key_files": []},
        ]
        cases = [{"id": "q1", "query": "TypeError foo", "expected_card_ids": ["a"]}]
        results = evaluate_compare(cases, cards, compact_cards=None, top_k=5)
        labels = [r["label"] for r in results]
        self.assertIn("lexical_baseline", labels)
        self.assertIn("lexical_quality", labels)
        self.assertIn("bm25f_symptom_heavy", labels)
        # Each result has the standard metrics
        for r in results:
            self.assertIn("recall_at_1", r)
            self.assertIn("mrr", r)
            self.assertIn("ndcg_at_5", r)
            self.assertIn("notes", r)


if __name__ == "__main__":
    unittest.main()
