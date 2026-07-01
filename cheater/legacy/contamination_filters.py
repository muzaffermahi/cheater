from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .memory_schema import MemoryCard


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass
class ContaminationFilter:
    benchmark_datasets: set[str] = field(default_factory=set)
    exempt_ids: set[str] = field(default_factory=set)

    def exclude_for_benchmark(
        self,
        cards: list[MemoryCard],
        benchmark_dataset: str = "",
        benchmark_instance_id: str = "",
        benchmark_repo: str = "",
    ) -> tuple[list[MemoryCard], list[dict[str, Any]]]:
        excluded: list[dict[str, Any]] = []
        passed: list[MemoryCard] = []

        benchmark_repo_lower = benchmark_repo.strip().lower()
        benchmark_instance_lower = benchmark_instance_id.strip().lower()

        for card in cards:
            reasons: list[str] = []

            if card.card_id in self.exempt_ids:
                passed.append(card)
                continue

            if card.contamination_scope == "swe_bench_official":
                reasons.append("source_dataset_is_benchmark_holdout")
            elif card.source_dataset in self.benchmark_datasets:
                reasons.append(f"source_dataset={card.source_dataset}")

            if benchmark_repo_lower:
                card_repo = card.source_repo.strip().lower()
                if card_repo == benchmark_repo_lower:
                    instance_match = (
                        benchmark_instance_lower
                        and card.source_instance_id.strip().lower()
                        == benchmark_instance_lower
                    )
                    if instance_match:
                        reasons.append("same_repo_and_instance")
                    elif not benchmark_instance_lower:
                        reasons.append("same_repo")

            card_patch_hash = _sha256(card.patch or "")
            card_test_patch_hash = _sha256(card.test_patch or "")

            if reasons:
                excluded.append(
                    {
                        "card_id": card.card_id,
                        "source_dataset": card.source_dataset,
                        "source_instance_id": card.source_instance_id,
                        "reasons": reasons,
                        "benchmark_dataset": benchmark_dataset,
                        "benchmark_instance_id": benchmark_instance_id,
                        "benchmark_repo": benchmark_repo,
                    }
                )
            else:
                passed.append(card)

        return passed, excluded

    def to_dict(self) -> dict[str, Any]:
        return {
            "benchmark_datasets": sorted(self.benchmark_datasets),
            "exempt_ids": sorted(self.exempt_ids),
        }


DEFAULT_BENCHMARK_HOLDOUTS: set[str] = {
    "princeton-nlp/SWE-bench",
    "princeton-nlp/SWE-bench_Verified",
}


def build_contamination_report(
    excluded: list[dict[str, Any]],
    output_path: str | Path | None = None,
) -> dict[str, Any]:
    by_reason: dict[str, int] = {}
    for item in excluded:
        for reason in item["reasons"]:
            by_reason[reason] = by_reason.get(reason, 0) + 1
    report = {
        "total_excluded": len(excluded),
        "exclusions_by_reason": by_reason,
        "excluded_cards": excluded,
    }
    if output_path:
        import json

        p = Path(output_path).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
    return report
