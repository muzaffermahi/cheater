from __future__ import annotations

import unittest
from pathlib import Path

from cheater.retrieval import BM25FIndex, load_index_cards

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_CARDS = REPO_ROOT / "data" / "samples" / "sample_cards.v1.jsonl"


class TestSearchSmoke(unittest.TestCase):
    def setUp(self) -> None:
        if not SAMPLE_CARDS.is_file():
            self.skipTest("sample cards not checked in")
        self.cards = load_index_cards(SAMPLE_CARDS)
        self.index = BM25FIndex(self.cards)

    def test_sample_cards_load_and_are_usable(self) -> None:
        self.assertGreaterEqual(len(self.cards), 5)
        for c in self.cards:
            self.assertTrue(c.get("usable"))

    def test_search_returns_expected_pydantic_card(self) -> None:
        results = self.index.search(
            "pydantic ValidationError env_nested_delimiter environment variable", top_k=3
        )
        self.assertGreater(len(results), 0)
        ids = [c.get("id") for _, c in results]
        self.assertIn("pydantic__pydantic-3975", ids)
        self.assertEqual(results[0][1].get("id"), "pydantic__pydantic-3975")

    def test_search_returns_expected_geopandas_card(self) -> None:
        results = self.index.search(
            "geopandas left spatial join sorted by right index", top_k=3
        )
        ids = [c.get("id") for _, c in results]
        self.assertIn("geopandas__geopandas-3240", ids)

    def test_empty_query_returns_no_results(self) -> None:
        self.assertEqual(self.index.search("", top_k=5), [])

    def test_bm25_prefers_specific_over_generic(self) -> None:
        results = self.index.search(
            "cognitive complexity binary logical operators BoolOp nesting", top_k=2
        )
        self.assertEqual(results[0][1].get("id"), "Melevir__cognitive_complexity-15")
        self.assertGreater(results[0][0], results[1][0])


if __name__ == "__main__":
    unittest.main()
