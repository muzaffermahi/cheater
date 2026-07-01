from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .bug_memory import BM25Index, tokenize_terms
from .memory_index import IndexMetadata, load_cards, load_index_metadata
from .memory_schema import MemoryCard


@dataclass
class HybridResult:
    card: MemoryCard
    score: float
    bm25_score: float = 0.0
    dense_score: float = 0.0
    rank_bm25: int = 0
    rank_dense: int = 0
    method: str = "bm25"


DEFAULT_BM25_WEIGHT = 0.4
DEFAULT_DENSE_WEIGHT = 0.6
DEFAULT_LANGUAGE_BONUS = 0.1
DEFAULT_BUG_TYPE_BONUS = 0.05
DEFAULT_CONTAMINATION_PENALTY = -10.0


@dataclass
class HybridRetriever:
    cards: list[dict[str, Any]] = field(default_factory=list)
    bm25_index: BM25Index | None = None
    dense_embeddings: Any = None
    dense_model: Any = None
    dense_id_map: list[dict[str, Any]] = field(default_factory=list)
    index_metadata: IndexMetadata = field(default_factory=IndexMetadata)
    bm25_weight: float = DEFAULT_BM25_WEIGHT
    dense_weight: float = DEFAULT_DENSE_WEIGHT
    language_bonus: float = DEFAULT_LANGUAGE_BONUS
    bug_type_bonus: float = DEFAULT_BUG_TYPE_BONUS
    contamination_penalty: float = DEFAULT_CONTAMINATION_PENALTY

    @classmethod
    def load(cls, index_dir: str | Path) -> HybridRetriever:
        index_path = Path(index_dir).expanduser().resolve()
        meta_path = index_path / "index_metadata.json"
        meta = load_index_metadata(meta_path)

        cards_path = Path(meta.cards_path)
        if not cards_path.is_file():
            cards_path = index_path.parent.parent / "cards.jsonl"
        if not cards_path.is_file():
            raise FileNotFoundError(f"Cannot find cards file for index at {index_dir}")

        cards_dicts = load_cards(str(cards_path))
        cards = [card.to_dict() for card in cards_dicts]

        bm25_index = None
        if meta.bm25_available:
            bm25_index = BM25Index(cards)

        dense_embeddings = None
        dense_model = None
        dense_id_map = []
        if meta.dense_available and meta.dense_model:
            try:
                import numpy as np
                from sentence_transformers import SentenceTransformer

                short_name = meta.dense_model.replace("/", "_").replace("-", "_")
                dense_dir = index_path / "dense" / short_name
                emb_path = dense_dir / "embeddings.npy"
                id_map_path = dense_dir / "id_map.json"

                if emb_path.is_file() and id_map_path.is_file():
                    dense_embeddings = np.load(str(emb_path))
                    with id_map_path.open("r", encoding="utf-8") as f:
                        dense_id_map = json.load(f)
                    dense_model = SentenceTransformer(meta.dense_model)
            except Exception:
                pass

        return cls(
            cards=cards,
            bm25_index=bm25_index,
            dense_embeddings=dense_embeddings,
            dense_model=dense_model,
            dense_id_map=dense_id_map,
            index_metadata=meta,
        )

    def _tokenize_query(self, query: str) -> set[str]:
        return set(tokenize_terms(query))

    def _compute_language_bonus(self, card: dict[str, Any], query: str) -> float:
        card_lang = str(card.get("language") or "").lower()
        query_lower = query.lower()
        if card_lang and card_lang in query_lower:
            return self.language_bonus
        lang_map = {
            "python": ["python", "django", "flask", "astropy", "pytest", "numpy"],
            "javascript": ["javascript", "js", "node", "react", "typescript"],
            "java": ["java", "maven", "gradle", "spring"],
            "rust": ["rust", "cargo"],
            "go": ["go", "golang"],
        }
        for lang, keywords in lang_map.items():
            if card_lang == lang:
                for kw in keywords:
                    if kw in query_lower:
                        return self.language_bonus
        return 0.0

    def _compute_bug_type_bonus(self, card: dict[str, Any], query: str) -> float:
        bug_type = str(card.get("task_type") or card.get("bug_type") or "").lower()
        query_lower = query.lower()
        if bug_type and bug_type.replace("_", " ") in query_lower:
            return self.bug_type_bonus
        return 0.0

    def _compute_contamination_penalty(self, card: dict[str, Any]) -> float:
        scope = str(card.get("contamination_scope") or "")
        if scope == "swe_bench_official":
            return self.contamination_penalty
        return 0.0

    def search_bm25(self, query: str, top_k: int = 10) -> list[tuple[float, int]]:
        if self.bm25_index is None:
            return []
        results = self.bm25_index.search(query, top_k)
        scored: list[tuple[float, int]] = []
        for score, card in results:
            for idx, c in enumerate(self.cards):
                if c.get("card_id") == card.get("card_id"):
                    scored.append((score, idx))
                    break
        return scored

    def search_dense(self, query: str, top_k: int = 10) -> list[tuple[float, int]]:
        if self.dense_embeddings is None or self.dense_model is None:
            return []
        try:
            query_emb = self.dense_model.encode([query], show_progress_bar=False)
            import numpy as np

            scores = np.dot(self.dense_embeddings, query_emb.T).flatten()
            top_indices = np.argsort(scores)[::-1][:top_k]
            return [(float(scores[idx]), int(idx)) for idx in top_indices]
        except Exception:
            return []

    def search(
        self,
        query: str,
        top_k: int = 5,
        candidate_k: int = 20,
        strategy: str = "bm25",
    ) -> list[HybridResult]:
        if strategy == "legacy":
            from .bug_memory import LegacyIndex

            legacy = LegacyIndex(self.cards)
            results = legacy.search(query, top_k)
            return [
                HybridResult(
                    card=MemoryCard.from_dict(self.cards[idx]),
                    score=score,
                    bm25_score=score,
                    method="legacy",
                )
                for score, card in results
                for idx, c in enumerate(self.cards)
                if c.get("id") == card.get("id")
            ][:top_k]

        if strategy in ("bm25", "bm25_filtered"):
            from .bug_memory import search_cards, search_cards_with_diagnostics

            if strategy == "bm25_filtered":
                results, _ = search_cards_with_diagnostics(
                    query, self.cards, top_k, strategy="bm25_filtered"
                )
            else:
                results = search_cards(query, self.cards, top_k, strategy="bm25")
            return [
                HybridResult(
                    card=MemoryCard.from_dict(card),
                    score=score,
                    bm25_score=score,
                    method=strategy,
                )
                for score, card in results
            ]

        if strategy == "hybrid":
            return self._hybrid_search(query, top_k, candidate_k)

        raise ValueError(f"Unknown retrieval strategy: {strategy}")

    def _hybrid_search(
        self, query: str, top_k: int = 5, candidate_k: int = 20
    ) -> list[HybridResult]:
        bm25_results = self.search_bm25(query, candidate_k)
        dense_results = self.search_dense(query, candidate_k)

        if not dense_results:
            return self.search(query, top_k, strategy="bm25")

        bm25_scores = {idx: score for score, idx in bm25_results}
        dense_scores = {idx: score for score, idx in dense_results}

        all_indices = set(bm25_scores) | set(dense_scores)

        bm25_max = max(bm25_scores.values()) if bm25_scores else 1.0
        dense_max = max(dense_scores.values()) if dense_scores else 1.0
        if bm25_max <= 0:
            bm25_max = 1.0
        if dense_max <= 0:
            dense_max = 1.0

        scored: list[tuple[float, int]] = []
        for idx in all_indices:
            bm25_norm = bm25_scores.get(idx, 0.0) / bm25_max
            dense_norm = dense_scores.get(idx, 0.0) / dense_max

            card = self.cards[idx] if idx < len(self.cards) else {}
            bonus = self._compute_language_bonus(card, query)
            bonus += self._compute_bug_type_bonus(card, query)
            penalty = self._compute_contamination_penalty(card)

            combined = (
                self.bm25_weight * bm25_norm
                + self.dense_weight * dense_norm
                + bonus
                + penalty
            )
            scored.append((combined, idx))

        scored.sort(key=lambda x: x[0], reverse=True)
        top = scored[:top_k]

        rank_bm25 = {idx: rank for rank, (_, idx) in enumerate(bm25_results)}
        rank_dense = {idx: rank for rank, (_, idx) in enumerate(dense_results)}

        return [
            HybridResult(
                card=MemoryCard.from_dict(self.cards[idx]),
                score=score,
                bm25_score=bm25_scores.get(idx, 0.0),
                dense_score=dense_scores.get(idx, 0.0),
                rank_bm25=rank_bm25.get(idx, 999),
                rank_dense=rank_dense.get(idx, 999),
                method="hybrid",
            )
            for score, idx in top
        ]


def format_hybrid_results(
    results: list[HybridResult], top_k: int = 5
) -> list[tuple[float, dict[str, Any]]]:
    formatted: list[tuple[float, dict[str, Any]]] = []
    for r in results[:top_k]:
        card_dict = r.card.to_dict()
        score = r.score
        existing = card_dict.get("id", card_dict.get("card_id"))
        if not existing:
            card_dict["id"] = r.card.card_id
        formatted.append((score, card_dict))
    return formatted
