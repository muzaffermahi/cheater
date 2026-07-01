"""Comprehensive retrieval benchmark with multiple strategies.

Strategies:
  1. bm25f        - lexical BM25F (std-lib)
  2. dense        - nomic embeddings cosine similarity
  3. hybrid       - weighted fusion of BM25F + dense
  4. qwen_expand  - Qwen query expansion + BM25F
  5. qwen_rerank  - BM25F top-K + Qwen LLM reranking

Uses the 836 LLM-compacted cards as both corpus and benchmark source.
For each card, a query is derived from its symptom + error_signature.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent

# ─── Card loading ───────────────────────────────────────────────────────────

def load_compact_cards(path: str = "data/compact_bug_cards.jsonl") -> list[dict]:
    cards = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                cards.append(json.loads(line))
    return cards

def load_v1_cards(path: str = "data/cards/cards.v1.jsonl") -> list[dict]:
    cards = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                c = json.loads(line)
                if c.get("usable") is True:
                    cards.append(c)
    return cards

# ─── Benchmark generation ───────────────────────────────────────────────────

TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]+|\d+")

def tokenize(text: str) -> set[str]:
    return {t.lower() for t in TOKEN_RE.findall(text or "") if len(t) >= 2}

def make_query_from_compact_card(card: dict) -> str:
    """Create a realistic search query from a compact card's content."""
    parts = []
    error_sig = str(card.get("error_signature") or "").strip()
    title = str(card.get("title") or "").strip()
    bug_type = str(card.get("bug_type") or "").strip()
    symptoms = card.get("symptoms") or []
    if isinstance(symptoms, str):
        symptoms = [symptoms]

    # Use error signature as primary query signal
    if error_sig:
        parts.append(error_sig)
    elif title:
        parts.append(title)

    # Add first symptom (truncated)
    if symptoms and isinstance(symptoms, list):
        first = str(symptoms[0]).strip()
        if first:
            parts.append(first[:150])

    # Add bug type for context
    if bug_type and bug_type.lower() not in " ".join(parts).lower():
        parts.append(bug_type)

    query = " ".join(parts)
    # Clean up: remove common noise
    query = re.sub(r"\s+", " ", query).strip()
    return query[:300]  # cap length

def build_compact_benchmark(cards: list[dict]) -> list[dict]:
    """Build benchmark: one case per card, query derived from card content."""
    cases = []
    for card in cards:
        cid = card.get("id")
        if not cid:
            continue
        query = make_query_from_compact_card(card)
        if not query or len(query) < 10:
            continue
        cases.append({
            "id": f"bench_{cid}",
            "query": query,
            "expected_card_ids": [cid],
            "notes": None,
        })
    return cases

# ─── BM25F (reuse cheater core) ────────────────────────────────────────────

def build_bm25f_index(cards: list[dict]) -> Any:
    from cheater.retrieval import BM25FIndex
    return BM25FIndex(cards)

def bm25f_search(index: Any, query: str, top_k: int = 5) -> list[tuple[float, dict]]:
    return index.search(query, top_k=top_k)

# ─── Dense retrieval with nomic embeddings ──────────────────────────────────

class DenseIndex:
    def __init__(self, cards: list[dict], embeddings: np.ndarray, ids: list[str]):
        self.cards = cards
        self.embeddings = embeddings  # (N, D) normalized
        self.ids = ids
        # Precompute norms
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        self.embeddings_normed = embeddings / norms

    def search(self, query_emb: np.ndarray, top_k: int = 5) -> list[tuple[float, dict]]:
        q = query_emb / (np.linalg.norm(query_emb) + 1e-9)
        scores = self.embeddings_normed @ q
        top_idx = np.argsort(scores)[::-1][:top_k]
        return [(float(scores[i]), self.cards[i]) for i in top_idx]

def embed_texts(texts: list[str], model: str = "nomic-embed", batch: int = 64) -> np.ndarray:
    from openai import OpenAI
    client = OpenAI(base_url="http://127.0.0.1:1234/v1", api_key="lm-studio")
    all_embs = []
    for i in range(0, len(texts), batch):
        chunk = texts[i:i+batch]
        r = client.embeddings.create(model=model, input=chunk)
        all_embs.extend([d.embedding for d in r.data])
        if (i + batch) % 256 == 0:
            print(f"  embedded {min(i+batch, len(texts))}/{len(texts)}", flush=True)
    return np.array(all_embs, dtype=np.float32)

def build_dense_index(cards: list[dict], field: str = "search_text") -> DenseIndex:
    texts = [str(c.get(field) or c.get("embedding_text") or "") for c in cards]
    print(f"  embedding {len(texts)} card texts...", flush=True)
    embs = embed_texts(texts)
    ids = [str(c.get("id") or "") for c in cards]
    return DenseIndex(cards, embs, ids)

def dense_search(index: DenseIndex, query: str, top_k: int = 5) -> list[tuple[float, dict]]:
    q_emb = embed_texts([query])[0]
    return index.search(q_emb, top_k=top_k)

# ─── Hybrid retrieval ───────────────────────────────────────────────────────

def hybrid_search(
    bm25_index: Any,
    dense_index: DenseIndex,
    query: str,
    top_k: int = 5,
    bm25_weight: float = 0.4,
    dense_weight: float = 0.6,
    candidate_k: int = 20,
) -> list[tuple[float, dict]]:
    # Get candidates from both
    bm25_results = bm25_index.search(query, top_k=candidate_k)
    q_emb = embed_texts([query])[0]
    dense_results = dense_index.search(q_emb, top_k=candidate_k)

    # Build score maps (normalized)
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
        combined = bm25_weight * b + dense_weight * d
        scored.append((combined, card_map.get(cid, {"id": cid})))

    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[:top_k]

# ─── Qwen query expansion ───────────────────────────────────────────────────

def qwen_expand_query(query: str, model: str = "qwen3.5-9b") -> str:
    from openai import OpenAI
    client = OpenAI(base_url="http://127.0.0.1:1234/v1", api_key="lm-studio")
    prompt = (
        f"Expand this search query with synonymous technical terms for better bug-card retrieval. "
        f"Return ONLY the expanded query, no explanation.\n"
        f"Query: {query}\n"
        f"Expanded query:"
    )
    r = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=200,
        temperature=0.1,
    )
    expanded = (r.choices[0].message.content or "").strip()
    return expanded if expanded else query

# ─── Qwen LLM reranking ─────────────────────────────────────────────────────

def qwen_rerank(
    query: str,
    candidates: list[tuple[float, dict]],
    model: str = "qwen3.5-9b",
    top_k: int = 5,
) -> list[tuple[float, dict]]:
    from openai import OpenAI
    client = OpenAI(base_url="http://127.0.0.1:1234/v1", api_key="lm-studio")

    if not candidates:
        return []

    # Build a compact prompt with candidate summaries
    candidate_lines = []
    for i, (score, card) in enumerate(candidates[:20]):
        title = str(card.get("title") or card.get("symptom") or "")[:100]
        root = str(card.get("root_cause") or "")[:100]
        fix = str(card.get("fix_pattern") or "")[:100]
        cid = card.get("id")
        candidate_lines.append(f"[{i}] id={cid} | {title} | root: {root} | fix: {fix}")

    prompt = (
        f"Rank these bug cards by relevance to the query. Return ONLY the indices "
        f"of the top {top_k} most relevant, comma-separated (e.g. 3,1,0,2).\n\n"
        f"Query: {query}\n\n"
        f"Candidates:\n" + "\n".join(candidate_lines) + "\n\n"
        f"Top {top_k} indices:"
    )
    r = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=500,
        temperature=0,
    )
    text = (r.choices[0].message.content or "").strip()

    # Parse indices
    nums = re.findall(r"\d+", text)
    reranked = []
    for n in nums[:top_k]:
        idx = int(n)
        if 0 <= idx < len(candidates):
            score, card = candidates[idx]
            # Give reranked items a high score
            reranked.append((score + 1000.0, card))

    # Fallback: if parsing failed, return original order
    if not reranked:
        return candidates[:top_k]

    # Fill remaining slots from original if we didn't get enough
    used_ids = {c.get("id") for _, c in reranked}
    for score, card in candidates:
        if len(reranked) >= top_k:
            break
        if card.get("id") not in used_ids:
            reranked.append((score, card))
            used_ids.add(card.get("id"))

    return reranked[:top_k]

# ─── Evaluation ─────────────────────────────────────────────────────────────

def evaluate_strategy(
    cases: list[dict],
    search_fn,
    top_k: int = 5,
    label: str = "",
) -> dict:
    k_values = (1, 3, 5)
    recall_hits = {k: 0 for k in k_values}
    mrr_sum = 0.0
    no_hit = 0
    per_case = []
    t0 = time.perf_counter()

    for case in cases:
        query = case["query"]
        expected = set(case["expected_card_ids"])
        results = search_fn(query, top_k=max(top_k, max(k_values)))
        result_ids = [str(c.get("id")) for _, c in results]

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

        per_case.append({
            "id": case.get("id"),
            "hit": first_rank is not None,
            "rank": first_rank,
        })

    elapsed = time.perf_counter() - t0
    n = max(1, len(cases))
    return {
        "label": label,
        "cases": len(cases),
        "no_hit": no_hit,
        "recall_at_1": round(recall_hits[1] / n, 4),
        "recall_at_3": round(recall_hits[3] / n, 4),
        "recall_at_5": round(recall_hits[5] / n, 4),
        "mrr": round(mrr_sum / n, 4),
        "time_seconds": round(elapsed, 2),
        "per_case": per_case,
    }

def print_summary(s: dict) -> None:
    print(f"\n{'='*60}")
    print(f"  {s['label']}")
    print(f"{'='*60}")
    print(f"  cases:       {s['cases']}")
    print(f"  no-hit:      {s['no_hit']}")
    print(f"  recall@1:    {s['recall_at_1']}")
    print(f"  recall@3:    {s['recall_at_3']}")
    print(f"  recall@5:    {s['recall_at_5']}")
    print(f"  MRR:         {s['mrr']}")
    print(f"  time:        {s['time_seconds']}s")

# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Comprehensive retrieval benchmark")
    parser.add_argument("--cards", default="data/compact_bug_cards.jsonl", help="Card corpus")
    parser.add_argument("--limit", type=int, default=None, help="Limit benchmark cases")
    parser.add_argument("--strategies", nargs="+", default=["bm25f", "dense", "hybrid"],
                        help="Strategies to run")
    parser.add_argument("--hybrid-bm25-weight", type=float, default=0.4)
    parser.add_argument("--hybrid-dense-weight", type=float, default=0.6)
    parser.add_argument("--output", default=None, help="Save results JSON")
    args = parser.parse_args()

    print("Loading cards...", flush=True)
    cards = load_compact_cards(args.cards)
    print(f"  {len(cards)} cards loaded", flush=True)

    print("Building benchmark cases...", flush=True)
    cases = build_compact_benchmark(cards)
    if args.limit:
        cases = cases[:args.limit]
    print(f"  {len(cases)} benchmark cases", flush=True)

    results = []

    # ─── BM25F ───
    if "bm25f" in args.strategies:
        print("\nBuilding BM25F index...", flush=True)
        bm25_index = build_bm25f_index(cards)
        s = evaluate_strategy(cases, lambda q, top_k=5: bm25f_search(bm25_index, q, top_k), label="BM25F (lexical)")
        print_summary(s)
        results.append(s)

    # ─── Dense ───
    if "dense" in args.strategies:
        print("\nBuilding dense index (nomic embeddings)...", flush=True)
        dense_index = build_dense_index(cards)
        s = evaluate_strategy(cases, lambda q, top_k=5: dense_search(dense_index, q, top_k), label="Dense (nomic embeddings)")
        print_summary(s)
        results.append(s)

    # ─── Hybrid ───
    if "hybrid" in args.strategies:
        print("\nBuilding hybrid (BM25F + dense)...", flush=True)
        if "bm25f" not in args.strategies:
            bm25_index = build_bm25f_index(cards)
        if "dense" not in args.strategies:
            dense_index = build_dense_index(cards)
        bw = args.hybrid_bm25_weight
        dw = args.hybrid_dense_weight
        s = evaluate_strategy(
            cases,
            lambda q, top_k=5: hybrid_search(bm25_index, dense_index, q, top_k, bw, dw),
            label=f"Hybrid (BM25F={bw} + Dense={dw})",
        )
        print_summary(s)
        results.append(s)

    # ─── Qwen expansion (subset) ───
    if "qwen_expand" in args.strategies:
        subset = cases[:min(50, len(cases))]
        print(f"\nQwen query expansion on {len(subset)} cases...", flush=True)
        if "bm25f" not in args.strategies:
            bm25_index = build_bm25f_index(cards)
        def qwen_expanded_search(q, top_k=5):
            expanded = qwen_expand_query(q)
            return bm25f_search(bm25_index, expanded, top_k)
        s = evaluate_strategy(subset, qwen_expanded_search, label="Qwen-expanded BM25F (50 cases)")
        print_summary(s)
        results.append(s)

    # ─── Qwen reranking (subset) ───
    if "qwen_rerank" in args.strategies:
        subset = cases[:min(50, len(cases))]
        print(f"\nQwen LLM reranking on {len(subset)} cases...", flush=True)
        if "bm25f" not in args.strategies:
            bm25_index = build_bm25f_index(cards)
        def qwen_rerank_search(q, top_k=5):
            candidates = bm25f_search(bm25_index, q, top_k=20)
            return qwen_rerank(q, candidates, top_k=top_k)
        s = evaluate_strategy(subset, qwen_rerank_search, label="Qwen-reranked BM25F (50 cases)")
        print_summary(s)
        results.append(s)

    # ─── Summary table ───
    print(f"\n{'='*60}")
    print("  SUMMARY TABLE")
    print(f"{'='*60}")
    print(f"  {'Strategy':<40} {'R@1':>6} {'R@3':>6} {'R@5':>6} {'MRR':>6} {'Time':>8}")
    print(f"  {'-'*40} {'-'*6} {'-'*6} {'-'*6} {'-'*6} {'-'*8}")
    for s in results:
        print(f"  {s['label']:<40} {s['recall_at_1']:>6.4f} {s['recall_at_3']:>6.4f} {s['recall_at_5']:>6.4f} {s['mrr']:>6.4f} {s['time_seconds']:>7.1f}s")

    if args.output:
        Path(args.output).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nResults saved to {args.output}")

if __name__ == "__main__":
    main()
