"""Build canonical v1 memory cards from a raw source.

Streaming pipeline: reads source records one at a time, normalizes to v1,
validates, scores quality, detects duplicates, and writes JSONL incrementally.

Supports:
  --input <file>        JSONL file (compact, solved, or raw format)
  --hf-dataset <name>   HuggingFace dataset (e.g. nebius/SWE-agent-trajectories)
  --output <file>       output canonical JSONL
  --source <label>      source label written into manifest
  --limit N             stop after N input records
  --dry-run             do not write output; report only
  --resume              skip ids already present in --output
  --min-quality {junk,low,medium,high}
                        downrank usable cards below this tier; default low
  --full                explicit flag for "build the full serious corpus"

Writes a manifest with:
  schema_version, source, input path, output path,
  count_total, count_valid, count_usable, count_unusable,
  count_filtered, count_duplicates,
  created_at, build_command, quality summary.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from cheater import SCHEMA_VERSION
from cheater.cards import load_card_ids, read_jsonl
from cheater.quality import quality_tier, score_card
from cheater.schema import normalize_and_validate
from cheater.sources import (
    CompactCardSource, HFDatasetSource, SolvedCardSource,
)


# Mapping of quality tier names to minimum acceptable scores
TIER_MIN_SCORE = {"junk": 0.0, "low": 0.3, "medium": 0.5, "high": 0.75}


def _make_source(input_path: str, source_label: str) -> Iterator[dict]:
    """Pick a source adapter by sniffing the first record's fields."""
    p = Path(input_path)
    first = None
    for raw in read_jsonl(p):
        first = raw
        break
    if first is None:
        raise ValueError(f"Input file is empty: {p}")
    keys = set(first.keys())
    if {"title", "root_cause", "fix_pattern", "search_text"}.issubset(keys):
        src = CompactCardSource(input_path)
    elif {"issue", "error_excerpt", "patch_summary"}.issubset(keys):
        src = SolvedCardSource(input_path)
    else:
        raise ValueError(
            f"Unrecognized input format at {p}. Expected compact cards "
            "(title/root_cause/fix_pattern/search_text) or solved trajectory "
            "cards (issue/error_excerpt/patch_summary)."
        )
    return src.iter_records()


def _score_and_attach(card: dict[str, Any]) -> dict[str, Any]:
    """Run quality scoring on a normalized card and attach fields."""
    q = score_card(card)
    card["quality_score"] = q["score"]
    card["quality_reasons"] = q["reasons"]
    card["quality_tier"] = quality_tier(q["score"])
    return card


def write_manifest(manifest_path: Path, payload: dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build(
    input_path: str | None,
    output_path: str,
    *,
    source_label: str,
    limit: int | None,
    dry_run: bool,
    resume: bool,
    hf_dataset: str | None = None,
    min_quality: str = "low",
) -> dict:
    """Stream records, normalize, score, dedupe, write JSONL."""
    out = Path(output_path)
    existing_ids: set[str] = set()
    if resume and out.is_file():
        existing_ids = load_card_ids(out)

    min_score = TIER_MIN_SCORE[min_quality]

    if hf_dataset:
        src = HFDatasetSource(dataset_name=hf_dataset)
        records = src.iter_records()
        source_label = source_label or hf_dataset
        input_label = hf_dataset
    else:
        records = _make_source(input_path, source_label)
        input_label = input_path

    count_total = 0
    count_valid = 0
    count_usable = 0
    count_unusable = 0
    count_filtered = 0  # usable but below min_quality tier
    count_duplicate = 0
    skipped_existing = 0
    written = 0

    out.parent.mkdir(parents=True, exist_ok=True)
    handle = None if dry_run else out.open("a", encoding="utf-8")
    quality_buckets: dict[str, int] = {"high": 0, "medium": 0, "low": 0, "junk": 0}

    try:
        for raw in records:
            if limit is not None and count_total >= limit:
                break
            count_total += 1
            card, result = normalize_and_validate(raw)
            cid = card.get("id")

            if cid and cid in existing_ids:
                count_duplicate += 1
                skipped_existing += 1
                continue

            if not result.ok:
                count_unusable += 1
                _score_and_attach(card)
                quality_buckets[card["quality_tier"]] += 1
                if not dry_run and handle is not None:
                    handle.write(json.dumps(card, ensure_ascii=False) + "\n")
                written += 1
                continue

            count_valid += 1
            _score_and_attach(card)
            quality_buckets[card["quality_tier"]] += 1

            # Usable flag controls whether the card enters the default index
            if card.get("quality_score", 0) < min_score:
                card["usable"] = False
                count_filtered += 1
            if card.get("usable") is True:
                count_usable += 1
            else:
                count_unusable += 1

            if not dry_run and handle is not None:
                handle.write(json.dumps(card, ensure_ascii=False) + "\n")
                written += 1
                if written % 500 == 0:
                    handle.flush()
            if cid:
                existing_ids.add(cid)
    finally:
        if handle is not None:
            handle.flush()
            handle.close()

    manifest_path = out.parent / "manifest.v1.json"
    payload = {
        "schema_version": SCHEMA_VERSION,
        "source": source_label or (Path(input_label).name if input_label else "unknown"),
        "input_path": str(input_label),
        "output_path": str(output_path),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "build_command": " ".join(sys.argv),
        "min_quality_tier": min_quality,
        "min_quality_score": min_score,
        "count_total": count_total,
        "count_valid": count_valid,
        "count_usable": count_usable,
        "count_unusable": count_unusable,
        "count_filtered": count_filtered,
        "count_duplicates": count_duplicate,
        "count_skipped_existing": skipped_existing,
        "count_written": written,
        "quality_tiers": quality_buckets,
        "host": socket.gethostname(),
        "user": getpass.getuser() if hasattr(getpass, "getuser") else "unknown",
    }
    if not dry_run:
        write_manifest(manifest_path, payload)

    return {
        "input": input_label,
        "output": str(output_path),
        "dry_run": dry_run,
        "count_total": count_total,
        "count_valid": count_valid,
        "count_usable": count_usable,
        "count_unusable": count_unusable,
        "count_filtered": count_filtered,
        "count_duplicates": count_duplicate,
        "written": written,
        "manifest": str(manifest_path) if not dry_run else None,
        "quality_tiers": quality_buckets,
    }


def run(args: argparse.Namespace) -> int:
    if not args.hf_dataset and not args.input:
        sys.stderr.write("Error: either --input or --hf-dataset is required.\n")
        return 2
    if args.full:
        # --full is a documentation/expectation flag; equivalent to the default
        sys.stderr.write("Building full corpus (--full mode)...\n")
    result = build(
        args.input,
        args.output,
        source_label=args.source,
        limit=args.limit,
        dry_run=args.dry_run,
        resume=args.resume,
        hf_dataset=args.hf_dataset,
        min_quality=args.min_quality,
    )
    sys.stderr.write("=== build-cards ===\n")
    for k, v in result.items():
        if k == "quality_tiers":
            sys.stderr.write(f"  {k}: {v}\n")
        else:
            sys.stderr.write(f"  {k}: {v}\n")
    return 0
