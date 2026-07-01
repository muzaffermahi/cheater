"""Lexical retrieval baseline for Cheater v1 cards.

Field-weighted BM25F (Okapi BM25 with per-field boosts). All math is std-lib
and numpy-free; the optional dense retriever lives in a separate module.

Search inputs:
  - query string
  - top_k
  - language / repo / bug_type filters
  - quality_min (cards below this quality are excluded from results)
  - quality_boost (cards get a score bonus proportional to quality_score)
  - same_language_boost (boost if card language matches query-detected language)
  - mmr_lambda (0..1, diversity re-ranking; 0=pure diversity, 1=pure relevance)
  - compact_first (when set, a compact card outranks a full card with equal
    score; this implements the "compact-first fallback" when both corpora
    are loaded together)

Public API:
  BM25FIndex.search(query, top_k=...)        -- back-compat signature
  search(query, cards, top_k=..., **opts)   -- new unified signature
  format_result(card, rank, score, ...)    -- human-readable output
  why_matched(card, query, terms)           -- "why this matched" hints

The index is built in memory from a list of cards. For 13k cards this is
fast (a few seconds build, a few ms per query). The BM25 term stats, field
boosts, and IDF are deterministic given the same input.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any, Iterable

TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_\.:-]*|\d+")

# Backwards-compatible field boosts (preserved from v1)
DEFAULT_FIELD_BOOSTS: dict[str, float] = {
    "embedding_text": 2.0,
    "symptom": 1.8,
    "search_keywords": 1.5,
    "root_cause": 1.4,
    "fix_pattern": 1.4,
    "bug_type": 0.8,
    "language": 0.6,
    "key_files": 0.6,
}

# Stopwords: very common English words that hurt retrieval if treated as content
STOPWORDS: set[str] = {
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "but",
    "in", "with", "to", "for", "of", "as", "by", "this", "that", "it",
    "from", "be", "are", "was", "were", "not", "have", "has", "had",
    "if", "then", "else", "when", "all", "any", "some", "no", "nor",
    "you", "your", "i", "we", "they", "he", "she", "them", "us", "me",
    "but", "do", "does", "did", "doing", "would", "could", "should",
    "will", "shall", "may", "might", "must", "can", "could",
}


def tokenize_terms(text: Any) -> list[str]:
    """Tokenize text into lowercase terms, dropping stopwords and short tokens."""
    if text is None:
        return []
    if isinstance(text, list):
        text = " ".join(str(x) for x in text)
    if not isinstance(text, str):
        text = str(text)
    return [
        t.lower() for t in TOKEN_RE.findall(text)
        if len(t) >= 2 and t.lower() not in STOPWORDS
    ]


def stream_usable_cards(path) -> Iterable[dict[str, Any]]:
    """Stream usable=true canonical cards from a JSONL file.

    Cards without a `usable` field (e.g. legacy compact corpus) are treated as
    usable=True. The compact corpus is curated and always usable.
    """
    from pathlib import Path
    import json
    p = Path(path)
    if not p.is_file():
        return
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                c = json.loads(line)
            except json.JSONDecodeError:
                continue
            # usable is True if it's explicitly True OR absent (legacy corpus)
            if c.get("usable") is True or c.get("usable") is None:
                yield c


class BM25FIndex:
    """Okapi BM25 with per-field boosts.

    Supports:
      - weighted field scoring (DEFAULT_FIELD_BOOSTS)
      - quality_score boost (cards with higher quality get a bonus)
      - same-language boost
      - exact keyword boost (boost when query terms appear as exact substrings)
      - MMR diversity re-ranking
      - filtering by language / repo / bug_type
    """

    def __init__(
        self,
        cards: list[dict[str, Any]],
        *,
        field_boosts: dict[str, float] | None = None,
        k1: float = 1.2,
        b: float = 0.75,
        quality_boost_weight: float = 0.3,
        exact_match_boost: float = 0.5,
        same_language_boost: float = 0.1,
    ) -> None:
        self.cards = cards
        self.field_boosts = field_boosts or dict(DEFAULT_FIELD_BOOSTS)
        self.k1 = k1
        self.b = b
        self.quality_boost_weight = quality_boost_weight
        self.exact_match_boost = exact_match_boost
        self.same_language_boost = same_language_boost
        self._term_counts: list[dict[str, Counter[str]]] = []
        self._field_lengths: list[dict[str, int]] = []
        self._doc_freq: Counter[str] = Counter()
        self._avg_lengths: dict[str, float] = {}
        self._card_tokens: list[set[str]] = []
        self._card_text_lower: list[str] = []  # concatenated searchable text per card
        self._build()

    def _build(self) -> None:
        length_totals: Counter[str] = Counter()
        for card in self.cards:
            counts: dict[str, Counter[str]] = {}
            lengths: dict[str, int] = {}
            doc_terms: set[str] = set()
            for field in self.field_boosts:
                terms = tokenize_terms(card.get(field))
                c = Counter(terms)
                counts[field] = c
                lengths[field] = len(terms)
                length_totals[field] += len(terms)
                doc_terms.update(c)
            self._term_counts.append(counts)
            self._field_lengths.append(lengths)
            self._doc_freq.update(doc_terms)
            self._card_tokens.append(doc_terms)
            # For exact-match boost: cache lower-cased searchable text
            text_parts = []
            for f in ("symptom", "fix_pattern", "root_cause", "embedding_text",
                      "test_signal"):
                v = card.get(f)
                if v:
                    text_parts.append(str(v))
            for f in ("key_files", "search_keywords"):
                v = card.get(f)
                if isinstance(v, list):
                    text_parts.extend(str(x) for x in v)
            self._card_text_lower.append("\n".join(text_parts).lower())
        count = max(1, len(self.cards))
        self._avg_lengths = {
            f: max(1.0, length_totals[f] / count) for f in self.field_boosts
        }

    def _idf(self, term: str) -> float:
        n = len(self.cards)
        df = self._doc_freq.get(term, 0)
        if n == 0 or df == 0:
            return 0.0
        return (n - df + 0.5) / (df + 0.5)

    def _weighted_tf(self, term: str, doc_index: int) -> float:
        wf = 0.0
        for field, boost in self.field_boosts.items():
            tf = self._term_counts[doc_index][field].get(term, 0)
            if not tf:
                continue
            length = self._field_lengths[doc_index][field]
            avg = self._avg_lengths[field]
            norm = 1.0 - self.b + self.b * length / avg
            wf += boost * tf / norm
        return wf

    def score(self, query: str, doc_index: int) -> float:
        terms = set(tokenize_terms(query))
        if not terms or not self.cards:
            return 0.0
        score = 0.0
        matched = 0
        for term in terms:
            wf = self._weighted_tf(term, doc_index)
            if wf <= 0:
                continue
            matched += 1
            sat = (self.k1 + 1.0) * wf / (self.k1 + wf)
            score += self._idf(term) * sat
        if not matched:
            return 0.0
        return score + matched / len(terms)

    def score_with_extras(
        self,
        query: str,
        doc_index: int,
        *,
        query_language: str | None = None,
    ) -> tuple[float, dict[str, Any]]:
        """Like score() but adds quality and exact-match boosts, plus 'why matched' info."""
        base = self.score(query, doc_index)
        card = self.cards[doc_index]
        why: dict[str, Any] = {"base_score": round(base, 4)}

        # Quality boost
        q_score = card.get("quality_score")
        if isinstance(q_score, (int, float)) and self.quality_boost_weight > 0:
            qb = self.quality_boost_weight * float(q_score)
            base += qb
            why["quality_boost"] = round(qb, 4)

        # Exact match boost: count query tokens that appear as exact substrings
        # in the card's text. Caps at the number of query tokens.
        text = self._card_text_lower[doc_index]
        if text and self.exact_match_boost > 0:
            terms = tokenize_terms(query)
            exact = 0
            for t in terms:
                if len(t) >= 3 and t in text:
                    exact += 1
            if terms:
                em = self.exact_match_boost * (exact / len(terms))
                base += em
                if em > 0:
                    why["exact_match_boost"] = round(em, 4)
                    why["exact_matches"] = exact

        # Same-language boost
        if query_language and self.same_language_boost > 0:
            card_lang = (card.get("language") or "").lower().strip()
            if card_lang and card_lang == query_language.lower().strip():
                base += self.same_language_boost
                why["same_language_boost"] = round(self.same_language_boost, 4)

        return base, why

    def search(
        self,
        query: str,
        top_k: int = 5,
        *,
        language: str | None = None,
        repo: str | None = None,
        bug_type: str | None = None,
        quality_min: float = 0.0,
        quality_boost: float | None = None,
        exact_match_boost: float | None = None,
        same_language_boost: float | None = None,
        mmr_lambda: float = 0.0,
        candidate_k: int = 50,
    ) -> list[tuple[float, dict[str, Any]]]:
        """Search with filters, quality boost, and optional MMR diversity.

        Returns up to top_k results as (score, card) tuples. If mmr_lambda > 0,
        results are re-ranked for diversity (avoiding near-duplicate cards).
        """
        if top_k < 1 or not self.cards:
            return []

        # Pre-filter by language/repo/bug_type/quality
        candidate_indices: list[int] = []
        for i, card in enumerate(self.cards):
            if language and (card.get("language") or "").lower() != language.lower():
                continue
            if repo and (card.get("repo") or "").lower() != repo.lower():
                continue
            if bug_type and (card.get("bug_type") or "").lower() != bug_type.lower():
                continue
            if quality_min > 0:
                q_s = card.get("quality_score")
                if not isinstance(q_s, (int, float)) or q_s < quality_min:
                    continue
            candidate_indices.append(i)

        # Compute scores on candidates (or all if too few)
        scored: list[tuple[float, int, dict[str, Any]]] = []
        qb = self.quality_boost_weight if quality_boost is None else quality_boost
        emb_boost = self.exact_match_boost if exact_match_boost is None else exact_match_boost
        slb = self.same_language_boost if same_language_boost is None else same_language_boost

        # Temporarily apply custom boosts
        old_qb, old_emb, old_slb = self.quality_boost_weight, self.exact_match_boost, self.same_language_boost
        self.quality_boost_weight = qb
        self.exact_match_boost = emb_boost
        self.same_language_boost = slb
        try:
            for i in candidate_indices:
                s, _why = self.score_with_extras(query, i, query_language=language)
                if s > 0:
                    scored.append((s, i, _why))
        finally:
            self.quality_boost_weight, self.exact_match_boost, self.same_language_boost = old_qb, old_emb, old_slb

        scored.sort(key=lambda x: x[0], reverse=True)

        # If filters were applied, do NOT fall back to unfiltered results.
        # If no filters and we don't have enough, fall back to scoring all cards.
        has_filters = (language is not None or repo is not None
                       or bug_type is not None or quality_min > 0)
        if len(scored) < top_k and not has_filters:
            fallback: list[tuple[float, int, dict[str, Any]]] = []
            seen_i = {i for _, i, _ in scored}
            self.quality_boost_weight = qb
            self.exact_match_boost = emb_boost
            self.same_language_boost = slb
            try:
                for i in range(len(self.cards)):
                    if i in seen_i:
                        continue
                    s, _why = self.score_with_extras(query, i, query_language=language)
                    if s > 0:
                        fallback.append((s, i, _why))
            finally:
                self.quality_boost_weight, self.exact_match_boost, self.same_language_boost = old_qb, old_emb, old_slb
            fallback.sort(key=lambda x: x[0], reverse=True)
            scored.extend(fallback)

        # Take top candidate_k
        candidates = scored[:max(top_k, candidate_k)]

        # MMR re-ranking for diversity
        if mmr_lambda > 0 and len(candidates) > top_k:
            selected: list[tuple[float, int, dict[str, Any]]] = []
            remaining = list(candidates)
            while len(selected) < top_k and remaining:
                if not selected:
                    # Pick the highest-scoring one first
                    best = remaining.pop(0)
                else:
                    # Pick the one with max(mmr_lambda * score - (1-mmr_lambda) * max_similarity_to_selected)
                    best = max(
                        remaining,
                        key=lambda c: (
                            mmr_lambda * c[0]
                            - (1.0 - mmr_lambda) * max(
                                _card_jaccard(self.cards[c[1]], self.cards[s[1]])
                                for s in selected
                            )
                        ),
                    )
                    remaining.remove(best)
                selected.append(best)
            return [(s, self.cards[i]) for s, i, _ in selected[:top_k]]

        return [(s, self.cards[i]) for s, i, _ in candidates[:top_k]]


def _card_jaccard(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Jaccard similarity over a card's token set (used by MMR)."""
    ta = set()
    tb = set()
    for f in ("symptom", "fix_pattern", "root_cause", "embedding_text", "test_signal"):
        ta |= set(tokenize_terms(a.get(f)))
        tb |= set(tokenize_terms(b.get(f)))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def load_index_cards(path) -> list[dict[str, Any]]:
    """Load usable cards into a list for in-memory indexing."""
    return list(stream_usable_cards(path))


def format_result(
    card: dict[str, Any],
    rank: int,
    score: float,
    *,
    why: dict[str, Any] | None = None,
) -> str:
    lines = [
        "",
        "=" * 88,
        f"#{rank}  score={score:.3f}",
        f"id:          {card.get('id') or ''}",
        f"repo:        {card.get('repo') or '(unknown)'}",
        f"language:    {card.get('language') or '(unknown)'}",
        f"bug_type:    {card.get('bug_type') or '(unknown)'}",
        f"quality:     {card.get('quality_score', '?')} ({card.get('quality_tier', '?')})",
        f"symptom:     {(card.get('symptom') or '')[:240]}",
        f"fix_pattern: {(card.get('fix_pattern') or '')[:240]}",
        f"keywords:    {', '.join(card.get('search_keywords') or [])}",
    ]
    if why:
        hints = []
        if why.get("exact_matches"):
            hints.append(f"exact={why['exact_matches']}")
        if why.get("quality_boost"):
            hints.append(f"quality_boost={why['quality_boost']:.3f}")
        if why.get("same_language_boost"):
            hints.append("same_lang")
        if hints:
            lines.append(f"why:          {'; '.join(hints)}")
    # Quality warnings
    qs = card.get("quality_score")
    if isinstance(qs, (int, float)) and qs < 0.4:
        reasons = card.get("quality_reasons") or []
        lines.append(f"WARNING: low quality ({qs}); reasons: {', '.join(reasons[:3])}")
    return "\n".join(lines)


def why_matched(card: dict[str, Any], query: str, top_terms: list[str] | None = None) -> dict[str, Any]:
    """Return structured 'why this card matched' info for transparency."""
    if top_terms is None:
        top_terms = list(dict.fromkeys(tokenize_terms(query)))[:10]
    text = " ".join(
        str(card.get(f) or "")
        for f in ("symptom", "fix_pattern", "root_cause", "embedding_text", "test_signal")
    ).lower()
    hits = {t: text.count(t) for t in top_terms if t in text}
    return {
        "matched_terms": hits,
        "field_match": {
            f: bool(set(tokenize_terms(card.get(f))) & set(top_terms))
            for f in ("symptom", "fix_pattern", "root_cause", "search_keywords",
                      "key_files", "test_signal", "embedding_text")
            if card.get(f)
        },
    }


def search(
    query: str,
    cards: list[dict[str, Any]],
    top_k: int = 5,
    **opts,
) -> list[tuple[float, dict[str, Any]]]:
    """Convenience function: build a temporary BM25FIndex and search.

    opts are passed to BM25FIndex.search.
    """
    if not cards:
        return []
    idx = BM25FIndex(cards)
    return idx.search(query, top_k=top_k, **opts)
