from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


HEADERS = (
    "task id",
    "variant",
    "status",
    "test exit",
    "first failed",
    "retries",
    "memories",
    "files",
    "run folder",
)

PAIRINGS = (
    ("baseline_pi", "cheater_pi"),
    ("baseline_pi", "cheater_pi_retry"),
    ("baseline_qwen", "cheater_qwen"),
    ("baseline_qwen", "cheater_qwen_retry"),
)


def _variant_family(variant: str) -> str:
    """Return the agent arm independent of an explicit retrieval-strategy suffix."""
    return variant.split("__", 1)[0]


_TRIAL_SUFFIX = re.compile(r"__trial_(\d+)$")


def _variant_trial(variant: str) -> int | None:
    match = _TRIAL_SUFFIX.search(variant)
    return int(match.group(1)) if match else None


def _variant_configuration(variant: str) -> str:
    return _TRIAL_SUFFIX.sub("", variant)


def _with_trial(configuration: str, trial: int | None) -> str:
    return configuration if trial is None else f"{configuration}__trial_{trial:02d}"


def _wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float | None, float | None]:
    if total <= 0:
        return None, None
    rate = successes / total
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    margin = (
        z
        * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))
        / denominator
    )
    return max(0.0, center - margin), min(1.0, center + margin)


def _mcnemar_exact_p(improved: int, regressed: int) -> float | None:
    discordant = improved + regressed
    if discordant == 0:
        return None
    tail = sum(
        math.comb(discordant, index) for index in range(min(improved, regressed) + 1)
    ) / (2**discordant)
    return min(1.0, 2 * tail)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Compare local Cheater evaluation artifacts without treating dry, unknown, "
            "unavailable, or refused runs as passes or failures."
        )
    )
    parser.add_argument(
        "eval_run",
        nargs="+",
        help="One or more evaluation folders. Variant/task pairs must be unique.",
    )
    parser.add_argument(
        "--format",
        choices=("table", "json"),
        default="table",
        help="Console output format.",
    )
    parser.add_argument(
        "--no-write",
        action="store_true",
        help="Do not create or replace summary.json and summary.md.",
    )
    parser.add_argument(
        "--output",
        help=(
            "Directory for summary.json and summary.md. Defaults to the input folder "
            "for a single run; required when merging multiple runs unless --no-write."
        ),
    )
    parser.add_argument(
        "--pair-config",
        action="append",
        default=[],
        metavar="REFERENCE=CANDIDATE",
        help=(
            "Pair two exact configuration labels by task and trial. Repeat for multiple "
            "custom ablations. Configuration names are the variant labels without a "
            "__trial_NN suffix."
        ),
    )
    return parser


def load_results(eval_run: Path) -> list[dict[str, Any]]:
    if not eval_run.is_dir():
        raise ValueError(f"Evaluation run directory not found: {eval_run}")
    aggregate = eval_run / "evaluation_results.json"
    results: list[dict[str, Any]] = []
    if aggregate.is_file():
        try:
            value = json.loads(aggregate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"WARNING: invalid aggregate file {aggregate}: {exc}", file=sys.stderr)
        else:
            rows = value.get("results") if isinstance(value, dict) else None
            if isinstance(rows, list):
                results = [dict(item) for item in rows if isinstance(item, dict)]

    if not results:
        for path in eval_run.rglob("result.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                print(f"WARNING: skipping invalid result {path}: {exc}", file=sys.stderr)
                continue
            if not isinstance(value, dict):
                continue
            value.setdefault("run_folder", str(path.parent))
            results.append(value)
    results.sort(key=lambda item: (str(item.get("task_id")), str(item.get("variant"))))
    if not results:
        raise ValueError(f"No evaluation results found under: {eval_run}")
    return results


def load_results_many(eval_runs: list[Path]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: dict[tuple[str, str], Path] = {}
    for eval_run in eval_runs:
        for item in load_results(eval_run):
            key = (str(item.get("task_id") or ""), str(item.get("variant") or ""))
            if key in seen:
                raise ValueError(
                    "Duplicate task/variant result while merging: "
                    f"{key[0]}/{key[1]} appears in {seen[key]} and {eval_run}."
                )
            seen[key] = eval_run
            copied = dict(item)
            copied["source_eval_run"] = str(eval_run)
            merged.append(copied)
    merged.sort(key=lambda item: (str(item.get("task_id")), str(item.get("variant"))))
    return merged


def _display(value: Any) -> str:
    return "-" if value is None else str(value)


def result_rows(results: list[dict[str, Any]]) -> list[list[str]]:
    rows: list[list[str]] = []
    for item in results:
        memory_ids = item.get("retrieved_memory_ids")
        if not isinstance(memory_ids, list):
            memory_ids = item.get("memory_ids") if isinstance(item.get("memory_ids"), list) else []
        rows.append(
            [
                str(item.get("task_id") or ""),
                str(item.get("variant") or ""),
                str(item.get("solved_status") or "unknown"),
                _display(item.get("test_exit_code")),
                _display(item.get("first_attempt_failed")),
                str(item.get("retries_used") or 0),
                str(len(memory_ids)),
                str(item.get("changed_files_count") or 0),
                str(item.get("run_folder") or ""),
            ]
        )
    return rows


def format_table(headers: tuple[str, ...], rows: list[list[str]]) -> str:
    widths = [len(header) for header in headers]
    for row in rows:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))
    header_line = " | ".join(
        header.ljust(widths[index]) for index, header in enumerate(headers)
    )
    divider = "-+-".join("-" * width for width in widths)
    body = [
        " | ".join(value.ljust(widths[index]) for index, value in enumerate(row))
        for row in rows
    ]
    return "\n".join([header_line, divider, *body])


def markdown_table(headers: tuple[str, ...], rows: list[list[str]]) -> str:
    escaped_rows = [[value.replace("|", "\\|") for value in row] for row in rows]
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in escaped_rows)
    return "\n".join(lines)


def _variant_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    statuses: dict[str, int] = {}
    for item in items:
        status = str(item.get("solved_status") or "unknown")
        statuses[status] = statuses.get(status, 0) + 1
    definitive = [item for item in items if isinstance(item.get("solved"), bool)]
    solved = sum(item.get("solved") is True for item in definitive)
    lower, upper = _wilson_interval(solved, len(definitive))
    by_task: dict[str, list[bool]] = {}
    for item in definitive:
        by_task.setdefault(str(item.get("task_id") or ""), []).append(bool(item["solved"]))
    repeated = {task_id: values for task_id, values in by_task.items() if len(values) > 1}
    mixed = sorted(task_id for task_id, values in repeated.items() if len(set(values)) > 1)
    prompt_by_task: dict[str, list[str]] = {}
    for item in items:
        prompt_hash = item.get("initial_prompt_sha256")
        if isinstance(prompt_hash, str):
            prompt_by_task.setdefault(str(item.get("task_id") or ""), []).append(prompt_hash)
    repeated_prompts = {
        task_id: values for task_id, values in prompt_by_task.items() if len(values) > 1
    }
    mixed_prompts = sorted(
        task_id for task_id, values in repeated_prompts.items() if len(set(values)) > 1
    )
    prompt_sizes = [
        int(item["initial_prompt_bytes"])
        for item in items
        if isinstance(item.get("initial_prompt_bytes"), int)
    ]
    memory_counts = []
    qwen_metrics = [
        metrics
        for item in items
        for attempt in (item.get("attempts") or [])
        if isinstance(attempt, dict)
        and isinstance((metrics := attempt.get("qwen_event_metrics")), dict)
    ]
    for item in items:
        memory_ids = item.get("retrieved_memory_ids")
        if not isinstance(memory_ids, list):
            memory_ids = item.get("memory_ids") if isinstance(item.get("memory_ids"), list) else []
        memory_counts.append(len(memory_ids))
    return {
        "total": len(items),
        "definitive_test_outcomes": len(definitive),
        "solved": solved,
        "failed": sum(item.get("solved") is False for item in definitive),
        "unknown_or_not_run": len(items) - len(definitive),
        "solved_after_retry": sum(item.get("retry_solved") is True for item in items),
        "solve_rate": solved / len(definitive) if definitive else None,
        "wilson_95_low": lower,
        "wilson_95_high": upper,
        "distinct_trials": sorted(
            {trial for item in items if (trial := _variant_trial(str(item.get("variant") or ""))) is not None}
        ),
        "tasks_with_multiple_trials": len(repeated),
        "mixed_outcome_tasks": mixed,
        "tasks_with_multiple_prompt_hashes": len(repeated_prompts),
        "mixed_prompt_hash_tasks": mixed_prompts,
        "memory_injected_runs": sum(count > 0 for count in memory_counts),
        "retrieved_memory_count": sum(memory_counts),
        "average_memories_per_run": sum(memory_counts) / len(memory_counts) if memory_counts else 0.0,
        "average_prompt_bytes": sum(prompt_sizes) / len(prompt_sizes) if prompt_sizes else None,
        "minimum_prompt_bytes": min(prompt_sizes) if prompt_sizes else None,
        "maximum_prompt_bytes": max(prompt_sizes) if prompt_sizes else None,
        "cards_formats": sorted(
            {str(item.get("cards_format")) for item in items if item.get("cards_format")}
        ),
        "top_k_values": sorted(
            {int(item["top_k"]) for item in items if isinstance(item.get("top_k"), int)}
        ),
        "include_patch_values": sorted(
            {bool(item["include_patch"]) for item in items if isinstance(item.get("include_patch"), bool)}
        ),
        "qwen_attempts_with_metrics": len(qwen_metrics),
        "qwen_assistant_turns": sum(
            int(metrics.get("assistant_turns") or 0) for metrics in qwen_metrics
        ),
        "qwen_tool_events": sum(
            int(metrics.get("tool_events") or 0) for metrics in qwen_metrics
        ),
        "qwen_action_rescues": sum(
            int(metrics.get("action_rescues") or 0) for metrics in qwen_metrics
        ),
        "statuses": dict(sorted(statuses.items())),
    }


def _pairwise_summary(
    results: list[dict[str, Any]], baseline: str, candidate: str
) -> dict[str, Any]:
    by_key = {
        (str(item.get("task_id")), str(item.get("variant"))): item for item in results
    }
    task_ids = sorted({str(item.get("task_id")) for item in results})
    comparable = improved = regressed = same = 0
    prompt_hash_comparable = prompt_hash_identical = 0
    no_memory_prompt_mismatches: list[str] = []
    identical_prompt_outcome_divergences: list[str] = []
    no_intervention_outcome_divergences: list[str] = []
    missing_or_unknown: list[str] = []
    for task_id in task_ids:
        left = by_key.get((task_id, baseline))
        right = by_key.get((task_id, candidate))
        if not left or not right:
            missing_or_unknown.append(task_id)
            continue
        left_prompt = left.get("initial_prompt_sha256")
        right_prompt = right.get("initial_prompt_sha256")
        if isinstance(left_prompt, str) and isinstance(right_prompt, str):
            prompt_hash_comparable += 1
            if left_prompt == right_prompt:
                prompt_hash_identical += 1
            elif not (right.get("retrieved_memory_ids") or right.get("memory_ids")):
                no_memory_prompt_mismatches.append(task_id)
        if (
            not isinstance(left.get("solved"), bool)
            or not isinstance(right.get("solved"), bool)
        ):
            missing_or_unknown.append(task_id)
            continue
        comparable += 1
        if left_prompt == right_prompt and left["solved"] != right["solved"]:
            identical_prompt_outcome_divergences.append(task_id)
            candidate_memories = right.get("retrieved_memory_ids") or right.get("memory_ids")
            if not candidate_memories and not right.get("retry_solved"):
                no_intervention_outcome_divergences.append(task_id)
        if not left["solved"] and right["solved"]:
            improved += 1
        elif left["solved"] and not right["solved"]:
            regressed += 1
        else:
            same += 1
    return {
        "baseline": baseline,
        "candidate": candidate,
        "trial_index": _variant_trial(candidate) or _variant_trial(baseline),
        "comparable_tasks": comparable,
        "improved": improved,
        "regressed": regressed,
        "same": same,
        "prompt_hash_comparable": prompt_hash_comparable,
        "prompt_hash_identical": prompt_hash_identical,
        "no_memory_prompt_mismatches": no_memory_prompt_mismatches,
        "identical_prompt_outcome_divergences": identical_prompt_outcome_divergences,
        "no_intervention_outcome_divergences": no_intervention_outcome_divergences,
        "excluded_tasks": missing_or_unknown,
    }


def build_summary(
    eval_run: Path,
    results: list[dict[str, Any]],
    source_eval_runs: list[Path] | None = None,
    configuration_pairings: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    variants = sorted({str(item.get("variant") or "unknown") for item in results})
    configurations = sorted({_variant_configuration(variant) for variant in variants})
    task_ids = sorted({str(item.get("task_id") or "") for item in results})
    result_index = {
        (str(item.get("task_id") or ""), str(item.get("variant") or "unknown")): item
        for item in results
    }
    complete_ablation_tasks = [
        task_id
        for task_id in task_ids
        if all(
            isinstance(result_index.get((task_id, variant), {}).get("solved"), bool)
            for variant in variants
        )
    ]
    real_task_ids = {
        task_id
        for task_id in task_ids
        if all(
            str(item.get("task_kind") or "real") == "real"
            for item in results
            if str(item.get("task_id") or "") == task_id
        )
    }
    complete_real_ablation_tasks = [
        task_id for task_id in complete_ablation_tasks if task_id in real_task_ids
    ]
    variant_counts = {
        variant: _variant_summary(
            [item for item in results if str(item.get("variant") or "unknown") == variant]
        )
        for variant in variants
    }
    configuration_counts = {
        configuration: _variant_summary(
            [
                item
                for item in results
                if _variant_configuration(str(item.get("variant") or "unknown"))
                == configuration
            ]
        )
        for configuration in configurations
    }
    configuration_bug_type_counts: dict[str, dict[str, dict[str, Any]]] = {}
    for configuration in configurations:
        configuration_items = [
            item
            for item in results
            if _variant_configuration(str(item.get("variant") or "unknown"))
            == configuration
        ]
        bug_types = sorted(
            {str(item.get("bug_type") or "unclassified") for item in configuration_items}
        )
        configuration_bug_type_counts[configuration] = {
            bug_type: _variant_summary(
                [
                    item
                    for item in configuration_items
                    if str(item.get("bug_type") or "unclassified") == bug_type
                ]
            )
            for bug_type in bug_types
        }
    pairwise: list[dict[str, Any]] = []
    for baseline_family, candidate_family in PAIRINGS:
        baseline_configurations = sorted(
            {
                _variant_configuration(variant)
                for variant in variants
                if _variant_family(variant) == baseline_family
            }
        )
        candidate_configurations = sorted(
            {
                _variant_configuration(variant)
                for variant in variants
                if _variant_family(variant) == candidate_family
            }
        )
        if not baseline_configurations and not candidate_configurations:
            continue
        baseline_configurations = baseline_configurations or [baseline_family]
        candidate_configurations = candidate_configurations or [candidate_family]
        for baseline_configuration in baseline_configurations:
            for candidate_configuration in candidate_configurations:
                baseline_trials = {
                    _variant_trial(variant)
                    for variant in variants
                    if _variant_configuration(variant) == baseline_configuration
                }
                candidate_trials = {
                    _variant_trial(variant)
                    for variant in variants
                    if _variant_configuration(variant) == candidate_configuration
                }
                trials = sorted(
                    baseline_trials | candidate_trials,
                    key=lambda value: (-1 if value is None else value),
                )
                for trial in trials or [None]:
                    pairwise.append(
                        _pairwise_summary(
                            results,
                            _with_trial(baseline_configuration, trial),
                            _with_trial(candidate_configuration, trial),
                        )
                    )
    for baseline_configuration, candidate_configuration in configuration_pairings or []:
        if baseline_configuration not in configurations:
            raise ValueError(
                f"Custom reference configuration not found: {baseline_configuration}"
            )
        if candidate_configuration not in configurations:
            raise ValueError(
                f"Custom candidate configuration not found: {candidate_configuration}"
            )
        baseline_trials = {
            _variant_trial(variant)
            for variant in variants
            if _variant_configuration(variant) == baseline_configuration
        }
        candidate_trials = {
            _variant_trial(variant)
            for variant in variants
            if _variant_configuration(variant) == candidate_configuration
        }
        trials = sorted(
            baseline_trials | candidate_trials,
            key=lambda value: (-1 if value is None else value),
        )
        for trial in trials or [None]:
            comparison = _pairwise_summary(
                results,
                _with_trial(baseline_configuration, trial),
                _with_trial(candidate_configuration, trial),
            )
            if comparison not in pairwise:
                pairwise.append(comparison)
    aggregate_groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in pairwise:
        key = (
            _variant_configuration(str(item["baseline"])),
            _variant_configuration(str(item["candidate"])),
        )
        aggregate_groups.setdefault(key, []).append(item)
    pairwise_aggregate: list[dict[str, Any]] = []
    for (baseline, candidate), items in sorted(aggregate_groups.items()):
        comparable = sum(int(item["comparable_tasks"]) for item in items)
        improved = sum(int(item["improved"]) for item in items)
        regressed = sum(int(item["regressed"]) for item in items)
        pairwise_aggregate.append(
            {
                "baseline": baseline,
                "candidate": candidate,
                "trial_count": len(items),
                "comparable_task_trials": comparable,
                "improved": improved,
                "regressed": regressed,
                "same": sum(int(item["same"]) for item in items),
                "paired_delta": (improved - regressed) / comparable if comparable else None,
                "discordant": improved + regressed,
                "mcnemar_exact_p": _mcnemar_exact_p(improved, regressed),
                "prompt_hash_comparable": sum(int(item["prompt_hash_comparable"]) for item in items),
                "prompt_hash_identical": sum(int(item["prompt_hash_identical"]) for item in items),
                "no_memory_prompt_mismatches": [
                    {"trial_index": item.get("trial_index"), "task_id": task_id}
                    for item in items
                    for task_id in item["no_memory_prompt_mismatches"]
                ],
                "identical_prompt_outcome_divergences": [
                    {"trial_index": item.get("trial_index"), "task_id": task_id}
                    for item in items
                    for task_id in item["identical_prompt_outcome_divergences"]
                ],
                "no_intervention_outcome_divergences": [
                    {"trial_index": item.get("trial_index"), "task_id": task_id}
                    for item in items
                    for task_id in item["no_intervention_outcome_divergences"]
                ],
            }
        )
    return {
        "schema_version": 2,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "eval_run": str(eval_run),
        "source_eval_runs": [str(path) for path in (source_eval_runs or [eval_run])],
        "result_count": len(results),
        "unique_task_count": len(task_ids),
        "complete_ablation_task_count": len(complete_ablation_tasks),
        "complete_ablation_tasks": complete_ablation_tasks,
        "complete_real_ablation_task_count": len(complete_real_ablation_tasks),
        "complete_real_ablation_tasks": complete_real_ablation_tasks,
        "synthetic_or_nonreal_task_count": len(task_ids) - len(real_task_ids),
        "ten_task_local_eval_gate_met": len(complete_real_ablation_tasks) >= 10,
        "variant_counts": variant_counts,
        "configuration_counts": configuration_counts,
        "configuration_bug_type_counts": configuration_bug_type_counts,
        "requested_configuration_pairings": [
            {"reference": reference, "candidate": candidate}
            for reference, candidate in (configuration_pairings or [])
        ],
        "pairwise": pairwise,
        "pairwise_aggregate": pairwise_aggregate,
        "official_benchmark_score": None,
        "note": (
            "Counts are local test-command outcomes only. Unknown/unavailable/dry/refused "
            "runs are excluded from solved and failed counts."
        ),
        "results": results,
    }


def write_reports(
    eval_run: Path,
    results: list[dict[str, Any]],
    source_eval_runs: list[Path] | None = None,
    configuration_pairings: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    rows = result_rows(results)
    summary = build_summary(
        eval_run, results, source_eval_runs, configuration_pairings
    )
    (eval_run / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    count_lines = []
    for variant, counts in summary["variant_counts"].items():
        count_lines.append(
            f"- {variant}: {counts['solved']} solved, {counts['failed']} failed, "
            f"{counts['unknown_or_not_run']} unknown/not-run"
        )
    configuration_lines = []
    for configuration, counts in summary["configuration_counts"].items():
        rate = counts["solve_rate"]
        rate_text = f"{rate:.1%}" if rate is not None else "n/a"
        interval = (
            f"{counts['wilson_95_low']:.1%}-{counts['wilson_95_high']:.1%}"
            if counts["wilson_95_low"] is not None
            else "n/a"
        )
        configuration_lines.append(
            f"- {configuration}: {counts['solved']}/{counts['definitive_test_outcomes']} "
            f"solved ({rate_text}; Wilson 95% {interval}); "
            f"mixed repeated-task outcomes: {len(counts['mixed_outcome_tasks'])}; "
            f"prompt-drift tasks: {len(counts['mixed_prompt_hash_tasks'])}; "
            f"memory runs: {counts['memory_injected_runs']}/{counts['total']}; "
            f"avg prompt bytes: {counts['average_prompt_bytes'] if counts['average_prompt_bytes'] is not None else 'n/a'}"
        )
    pair_lines = []
    for item in summary["pairwise"]:
        pair_lines.append(
            f"- {item['baseline']} -> {item['candidate']}: {item['improved']} improved, "
            f"{item['regressed']} regressed, {item['same']} same "
            f"({item['comparable_tasks']} comparable); prompts identical for "
            f"{item['prompt_hash_identical']}/{item['prompt_hash_comparable']} hashed pairs; "
            f"{len(item['no_memory_prompt_mismatches'])} no-memory prompt mismatches; "
            f"{len(item['no_intervention_outcome_divergences'])} no-intervention outcome divergences"
        )
    aggregate_lines = []
    for item in summary["pairwise_aggregate"]:
        delta = (
            f"{item['paired_delta']:+.1%}" if item["paired_delta"] is not None else "n/a"
        )
        p_value = (
            f"{item['mcnemar_exact_p']:.4f}"
            if item["mcnemar_exact_p"] is not None
            else "n/a"
        )
        aggregate_lines.append(
            f"- {item['baseline']} -> {item['candidate']}: {item['improved']} improved, "
            f"{item['regressed']} regressed, {item['same']} same across "
            f"{item['comparable_task_trials']} paired task-trials; delta {delta}; "
            f"exact McNemar p={p_value}; no-intervention divergences "
            f"{len(item['no_intervention_outcome_divergences'])}"
        )
    bug_type_lines = []
    for configuration, counts_by_type in summary["configuration_bug_type_counts"].items():
        for bug_type, counts in counts_by_type.items():
            bug_type_lines.append(
                f"- {configuration} / {bug_type}: {counts['solved']}/"
                f"{counts['definitive_test_outcomes']} solved"
            )
    md = (
        "# Local evaluation summary\n\n"
        + markdown_table(HEADERS, rows)
        + "\n\n## Variant counts\n\n"
        + "\n".join(count_lines)
        + "\n\n## Configuration aggregates\n\n"
        + ("\n".join(configuration_lines) if configuration_lines else "No configurations.")
        + "\n\n## Pairwise ablations\n\n"
        + ("\n".join(pair_lines) if pair_lines else "No pairwise comparison available.")
        + "\n\n## Paired-trial aggregates\n\n"
        + ("\n".join(aggregate_lines) if aggregate_lines else "No paired comparison available.")
        + "\n\n## Bug-type stratification\n\n"
        + ("\n".join(bug_type_lines) if bug_type_lines else "No bug-type data available.")
        + "\n\n## Local task gate\n\n"
        + f"- Complete ablation tasks: {summary['complete_ablation_task_count']}\n"
        + f"- Complete real ablation tasks: {summary['complete_real_ablation_task_count']}\n"
        + f"- Ten-task gate met: {summary['ten_task_local_eval_gate_met']}\n"
        + "\n\nThis report contains local test-command outcomes, not an official benchmark score.\n"
    )
    (eval_run / "summary.md").write_text(md, encoding="utf-8")
    return summary


def _print_counts(summary: dict[str, Any]) -> None:
    for variant, counts in summary["variant_counts"].items():
        print(
            f"{variant}: {counts['solved']} solved / {counts['failed']} failed / "
            f"{counts['unknown_or_not_run']} unknown or not run"
        )
    for item in summary["pairwise"]:
        print(
            f"{item['baseline']} -> {item['candidate']}: "
            f"+{item['improved']} / -{item['regressed']} / ={item['same']} "
            f"across {item['comparable_tasks']} comparable tasks; prompts "
            f"{item['prompt_hash_identical']}/{item['prompt_hash_comparable']} identical"
        )
    for item in summary["pairwise_aggregate"]:
        print(
            f"aggregate {item['baseline']} -> {item['candidate']}: "
            f"+{item['improved']} / -{item['regressed']} / ={item['same']} across "
            f"{item['comparable_task_trials']} paired task-trials"
        )
    print(
        "Ten-task local eval gate:",
        "met" if summary["ten_task_local_eval_gate_met"] else "NOT MET",
        f"({summary['complete_real_ablation_task_count']} complete real tasks)",
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    eval_runs = [Path(value).expanduser().resolve() for value in args.eval_run]
    if args.output:
        report_root = Path(args.output).expanduser().resolve()
    elif len(eval_runs) == 1:
        report_root = eval_runs[0]
    elif args.no_write:
        report_root = Path.cwd().resolve()
    else:
        print(
            "Comparison stopped: --output is required when merging multiple runs.",
            file=sys.stderr,
        )
        return 2
    try:
        results = load_results_many(eval_runs)
    except ValueError as exc:
        print("Comparison stopped:", exc, file=sys.stderr)
        return 2
    configuration_pairings: list[tuple[str, str]] = []
    for value in args.pair_config:
        reference, separator, candidate = value.partition("=")
        if not separator or not reference.strip() or not candidate.strip():
            print(
                "Comparison stopped: --pair-config requires REFERENCE=CANDIDATE.",
                file=sys.stderr,
            )
            return 2
        configuration_pairings.append((reference.strip(), candidate.strip()))
    try:
        summary = build_summary(
            report_root, results, eval_runs, configuration_pairings
        )
    except ValueError as exc:
        print("Comparison stopped:", exc, file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    else:
        print(format_table(HEADERS, result_rows(results)))
        print()
        _print_counts(summary)
    if not args.no_write:
        report_root.mkdir(parents=True, exist_ok=True)
        write_reports(report_root, results, eval_runs, configuration_pairings)
        print("Wrote:", report_root / "summary.json")
        print("Wrote:", report_root / "summary.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
