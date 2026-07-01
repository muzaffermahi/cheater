"""Harder benchmark: Qwen generates paraphrased queries to test retrieval robustness."""
from __future__ import annotations

import json
import time
import re
import sys
from pathlib import Path

import numpy as np
from openai import OpenAI
from bench_full import (
    load_compact_cards, build_compact_benchmark, build_bm25f_index,
    embed_texts,
)
from bench_push import make_rich_text, evaluate_with_precomputed

CLIENT = OpenAI(base_url="http://127.0.0.1:1234/v1", api_key="lm-studio")
MODEL = "qwen3.5-9b"


def qwen_paraphrase_query(card: dict) -> str:
    """Ask Qwen to describe the bug in its own words (harder, not copied from card)."""
    title = str(card.get("title") or "")
    error_sig = str(card.get("error_signature") or "")
    symptoms = card.get("symptoms") or []
    if isinstance(symptoms, list):
        symptoms = " ".join(str(s) for s in symptoms[:2])
    else:
        symptoms = str(symptoms)

    prompt = (
        f"A developer encounters this bug. Write a short 1-2 sentence search query "
        f"they would type to find a fix. Do NOT copy the text; describe it in your own words.\n\n"
        f"Title: {title}\n"
        f"Error: {error_sig}\n"
        f"Symptoms: {symptoms[:200]}\n\n"
        f"Search query:"
    )
    try:
        r = CLIENT.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1000,
            temperature=0.3,
        )
        query = (r.choices[0].message.content or "").strip()
        # Clean up: take first line, remove quotes
        query = query.split("\n")[0].strip().strip('"').strip("'")
        return query[:300] if query else ""
    except Exception:
        return ""


def main():
    print("Loading compact cards...", flush=True)
    cards = load_compact_cards("data/compact_bug_cards.jsonl")
    print(f"  {len(cards)} cards", flush=True)

    # Build standard benchmark (queries from card content)
    std_cases = build_compact_benchmark(cards)

    # Build Qwen-paraphrased benchmark on first 100 cards
    n_para = 30
    print(f"\nGenerating {n_para} Qwen-paraphrased queries...", flush=True)
    para_cases = []
    for i, card in enumerate(cards[:n_para]):
        cid = card.get("id")
        if not cid:
            continue
        query = qwen_paraphrase_query(card)
        if query and len(query) >= 10:
            para_cases.append({
                "id": f"para_{cid}",
                "query": query,
                "expected_card_ids": [cid],
                "notes": "Qwen-paraphrased",
            })
        if (i + 1) % 10 == 0:
            print(f"  {i+1}/{n_para} done ({len(para_cases)} valid)", flush=True)

    print(f"  {len(para_cases)} paraphrased cases", flush=True)

    # Show a few examples
    print("\n  Sample paraphrased queries:")
    for c in para_cases[:5]:
        print(f"    [{c['expected_card_ids'][0]}] {c['query'][:100]}")

    # Build indices
    print("\nBuilding BM25F index...", flush=True)
    bm25_index = build_bm25f_index(cards)

    print("Building dense index (rich text)...", flush=True)
    rich_texts = [make_rich_text(c) for c in cards]
    card_embs = embed_texts(rich_texts)
    card_embs_norm = card_embs / (np.linalg.norm(card_embs, axis=1, keepdims=True) + 1e-9)
    card_ids = np.array([str(c.get("id") or "") for c in cards])

    # Embed queries
    all_cases = std_cases + para_cases
    all_queries = [c["query"] for c in all_cases]
    print(f"\nEmbedding {len(all_queries)} queries...", flush=True)
    query_embs = embed_texts(all_queries)
    query_embs_norm = query_embs / (np.linalg.norm(query_embs, axis=1, keepdims=True) + 1e-9)

    k_values = (1, 3, 5)
    n_std = len(std_cases)
    n_par = len(para_cases)

    # Dense
    sim = query_embs_norm @ card_embs_norm.T
    print(f"\n{'='*70}")
    print(f"  RESULTS: {n_std} standard + {n_par} Qwen-paraphrased cases (836 cards)")
    print(f"{'='*70}")
    print(f"  {'Strategy':<30} {'Type':>6} {'R@1':>7} {'R@3':>7} {'R@5':>7} {'MRR':>7} {'NoHit':>6}")
    print(f"  {'-'*30} {'-'*6} {'-'*7} {'-'*7} {'-'*7} {'-'*7} {'-'*6}")

    # Dense - standard
    s = evaluate_with_precomputed(std_cases, [sim[i] for i in range(n_std)], [card_ids]*n_std, k_values)
    print(f"  {'Dense (nomic)':<30} {'STD':>6} {s['recall_at_1']:>7.4f} {s['recall_at_3']:>7.4f} {s['recall_at_5']:>7.4f} {s['mrr']:>7.4f} {s['no_hit']:>6}")

    # Dense - paraphrased
    s2 = evaluate_with_precomputed(para_cases, [sim[n_std+i] for i in range(n_par)], [card_ids]*n_par, k_values)
    print(f"  {'Dense (nomic)':<30} {'PARA':>6} {s2['recall_at_1']:>7.4f} {s2['recall_at_3']:>7.4f} {s2['recall_at_5']:>7.4f} {s2['mrr']:>7.4f} {s2['no_hit']:>6}")

    # BM25F - standard
    bm25_scores_std = []
    for i in range(n_std):
        results = bm25_index.search(all_queries[i], top_k=100)
        sm = {c.get("id"): sc for sc, c in results}
        scores = np.array([float(sm.get(cid, 0.0)) for cid in card_ids])
        mx = float(scores.max()) if scores.max() > 0 else 1.0
        bm25_scores_std.append(scores / mx)
    s = evaluate_with_precomputed(std_cases, bm25_scores_std, [card_ids]*n_std, k_values)
    print(f"  {'BM25F (lexical)':<30} {'STD':>6} {s['recall_at_1']:>7.4f} {s['recall_at_3']:>7.4f} {s['recall_at_5']:>7.4f} {s['mrr']:>7.4f} {s['no_hit']:>6}")

    # BM25F - paraphrased
    bm25_scores_para = []
    for i in range(n_par):
        results = bm25_index.search(all_queries[n_std+i], top_k=100)
        sm = {c.get("id"): sc for sc, c in results}
        scores = np.array([float(sm.get(cid, 0.0)) for cid in card_ids])
        mx = float(scores.max()) if scores.max() > 0 else 1.0
        bm25_scores_para.append(scores / mx)
    s2 = evaluate_with_precomputed(para_cases, bm25_scores_para, [card_ids]*n_par, k_values)
    print(f"  {'BM25F (lexical)':<30} {'PARA':>6} {s2['recall_at_1']:>7.4f} {s2['recall_at_3']:>7.4f} {s2['recall_at_5']:>7.4f} {s2['mrr']:>7.4f} {s2['no_hit']:>6}")

    # Hybrid 0.1/0.9
    for bw, dw in [(0.1, 0.9), (0.2, 0.8)]:
        hyb_std = [bw * bm25_scores_std[i] + dw * sim[i] for i in range(n_std)]
        hyb_para = [bw * bm25_scores_para[i] + dw * sim[n_std+i] for i in range(n_par)]
        s = evaluate_with_precomputed(std_cases, hyb_std, [card_ids]*n_std, k_values)
        s2 = evaluate_with_precomputed(para_cases, hyb_para, [card_ids]*n_par, k_values)
        label = f"Hybrid {bw}/{dw}"
        print(f"  {label:<30} {'STD':>6} {s['recall_at_1']:>7.4f} {s['recall_at_3']:>7.4f} {s['recall_at_5']:>7.4f} {s['mrr']:>7.4f} {s['no_hit']:>6}")
        print(f"  {label:<30} {'PARA':>6} {s2['recall_at_1']:>7.4f} {s2['recall_at_3']:>7.4f} {s2['recall_at_5']:>7.4f} {s2['mrr']:>7.4f} {s2['no_hit']:>6}")

    # Save paraphrased benchmark
    out_path = Path("data/benchmarks/qwen_paraphrase_benchmark.jsonl")
    with out_path.open("w", encoding="utf-8") as f:
        for c in para_cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"\n  Paraphrased benchmark saved to {out_path}")


if __name__ == "__main__":
    main()
