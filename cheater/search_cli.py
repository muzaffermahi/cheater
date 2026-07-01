"""search CLI command."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cheater.retrieval import BM25FIndex, format_result, load_index_cards


def _load_cards(path: str) -> list[dict[str, Any]]:
    p = Path(path)
    if not p.is_file():
        sys.stderr.write(f"Card file not found: {p}\n")
        return []
    return load_index_cards(p)


def run(args: argparse.Namespace) -> int:
    path = Path(args.cards)
    cards = _load_cards(path)
    sys.stderr.write(f"Loaded {len(cards)} usable cards from {path}\n")
    if not cards:
        return 0

    # Compact-first fallback: if --compact-cards is provided AND the query
    # has results there, prefer those. Otherwise use --cards.
    use_compact = bool(getattr(args, "compact_cards", None))
    compact_cards: list[dict[str, Any]] = []
    if use_compact:
        compact_cards = _load_cards(Path(args.compact_cards))
        sys.stderr.write(f"Loaded {len(compact_cards)} compact cards from {args.compact_cards}\n")

    # Build the primary index
    idx = BM25FIndex(cards)

    # Search
    results = idx.search(
        args.query,
        top_k=args.top_k,
        language=getattr(args, "language", None),
        repo=getattr(args, "repo", None),
        bug_type=getattr(args, "bug_type", None),
        quality_min=getattr(args, "quality_min", 0.0),
        mmr_lambda=getattr(args, "mmr", 0.0),
    )

    # Compact-first: if we have compact cards, search them too and prefer
    if use_compact and compact_cards:
        compact_idx = BM25FIndex(compact_cards)
        compact_results = compact_idx.search(
            args.query,
            top_k=args.top_k,
            language=getattr(args, "language", None),
            repo=getattr(args, "repo", None),
            bug_type=getattr(args, "bug_type", None),
            quality_min=getattr(args, "quality_min", 0.0),
        )
        # Merge: prefer compact results that are also in full results
        full_ids = {c.get("id"): (s, c) for s, c in results}
        merged: list[tuple[float, dict[str, Any]]] = []
        seen_ids: set[str] = set()
        # First: compact results that also appear in full corpus
        for s, c in compact_results:
            cid = c.get("id")
            if cid in full_ids and cid not in seen_ids:
                # Boost slightly: compact cards are cleaner
                merged.append((s * 1.1, c))
                seen_ids.add(cid)
        # Then: remaining full results
        for s, c in results:
            if c.get("id") not in seen_ids:
                merged.append((s, c))
                seen_ids.add(c.get("id"))
        # Then: remaining compact-only results
        for s, c in compact_results:
            if c.get("id") not in seen_ids:
                merged.append((s * 0.9, c))  # slight penalty for compact-only
                seen_ids.add(c.get("id"))
        merged.sort(key=lambda x: x[0], reverse=True)
        results = merged[:args.top_k]

    if not results:
        print("No matches.")
        return 0

    sys.stderr.write(f"Query: {args.query}\n")
    if getattr(args, "language", None):
        sys.stderr.write(f"  language filter: {args.language}\n")
    if getattr(args, "repo", None):
        sys.stderr.write(f"  repo filter: {args.repo}\n")

    if getattr(args, "json", False):
        out = []
        for rank, (score, card) in enumerate(results, start=1):
            out.append({
                "rank": rank,
                "score": score,
                "id": card.get("id"),
                "repo": card.get("repo"),
                "language": card.get("language"),
                "bug_type": card.get("bug_type"),
                "quality_score": card.get("quality_score"),
                "quality_tier": card.get("quality_tier"),
                "symptom": (card.get("symptom") or "")[:200],
                "fix_pattern": (card.get("fix_pattern") or "")[:200],
                "search_keywords": card.get("search_keywords") or [],
            })
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        for rank, (score, card) in enumerate(results, start=1):
            print(format_result(card, rank, score))
    return 0
