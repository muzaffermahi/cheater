from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_\.:-]*|\d+")
FIELD_WEIGHTS = {
    "search_text": 10.0,
    "error_signature": 8.0,
    "title": 7.0,
    "symptoms": 6.0,
    "root_cause": 5.0,
    "fix_pattern": 5.0,
    "patch_essence": 5.0,
    "language_or_framework": 4.0,
    "bug_type": 4.0,
    "changed_files": 3.0,
}


def tokenize(value: Any) -> set[str]:
    if isinstance(value, list):
        text = " ".join(str(item) for item in value)
    else:
        text = str(value or "")
    return {token.lower() for token in TOKEN_RE.findall(text) if len(token) >= 2}


def load_cards(path: Path) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                card = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"Warning: skipping invalid JSON on line {line_number}: {exc}")
                continue
            if isinstance(card, dict):
                cards.append(card)
    return cards


def score_card(query_tokens: set[str], card: dict[str, Any]) -> float:
    score = 0.0
    matched_tokens: set[str] = set()
    for field, weight in FIELD_WEIGHTS.items():
        field_tokens = tokenize(card.get(field))
        matches = query_tokens & field_tokens
        score += len(matches) * weight
        matched_tokens.update(matches)
    if query_tokens:
        score += 5.0 * len(matched_tokens) / len(query_tokens)
    return score


def print_list(label: str, value: Any) -> None:
    print(f"{label}:")
    items = value if isinstance(value, list) else []
    if not items:
        print("  (none)")
        return
    for item in items:
        print(f"  - {item}")


def print_result(card: dict[str, Any], rank: int, score: float, show_patch: bool) -> None:
    print("\n" + "=" * 88)
    print(f"#{rank}  score={score:.1f}")
    print("id:", card.get("id") or "")
    print("title:", card.get("title") or "")
    print("framework:", card.get("language_or_framework") or "")
    print("bug_type:", card.get("bug_type") or "")
    print("error_signature:", card.get("error_signature") or "")
    print_list("symptoms", card.get("symptoms"))
    print("root_cause:", card.get("root_cause") or "")
    print("fix_pattern:", card.get("fix_pattern") or "")
    print("patch_essence:", card.get("patch_essence") or "")
    print_list("when_to_use", card.get("when_to_use"))
    print_list("avoid", card.get("avoid"))
    print_list("changed files", card.get("changed_files"))
    if show_patch:
        print("\n--- patch ---")
        print((card.get("patch") or "").rstrip() or "(none)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Search compact solved bug cards.")
    parser.add_argument("query", nargs="+", help="Search query.")
    parser.add_argument("--cards", default="data/compact_bug_cards.jsonl")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--show-patch", action="store_true")
    args = parser.parse_args()

    path = Path(args.cards)
    if not path.exists():
        raise SystemExit(
            f"Compact card file not found: {path}. Run 04_compact_cards_llm.py first."
        )
    if args.top_k < 1:
        raise SystemExit("--top-k must be at least 1.")

    query = " ".join(args.query)
    query_tokens = tokenize(query)
    if not query_tokens:
        raise SystemExit("Empty query after tokenization.")

    cards = load_cards(path)
    print(f"Loaded {len(cards)} compact cards from {path}")
    print("Query:", query)
    if not cards:
        print("No compact cards found. Run 04_compact_cards_llm.py first.")
        return

    scored = [(score_card(query_tokens, card), card) for card in cards]
    scored = [(score, card) for score, card in scored if score > 0]
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored:
        print("No matches.")
        return

    for rank, (score, card) in enumerate(scored[: args.top_k], start=1):
        print_result(card, rank, score, args.show_patch)


if __name__ == "__main__":
    main()
