from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .bug_memory import (
    BM25Index,
    LegacyIndex,
    load_cards,
    search_cards_with_diagnostics,
    tokenize,
    tokenize_terms,
)


HOLDOUT_LEGACY_WEIGHTS = {
    "root_cause": 5.0,
    "fix_pattern": 5.0,
    "patch_essence": 5.0,
    "language_or_framework": 4.0,
    "bug_type": 4.0,
    "changed_files": 3.0,
}

HOLDOUT_BM25_WEIGHTS = {
    "root_cause": 1.5,
    "fix_pattern": 1.5,
    "patch_essence": 1.5,
    "language_or_framework": 0.8,
    "bug_type": 1.0,
    "changed_files": 0.6,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Compare deterministic legacy and BM25 memory retrieval without calling an LLM."
        )
    )
    parser.add_argument("--cards", default="data/compact_bug_cards.jsonl")
    parser.add_argument("--tasks", default="eval_tasks.jsonl")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--holdout-limit", type=int, default=0)
    parser.add_argument("--output", default="retrieval_comparisons")
    return parser


def load_tasks(path: Path) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid task JSON on line {line_number}: {exc}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"Task line {line_number} is not an object.")
            tasks.append(value)
    return tasks


def _query_from_card(card: dict[str, Any]) -> str:
    symptoms = card.get("symptoms")
    symptom_text = " ".join(str(item) for item in symptoms) if isinstance(symptoms, list) else ""
    return "\n".join(
        part
        for part in (
            str(card.get("title") or ""),
            str(card.get("error_signature") or ""),
            symptom_text,
        )
        if part.strip()
    )


def _rank(scores: list[float], target_index: int) -> int:
    order = sorted(range(len(scores)), key=lambda index: scores[index], reverse=True)
    return order.index(target_index) + 1


def evaluate_holdout(
    cards: list[dict[str, Any]],
    *,
    limit: int = 0,
) -> dict[str, Any]:
    evaluated_cards = cards[:limit] if limit > 0 else cards
    legacy = LegacyIndex(cards, field_weights=dict(HOLDOUT_LEGACY_WEIGHTS))
    bm25 = BM25Index(cards, field_weights=dict(HOLDOUT_BM25_WEIGHTS))
    ranks: dict[str, list[int]] = {"legacy": [], "bm25": []}
    zero_score: dict[str, int] = {"legacy": 0, "bm25": 0}
    bm25_top_diagnostics: list[dict[str, Any]] = []
    for target_index, card in enumerate(evaluated_cards):
        query = _query_from_card(card)
        legacy_tokens = tokenize(query)
        bm25_terms = set(tokenize_terms(query))
        legacy_scores = [
            legacy.score_tokens(legacy_tokens, card_index)
            for card_index in range(len(cards))
        ]
        bm25_scores = [
            bm25.score_terms(bm25_terms, card_index)
            for card_index in range(len(cards))
        ]
        for name, scores in (("legacy", legacy_scores), ("bm25", bm25_scores)):
            ranks[name].append(_rank(scores, target_index))
            zero_score[name] += int(scores[target_index] <= 0)
        bm25_order = sorted(
            range(len(bm25_scores)), key=lambda index: bm25_scores[index], reverse=True
        )
        top_index = bm25_order[0]
        runner_up = bm25_scores[bm25_order[1]] if len(bm25_order) > 1 else 0.0
        explanation = bm25.explain(query, top_index, anchor_count=12)
        bm25_top_diagnostics.append(
            {
                "correct": top_index == target_index,
                "score": bm25_scores[top_index],
                "margin": bm25_scores[top_index] - runner_up,
                "anchor_matches": len(explanation["matched_anchors"]),
            }
        )

    result: dict[str, Any] = {
        "protocol": (
            "Query uses title, error_signature, and symptoms. Candidate scoring excludes "
            "those fields and search_text; it uses root cause, fix pattern, patch essence, "
            "framework, bug type, and changed files. This measures cross-field coherence, "
            "not downstream task relevance."
        ),
        "evaluated": len(evaluated_cards),
        "corpus_size": len(cards),
    }
    for name, values in ranks.items():
        count = max(1, len(values))
        result[name] = {
            "recall_at_1": sum(rank <= 1 for rank in values) / count,
            "recall_at_3": sum(rank <= 3 for rank in values) / count,
            "recall_at_10": sum(rank <= 10 for rank in values) / count,
            "mean_reciprocal_rank": sum(1.0 / rank for rank in values) / count,
            "median_rank": sorted(values)[len(values) // 2] if values else None,
            "zero_target_scores": zero_score[name],
        }
    filter_sweep: list[dict[str, Any]] = []
    for minimum_anchors in (0, 1, 2, 3):
        for minimum_margin in (0.0, 0.5, 1.0, 2.0, 5.0):
            accepted = [
                item
                for item in bm25_top_diagnostics
                if item["anchor_matches"] >= minimum_anchors
                and item["margin"] >= minimum_margin
            ]
            correct = sum(item["correct"] for item in accepted)
            filter_sweep.append(
                {
                    "minimum_anchor_matches": minimum_anchors,
                    "minimum_score_margin": minimum_margin,
                    "accepted": len(accepted),
                    "coverage": len(accepted) / max(1, len(bm25_top_diagnostics)),
                    "precision_when_accepted": correct / max(1, len(accepted)),
                    "correct_accepts": correct,
                    "recall_of_all_targets": correct / max(1, len(bm25_top_diagnostics)),
                }
            )
    result["bm25_filter_sweep"] = filter_sweep
    return result


def _file_keys(values: Any) -> set[str]:
    if not isinstance(values, list):
        return set()
    keys: set[str] = set()
    for value in values:
        path = Path(str(value).replace("\\", "/"))
        keys.add(path.name.casefold())
        keys.add(path.stem.casefold())
    return {key for key in keys if key}


def _result_rows(
    results: list[tuple[float, dict[str, Any]]],
    expected_files: Any,
    *,
    query: str = "",
    bm25_index: BM25Index | None = None,
) -> list[dict[str, Any]]:
    expected_keys = _file_keys(expected_files)
    rows: list[dict[str, Any]] = []
    card_positions = {id(card): index for index, card in enumerate(bm25_index.cards)} if bm25_index else {}
    for rank, (score, card) in enumerate(results, start=1):
        card_keys = _file_keys(card.get("changed_files"))
        row = {
            "rank": rank,
            "id": card.get("id"),
            "title": card.get("title"),
            "score": score,
            "expected_file_overlap": sorted(expected_keys & card_keys),
        }
        if bm25_index is not None:
            explanation = bm25_index.explain(query, card_positions[id(card)])
            row.update(
                {
                    "query_anchors": explanation["anchors"],
                    "matched_anchors": explanation["matched_anchors"],
                    "matched_terms": list(explanation["term_contributions"]),
                    "coverage": explanation["coverage"],
                }
            )
        rows.append(row)
    return rows


def evaluate_tasks(
    tasks: list[dict[str, Any]],
    cards: list[dict[str, Any]],
    *,
    top_k: int,
) -> list[dict[str, Any]]:
    legacy = LegacyIndex(cards)
    bm25 = BM25Index(cards)
    rows: list[dict[str, Any]] = []
    for task in tasks:
        query = "\n".join(
            part
            for part in (str(task.get("task") or ""), str(task.get("error") or ""))
            if part.strip()
        )
        legacy_results = legacy.search(query, top_k)
        bm25_results = bm25.search(query, top_k)
        filtered_results, filtered_diagnostics = search_cards_with_diagnostics(
            query,
            cards,
            top_k,
            strategy="bm25_filtered",
            minimum_anchor_matches=2,
            minimum_score_margin=5.0,
        )
        relevant_ids = task.get("relevant_memory_ids")
        has_labels = isinstance(relevant_ids, list) and bool(relevant_ids)
        rows.append(
            {
                "task_id": task.get("id"),
                "query": query,
                "ground_truth_available": has_labels,
                "relevant_memory_ids": relevant_ids if has_labels else [],
                "legacy": _result_rows(legacy_results, task.get("expected_files")),
                "bm25": _result_rows(
                    bm25_results,
                    task.get("expected_files"),
                    query=query,
                    bm25_index=bm25,
                ),
                "bm25_filtered": _result_rows(
                    filtered_results,
                    task.get("expected_files"),
                    query=query,
                    bm25_index=bm25,
                ),
                "bm25_filtered_diagnostics": filtered_diagnostics,
                "top_changed": bool(
                    legacy_results
                    and bm25_results
                    and legacy_results[0][1].get("id") != bm25_results[0][1].get("id")
                ),
            }
        )
    return rows


def render_markdown(summary: dict[str, Any]) -> str:
    holdout = summary["holdout"]
    lines = [
        "# Retrieval comparison",
        "",
        "No LLM was called. Holdout metrics measure cross-field card coherence, not",
        "downstream bug-fix relevance. The local task set has no exact memory labels.",
        "",
        "## Cross-field holdout",
        "",
        "| Strategy | R@1 | R@3 | R@10 | MRR | Median rank |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name in ("legacy", "bm25"):
        item = holdout[name]
        lines.append(
            f"| {name} | {item['recall_at_1']:.3f} | {item['recall_at_3']:.3f} | "
            f"{item['recall_at_10']:.3f} | {item['mean_reciprocal_rank']:.3f} | "
            f"{item['median_rank']} |"
        )
    lines.extend(
        [
            "",
            "## Unlabeled local-task diagnostics",
            "",
        "| Task | Legacy top | BM25 top | Filtered top | Changed |",
        "| --- | --- | --- | --- | --- |",
        ]
    )
    for task in summary["tasks"]:
        legacy_top = task["legacy"][0]["id"] if task["legacy"] else "(none)"
        bm25_top = task["bm25"][0]["id"] if task["bm25"] else "(none)"
        filtered_top = (
            task["bm25_filtered"][0]["id"] if task["bm25_filtered"] else "(none)"
        )
        lines.append(
            f"| {task['task_id']} | {legacy_top} | {bm25_top} | {filtered_top} | "
            f"{'yes' if task['top_changed'] else 'no'} |"
        )
    labeled = summary.get("labeled_task_metrics") or {}
    if labeled.get("labeled_tasks"):
        lines.extend(
            [
                "",
                "## Manually labeled analogy tasks",
                "",
                f"Labeled tasks: {labeled['labeled_tasks']}. Labels are manual analogy reviews,",
                "not exact-fix ground truth.",
                "",
                "| Strategy | Hit@1 | Hit@K | Memories attached |",
                "| --- | ---: | ---: | ---: |",
            ]
        )
        for name in ("legacy", "bm25", "bm25_filtered"):
            item = labeled[name]
            lines.append(
                f"| {name} | {item['hit_at_1']:.3f} | {item['hit_at_k']:.3f} | "
                f"{item['memories_attached']} |"
            )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.top_k < 1:
        raise SystemExit("--top-k must be at least 1")
    if args.holdout_limit < 0:
        raise SystemExit("--holdout-limit cannot be negative")
    cards_path = Path(args.cards).expanduser().resolve()
    tasks_path = Path(args.tasks).expanduser().resolve()
    cards = load_cards(cards_path)
    tasks = load_tasks(tasks_path)
    holdout = evaluate_holdout(cards, limit=args.holdout_limit)
    task_rows = evaluate_tasks(tasks, cards, top_k=args.top_k)
    labeled_rows = [row for row in task_rows if row["ground_truth_available"]]
    labeled_metrics: dict[str, Any] = {"labeled_tasks": len(labeled_rows)}
    for strategy in ("legacy", "bm25", "bm25_filtered"):
        top_hits = 0
        any_hits = 0
        attached = 0
        for row in labeled_rows:
            relevant = set(row["relevant_memory_ids"])
            ids = [item["id"] for item in row[strategy]]
            attached += len(ids)
            top_hits += int(bool(ids) and ids[0] in relevant)
            any_hits += int(bool(relevant & set(ids)))
        denominator = max(1, len(labeled_rows))
        labeled_metrics[strategy] = {
            "hit_at_1": top_hits / denominator,
            "hit_at_k": any_hits / denominator,
            "memories_attached": attached,
        }
    summary = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "cards_file": str(cards_path),
        "tasks_file": str(tasks_path),
        "card_count": len(cards),
        "task_count": len(tasks),
        "task_ground_truth_available": all(
            row["ground_truth_available"] for row in task_rows
        ),
        "holdout": holdout,
        "tasks": task_rows,
        "labeled_task_metrics": labeled_metrics,
        "note": (
            "Do not interpret holdout retrieval metrics as agent solve rate or official "
            "benchmark performance."
        ),
    }
    output_root = Path(args.output).expanduser().resolve()
    run_dir = output_root / datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = 2
    while run_dir.exists():
        run_dir = output_root / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{suffix}"
        suffix += 1
    run_dir.mkdir(parents=True)
    (run_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (run_dir / "summary.md").write_text(render_markdown(summary), encoding="utf-8")
    print("Retrieval comparison:", run_dir)
    print(render_markdown(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
