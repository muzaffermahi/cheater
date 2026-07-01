from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_\.:-]*|\d+")
FIELD_WEIGHTS = {
    "search_text": 10.0,
    "card_text_bm25": 10.0,
    "error_signature": 8.0,
    "title": 7.0,
    "symptoms": 6.0,
    "root_cause": 5.0,
    "root_cause_summary": 5.0,
    "fix_pattern": 5.0,
    "fix_pattern_summary": 5.0,
    "patch_essence": 5.0,
    "language_or_framework": 4.0,
    "bug_type": 4.0,
    "changed_files": 3.0,
}

BM25_FIELD_WEIGHTS = {
    "search_text": 2.0,
    "card_text_bm25": 2.0,
    "error_signature": 2.5,
    "title": 2.0,
    "symptoms": 1.7,
    "root_cause": 1.5,
    "root_cause_summary": 1.5,
    "fix_pattern": 1.5,
    "fix_pattern_summary": 1.5,
    "patch_essence": 1.5,
    "language_or_framework": 0.8,
    "bug_type": 1.0,
    "changed_files": 0.6,
}

MAX_DEFAULT_CORPUS_BYTES = 256 * 1024 * 1024


def inspect_cards_corpus(path: str | Path) -> dict[str, Any]:
    card_path = Path(path).expanduser().resolve()
    result: dict[str, Any] = {
        "path": str(card_path),
        "exists": card_path.is_file(),
        "size_bytes": card_path.stat().st_size if card_path.is_file() else None,
        "format": "missing",
        "supported": False,
        "first_card_keys": [],
        "error": None,
    }
    if not card_path.is_file():
        result["error"] = f"Memory cards file not found: {card_path}"
        return result
    first: dict[str, Any] | None = None
    try:
        with card_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    value = json.loads(line)
                    if isinstance(value, dict):
                        first = value
                    break
    except (OSError, json.JSONDecodeError) as exc:
        result["format"] = "invalid_jsonl"
        result["error"] = str(exc)
        return result
    if first is None:
        result["format"] = "empty"
        result["error"] = "Memory cards file contains no JSON objects."
        return result
    keys = sorted(str(key) for key in first)
    result["first_card_keys"] = keys
    key_set = set(keys)
    if {"title", "root_cause", "fix_pattern", "search_text"}.issubset(key_set):
        result["format"] = "compact_cards"
        result["supported"] = True
    elif {"issue", "error_excerpt", "patch_summary", "search_text"}.issubset(key_set):
        result["format"] = "solved_trajectory_cards"
        result["supported"] = True
    elif "trajectory" in key_set:
        result["format"] = "raw_trajectory_rows"
        result["error"] = (
            "Raw trajectory rows are not runtime cards. Convert them first with "
            "02_build_solved_bug_cards.py."
        )
    elif {"raw_preview", "error_excerpt"}.issubset(key_set):
        result["format"] = "raw_preview_rows"
        result["error"] = (
            "Raw preview rows are not searchable runtime cards. Use "
            "data/compact_bug_cards.jsonl, or rebuild solved trajectory cards with "
            "02_build_solved_bug_cards.py from the original dataset."
        )
    elif {"card_id", "card_text_bm25", "source_dataset"}.issubset(key_set):
        result["format"] = "memory_store_cards"
        result["supported"] = True
    else:
        result["format"] = "unknown_cards"
        result["error"] = "Unrecognized memory card fields."
    return result


def load_cards(path: str | Path) -> list[dict[str, Any]]:
    card_path = Path(path)
    cards: list[dict[str, Any]] = []
    with card_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                card = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"Warning: skipping invalid card on line {line_number}: {exc}")
                continue
            if isinstance(card, dict):
                cards.append(card)
    return cards


def tokenize(text: Any) -> set[str]:
    return set(tokenize_terms(text))


def tokenize_terms(text: Any) -> list[str]:
    if isinstance(text, list):
        text = " ".join(str(item) for item in text)
    return [
        token.lower() for token in TOKEN_RE.findall(str(text or "")) if len(token) >= 2
    ]


def score_card(
    query: str,
    card: dict[str, Any],
    field_weights: dict[str, float] | None = None,
) -> float:
    query_tokens = tokenize(query)
    if not query_tokens:
        return 0.0

    score = 0.0
    matched: set[str] = set()
    for field_name, weight in (field_weights or FIELD_WEIGHTS).items():
        matches = query_tokens & tokenize(card.get(field_name))
        score += len(matches) * weight
        matched.update(matches)

    # Prefer cards that cover more of the query when weighted scores are close.
    score += 5.0 * len(matched) / len(query_tokens)
    return score


@dataclass
class LegacyIndex:
    cards: list[dict[str, Any]]
    field_weights: dict[str, float] = field(default_factory=lambda: dict(FIELD_WEIGHTS))
    _tokens: list[dict[str, set[str]]] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._tokens = [
            {
                field_name: tokenize(card.get(field_name))
                for field_name in self.field_weights
            }
            for card in self.cards
        ]

    def score(self, query: str, card_index: int) -> float:
        query_tokens = tokenize(query)
        return self.score_tokens(query_tokens, card_index)

    def score_tokens(self, query_tokens: set[str], card_index: int) -> float:
        if not query_tokens:
            return 0.0
        score = 0.0
        matched: set[str] = set()
        for field_name, weight in self.field_weights.items():
            matches = query_tokens & self._tokens[card_index][field_name]
            score += len(matches) * weight
            matched.update(matches)
        score += 5.0 * len(matched) / len(query_tokens)
        return score

    def search(self, query: str, top_k: int = 5) -> list[tuple[float, dict[str, Any]]]:
        if top_k < 1:
            return []
        scored = [
            (self.score(query, index), card) for index, card in enumerate(self.cards)
        ]
        matches = [(score, card) for score, card in scored if score > 0]
        matches.sort(key=lambda item: item[0], reverse=True)
        return matches[:top_k]


@dataclass
class BM25Index:
    cards: list[dict[str, Any]]
    field_weights: dict[str, float] = field(
        default_factory=lambda: dict(BM25_FIELD_WEIGHTS)
    )
    k1: float = 1.2
    b: float = 0.75
    _term_counts: list[dict[str, Counter[str]]] = field(init=False, repr=False)
    _field_lengths: list[dict[str, int]] = field(init=False, repr=False)
    _average_lengths: dict[str, float] = field(init=False, repr=False)
    _document_frequency: Counter[str] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._term_counts = []
        self._field_lengths = []
        self._document_frequency = Counter()
        length_totals: Counter[str] = Counter()
        for card in self.cards:
            card_counts: dict[str, Counter[str]] = {}
            card_lengths: dict[str, int] = {}
            document_terms: set[str] = set()
            for field_name in self.field_weights:
                terms = tokenize_terms(card.get(field_name))
                counts = Counter(terms)
                card_counts[field_name] = counts
                card_lengths[field_name] = len(terms)
                length_totals[field_name] += len(terms)
                document_terms.update(counts)
            self._term_counts.append(card_counts)
            self._field_lengths.append(card_lengths)
            self._document_frequency.update(document_terms)
        count = max(1, len(self.cards))
        self._average_lengths = {
            field_name: max(1.0, length_totals[field_name] / count)
            for field_name in self.field_weights
        }

    def inverse_document_frequency(self, term: str) -> float:
        document_count = len(self.cards)
        frequency = self._document_frequency.get(term, 0)
        if document_count == 0 or frequency == 0:
            return 0.0
        return math.log(1.0 + (document_count - frequency + 0.5) / (frequency + 0.5))

    def score(self, query: str, card_index: int) -> float:
        query_terms = set(tokenize_terms(query))
        return self.score_terms(query_terms, card_index)

    def score_terms(self, query_terms: set[str], card_index: int) -> float:
        if not query_terms or not self.cards:
            return 0.0
        score = 0.0
        matched = 0
        for term in query_terms:
            weighted_frequency = 0.0
            for field_name, boost in self.field_weights.items():
                term_frequency = self._term_counts[card_index][field_name].get(term, 0)
                if not term_frequency:
                    continue
                length = self._field_lengths[card_index][field_name]
                average = self._average_lengths[field_name]
                normalization = 1.0 - self.b + self.b * length / average
                weighted_frequency += boost * term_frequency / normalization
            if weighted_frequency <= 0:
                continue
            matched += 1
            saturation = (
                (self.k1 + 1.0) * weighted_frequency / (self.k1 + weighted_frequency)
            )
            score += self.inverse_document_frequency(term) * saturation
        coverage = matched / len(query_terms)
        return score + coverage

    def explain(
        self,
        query: str,
        card_index: int,
        *,
        anchor_count: int = 12,
    ) -> dict[str, Any]:
        query_terms = set(tokenize_terms(query))
        contributions: dict[str, float] = {}
        matched_fields: dict[str, list[str]] = {}
        for term in query_terms:
            weighted_frequency = 0.0
            fields: list[str] = []
            for field_name, boost in self.field_weights.items():
                term_frequency = self._term_counts[card_index][field_name].get(term, 0)
                if not term_frequency:
                    continue
                fields.append(field_name)
                length = self._field_lengths[card_index][field_name]
                average = self._average_lengths[field_name]
                normalization = 1.0 - self.b + self.b * length / average
                weighted_frequency += boost * term_frequency / normalization
            if weighted_frequency <= 0:
                continue
            saturation = (
                (self.k1 + 1.0) * weighted_frequency / (self.k1 + weighted_frequency)
            )
            contributions[term] = self.inverse_document_frequency(term) * saturation
            matched_fields[term] = fields
        anchors = [
            term
            for term in sorted(
                query_terms,
                key=lambda value: (-self.inverse_document_frequency(value), value),
            )
            if self.inverse_document_frequency(term) > 0
        ][: max(0, anchor_count)]
        matched_anchors = [term for term in anchors if term in contributions]
        return {
            "score": self.score_terms(query_terms, card_index),
            "query_term_count": len(query_terms),
            "matched_term_count": len(contributions),
            "coverage": len(contributions) / len(query_terms) if query_terms else 0.0,
            "anchors": anchors,
            "matched_anchors": matched_anchors,
            "term_contributions": dict(
                sorted(contributions.items(), key=lambda item: item[1], reverse=True)
            ),
            "matched_fields": matched_fields,
        }

    def search(self, query: str, top_k: int = 5) -> list[tuple[float, dict[str, Any]]]:
        if top_k < 1:
            return []
        scored = [
            (self.score(query, index), card) for index, card in enumerate(self.cards)
        ]
        matches = [(score, card) for score, card in scored if score > 0]
        matches.sort(key=lambda item: item[0], reverse=True)
        return matches[:top_k]


def search_cards(
    query: str,
    cards: list[dict[str, Any]],
    top_k: int = 5,
    *,
    strategy: str = "legacy",
) -> list[tuple[float, dict[str, Any]]]:
    results, _ = search_cards_with_diagnostics(query, cards, top_k, strategy=strategy)
    return results


def search_cards_with_diagnostics(
    query: str,
    cards: list[dict[str, Any]],
    top_k: int = 5,
    *,
    strategy: str = "legacy",
    minimum_anchor_matches: int = 2,
    minimum_score_margin: float = 5.0,
) -> tuple[list[tuple[float, dict[str, Any]]], dict[str, Any]]:
    if top_k < 1:
        return [], {"strategy": strategy, "returned": 0, "reason": "top_k_below_one"}
    if strategy == "legacy":
        results = LegacyIndex(cards).search(query, top_k)
        return results, {
            "strategy": strategy,
            "returned": len(results),
            "top_score": results[0][0] if results else None,
            "reason": "legacy_ranked",
        }
    if strategy not in {"bm25", "bm25_filtered"}:
        raise ValueError(f"Unknown retrieval strategy: {strategy}")
    index = BM25Index(cards)
    candidates = index.search(query, max(top_k, 2))
    if not candidates:
        return [], {
            "strategy": strategy,
            "returned": 0,
            "reason": "no_lexical_matches",
        }
    card_positions = {id(card): position for position, card in enumerate(cards)}
    top_score, top_card = candidates[0]
    runner_up_score = candidates[1][0] if len(candidates) > 1 else 0.0
    explanation = index.explain(query, card_positions[id(top_card)])
    margin = top_score - runner_up_score
    diagnostics = {
        "strategy": strategy,
        "top_score": top_score,
        "runner_up_score": runner_up_score,
        "score_margin": margin,
        "query_anchors": explanation["anchors"],
        "matched_anchors": explanation["matched_anchors"],
        "matched_terms": list(explanation["term_contributions"]),
        "coverage": explanation["coverage"],
        "minimum_anchor_matches": minimum_anchor_matches,
        "minimum_score_margin": minimum_score_margin,
    }
    if strategy == "bm25":
        results = candidates[:top_k]
        diagnostics.update({"returned": len(results), "reason": "bm25_ranked"})
        return results, diagnostics
    enough_anchors = len(explanation["matched_anchors"]) >= minimum_anchor_matches
    enough_margin = margin >= minimum_score_margin
    if enough_anchors and enough_margin:
        diagnostics.update({"returned": 1, "reason": "confidence_filter_passed"})
        return [candidates[0]], diagnostics
    reasons: list[str] = []
    if not enough_anchors:
        reasons.append("insufficient_anchor_matches")
    if not enough_margin:
        reasons.append("insufficient_score_margin")
    diagnostics.update({"returned": 0, "reason": "+".join(reasons)})
    return [], diagnostics


def _format_list(value: Any) -> str:
    if not isinstance(value, list) or not value:
        return "(none)"
    return "; ".join(str(item) for item in value)


def format_memory_block(
    results: list[tuple[float, dict[str, Any]]], include_patch: bool = False
) -> str:
    if not results:
        return "No matching solved bug memories were found."

    blocks: list[str] = []
    for rank, (score, card) in enumerate(results, start=1):
        card_id = card.get("card_id") or card.get("id") or ""
        block = [
            f"## Memory {rank}: {card.get('title') or '(untitled)'}",
            "",
            f"- ID: {card_id}",
            f"- Retrieval score: {score:.1f}",
            f"- Language/framework: {card.get('language_or_framework') or '(unknown)'}",
            f"- Bug type: {card.get('bug_type') or '(unknown)'}",
            f"- Error signature: {card.get('error_signature') or '(none)'}",
            f"- Symptoms: {_format_list(card.get('symptoms'))}",
            f"- Root cause: {card.get('root_cause') or card.get('root_cause_summary') or '(none)'}",
            f"- Fix pattern: {card.get('fix_pattern') or card.get('fix_pattern_summary') or '(none)'}",
            f"- Patch essence: {card.get('patch_essence') or '(none)'}",
            f"- When to use: {_format_list(card.get('when_to_use'))}",
            f"- Avoid: {_format_list(card.get('avoid'))}",
            f"- Changed files: {_format_list(card.get('changed_files'))}",
        ]
        if include_patch:
            block.extend(
                [
                    "",
                    "<details>",
                    "<summary>Reference patch</summary>",
                    "",
                    "```diff",
                    str(card.get("patch") or "").rstrip(),
                    "```",
                    "</details>",
                ]
            )
        blocks.append("\n".join(block))
    return "\n\n".join(blocks) + "\n"
