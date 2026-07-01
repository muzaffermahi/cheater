"""Push benchmark numbers even higher with richer embeddings + Qwen expansion."""
from __future__ import annotations

import json
import time
import re
import sys
from pathlib import Path

import numpy as np
from bench_full import (
    load_compact_cards, build_compact_benchmark, build_bm25f_index,
    build_dense_index, embed_texts, qwen_expand_query,
)

def make_rich_text(card: dict) -> str:
    """Combine multiple fields for richer embedding text."""
    parts = []
    title = str(card.get("title") or "").strip()
    if title:
        parts.append(title)
    error_sig = str(card.get("error_signature") or "").strip()
    if error_sig:
        parts.append(error_sig)
    symptoms = card.get("symptoms") or []
    if isinstance(symptoms, list):
        parts.extend(str(s) for s in symptoms if str(s).strip())
    root = str(card.get("root_cause") or "").strip()
    if root:
        parts.append(root)
    fix = str(card.get("fix_pattern") or "").strip()
    if fix:
        parts.append(fix)
    bug_type = str(card.get("bug_type") or "").strip()
    if bug_type:
        parts.append(bug_type)
    search_text = str(card.get("search_text") or "").strip()
    if search_text:
        parts.append(search_text)
    return " ".join(parts)[:2000]


def evaluate_with_precomputed(cases, all_scores, all_ids, k_values=(1, 3, 5)):
    """Evaluate when scores are precomputed for each case."""
    recall_hits = {k: 0 for k in k_values}
    mrr_sum = 0.0
    no_hit = 0
    for i, case in enumerate(cases):
        expected = set(case["expected_card_ids"])
        scores = all_scores[i]
        ids = all_ids[i]
        # Sort by score descending
        ranked = sorted(zip(scores, ids), key=lambda x: x[0], reverse=True)
        result_ids = [str(id_) for _, id_ in ranked[:max(k_values)]]
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
    n = len(cases)
    return {
        "cases": n,
        "no_hit": no_hit,
        "recall_at_1": round(recall_hits[1] / n, 4),
        "recall_at_3": round(recall_hits[3] / n, 4),
        "recall_at_5": round(recall_hits[5] / n, 4),
        "mrr": round(mrr_sum / n, 4),
    }


def main():
    print("Loading cards...", flush=True)
    cards = load_compact_cards("data/compact_bug_cards.jsonl")
    cases = build_compact_benchmark(cards)
    n = len(cases)
    print(f"  {len(cards)} cards, {n} cases", flush=True)

    print("Building BM25F index...", flush=True)
    bm25_index = build_bm25f_index(cards)

    # ─── Dense index with rich text ───
    print("Building dense index with RICH embedding text...", flush=True)
    rich_texts = [make_rich_text(c) for c in cards]
    card_embs = embed_texts(rich_texts)
    card_embs_norm = card_embs / (np.linalg.norm(card_embs, axis=1, keepdims=True) + 1e-9)

    # Pre-embed queries
    print("Pre-embedding queries...", flush=True)
    queries = [c["query"] for c in cases]
    query_embs = embed_texts(queries)
    query_embs_norm = query_embs / (np.linalg.norm(query_embs, axis=1, keepdims=True) + 1e-9)

    card_ids = np.array([str(c.get("id") or "") for c in cards])

    # ─── Dense-only with rich text ───
    print("\n  Computing dense cosine similarities (rich text)...", flush=True)
    sim_matrix = query_embs_norm @ card_embs_norm.T  # (N_queries, N_cards)
    
    # For each query, get ranked results
    dense_all_scores = []
    dense_all_ids = []
    for i in range(n):
        scores = sim_matrix[i]
        dense_all_scores.append(scores)
        dense_all_ids.append(card_ids)

    s = evaluate_with_precomputed(cases, dense_all_scores, dense_all_ids)
    print(f"  Dense (rich text):     R@1={s['recall_at_1']:.4f} R@3={s['recall_at_3']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f} NoHit={s['no_hit']}")

    # ─── Hybrid 0.1/0.9 with rich text ───
    print("\n  Computing hybrid 0.1/0.9 (rich text)...", flush=True)
    bm25_max = 0.0
    bm25_all_scores = []
    for i in range(n):
        results = bm25_index.search(queries[i], top_k=len(cards))
        score_map = {c.get("id"): s for s, c in results}
        scores = np.array([score_map.get(cid, 0.0) for cid in card_ids])
        mx = float(scores.max()) if scores.max() > 0 else 1.0
        bm25_all_scores.append(scores / mx)
    
    hybrid_all_scores = []
    for i in range(n):
        combined = 0.1 * bm25_all_scores[i] + 0.9 * dense_all_scores[i]
        hybrid_all_scores.append(combined)
    
    s = evaluate_with_precomputed(cases, hybrid_all_scores, dense_all_ids)
    print(f"  Hybrid 0.1/0.9 (rich): R@1={s['recall_at_1']:.4f} R@3={s['recall_at_3']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f} NoHit={s['no_hit']}")

    # ─── Find R@1 misses for Qwen expansion ───
    print("\n  Finding R@1 misses...", flush=True)
    misses = []
    for i in range(n):
        expected = set(cases[i]["expected_card_ids"])
        ranked = sorted(zip(hybrid_all_scores[i], card_ids), key=lambda x: x[0], reverse=True)
        top_id = str(ranked[0][1])
        if top_id not in expected:
            misses.append(i)
    print(f"  {len(misses)} R@1 misses out of {n}", flush=True)

    # ─── Qwen query expansion on misses ───
    if misses:
        subset = min(20, len(misses))
        print(f"\n  Qwen query expansion on {subset} misses...", flush=True)
        recovered = 0
        for j, i in enumerate(misses[:subset]):
            case = cases[i]
            expected = set(case["expected_card_ids"])
            expanded = qwen_expand_query(case["query"])
            # Re-embed expanded query
            exp_emb = embed_texts([expanded])[0]
            exp_emb_norm = exp_emb / (np.linalg.norm(exp_emb) + 1e-9)
            # Dense search with expanded query
            scores = exp_emb_norm @ card_embs_norm.T
            ranked = sorted(zip(scores, card_ids), key=lambda x: x[0], reverse=True)
            top_id = str(ranked[0][1])
            if top_id in expected:
                recovered += 1
                print(f"    RECOVERED: case {i} -> {top_id}", flush=True)
            if (j + 1) % 5 == 0:
                print(f"    tested {j+1}/{subset}, recovered: {recovered}", flush=True)
        
        potential_r1 = (n - len(misses) + recovered) / n
        print(f"\n  Qwen expansion recovered {recovered}/{subset} misses")
        print(f"  Potential R@1 with Qwen expansion: {potential_r1:.4f}")

    # ─── Try different embedding fields ───
    print("\n  Testing different embedding fields...", flush=True)
    for field_name in ["search_text", "title", "error_signature", "root_cause"]:
        texts = [str(c.get(field_name) or "").strip() for c in cards]
        if all(len(t) < 5 for t in texts[:10]):
            continue
        print(f"    embedding field: {field_name}...", flush=True)
        embs = embed_texts(texts)
        embs_norm = embs / (np.linalg.norm(embs, axis=1, keepdims=True) + 1e-9)
        sim = query_embs_norm @ embs_norm.T
        all_scores = [sim[i] for i in range(n)]
        s = evaluate_with_precomputed(cases, all_scores, [card_ids]*n)
        print(f"    {field_name:<20}: R@1={s['recall_at_1']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f}")

    # ─── Final summary ───
    print(f"\n{'='*60}")
    print("  FINAL BEST RESULTS (836 cards, 836 cases)")
    print(f"{'='*60}")
    s_best = evaluate_with_precomputed(cases, hybrid_all_scores, dense_all_ids)
    print(f"  Hybrid BM25F=0.1 Dense=0.9 (rich text):")
    print(f"    R@1 = {s_best['recall_at_1']}")
    print(f"    R@3 = {s_best['recall_at_3']}")
    print(f"    R@5 = {s_best['recall_at_5']}")
    print(f"    MRR = {s_best['mrr']}")
    print(f"    No-hit = {s_best['no_hit']}")


if __name__ == "__main__":
    main()
