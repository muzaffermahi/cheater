from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from .memory_schema import NormalizedRecord


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalized_title_hash(record: NormalizedRecord) -> str:
    return _sha256(record.problem_statement.strip().lower()[:200])


def _load_records(path: Path) -> list[NormalizedRecord]:
    records: list[NormalizedRecord] = []
    with path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
                records.append(NormalizedRecord.from_dict(value))
            except (json.JSONDecodeError, KeyError) as exc:
                print(f"Warning: skipping invalid record on line {line_number}: {exc}")
    return records


def _save_records(records: list[NormalizedRecord], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record.to_dict(), ensure_ascii=False) + "\n")


def deduplicate(
    records: list[NormalizedRecord],
) -> tuple[list[NormalizedRecord], dict[str, Any]]:
    seen_exact_provenance: set[tuple[str, str]] = set()
    seen_patch_sha256: dict[str, int] = {}
    seen_title_hash: dict[str, int] = {}
    seen_repo_instance: set[tuple[str, str]] = set()

    deduped: list[NormalizedRecord] = []
    removed: dict[str, list[str]] = {
        "exact_provenance": [],
        "patch_sha256": [],
        "title_approximate": [],
        "repo_instance_duplicate": [],
    }

    for record in records:
        repo = record.repo.strip().lower()
        instance_id = record.instance_id.strip().lower()
        issue_url = record.issue_url.strip().lower()
        pr_url = record.pr_url.strip().lower()
        commit_url = record.commit_url.strip().lower()

        provenance_key = (repo, instance_id)
        if provenance_key in seen_repo_instance:
            removed["repo_instance_duplicate"].append(record.normalized_id)
            continue

        exact_keys: list[tuple[str, str]] = []
        if repo and instance_id:
            exact_keys.append(("repo+instance_id", f"{repo}::{instance_id}"))
        if issue_url:
            exact_keys.append(("issue_url", issue_url))
        if pr_url:
            exact_keys.append(("pr_url", pr_url))
        if commit_url:
            exact_keys.append(("commit_url", commit_url))

        is_dup = False
        for kind, key in exact_keys:
            if key in seen_exact_provenance:
                removed["exact_provenance"].append(f"{record.normalized_id} ({kind})")
                is_dup = True
                break
        if is_dup:
            continue

        patch_hash = record.patch_sha256
        if patch_hash and patch_hash in seen_patch_sha256:
            removed["patch_sha256"].append(
                f"{record.normalized_id} (duplicate of {seen_patch_sha256[patch_hash]})"
            )
            continue

        title_hash = _normalized_title_hash(record)
        if title_hash in seen_title_hash:
            removed["title_approximate"].append(
                f"{record.normalized_id} (similar title to {seen_title_hash[title_hash]})"
            )
            continue

        seen_repo_instance.add(provenance_key)
        for _, key in exact_keys:
            seen_exact_provenance.add(key)
        if patch_hash:
            seen_patch_sha256[patch_hash] = len(deduped)
        seen_title_hash[title_hash] = len(deduped)
        deduped.append(record)

    removed_counts = {k: len(v) for k, v in removed.items()}
    report = {
        "total_input": len(records),
        "total_output": len(deduped),
        "total_removed": len(records) - len(deduped),
        "removed_counts": removed_counts,
        "removed_details": removed,
        "dedup_methods": [
            "exact_provenance: repo+instance_id, repo+issue_url, repo+pr_url, repo+commit_url",
            "patch_hash: patch_sha256, test_patch_sha256",
            "approximate: normalized title hash",
            "repo+instance_id unique set",
        ],
    }
    return deduped, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deduplicate normalized memory records."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Input normalized JSONL file.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output deduped JSONL file.",
    )
    parser.add_argument(
        "--report",
        default=None,
        help="Output dedup report JSON file.",
    )
    args = parser.parse_args(argv)

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.is_file():
        print(f"Input file not found: {input_path}")
        return 1

    records = _load_records(input_path)
    print(f"Loaded {len(records)} records from {input_path}")

    deduped, report = deduplicate(records)
    output_path = Path(args.output).expanduser().resolve()
    _save_records(deduped, output_path)

    print(f"Deduplicated: {len(records)} -> {len(deduped)} records")
    print(f"Removed: {report['total_removed']}")
    for method, count in report["removed_counts"].items():
        print(f"  {method}: {count}")

    if args.report:
        report_path = Path(args.report).expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report["source"] = str(input_path)
        report["output"] = str(output_path)
        report["timestamp"] = datetime.now().isoformat(timespec="seconds")
        with report_path.open("w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"Report saved to {report_path}")
    else:
        print(json.dumps(report, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
