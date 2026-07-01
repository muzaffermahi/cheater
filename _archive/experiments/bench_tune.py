"""Tune hybrid retrieval weights and test Qwen reranking."""
from __future__ import annotations

import json
import time
import sys
from pathlib import Path

import numpy as np
from bench_full import (
    load_compact_cards, build_compact_benchmark, build_bm25f_index,
    build_dense_index, embed_texts, bm25f_search, qwen_rerank,
)

def main():
    print("Loading cards...", flush=True)
    cards = load_compact_cards("data/compact_bug_cards.jsonl")
    cases = build_compact_benchmark(cards)
    print(f"  {len(cards)} cards, {len(cases)} cases", flush=True)

    print("Building BM25F index...", flush=True)
    bm25_index = build_bm25f_index(cards)

    print("Building dense index...", flush=True)
    dense_index = build_dense_index(cards)

    # Pre-embed all queries
    print("Pre-embedding all queries...", flush=True)
    queries = [c["query"] for c in cases]
    query_embs = embed_texts(queries)
    print(f"  {len(queries)} query embeddings done", flush=True)

    k_values = (1, 3, 5)

    # ─── Weight tuning ───
    print()
    print(f"  {'Weights':<25} {'R@1':>7} {'R@3':>7} {'R@5':>7} {'MRR':>7} {'NoHit':>6}")
    print(f"  {'-'*25} {'-'*7} {'-'*7} {'-'*7} {'-'*7} {'-'*6}")

    best_r1 = 0.0
    best_weights = None
    best_results = None

    for bw, dw in [(0.0,1.0),(0.1,0.9),(0.2,0.8),(0.3,0.7),(0.4,0.6),(0.5,0.5),(0.6,0.4),(0.7,0.3),(1.0,0.0)]:
        recall_hits = {k: 0 for k in k_values}
        mrr_sum = 0.0
        no_hit = 0
        per_case_ranks = []
        t0 = time.perf_counter()
        for i, case in enumerate(cases):
            expected = set(case["expected_card_ids"])
            q_emb = query_embs[i]
            bm25_results = bm25_index.search(case["query"], top_k=20)
            dense_results = dense_index.search(q_emb, top_k=20)
            bm25_max = max((s for s, _ in bm25_results), default=1.0) or 1.0
            dense_max = max((s for s, _ in dense_results), default=1.0) or 1.0
            bm25_scores = {c.get("id"): s / bm25_max for s, c in bm25_results}
            dense_scores = {c.get("id"): s / dense_max for s, c in dense_results}
            all_ids = set(bm25_scores) | set(dense_scores)
            card_map = {c.get("id"): c for s, c in bm25_results}
            card_map.update({c.get("id"): c for s, c in dense_results})
            scored = []
            for cid in all_ids:
                b = bm25_scores.get(cid, 0.0)
                d = dense_scores.get(cid, 0.0)
                combined = bw * b + dw * d
                scored.append((combined, card_map.get(cid, {"id": cid})))
            scored.sort(key=lambda x: x[0], reverse=True)
            result_ids = [str(c.get("id")) for _, c in scored[:5]]
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
            per_case_ranks.append((i, first_rank))
        elapsed = time.perf_counter() - t0
        n = len(cases)
        label = f"BM25F={bw:.1f} Dense={dw:.1f}"
        r1 = recall_hits[1] / n
        print(f"  {label:<25} {r1:>7.4f} {recall_hits[3]/n:>7.4f} {recall_hits[5]/n:>7.4f} {mrr_sum/n:>7.4f} {no_hit:>6}  {elapsed:.1f}s")
        if r1 > best_r1:
            best_r1 = r1
            best_weights = (bw, dw)
            best_results = per_case_ranks

    print(f"\n  Best R@1: {best_r1:.4f} at weights {best_weights}")

    # ─── Qwen reranking on best hybrid config ───
    bw, dw = best_weights
    print(f"\n  Qwen reranking with best hybrid weights ({bw}/{dw})...")
    # Find cases where the best hybrid MISSES rank 1
    misses = [(i, rank) for i, rank in best_results if rank is None or rank > 1]
    print(f"  {len(misses)} cases where R@1 missed. Reranking first 30...", flush=True)

    improved = 0
    reranked_r1_hits = 0
    total_tested = 0
    for i, _rank in misses[:30]:
        case = cases[i]
        expected = set(case["expected_card_ids"])
        q_emb = query_embs[i]
        # Get hybrid top-20
        bm25_results = bm25_index.search(case["query"], top_k=20)
        dense_results = dense_index.search(q_emb, top_k=20)
        bm25_max = max((s for s, _ in bm25_results), default=1.0) or 1.0
        dense_max = max((s for s, _ in dense_results), default=1.0) or 1.0
        bm25_scores = {c.get("id"): s / bm25_max for s, c in bm25_results}
        dense_scores = {c.get("id"): s / dense_max for s, c in dense_results}
        all_ids = set(bm25_scores) | set(dense_scores)
        card_map = {c.get("id"): c for s, c in bm25_results}
        card_map.update({c.get("id"): c for s, c in dense_results})
        scored = []
        for cid in all_ids:
            b = bm25_scores.get(cid, 0.0)
            d = dense_scores.get(cid, 0.0)
            combined = bw * b + dw * d
            scored.append((combined, card_map.get(cid, {"id": cid})))
        scored.sort(key=lambda x: x[0], reverse=True)
        candidates = scored[:20]

        # Qwen rerank
        reranked = qwen_rerank(case["query"], candidates, top_k=5)
        result_ids = [str(c.get("id")) for _, c in reranked[:5]]
        if result_ids and result_ids[0] in expected:
            reranked_r1_hits += 1
            improved += 1
        total_tested += 1
        if total_tested % 10 == 0:
            print(f"    tested {total_tested}/30, reranked R@1 hits: {reranked_r1_hits}", flush=True)

    print(f"\n  Qwen reranking on {total_tested} miss cases:")
    print(f"    R@1 recovered by Qwen: {reranked_r1_hits}/{total_tested} = {reranked_r1_hits/max(1,total_tested):.4f}")
    print(f"    Potential new R@1: {(best_r1 * len(cases) + improved) / len(cases):.4f}")

if __name__ == "__main__":
    main()
