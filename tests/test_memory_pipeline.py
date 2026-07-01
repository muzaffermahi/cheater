from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from cheater.legacy.memory_dataset_registry import DatasetRegistry
from cheater.legacy.memory_normalizers import (
    SweRenchNormalizer,
    SweRenchV2Normalizer,
    SweRenchV2PRsNormalizer,
    MultiSweBenchNormalizer,
    MuLocBenchNormalizer,
    BenchHoldoutNormalizer,
    NORMALIZER_REGISTRY,
)
from cheater.legacy.memory_schema import (
    NormalizedRecord,
    MemoryCard,
    make_normalized_id,
    make_card_id,
    compute_provenance_hash,
)
from cheater.legacy.dedupe_memory_records import deduplicate
from cheater.legacy.contamination_filters import ContaminationFilter, DEFAULT_BENCHMARK_HOLDOUTS
from cheater.legacy.build_memory_cards import build_card, _card_should_be_enabled, _classify_task_type
from cheater.legacy.memory_index import load_cards as load_cards_from_index
from cheater.legacy.bug_memory import BM25Index, load_cards


SAMPLE_ROW_SWE_RENCH: dict[str, Any] = {
    "instance_id": "test__repo-123",
    "repo": "test/repo",
    "patch": "diff --git a/file.py b/file.py\nindex abc..def 100644\n--- a/file.py\n+++ b/file.py\n@@ -1,3 +1,4 @@\n old line\n+new line",
    "test_patch": "diff --git a/test_file.py b/test_file.py\nindex 111..222 100644\n--- a/test_file.py\n+++ b/test_file.py\n@@ -1,2 +1,3 @@\n old test\n+new test",
    "FAIL_TO_PASS": ["test_something"],
    "PASS_TO_PASS": ["test_other"],
    "problem_statement": "# Bug: Parser rejects valid alias\nWhen parsing a valid alias the parser raises a TypeError.",
    "issue_url": "https://github.com/test/repo/issues/1",
    "base_commit": "abc123",
    "changed_files": ["file.py"],
    "split": "train",
}


class TestDatasetRegistry(unittest.TestCase):
    def setUp(self) -> None:
        self.registry_path = (
            Path(__file__).resolve().parent.parent / "cheater" / "legacy" / "memory_datasets.json"
        )
        self.registry = DatasetRegistry.load(self.registry_path)

    def test_registry_loads(self) -> None:
        self.assertGreater(len(self.registry.datasets), 0)

    def test_benchmark_holdouts_disabled_by_default(self) -> None:
        for ds in self.registry.quarantined():
            self.assertTrue(ds.quarantined)
            self.assertFalse(ds.enabled_by_default)

    def test_enabled_sources_excludes_holdouts(self) -> None:
        enabled = self.registry.enabled_sources()
        holdout_ids = {ds.dataset_id for ds in self.registry.quarantined()}
        for ds in enabled:
            self.assertNotIn(ds.dataset_id, holdout_ids)

    def test_holdout_ids_returns_correct_set(self) -> None:
        holdout_ids = self.registry.holdout_ids()
        self.assertIn("princeton-nlp/SWE-bench", holdout_ids)
        self.assertIn("princeton-nlp/SWE-bench_Verified", holdout_ids)

    def test_query_quarantined_refuses_without_flag(self) -> None:
        with self.assertRaises(ValueError):
            self.registry.resolve_ids(
                ["princeton-nlp/SWE-bench"], include_quarantined=False
            )

    def test_query_quarantined_allows_with_flag(self) -> None:
        results = self.registry.resolve_ids(
            ["princeton-nlp/SWE-bench"], include_quarantined=True
        )
        self.assertEqual(len(results), 1)

    def test_all_enabled_returns_only_enabled(self) -> None:
        results = self.registry.resolve_ids(all_enabled=True)
        for ds in results:
            self.assertTrue(ds.enabled_by_default)
            self.assertFalse(ds.quarantined)


class TestNormalizers(unittest.TestCase):
    def test_all_normalizers_registered(self) -> None:
        expected = [
            "nebius/SWE-rebench",
            "nebius/SWE-rebench-V2",
            "nebius/SWE-rebench-V2-PRs",
            "ByteDance-Seed/Multi-SWE-bench",
            "somethingone/MULocBench",
            "princeton-nlp/SWE-bench",
            "princeton-nlp/SWE-bench_Verified",
        ]
        for dataset_id in expected:
            self.assertIn(dataset_id, NORMALIZER_REGISTRY)

    def test_swe_rench_normalizer_produces_record(self) -> None:
        normalizer = SweRenchNormalizer()
        record = normalizer.normalize(SAMPLE_ROW_SWE_RENCH, 0)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.instance_id, "test__repo-123")
        self.assertEqual(record.repo, "test/repo")
        self.assertTrue(record.patch_sha256)
        self.assertTrue(record.test_patch_sha256)
        self.assertTrue(record.normalized_id.startswith("norm_"))

    def test_normalizer_tolerates_missing_fields(self) -> None:
        normalizer = SweRenchNormalizer()
        record = normalizer.normalize({"instance_id": "minimal"}, 0)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.instance_id, "minimal")
        self.assertEqual(record.patch, "")
        self.assertEqual(record.fail_to_pass, [])

    def test_normalizer_empty_instance_id_returns_none(self) -> None:
        normalizer = SweRenchNormalizer()
        record = normalizer.normalize({}, 0)
        self.assertIsNone(record)

    def test_multi_swe_bench_normalizer(self) -> None:
        normalizer = MultiSweBenchNormalizer()
        row = dict(SAMPLE_ROW_SWE_RENCH)
        row["programming_language"] = "Java"
        record = normalizer.normalize(row, 0)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.language, "Java")

    def test_muloc_bench_normalizer(self) -> None:
        normalizer = MuLocBenchNormalizer()
        row: dict[str, Any] = {
            "id": "loc_001",
            "repo": "test/loc",
            "bug_description": "Wrong line highlighted",
        }
        record = normalizer.normalize(row, 0)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.instance_id, "loc_001")

    def test_bench_holdout_normalizer_returns_none(self) -> None:
        normalizer = BenchHoldoutNormalizer()
        record = normalizer.normalize(SAMPLE_ROW_SWE_RENCH, 0)
        self.assertIsNone(record)


class TestSchema(unittest.TestCase):
    def test_normalized_id_deterministic(self) -> None:
        id1 = make_normalized_id("test", "inst-1", 0)
        id2 = make_normalized_id("test", "inst-1", 0)
        self.assertEqual(id1, id2)
        self.assertTrue(id1.startswith("norm_"))

    def test_card_id_deterministic(self) -> None:
        id1 = make_card_id("norm_abc123")
        id2 = make_card_id("norm_abc123")
        self.assertEqual(id1, id2)

    def test_provenance_hash_stable(self) -> None:
        record = {"a": 1, "b": [2, 3]}
        h1 = compute_provenance_hash(record)
        h2 = compute_provenance_hash(dict(sorted(record.items())))
        self.assertEqual(h1, h2)

    def test_normalized_record_roundtrip(self) -> None:
        record = NormalizedRecord(
            normalized_id="norm_test",
            source_dataset="test",
            source_split="train",
            source_row_index=0,
            instance_id="inst",
            repo="test/repo",
        )
        d = record.to_dict()
        restored = NormalizedRecord.from_dict(d)
        self.assertEqual(restored.normalized_id, "norm_test")
        self.assertEqual(restored.repo, "test/repo")

    def test_memory_card_roundtrip(self) -> None:
        card = MemoryCard(
            card_id="card_test",
            source_normalized_id="norm_test",
            source_dataset="test",
            source_instance_id="inst",
            source_repo="test/repo",
        )
        d = card.to_dict()
        restored = MemoryCard.from_dict(d)
        self.assertEqual(restored.card_id, "card_test")


class TestDeduplication(unittest.TestCase):
    def test_dedupe_exact_instance_id(self) -> None:
        records = [
            NormalizedRecord(
                normalized_id="r1",
                source_dataset="ds1",
                source_split="train",
                source_row_index=0,
                instance_id="same",
                repo="test/repo",
                problem_statement="# Bug 1: Parser error",
            ),
            NormalizedRecord(
                normalized_id="r2",
                source_dataset="ds1",
                source_split="train",
                source_row_index=1,
                instance_id="same",
                repo="test/repo",
                problem_statement="# Bug 1: Parser error",
            ),
            NormalizedRecord(
                normalized_id="r3",
                source_dataset="ds1",
                source_split="train",
                source_row_index=2,
                instance_id="different",
                repo="test/repo",
                problem_statement="# Bug 2: Sorting regression",
            ),
        ]
        deduped, report = deduplicate(records)
        self.assertEqual(len(deduped), 2)
        self.assertEqual(report["total_removed"], 1)

    def test_dedupe_patch_hash(self) -> None:
        records = [
            NormalizedRecord(
                normalized_id="r1",
                source_dataset="ds1",
                source_split="train",
                source_row_index=0,
                instance_id="a",
                repo="test/a",
                patch="diff --git a/x.py b/x.py",
                patch_sha256="hash1",
            ),
            NormalizedRecord(
                normalized_id="r2",
                source_dataset="ds1",
                source_split="train",
                source_row_index=1,
                instance_id="b",
                repo="test/b",
                patch="diff --git a/x.py b/x.py",
                patch_sha256="hash1",
            ),
        ]
        deduped, report = deduplicate(records)
        self.assertEqual(len(deduped), 1)

    def test_dedupe_no_duplicates(self) -> None:
        records = [
            NormalizedRecord(
                normalized_id="r1",
                source_dataset="ds1",
                source_split="train",
                source_row_index=0,
                instance_id="a",
                repo="test/a",
                patch_sha256="hash_a",
                problem_statement="# Bug 1: Parser error",
            ),
            NormalizedRecord(
                normalized_id="r2",
                source_dataset="ds1",
                source_split="train",
                source_row_index=1,
                instance_id="b",
                repo="test/b",
                patch_sha256="hash_b",
                problem_statement="# Bug 2: Sorting regression",
            ),
        ]
        deduped, report = deduplicate(records)
        self.assertEqual(len(deduped), 2)
        self.assertEqual(report["total_removed"], 0)


class TestContaminationFilter(unittest.TestCase):
    def setUp(self) -> None:
        self.filter = ContaminationFilter(benchmark_datasets=DEFAULT_BENCHMARK_HOLDOUTS)

    def test_exclude_benchmark_holdout_card(self) -> None:
        card = MemoryCard(
            card_id="holdout_card",
            source_normalized_id="norm_1",
            source_dataset="princeton-nlp/SWE-bench",
            source_instance_id="inst",
            source_repo="test/repo",
            contamination_scope="swe_bench_official",
        )
        passed, excluded = self.filter.exclude_for_benchmark([card])
        self.assertEqual(len(passed), 0)
        self.assertEqual(len(excluded), 1)
        self.assertIn("source_dataset_is_benchmark_holdout", excluded[0]["reasons"])

    def test_exclude_same_repo_instance(self) -> None:
        card = MemoryCard(
            card_id="same_inst",
            source_normalized_id="norm_1",
            source_dataset="test/source",
            source_instance_id="inst_1",
            source_repo="test/repo",
        )
        passed, excluded = self.filter.exclude_for_benchmark(
            [card],
            benchmark_dataset="test/source",
            benchmark_instance_id="inst_1",
            benchmark_repo="test/repo",
        )
        self.assertEqual(len(passed), 0)

    def test_allow_unrelated_card(self) -> None:
        card = MemoryCard(
            card_id="unrelated",
            source_normalized_id="norm_1",
            source_dataset="some/other",
            source_instance_id="inst_2",
            source_repo="other/repo",
        )
        passed, excluded = self.filter.exclude_for_benchmark(
            [card],
            benchmark_instance_id="inst_1",
            benchmark_repo="test/repo",
        )
        self.assertEqual(len(passed), 1)
        self.assertEqual(len(excluded), 0)


class TestCardBuilding(unittest.TestCase):
    def setUp(self) -> None:
        self.record = NormalizedRecord(
            normalized_id="norm_test",
            source_dataset="test/source",
            source_split="train",
            source_row_index=0,
            instance_id="inst-1",
            repo="test/repo",
            language="Python",
            base_commit="abc123",
            problem_statement="# Bug: Parser TypeError\nWhen parsing input, a TypeError is raised for valid aliases.",
            patch="diff --git a/parser.py b/parser.py\nindex abc..def 100644\n--- a/parser.py\n+++ b/parser.py\n@@ -10,7 +10,7 @@\n     def parse(self, input):\n-        return None\n+        return input.strip()",
            fail_to_pass=["test_parse_valid"],
            pass_to_pass=["test_parse_invalid"],
            changed_files=["parser.py"],
        )

    def test_card_generation(self) -> None:
        card = build_card(self.record)
        self.assertTrue(card.card_id.startswith("card_"))
        self.assertEqual(card.source_repo, "test/repo")
        self.assertGreater(card.quality_score, 0)

    def test_task_type_classification(self) -> None:
        card = build_card(self.record)
        self.assertIn(card.task_type, {"bug_fix", "regression", "incorrect_behavior"})

    def test_card_has_bm25_text(self) -> None:
        card = build_card(self.record)
        self.assertTrue(card.card_text_bm25)

    def test_quality_score_completeness(self) -> None:
        complete = build_card(self.record)
        minimal = build_card(
            NormalizedRecord(
                normalized_id="norm_min",
                source_dataset="test",
                source_split="train",
                source_row_index=0,
                instance_id="min",
                repo="test/min",
            )
        )
        self.assertGreater(complete.quality_score, minimal.quality_score)

    def test_card_should_be_enabled_bug_fix(self) -> None:
        card = build_card(self.record)
        card.task_type = "bug_fix"
        card.quality_score = 5.0
        self.assertTrue(_card_should_be_enabled(card))

    def test_card_should_be_disabled_feature(self) -> None:
        card = build_card(self.record)
        card.task_type = "feature_or_enhancement"
        card.quality_score = 3.0
        self.assertFalse(_card_should_be_enabled(card))


class TestBM25Index(unittest.TestCase):
    def test_bm25_index_builds_on_tiny_fixture(self) -> None:
        cards = [
            {
                "id": "a",
                "title": "Bug in parser",
                "search_text": "parser TypeError alias fix",
                "card_text_bm25": "parser TypeError alias fix",
            },
            {
                "id": "b",
                "title": "Regression in sorting",
                "search_text": "sort order regression reverse",
                "card_text_bm25": "sort order regression reverse",
            },
        ]
        index = BM25Index(cards)
        results = index.search("parser TypeError", 2)
        self.assertGreater(len(results), 0)
        self.assertEqual(results[0][1]["id"], "a")
        self.assertGreater(results[0][0], 0)

    def test_bm25_empty_query_returns_empty(self) -> None:
        cards = [{"id": "a", "search_text": "test"}]
        index = BM25Index(cards)
        results = index.search("", 5)
        self.assertEqual(results, [])


class TestOldCompactCards(unittest.TestCase):
    def test_old_compact_cards_still_load(self) -> None:
        compact_path = (
            Path(__file__).resolve().parent.parent / "data" / "compact_bug_cards.jsonl"
        )
        if not compact_path.is_file():
            self.skipTest("compact_bug_cards.jsonl not found")
        cards = load_cards(str(compact_path))
        self.assertGreater(len(cards), 0)
        self.assertIn("id", cards[0])
        self.assertIn("title", cards[0])


class TestAcceptanceCommands(unittest.TestCase):
    def test_dry_run_ingest(self) -> None:
        registry_path = Path(__file__).resolve().parent.parent / "cheater" / "legacy" / "memory_datasets.json"
        registry = DatasetRegistry.load(registry_path)
        ds = registry.get("nebius/SWE-rebench")
        self.assertIsNotNone(ds)
        self.assertEqual(ds.role, "memory_source")

    def test_eval_dry_run_still_works(self) -> None:
        import cheater.legacy.run_eval as ev

        task_file = Path(__file__).resolve().parent.parent / "data" / "eval_tasks" / "eval_tasks.example.jsonl"
        if not task_file.is_file():
            self.skipTest("eval_tasks.example.jsonl not found")
        args = ev.parse_args(
            [
                "--tasks",
                str(task_file),
                "--variant",
                "both",
                "--limit",
                "1",
                "--dry-run",
            ]
        )
        self.assertTrue(args.dry_run)
        self.assertEqual(args.limit, 1)
