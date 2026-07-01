from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from .memory_schema import (
    MemoryCard,
    NormalizedRecord,
    make_card_id,
    compute_provenance_hash,
)


def _extract_title(record: NormalizedRecord) -> str:
    problem = record.problem_statement.strip()
    if not problem:
        return f"{record.repo}: {record.instance_id}"
    lines = problem.split("\n")
    for line in lines:
        line = line.strip()
        if line.startswith("#"):
            return line.lstrip("#").strip()
        if line.startswith("##"):
            return line.lstrip("#").strip()
        if len(line) > 20 and len(line) < 200:
            return line
    first_line = lines[0] if lines else problem
    if len(first_line) > 200:
        return first_line[:197] + "..."
    return first_line


def _extract_symptoms(record: NormalizedRecord) -> str:
    parts: list[str] = []
    if record.problem_statement:
        extracted = record.problem_statement.strip()
        if len(extracted) > 500:
            extracted = extracted[:497] + "..."
        parts.append(extracted)
    return "\n".join(parts)


def _extract_error_signature(record: NormalizedRecord) -> str:
    problem = record.problem_statement
    tokens: list[str] = []
    patterns = [
        r"(?i)(error|exception|traceback|fail|assert)\s*[:\s].*",
        r"(?i)(TypeError|ValueError|KeyError|IndexError|AttributeError|"
        r"ImportError|ModuleNotFoundError|OSError|RuntimeError|"
        r"AssertionError|NotImplementedError|StopIteration|"
        r"RecursionError|PermissionError|FileNotFoundError)\w*",
        r"(?i)raise\s+\w+",
    ]
    for pattern in patterns:
        matches = re.findall(pattern, problem)
        tokens.extend(m.strip() for m in matches if m.strip())
    for ft in record.fail_to_pass:
        if ":" in ft:
            tokens.append(ft.split(":")[-1].strip())
    return "; ".join(dict.fromkeys(tokens))[:300]


def _extract_changed_files(record: NormalizedRecord) -> list[str]:
    if record.changed_files:
        return record.changed_files
    return _extract_changed_files_from_patch(record.patch)


def _extract_changed_files_from_patch(patch: str) -> list[str]:
    files: list[str] = []
    for line in patch.split("\n"):
        if line.startswith("+++ b/") or line.startswith("--- a/"):
            path = line[6:].strip()
            if path and path not in files:
                files.append(path)
    return files


def _extract_changed_symbols(patch: str) -> list[str]:
    symbols: list[str] = []
    for line in patch.split("\n"):
        if line.startswith("@@"):
            match = re.search(r"\+(\d+)(?:,\d+)?\s+(?:@@\s+)?(.*?)(?:\s+@@)?$", line)
            if match:
                context = match.group(2).strip()
                if context:
                    func_match = re.search(
                        r"(?:def |class |fn |func |function )(\w+)", context
                    )
                    if func_match:
                        symbols.append(func_match.group(1))
    return list(dict.fromkeys(symbols))


def _extract_failing_tests(record: NormalizedRecord) -> list[str]:
    tests: list[str] = []
    for ft in record.fail_to_pass:
        if ft.strip():
            tests.append(ft.strip())
    return tests


def _extract_fix_pattern_summary(record: NormalizedRecord) -> str:
    patch = record.patch
    if not patch.strip():
        return "No patch available."
    summary_parts: list[str] = []
    changed = _extract_changed_files_from_patch(patch)
    if changed:
        summary_parts.append(f"Changed files: {', '.join(changed)}")
    add_count = patch.count("\n+") - patch.count("\n+++")
    remove_count = patch.count("\n-") - patch.count("\n---")
    summary_parts.append(f"+{add_count} -{remove_count} lines")
    symbols = _extract_changed_symbols(patch)
    if symbols:
        summary_parts.append(f"Affected symbols: {', '.join(symbols[:10])}")
    return "; ".join(summary_parts)


def _extract_root_cause_summary(record: NormalizedRecord) -> str:
    if record.problem_statement:
        return "Extract root cause from problem statement (LLM-free placeholder)."
    return "No problem statement available."


def _compute_quality_score(record: NormalizedRecord) -> float:
    score = 0.0
    if record.problem_statement.strip():
        score += 2.0
    if record.patch.strip():
        score += 2.0
    if record.test_patch.strip():
        score += 1.0
    if record.fail_to_pass:
        score += 1.5
    changed = _extract_changed_files(record)
    if changed:
        score += 1.0
    patch_lines = record.patch.strip().split("\n")
    if 3 < len(patch_lines) < 500:
        score += 0.5
    if len(patch_lines) > 1000:
        score -= 1.0
    if not record.problem_statement.strip():
        score -= 1.0
    if not record.fail_to_pass:
        score -= 0.5
    return max(0.0, min(10.0, score))


def _classify_task_type(record: NormalizedRecord) -> str:
    problem = record.problem_statement.lower()
    patch = record.patch.lower()

    crash_patterns = [
        r"(?i)(crash|segfault|panic|stack overflow|null pointer|"
        r"dereference|segmentation fault|abort|unhandled)",
    ]
    for pat in crash_patterns:
        if re.search(pat, problem):
            return "crash"

    regression_patterns = [
        r"(?i)(regression|used to work|stopped working|"
        r"was working|broke|broken|introduced in|after upgrade)",
    ]
    for pat in regression_patterns:
        if re.search(pat, problem):
            return "regression"

    incorrect_patterns = [
        r"(?i)(incorrect|wrong|unexpected|erroneous|improper|"
        r"invalid output|wrong result|miscalculat|miscomput)",
    ]
    for pat in incorrect_patterns:
        if re.search(pat, problem):
            return "incorrect_behavior"

    feature_patterns = [
        r"(?i)(feature|enhancement|add|implement|new|support for|"
        r"introduce|request|proposal|suggest)",
    ]
    for pat in feature_patterns:
        if re.search(pat, problem):
            return "feature_or_enhancement"

    refactor_patterns = [
        r"(?i)(refactor|clean up|restructure|reorganize|"
        r"simplify|deduplicate|extract|inline|rename|move)",
    ]
    for pat in refactor_patterns:
        if re.search(pat, problem):
            return "refactor"

    if (
        record.fail_to_pass
        or "bug" in problem
        or "fix" in problem
        or "error" in problem
    ):
        return "bug_fix"

    if record.changed_files or record.patch.strip():
        return "bug_fix"

    return "unknown"


def _build_bm25_text(card: MemoryCard) -> str:
    fields = [
        card.title,
        card.symptoms,
        card.error_signature,
        card.root_cause_summary,
        card.fix_pattern_summary,
        card.language,
        card.source_repo,
    ]
    text = " ".join(str(f) for f in fields if f)
    return text[:2000]


def _build_dense_text(card: MemoryCard) -> str:
    fields = [
        card.title,
        card.error_signature,
        card.symptoms[:500],
        card.root_cause_summary[:300],
        card.fix_pattern_summary[:300],
    ]
    text = " ".join(str(f) for f in fields if f)
    return text[:1000]


def build_card(record: NormalizedRecord) -> MemoryCard:
    card_id = make_card_id(record.normalized_id)
    title = _extract_title(record)
    task_type = _classify_task_type(record)
    changed_files = _extract_changed_files(record)
    changed_symbols = _extract_changed_symbols(record.patch)
    failing_tests = _extract_failing_tests(record)
    quality_score = _compute_quality_score(record)
    card = MemoryCard(
        card_id=card_id,
        source_normalized_id=record.normalized_id,
        source_dataset=record.source_dataset,
        source_instance_id=record.instance_id,
        source_repo=record.repo,
        source_base_commit=record.base_commit,
        source_issue_url=record.issue_url,
        source_pr_url=record.pr_url,
        source_commit_url=record.commit_url,
        source_license_dataset=record.dataset_license,
        source_license_repo=record.repo_license,
        task_type=task_type,
        language=record.language,
        title=title,
        symptoms=_extract_symptoms(record),
        error_signature=_extract_error_signature(record),
        root_cause_summary=_extract_root_cause_summary(record),
        fix_pattern_summary=_extract_fix_pattern_summary(record),
        changed_files=changed_files,
        changed_symbols=list(dict.fromkeys(changed_symbols)),
        failing_tests=failing_tests,
        passing_tests_guard=record.pass_to_pass,
        card_text_bm25="",
        card_text_dense="",
        patch=record.patch,
        test_patch=record.test_patch,
        provenance_hash=compute_provenance_hash(record.to_dict()),
        contamination_scope=record.contamination_scope,
        human_review_status="unreviewed",
        quality_score=quality_score,
        created_at=datetime.now().isoformat(timespec="seconds"),
    )
    card.card_text_bm25 = _build_bm25_text(card)
    card.card_text_dense = _build_dense_text(card)
    return card


def _card_should_be_enabled(card: MemoryCard) -> bool:
    disabled_types = {
        "feature_or_enhancement",
        "refactor",
        "localization_only",
        "unknown",
    }
    if card.task_type in disabled_types:
        return card.quality_score >= 5.0
    if card.quality_score < 1.0:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build memory cards from normalized records."
    )
    parser.add_argument(
        "--input", required=True, help="Input normalized/deduped JSONL file."
    )
    parser.add_argument(
        "--output", default="memory_store/cards.jsonl", help="Output cards JSONL file."
    )
    parser.add_argument(
        "--min-quality",
        type=float,
        default=0.0,
        help="Minimum quality score to include (default: 0 = all).",
    )
    parser.add_argument(
        "--type-filter",
        choices=("all", "bug_only"),
        default="all",
        help="Filter by task type. bug_only excludes feature/refactor/localization (default: all).",
    )
    parser.add_argument(
        "--quarantine-status",
        choices=("exclude_quarantined", "include_all"),
        default="exclude_quarantined",
        help="Whether to exclude quarantined records (default: exclude_quarantined).",
    )
    args = parser.parse_args(argv)

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.is_file():
        print(f"Input file not found: {input_path}")
        return 1

    records: list[NormalizedRecord] = []
    with input_path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
                records.append(NormalizedRecord.from_dict(value))
            except (json.JSONDecodeError, KeyError) as exc:
                print(f"Warning: skipping invalid record on line {line_number}: {exc}")

    print(f"Loaded {len(records)} normalized records.")

    cards: list[MemoryCard] = []
    skipped_reasons: dict[str, int] = {}
    for record in records:
        if args.quarantine_status == "exclude_quarantined":
            if record.quarantine_status != "none":
                skipped_reasons["quarantined"] = (
                    skipped_reasons.get("quarantined", 0) + 1
                )
                continue
            if record.contamination_scope == "swe_bench_official":
                skipped_reasons["benchmark_holdout"] = (
                    skipped_reasons.get("benchmark_holdout", 0) + 1
                )
                continue

        card = build_card(record)

        if card.quality_score < args.min_quality:
            skipped_reasons["low_quality"] = skipped_reasons.get("low_quality", 0) + 1
            continue

        if args.type_filter == "bug_only" and not _card_should_be_enabled(card):
            skipped_reasons[f"type_{card.task_type}"] = (
                skipped_reasons.get(f"type_{card.task_type}", 0) + 1
            )
            continue

        cards.append(card)

    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        for card in cards:
            f.write(json.dumps(card.to_dict(), ensure_ascii=False) + "\n")

    print(f"\nGenerated {len(cards)} cards -> {output_path}")
    print(f"Skipped count by reason:")
    for reason, count in sorted(skipped_reasons.items()):
        print(f"  {reason}: {count}")

    bug_types: dict[str, int] = {}
    for card in cards:
        bug_types[card.task_type] = bug_types.get(card.task_type, 0) + 1
    print(f"\nTask type distribution:")
    for ttype, count in sorted(bug_types.items(), key=lambda x: -x[1]):
        enabled = (
            "enabled"
            if _card_should_be_enabled(next(c for c in cards if c.task_type == ttype))
            else "disabled"
            if cards
            else "n/a"
        )
        print(f"  {ttype}: {count} ({enabled})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
