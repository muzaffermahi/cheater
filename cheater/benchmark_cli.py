"""benchmark CLI command."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cheater.benchmark import (
    evaluate, evaluate_compare, format_compare, format_summary, read_benchmark,
)
from cheater.retrieval import BM25FIndex, load_index_cards


def _maybe_load_compact(path: str | None) -> list[dict[str, Any]] | None:
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        sys.stderr.write(f"Compact corpus not found: {p}\n")
        return None
    cards = load_index_cards(p)
    sys.stderr.write(f"Loaded {len(cards)} compact cards from {p}\n")
    return cards


def run(args: argparse.Namespace) -> int:
    cases = read_benchmark(args.benchmark)
    sys.stderr.write(f"Loaded {len(cases)} benchmark cases\n")
    cards = load_index_cards(Path(args.cards))
    sys.stderr.write(f"Loaded {len(cards)} usable cards from {args.cards}\n")
    if not cards:
        sys.stderr.write("No usable cards. Run `cheater build-cards` first.\n")
        return 1

    compact_cards = _maybe_load_compact(getattr(args, "compact_cards", None))

    if getattr(args, "compare", False):
        results = evaluate_compare(
            cases, cards, compact_cards=compact_cards, top_k=args.top_k,
        )
        text = format_compare(results)
        if args.json:
            # strip per_case from comparison output to keep it compact
            compact = [{k: v for k, v in r.items() if k != "per_case"} for r in results]
            print(json.dumps(compact, ensure_ascii=False, indent=2))
        else:
            sys.stderr.write(text + "\n")
        return 0

    # Single-config run
    idx = BM25FIndex(cards)
    summary = evaluate(
        cases,
        lambda q, k: idx.search(
            q, top_k=k,
            language=getattr(args, "language", None),
            quality_min=getattr(args, "quality_min", 0.0),
        ),
        args.top_k,
        label=f"BM25F top_k={args.top_k}",
    )
    if args.json:
        out = {k: v for k, v in summary.items() if k != "per_case"}
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        sys.stderr.write(format_summary(summary) + "\n")

    # Also report missed cases (where the expected card wasn't found)
    misses = [pc for pc in summary["per_case"] if not pc["hit"]]
    if misses and not args.json:
        sys.stderr.write(f"\n  Missed cases: {len(misses)}\n")
        for m in misses[:5]:
            tid = m.get("id", "?")
            tw = m.get("top_wrong") or {}
            sys.stderr.write(
                f"    {tid} (rank=None)  top_wrong={tw.get('id', '?')} score={tw.get('score', 0):.3f}\n"
            )
    return 0
