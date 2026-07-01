from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def load_run_results(run_dir: Path) -> list[dict[str, Any]]:
    results_file = run_dir / "evaluation_results.json"
    if not results_file.is_file():
        return []
    try:
        data = json.loads(results_file.read_text(encoding="utf-8"))
        return data.get("results", [])
    except (json.JSONDecodeError, OSError):
        return []


def _safe_list(value: Any, default: list | None = None) -> list:
    if isinstance(value, list):
        return value
    return default or []


def collect_memory_stats(results: list[dict[str, Any]]) -> dict[str, Any]:
    per_card: dict[str, dict[str, Any]] = {}
    per_dataset: Counter[str] = Counter()
    per_type: Counter[str] = Counter()
    total_runs = len(results)
    memory_runs = 0

    for r in results:
        memory_ids = _safe_list(r.get("retrieved_memory_ids"))
        if not memory_ids:
            continue
        memory_runs += 1
        sources = _safe_list(r.get("retrieved_memories"))
        attempt_status = r.get("solved_status", "unknown")
        final_status = r.get("solved")
        retry_used = bool(r.get("retries_used", 0) > 0)
        changed_files = _safe_list(r.get("changed_files"))

        for mem in sources:
            mem_id = str(mem.get("id", ""))
            if not mem_id:
                continue
            dataset = str(mem.get("source_dataset", "unknown"))
            card_type = str(mem.get("task_type", mem.get("bug_type", "unknown")))
            per_dataset[dataset] += 1
            per_type[card_type] += 1
            if mem_id not in per_card:
                per_card[mem_id] = {
                    "card_id": mem_id,
                    "title": str(mem.get("title", "")),
                    "source_dataset": dataset,
                    "task_type": card_type,
                    "retrieval_count": 0,
                    "prompted_count": 0,
                    "associated_success_count": 0,
                    "associated_failure_count": 0,
                    "retry_success_count": 0,
                    "known_relevant_count": 0,
                    "estimated_helpfulness": 0.0,
                }
            per_card[mem_id]["retrieval_count"] += 1
            if mem.get("score", 0) > 0:
                per_card[mem_id]["prompted_count"] += 1
            if final_status is True:
                per_card[mem_id]["associated_success_count"] += 1
            elif final_status is False:
                per_card[mem_id]["associated_failure_count"] += 1
            if retry_used and final_status is True:
                per_card[mem_id]["retry_success_count"] += 1

    for mem_id, stats in per_card.items():
        total = stats["associated_success_count"] + stats["associated_failure_count"]
        if total > 0:
            stats["estimated_helpfulness"] = stats["associated_success_count"] / total

    return {
        "total_runs": total_runs,
        "runs_with_memory": memory_runs,
        "datasets_used": dict(per_dataset.most_common()),
        "card_types_used": dict(per_type.most_common()),
        "unique_cards_retrieved": len(per_card),
        "per_card_stats": sorted(
            per_card.values(),
            key=lambda x: x["retrieval_count"],
            reverse=True,
        ),
    }


def summarize_eval_runs(eval_runs_path: Path) -> dict[str, Any]:
    all_results: list[dict[str, Any]] = []

    if (
        eval_runs_path.is_dir()
        and (eval_runs_path / "evaluation_results.json").is_file()
    ):
        all_results.extend(load_run_results(eval_runs_path))
    elif eval_runs_path.is_dir():
        for child in sorted(eval_runs_path.iterdir()):
            if child.is_dir():
                all_results.extend(load_run_results(child))

    return collect_memory_stats(all_results)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Memory usefulness telemetry summarizer."
    )
    sub = parser.add_subparsers(dest="command")

    summarize = sub.add_parser(
        "summarize", help="Aggregate memory stats from eval runs."
    )
    summarize.add_argument(
        "--runs",
        required=True,
        help="Evaluation run directory (or parent containing multiple runs).",
    )
    summarize.add_argument(
        "--output",
        default="memory_store/memory_stats.json",
        help="Output stats JSON path.",
    )
    args = parser.parse_args(argv)

    if args.command == "summarize":
        runs_path = Path(args.runs).expanduser().resolve()
        if not runs_path.is_dir():
            print(f"Eval runs directory not found: {runs_path}")
            return 1
        stats = summarize_eval_runs(runs_path)

        output_path = Path(args.output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(stats, f, indent=2, ensure_ascii=False)

        print(f"Memory stats saved to {output_path}")
        print(f"Total runs: {stats['total_runs']}")
        print(f"Runs with memory: {stats['runs_with_memory']}")
        print(f"Unique cards retrieved: {stats['unique_cards_retrieved']}")
        print(f"Datasets: {json.dumps(stats['datasets_used'], indent=2)}")
        print(f"Card types: {json.dumps(stats['card_types_used'], indent=2)}")
    else:
        parser.print_help()
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
