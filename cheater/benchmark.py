"""Retrieval-quality benchmark with compare mode and per-difficulty metrics.

Public API:
  evaluate(cases, index, top_k=...)           -- core metrics
  evaluate_compare(cases, cards, options)     -- compare multiple configurations
  format_summary(summary)                      -- human-readable text
  format_compare(results)                      -- comparison table

Metrics:
  recall@1, recall@3, recall@5, recall@10
  MRR
  nDCG@5
  per-difficulty (easy/medium/hard) metrics
  per-language metrics
  missed cases with top wrong result
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

from cheater.cards import CardError, read_jsonl


def read_benchmark(path: str | Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    p = Path(path)
    if not p.is_file():
        raise CardError(f"Benchmark file not found: {p}")
    for line_no, raw in enumerate(read_jsonl(p), start=1):
        if "query" not in raw or "expected_card_ids" not in raw:
            raise CardError(f"{p}:{line_no}: benchmark item needs 'query' and 'expected_card_ids'")
        cases.append(raw)
    return cases


def _dcg_at_k(relevances: list[int], k: int) -> float:
    """DCG@k: sum of rel_i / log2(i+2) for i in 0..k-1."""
    s = 0.0
    for i, r in enumerate(relevances[:k]):
        s += r / math.log2(i + 2)
    return s


def _ndcg_at_k(relevances: list[int], k: int) -> float:
    """nDCG@k with ideal DCG computed from sorted relevances."""
    dcg = _dcg_at_k(relevances, k)
    ideal = sorted(relevances, reverse=True)
    idcg = _dcg_at_k(ideal, k)
    if idcg == 0:
        return 0.0
    return dcg / idcg


def evaluate(
    cases: list[dict[str, Any]],
    search_fn: Callable[[str, int], list[tuple[float, dict[str, Any]]]],
    top_k: int = 5,
    *,
    label: str = "",
) -> dict[str, Any]:
    """Evaluate a single search configuration.

    search_fn(query, top_k) -> list of (score, card) tuples.
    search_fn may also be a BM25FIndex (back-compat with existing tests).
    """
    # Back-compat: accept a BM25FIndex directly
    if hasattr(search_fn, "search") and not callable(getattr(search_fn, "search", None)):
        pass
    if not callable(search_fn):
        # It's an index, not a function. Wrap it.
        idx = search_fn
        def search_fn(query, top_k):
            return idx.search(query, top_k=top_k)
    k_values = (1, 3, 5, 10)
    recall_hits: dict[int, int] = {k: 0 for k in k_values}
    mrr_sum = 0.0
    ndcg5_sum = 0.0
    no_hit = 0
    per_case: list[dict[str, Any]] = []
    # per-difficulty and per-language accumulators
    diff_buckets: dict[str, dict[str, float]] = defaultdict(
        lambda: {"hits1": 0, "hits5": 0, "mrr": 0.0, "count": 0}
    )
    lang_buckets: dict[str, dict[str, float]] = defaultdict(
        lambda: {"hits1": 0, "hits5": 0, "mrr": 0.0, "count": 0}
    )

    for case in cases:
        query = case["query"]
        expected = set(case.get("expected_card_ids") or [])
        results = search_fn(query, max(top_k, max(k_values)))
        result_ids = [str(c.get("id")) for _, c in results]

        # relevances: 1 if id is expected, 0 otherwise
        relevances = [1 if rid in expected else 0 for rid in result_ids]

        first_rank = None
        for rank, rid in enumerate(result_ids, start=1):
            if rid in expected:
                first_rank = rank
                break

        for k in k_values:
            if any(rid in expected for rid in result_ids[:k]):
                recall_hits[k] += 1

        if first_rank is None:
            no_hit += 1
        else:
            mrr_sum += 1.0 / first_rank

        ndcg5_sum += _ndcg_at_k(relevances, 5)

        diff = case.get("difficulty", "unknown")
        lang = case.get("language") or "unknown"
        diff_buckets[diff]["count"] += 1
        lang_buckets[lang]["count"] += 1
        if first_rank is not None and first_rank <= 1:
            diff_buckets[diff]["hits1"] += 1
            lang_buckets[lang]["hits1"] += 1
        if first_rank is not None and first_rank <= 5:
            diff_buckets[diff]["hits5"] += 1
            lang_buckets[lang]["hits5"] += 1
        if first_rank is not None:
            diff_buckets[diff]["mrr"] += 1.0 / first_rank
            lang_buckets[lang]["mrr"] += 1.0 / first_rank

        # Find top wrong result for misses
        top_wrong = None
        if first_rank is None and results:
            top_wrong = {
                "rank": 1,
                "id": result_ids[0],
                "score": results[0][0],
            }
        per_case.append({
            "id": case.get("id"),
            "difficulty": diff,
            "language": lang,
            "hit": first_rank is not None,
            "rank": first_rank,
            "top_wrong": top_wrong,
        })

    n = max(1, len(cases))
    # Per-difficulty stats
    by_difficulty = {}
    for d, b in diff_buckets.items():
        c = max(1, b["count"])
        by_difficulty[d] = {
            "count": b["count"],
            "recall_at_1": round(b["hits1"] / c, 4),
            "recall_at_5": round(b["hits5"] / c, 4),
            "mrr": round(b["mrr"] / c, 4),
        }
    by_language = {}
    for l, b in lang_buckets.items():
        c = max(1, b["count"])
        by_language[l] = {
            "count": b["count"],
            "recall_at_1": round(b["hits1"] / c, 4),
            "recall_at_5": round(b["hits5"] / c, 4),
            "mrr": round(b["mrr"] / c, 4),
        }

    return {
        "label": label,
        "cases": len(cases),
        "no_hit": no_hit,
        "recall_at_1": round(recall_hits[1] / n, 4),
        "recall_at_3": round(recall_hits[3] / n, 4),
        "recall_at_5": round(recall_hits[5] / n, 4),
        "recall_at_10": round(recall_hits[10] / n, 4),
        "mrr": round(mrr_sum / n, 4),
        "ndcg_at_5": round(ndcg5_sum / n, 4),
        "by_difficulty": by_difficulty,
        "by_language": by_language,
        "per_case": per_case,
    }


def evaluate_compare(
    cases: list[dict[str, Any]],
    cards: list[dict[str, Any]],
    compact_cards: list[dict[str, Any]] | None = None,
    *,
    top_k: int = 5,
) -> list[dict[str, Any]]:
    """Run multiple retrieval configurations and return a comparison table.

    Configurations tested:
      1. lexical_baseline     -- BM25F only
      2. lexical_quality      -- BM25F + quality filter (quality_min=0.3)
      3. lexical_full         -- BM25F over all usable cards (same as baseline)
      4. compact_only         -- search only compact corpus (if provided)
      5. compact_first        -- merge: compact results rank higher when both match
    """
    from cheater.retrieval import BM25FIndex

    results: list[dict[str, Any]] = []
    queries = [c["query"] for c in cases]

    def make_search_fn(idx, **opts):
        def fn(query, top_k):
            return idx.search(query, top_k=top_k, **opts)
        return fn

    # 1. Lexical baseline (no quality filter)
    idx_all = BM25FIndex(cards)
    r = evaluate(cases, make_search_fn(idx_all), top_k, label="lexical_baseline")
    r["notes"] = "BM25F on all usable cards, no quality filter"
    results.append(r)

    # 2. Lexical with quality filter
    r = evaluate(
        cases,
        lambda q, k: idx_all.search(q, top_k=k, quality_min=0.3),
        top_k,
        label="lexical_quality",
    )
    r["notes"] = "BM25F + quality_min=0.3 filter"
    results.append(r)

    # 3. BM25F weighted fields (same as 1 but with different boost config)
    custom_boosts = {
        "embedding_text": 1.5,
        "symptom": 2.5,
        "search_keywords": 2.0,
        "root_cause": 1.8,
        "fix_pattern": 1.8,
        "bug_type": 1.0,
        "language": 0.6,
        "key_files": 0.6,
    }
    idx_weighted = BM25FIndex(cards, field_boosts=custom_boosts)
    r = evaluate(cases, make_search_fn(idx_weighted), top_k, label="bm25f_symptom_heavy")
    r["notes"] = "BM25F with symptom/keywords/root_cause/fix_pattern boosted"
    results.append(r)

    # 4. Compact-only (if available)
    if compact_cards:
        idx_compact = BM25FIndex(compact_cards)
        r = evaluate(cases, make_search_fn(idx_compact), top_k, label="compact_only")
        r["notes"] = f"BM25F on compact corpus only ({len(compact_cards)} cards)"
        results.append(r)

        # 5. Compact-first: compact cards outrank full cards with equal score
        def compact_first_search(query, k):
            # Get top-k from each
            compact_results = idx_compact.search(query, top_k=k)
            full_results = idx_all.search(query, top_k=k)
            # Merge by id, compact wins ties
            seen = set()
            merged = []
            for s, c in compact_results:
                cid = c.get("id")
                if cid and cid not in seen:
                    merged.append((s * 1.05, c))
                    seen.add(cid)
            for s, c in full_results:
                cid = c.get("id")
                if cid and cid not in seen:
                    merged.append((s, c))
                    seen.add(cid)
            merged.sort(key=lambda x: x[0], reverse=True)
            return merged[:k]
        r = evaluate(cases, compact_first_search, top_k, label="compact_first")
        r["notes"] = "Compact cards boosted 5% over full corpus"
        results.append(r)

    return results


def format_summary(s: dict[str, Any]) -> str:
    lines = [
        "",
        "=" * 60,
        f"  {s.get('label', 'benchmark')}",
        "=" * 60,
        f"  cases:       {s['cases']}",
        f"  no-hit:      {s['no_hit']}",
        f"  recall@1:    {s['recall_at_1']}",
        f"  recall@3:    {s['recall_at_3']}",
        f"  recall@5:    {s['recall_at_5']}",
        f"  recall@10:   {s['recall_at_10']}",
        f"  MRR:         {s['mrr']}",
        f"  nDCG@5:      {s['ndcg_at_5']}",
    ]
    if s.get("by_difficulty"):
        lines.append("  by difficulty:")
        for d, m in s["by_difficulty"].items():
            lines.append(f"    {d:10s} n={m['count']:3d}  R@1={m['recall_at_1']:.3f}  R@5={m['recall_at_5']:.3f}  MRR={m['mrr']:.3f}")
    if s.get("by_language"):
        lines.append("  by language:")
        for l, m in s["by_language"].items():
            lines.append(f"    {l:15s} n={m['count']:3d}  R@1={m['recall_at_1']:.3f}  R@5={m['recall_at_5']:.3f}")
    return "\n".join(lines)


def format_compare(results: list[dict[str, Any]]) -> str:
    """Side-by-side comparison table for multiple configurations."""
    if not results:
        return "(no results)"
    lines = [
        "",
        "=" * 100,
        "  RETRIEVAL CONFIGURATION COMPARISON",
        "=" * 100,
        f"  {'config':<28s} {'R@1':>7s} {'R@3':>7s} {'R@5':>7s} {'R@10':>7s} {'MRR':>7s} {'nDCG5':>7s} {'cases':>6s}",
        f"  {'-'*28} {'-'*7} {'-'*7} {'-'*7} {'-'*7} {'-'*7} {'-'*7} {'-'*6}",
    ]
    for r in results:
        lines.append(
            f"  {r['label']:<28s} "
            f"{r['recall_at_1']:>7.4f} {r['recall_at_3']:>7.4f} {r['recall_at_5']:>7.4f} "
            f"{r['recall_at_10']:>7.4f} {r['mrr']:>7.4f} {r['ndcg_at_5']:>7.4f} {r['cases']:>6d}"
        )
    lines.append("")
    lines.append("  Notes per config:")
    for r in results:
        lines.append(f"    {r['label']}: {r.get('notes', '')}")
    return "\n".join(lines)
