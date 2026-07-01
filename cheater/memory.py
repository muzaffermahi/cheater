"""Cheater memory layer: modes, diversification, and structured retrieval.

Public API:
  MemoryMode                  -- enum: off | compact | balanced | aggressive
  memory_search(query, cards, mode="balanced", language=None, repo=None)
  explain_retrieval(query, cards, result)  -- why each card matched
  diversity_filter(results, key_fn, top_n)  -- reduce near-duplicates by language/repo
  format_brief(cards, query, repo_context=None)  -- formatted memory brief

Backed by cheater.retrieval (BM25F).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

from cheater.retrieval import BM25FIndex, load_index_cards, tokenize_terms

# Default top-k and quality_min per mode
MODE_DEFAULTS: dict[str, dict[str, Any]] = {
    "off":        {"top_k": 0,  "quality_min": 1.0, "mmr": 0.0},
    "compact":    {"top_k": 3,  "quality_min": 0.4, "mmr": 0.2},
    "balanced":   {"top_k": 5,  "quality_min": 0.0, "mmr": 0.0},
    "aggressive": {"top_k": 10, "quality_min": 0.0, "mmr": 0.0},
}


@dataclass
class MemoryHit:
    score: float
    card: dict[str, Any]
    why: dict[str, Any]


def memory_search(
    query: str,
    cards: list[dict[str, Any]],
    mode: str = "balanced",
    *,
    language: str | None = None,
    repo: str | None = None,
    bug_type: str | None = None,
    top_k_override: int | None = None,
) -> list[MemoryHit]:
    """Search memory with the given mode.

    Modes:
      off:        return []
      compact:    top-3, quality_min=0.4
      balanced:   top-5, quality_min=0.0
      aggressive: top-10, quality_min=0.0
    """
    mode = (mode or "balanced").lower()
    if mode == "off" or not cards or not query:
        return []
    opts = MODE_DEFAULTS.get(mode, MODE_DEFAULTS["balanced"]).copy()
    if top_k_override is not None:
        opts["top_k"] = max(1, top_k_override)
    idx = BM25FIndex(cards)
    results = idx.search(
        query,
        top_k=opts["top_k"],
        language=language,
        repo=repo,
        bug_type=bug_type,
        quality_min=opts["quality_min"],
        mmr_lambda=opts["mmr"],
    )
    # Each result is (score, card); we don't have 'why' from the simpler path,
    # so call score_with_extras for the top results.
    out: list[MemoryHit] = []
    for score, card in results:
        # Find doc_index
        try:
            doc_index = cards.index(card)
        except ValueError:
            doc_index = -1
        why: dict[str, Any] = {}
        if doc_index >= 0:
            try:
                _, why = idx.score_with_extras(query, doc_index, query_language=language)
            except Exception:
                why = {}
        out.append(MemoryHit(score=score, card=card, why=why))
    return out


def explain_retrieval(query: str, hit: MemoryHit) -> str:
    """Return a short human-readable explanation of why a card matched."""
    parts: list[str] = []
    why = hit.why or {}
    if why.get("exact_matches"):
        parts.append(f"exact match: {why['exact_matches']} term(s)")
    if why.get("quality_boost"):
        parts.append(f"quality boost: {why['quality_boost']:.2f}")
    if why.get("same_language_boost"):
        parts.append("same language")
    if not parts:
        parts.append("lexical overlap")
    score = hit.score
    return f"  score={score:.3f}  ({'; '.join(parts)})"


def diversity_filter(
    hits: list[MemoryHit],
    *,
    max_per_repo: int = 2,
    top_n: int | None = None,
) -> list[MemoryHit]:
    """Limit how many hits come from the same repo, to encourage cross-project diversity."""
    seen_repo: dict[str, int] = {}
    out: list[MemoryHit] = []
    for h in hits:
        repo = (h.card.get("repo") or "").lower()
        if not repo:
            repo = "(unknown)"
        if seen_repo.get(repo, 0) >= max_per_repo:
            continue
        out.append(h)
        seen_repo[repo] = seen_repo.get(repo, 0) + 1
    if top_n is not None:
        out = out[:top_n]
    return out


def format_brief(
    hits: list[MemoryHit],
    query: str,
    *,
    repo_context: str | None = None,
    max_lines: int = 30,
) -> str:
    """Format retrieved memory as a compact repair brief.

    This is what the model sees: a small structured summary, not full card dumps.
    """
    out: list[str] = []
    out.append("=== Memory Brief ===")
    out.append(f"Query: {query[:200]}")
    if repo_context:
        out.append(f"Repo context: {repo_context[:200]}")
    if not hits:
        out.append("(no memory hits)")
        out.append("Cheater does not claim to know the fix.")
        return "\n".join(out)
    out.append(f"Top {len(hits)} card(s):")
    for i, h in enumerate(hits, start=1):
        c = h.card
        out.append(f"  [{i}] id={c.get('id', '?')}  repo={c.get('repo', '?')}  lang={c.get('language', '?')}")
        if c.get("bug_type"):
            out.append(f"      bug_type: {c['bug_type']}")
        if c.get("symptom"):
            s = c["symptom"]
            out.append(f"      symptom: {s[:150]}{'...' if len(s) > 150 else ''}")
        if c.get("root_cause"):
            r = c["root_cause"]
            out.append(f"      root_cause: {r[:150]}{'...' if len(r) > 150 else ''}")
        if c.get("fix_pattern"):
            f = c["fix_pattern"]
            out.append(f"      fix: {f[:150]}{'...' if len(f) > 150 else ''}")
        if c.get("failed_approaches"):
            for fa in (c["failed_approaches"] or [])[:2]:
                out.append(f"      avoid: {str(fa)[:120]}")
        out.append("      " + explain_retrieval(query, h).strip())
    out.append("")
    out.append("Cheater does not claim to know the fix. These are cross-project analogies.")
    return "\n".join(out[:max_lines * 2])


def load_cards_for_memory(path: str) -> list[dict[str, Any]]:
    """Load usable cards from a path. Returns [] if file missing."""
    from pathlib import Path
    p = Path(path)
    if not p.is_file():
        return []
    return load_index_cards(p)
