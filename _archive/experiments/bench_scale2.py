"""Optimized scale benchmark: fast BM25F (top-100 only) + dense on 13k corpus."""
from __future__ import annotations

import json
import time
import re
import sys
from pathlib import Path

import numpy as np
from bench_full import build_bm25f_index, embed_texts
from bench_push import evaluate_with_precomputed


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
    parts = []
    for field in ("symptom", "root_cause", "fix_pattern", "embedding_text"):
        val = str(card.get(field) or "").strip()
        if val:
            parts.append(val)
    kws = card.get("search_keywords") or []
    if isinstance(kws, list):
        parts.extend(str(k) for k in kws if str(k).strip())
    return " ".join(parts)[:2000]


def make_self_query(card: dict) -> str:
    """Query = first 200 chars of embedding_text (self-retrieval test)."""
    return str(card.get("embedding_text") or "")[:200]


def make_symptom_query(card: dict) -> str:
    """Query from symptom only (harder, different from embedding text)."""
    s = str(card.get("symptom") or "").strip()
    return re.sub(r"\s+", " ", s)[:300]


def main():
    print("Loading v1 usable cards...", flush=True)
    cards = load_v1_usable("data/cards/cards.v1.jsonl")
    n_cards = len(cards)
    print(f"  {n_cards} usable cards", flush=True)

    limit = 200  # keep embedding time manageable
    # Build two benchmark sets: self-retrieval and symptom-based
    self_cases = []
    symptom_cases = []
    for card in cards[:limit]:
        cid = card.get("id")
        if not cid:
            continue
        sq = make_self_query(card)
        yq = make_symptom_query(card)
        if len(sq) >= 15:
            self_cases.append({"id": f"self_{cid}", "query": sq, "expected_card_ids": [cid]})
        if len(yq) >= 15:
            symptom_cases.append({"id": f"symp_{cid}", "query": yq, "expected_card_ids": [cid]})

    print(f"  {len(self_cases)} self-retrieval cases, {len(symptom_cases)} symptom-based cases", flush=True)

    # Build dense index on ALL cards
    print(f"\nEmbedding {n_cards} card texts (rich)...", flush=True)
    all_rich_texts = [make_v1_rich_text(c) for c in cards]
    all_card_embs = embed_texts(all_rich_texts, batch=128)
    all_card_embs_norm = all_card_embs / (np.linalg.norm(all_card_embs, axis=1, keepdims=True) + 1e-9)
    all_card_ids = np.array([str(c.get("id") or "") for c in cards])
    print(f"  done, shape={all_card_embs.shape}", flush=True)

    # Embed queries for both benchmark sets
    all_cases = self_cases + symptom_cases
    all_queries = [c["query"] for c in all_cases]
    print(f"\nEmbedding {len(all_queries)} queries...", flush=True)
    query_embs = embed_texts(all_queries, batch=128)
    query_embs_norm = query_embs / (np.linalg.norm(query_embs, axis=1, keepdims=True) + 1e-9)

    k_values = (1, 3, 5)

    # ─── Dense only ───
    print(f"\n  Computing dense similarities...", flush=True)
    t0 = time.perf_counter()
    sim_matrix = query_embs_norm @ all_card_embs_norm.T  # (N_queries, N_cards)
    print(f"  matrix shape: {sim_matrix.shape}, computed in {time.perf_counter()-t0:.2f}s", flush=True)

    n_self = len(self_cases)
    # Self-retrieval
    s = evaluate_with_precomputed(
        self_cases,
        [sim_matrix[i] for i in range(n_self)],
        [all_card_ids]*n_self,
        k_values,
    )
    print(f"  [SELF] Dense:     R@1={s['recall_at_1']:.4f} R@3={s['recall_at_3']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f} NoHit={s['no_hit']}")

    # Symptom-based
    s2 = evaluate_with_precomputed(
        symptom_cases,
        [sim_matrix[n_self + i] for i in range(len(symptom_cases))],
        [all_card_ids]*len(symptom_cases),
        k_values,
    )
    print(f"  [SYMP] Dense:     R@1={s2['recall_at_1']:.4f} R@3={s2['recall_at_3']:.4f} R@5={s2['recall_at_5']:.4f} MRR={s2['mrr']:.4f} NoHit={s2['no_hit']}")

    # ─── BM25F (fast, top-100) ───
    print(f"\n  Building BM25F index...", flush=True)
    bm25_index = build_bm25f_index(cards)
    print(f"  Running BM25F (top-100 per query)...", flush=True)
    t0 = time.perf_counter()
    bm25_all_scores = []
    for i in range(len(all_cases)):
        results = bm25_index.search(all_queries[i], top_k=100)
        score_map = {c.get("id"): s for s, c in results}
        scores = np.zeros(n_cards, dtype=np.float32)
        for j, cid in enumerate(all_card_ids):
            if cid in score_map:
                scores[j] = score_map[cid]
        mx = float(scores.max()) if scores.max() > 0 else 1.0
        bm25_all_scores.append(scores / mx)
    bm25_time = time.perf_counter() - t0
    print(f"  BM25F done in {bm25_time:.1f}s ({bm25_time/len(all_cases)*1000:.0f}ms/query)", flush=True)

    # Self-retrieval BM25F
    s = evaluate_with_precomputed(
        self_cases,
        [bm25_all_scores[i] for i in range(n_self)],
        [all_card_ids]*n_self,
        k_values,
    )
    print(f"  [SELF] BM25F:     R@1={s['recall_at_1']:.4f} R@3={s['recall_at_3']:.4f} R@5={s['recall_at_5']:.4f} MRR={s['mrr']:.4f} NoHit={s['no_hit']}")

    # Symptom-based BM25F
    s2 = evaluate_with_precomputed(
        symptom_cases,
        [bm25_all_scores[n_self + i] for i in range(len(symptom_cases))],
        [all_card_ids]*len(symptom_cases),
        k_values,
    )
    print(f"  [SYMP] BM25F:     R@1={s2['recall_at_1']:.4f} R@3={s2['recall_at_3']:.4f} R@5={s2['recall_at_5']:.4f} MRR={s2['mrr']:.4f} NoHit={s2['no_hit']}")

    # ─── Hybrid ───
    print(f"\n  Computing hybrid (weight tuning)...", flush=True)
    print(f"  {'Weights':<25} {'Type':>6} {'R@1':>7} {'R@3':>7} {'R@5':>7} {'MRR':>7} {'NoHit':>6}")
    for bw, dw in [(0.0,1.0),(0.1,0.9),(0.2,0.8),(0.3,0.7),(0.5,0.5)]:
        hybrid_scores = [bw * bm25_all_scores[i] + dw * sim_matrix[i] for i in range(len(all_cases))]
        # Self
        s = evaluate_with_precomputed(self_cases, [hybrid_scores[i] for i in range(n_self)], [all_card_ids]*n_self, k_values)
        # Symptom
        s2 = evaluate_with_precomputed(symptom_cases, [hybrid_scores[n_self+i] for i in range(len(symptom_cases))], [all_card_ids]*len(symptom_cases), k_values)
        label = f"BM25F={bw:.1f} Dense={dw:.1f}"
        print(f"  {label:<25} {'SELF':>6} {s['recall_at_1']:>7.4f} {s['recall_at_3']:>7.4f} {s['recall_at_5']:>7.4f} {s['mrr']:>7.4f} {s['no_hit']:>6}")
        print(f"  {label:<25} {'SYMP':>6} {s2['recall_at_1']:>7.4f} {s2['recall_at_3']:>7.4f} {s2['recall_at_5']:>7.4f} {s2['mrr']:>7.4f} {s2['no_hit']:>6}")

    # ─── Final summary ───
    print(f"\n{'='*70}")
    print(f"  SCALE BENCHMARK: 200 cases over {n_cards} usable cards")
    print(f"{'='*70}")
    # Best config: hybrid 0.1/0.9
    hybrid_self = [0.1 * bm25_all_scores[i] + 0.9 * sim_matrix[i] for i in range(n_self)]
    hybrid_symp = [0.1 * bm25_all_scores[n_self+i] + 0.9 * sim_matrix[n_self+i] for i in range(len(symptom_cases))]
    s = evaluate_with_precomputed(self_cases, hybrid_self, [all_card_ids]*n_self, k_values)
    s2 = evaluate_with_precomputed(symptom_cases, hybrid_symp, [all_card_ids]*len(symptom_cases), k_values)
    print(f"  Self-retrieval (query=embedding_text[:200]):")
    print(f"    R@1={s['recall_at_1']:.4f}  R@3={s['recall_at_3']:.4f}  R@5={s['recall_at_5']:.4f}  MRR={s['mrr']:.4f}")
    print(f"  Symptom-based (query=symptom, different from embedding_text):")
    print(f"    R@1={s2['recall_at_1']:.4f}  R@3={s2['recall_at_3']:.4f}  R@5={s2['recall_at_5']:.4f}  MRR={s2['mrr']:.4f}")


if __name__ == "__main__":
    main()
