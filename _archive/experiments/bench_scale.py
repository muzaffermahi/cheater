"""Scale benchmark to the full 13,389-card corpus from the 80k HF dataset."""
from __future__ import annotations

import json
import time
import re
import sys
from pathlib import Path

import numpy as np
from bench_full import build_bm25f_index, embed_texts
from bench_push import make_rich_text, evaluate_with_precomputed


def load_v1_usable(path: str = "data/cards/cards.v1.jsonl") -> list[dict]:
    cards = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                c = json.loads(line)
                if c.get("usable") is True:
                    cards.append(c)
    return cards


def make_v1_rich_text(card: dict) -> str:
    """Rich embedding text from v1 card fields."""
    parts = []
    for field in ("symptom", "root_cause", "fix_pattern", "embedding_text"):
        val = str(card.get(field) or "").strip()
        if val:
            parts.append(val)
    kws = card.get("search_keywords") or []
    if isinstance(kws, list):
        parts.extend(str(k) for k in kws if str(k).strip())
    return " ".join(parts)[:2000]


def make_v1_query(card: dict) -> str:
    """Create a query from the card's symptom (not embedding_text)."""
    symptom = str(card.get("symptom") or "").strip()
    test_signal = str(card.get("test_signal") or "").strip()
    # Use symptom as primary, add test_signal if different
    parts = [symptom]
    if test_signal and test_signal not in symptom:
        parts.append(test_signal)
    query = " ".join(parts)
    query = re.sub(r"\s+", " ", query).strip()
    return query[:300]


def build_v1_benchmark(cards: list[dict], limit: int | None = None) -> list[dict]:
    cases = []
    for card in cards:
        cid = card.get("id")
        if not cid:
            continue
        query = make_v1_query(card)
        if not query or len(query) < 15:
            continue
        cases.append({
            "id": f"bench_{cid}",
            "query": query,
            "expected_card_ids": [cid],
            "notes": None,
        })
        if limit and len(cases) >= limit:
            break
    return cases


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=500, help="Limit benchmark cases (default 500)")
    parser.add_argument("--cards", default="data/cards/cards.v1.jsonl")
    args = parser.parse_args()

    print("Loading v1 usable cards...", flush=True)
    cards = load_v1_usable(args.cards)
    print(f"  {len(cards)} usable cards", flush=True)

    # Build benchmark (limited for embedding speed)
    cases = build_v1_benchmark(cards, limit=args.limit)
    n = len(cases)
    print(f"  {n} benchmark cases", flush=True)

    # Build a card lookup
    card_by_id = {c["id"]: c for c in cards}
    benchmark_card_ids = [c["expected_card_ids"][0] for c in cases]
    benchmark_cards = [card_by_id[cid] for cid in benchmark_card_ids if cid in card_by_id]

    print(f"\nBuilding BM25F index on all {len(cards)} cards...", flush=True)
    bm25_index = build_bm25f_index(cards)

    print(f"Embedding {len(benchmark_cards)} benchmark card texts (rich)...", flush=True)
    rich_texts = [make_v1_rich_text(c) for c in benchmark_cards]
    card_embs = embed_texts(rich_texts)
    card_embs_norm = card_embs / (np.linalg.norm(card_embs, axis=1, keepdims=True) + 1e-9)

    print(f"Embedding {len(cards)} full corpus texts (rich)...", flush=True)
    all_rich_texts = [make_v1_rich_text(c) for c in cards]
    all_card_embs = embed_texts(all_rich_texts, batch=128)
    all_card_embs_norm = all_card_embs / (np.linalg.norm(all_card_embs, axis=1, keepdims=True) + 1e-9)
    all_card_ids = np.array([str(c.get("id") or "") for c in cards])

    print(f"Pre-embedding {n} queries...", flush=True)
    queries = [c["query"] for c in cases]
    query_embs = embed_texts(queries, batch=128)
    query_embs_norm = query_embs / (np.linalg.norm(query_embs, axis=1, keepdims=True) + 1e-9)

    k_values = (1, 3, 5)

    # ─── Dense only ───
    print(f"\n  Computing dense similarities ({n} queries x {len(cards)} cards)...", flush=True)
    sim_matrix = query_embs_norm @ all_card_embs_norm.T
    all_scores = [sim_matrix[i] for i in range(n)]
    s = evaluate_with_precomputed(cases, all_scores, [all_card_ids]*n, k_values)
    print(f"  Dense (rich text):     R@1={s['recall_at_1']:.4f} R@3={s['recall_at_3']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f} NoHit={s['no_hit']}")

    # ─── BM25F ───
    print(f"\n  Running BM25F on {n} queries...", flush=True)
    t0 = time.perf_counter()
    bm25_all_scores = []
    for i in range(n):
        results = bm25_index.search(queries[i], top_k=len(cards))
        score_map = {c.get("id"): s for s, c in results}
        scores = np.array([float(score_map.get(cid, 0.0)) for cid in all_card_ids])
        mx = float(scores.max()) if scores.max() > 0 else 1.0
        bm25_all_scores.append(scores / mx)
    bm25_time = time.perf_counter() - t0
    s = evaluate_with_precomputed(cases, bm25_all_scores, [all_card_ids]*n, k_values)
    print(f"  BM25F (lexical):       R@1={s['recall_at_1']:.4f} R@3={s['recall_at_3']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f} NoHit={s['no_hit']} ({bm25_time:.1f}s)")

    # ─── Hybrid 0.1/0.9 ───
    print(f"\n  Computing hybrid 0.1/0.9...", flush=True)
    hybrid_all_scores = [0.1 * bm25_all_scores[i] + 0.9 * all_scores[i] for i in range(n)]
    s = evaluate_with_precomputed(cases, hybrid_all_scores, [all_card_ids]*n, k_values)
    print(f"  Hybrid 0.1/0.9 (rich): R@1={s['recall_at_1']:.4f} R@3={s['recall_at_3']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f} NoHit={s['no_hit']}")

    # ─── Try different weights ───
    print(f"\n  Weight tuning on {n} cases:")
    print(f"  {'Weights':<25} {'R@1':>7} {'R@3':>7} {'R@5':>7} {'MRR':>7} {'NoHit':>6}")
    for bw, dw in [(0.0,1.0),(0.1,0.9),(0.2,0.8),(0.3,0.7),(0.5,0.5)]:
        hybrid_scores = [bw * bm25_all_scores[i] + dw * all_scores[i] for i in range(n)]
        s = evaluate_with_precomputed(cases, hybrid_scores, [all_card_ids]*n, k_values)
        label = f"BM25F={bw:.1f} Dense={dw:.1f}"
        print(f"  {label:<25} {s['recall_at_1']:>7.4f} {s['recall_at_3']:>7.4f} {s['recall_at_5']:>7.4f} {s['mrr']:>7.4f} {s['no_hit']:>6}")

    # ─── Final ───
    print(f"\n{'='*60}")
    print(f"  FINAL RESULTS: {n} cases over {len(cards)} cards")
    print(f"{'='*60}")
    s_final = evaluate_with_precomputed(cases, hybrid_all_scores, [all_card_ids]*n, k_values)
    print(f"  Hybrid BM25F=0.1 Dense=0.9 (rich text):")
    print(f"    R@1 = {s_final['recall_at_1']}")
    print(f"    R@3 = {s_final['recall_at_3']}")
    print(f"    R@5 = {s_final['recall_at_5']}")
    print(f"    MRR = {s_final['mrr']}")
    print(f"    No-hit = {s_final['no_hit']}")


if __name__ == "__main__":
    main()
