"""Measure RAM usage and timing for index build + search on the full corpus."""
from __future__ import annotations

import os
import sys
import time
import json
from pathlib import Path

import psutil

proc = psutil.Process(os.getpid())


def mem_mb() -> float:
    return proc.memory_info().rss / 1024 / 1024


def main() -> None:
    cards_path = sys.argv[1] if len(sys.argv) > 1 else "data/cards/cards.v1.jsonl"
    query = sys.argv[2] if len(sys.argv) > 2 else "pydantic validation error environment variable nested delimiter"

    print(f"Cards: {cards_path}")
    print(f"Query: {query}")
    print(f"Baseline RSS: {mem_mb():.1f} MB")

    # Phase 1: Load cards (streaming)
    t0 = time.perf_counter()
    from cheater.retrieval import load_index_cards, BM25FIndex
    cards = load_index_cards(cards_path)
    t1 = time.perf_counter()
    print(f"\n[LOAD] {len(cards)} usable cards in {t1-t0:.2f}s, RSS={mem_mb():.1f} MB")

    # Phase 2: Build BM25F index
    t0 = time.perf_counter()
    index = BM25FIndex(cards)
    t1 = time.perf_counter()
    print(f"[INDEX] BM25F built in {t1-t0:.2f}s, RSS={mem_mb():.1f} MB")
    print(f"  field_boosts: {index.field_boosts}")
    print(f"  k1={index.k1} b={index.b}")

    # Phase 3: Search
    for k in (1, 3, 5, 10, 20):
        t0 = time.perf_counter()
        results = index.search(query, top_k=k)
        t1 = time.perf_counter()
        top_id = results[0][1].get("id") if results else "(none)"
        top_score = results[0][0] if results else 0
        print(f"[SEARCH] top_k={k}: {t1-t0:.4f}s, {len(results)} results, top={top_id} score={top_score:.2f}")

    # Phase 4: Multiple queries (throughput)
    queries = [
        "pydantic validation error environment variable",
        "geopandas spatial join sorted wrong index",
        "cognitive complexity binary logical operators",
        "KeyError empty arguments sqlglot transpile",
        "AttributeError Name object has no attribute getitem",
        "TypeError string indices table output",
        "IndexError list assignment out of range",
        "ImportError cannot import name module",
        "AssertionError expected value got different value",
        "ValueError invalid literal for int",
    ]
    t0 = time.perf_counter()
    total_results = 0
    for q in queries:
        results = index.search(q, top_k=5)
        total_results += len(results)
    t1 = time.perf_counter()
    print(f"\n[THROUGHPUT] {len(queries)} queries in {t1-t0:.2f}s ({(t1-t0)/len(queries)*1000:.1f}ms/query), {total_results} total results, RSS={mem_mb():.1f} MB")

    # Phase 5: Corpus stats
    emb_lens = [len(c.get("embedding_text") or "") for c in cards]
    print(f"\n[CORPUS] {len(cards)} cards")
    print(f"  embedding_text: avg={sum(emb_lens)/len(emb_lens):.0f} min={min(emb_lens)} max={max(emb_lens)} chars")
    print(f"  total embedding_text: {sum(emb_lens)/1024/1024:.1f} MB")
    print(f"  final RSS: {mem_mb():.1f} MB")


if __name__ == "__main__":
    main()
