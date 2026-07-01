from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_\.:-]*|\d+")


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_RE.findall(text or "") if len(t) >= 2]


def load_cards(path: Path) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                cards.append(json.loads(line))
    return cards


def score_card(query_tokens: list[str], card: dict[str, Any]) -> float:
    search_text = (card.get("search_text") or "").lower()
    error_text = (card.get("error_excerpt") or "").lower()
    issue_text = (card.get("issue") or "").lower()
    patch_text = (card.get("patch_summary") or "").lower()

    score = 0.0
    for tok in query_tokens:
        # Exact-ish weighted contains scoring. Dumb but useful.
        if tok in error_text:
            score += 8.0
        if tok in issue_text:
            score += 4.0
        if tok in patch_text:
            score += 3.0
        if tok in search_text:
            score += 1.0

    # Bonus for error words
    for important in ["traceback", "assertionerror", "typeerror", "modulenotfounderror", "importerror", "failed"]:
        if important in query_tokens and important in search_text:
            score += 10.0

    return score


def print_result(card: dict[str, Any], rank: int, score: float, show_patch_chars: int) -> None:
    print("\n" + "=" * 100)
    print(f"#{rank}  score={score:.1f}")
    print("id:", card.get("id"))
    print("model:", card.get("model_name"))
    print("target:", card.get("target"))
    print("exit_status:", card.get("exit_status"))
    print("test_status_detected:", card.get("test_status_detected"))
    print("\n--- error excerpt ---")
    print((card.get("error_excerpt") or "")[:1800].strip() or "(none)")
    print("\n--- patch summary ---")
    print(card.get("patch_summary") or "")
    print("\n--- changed files ---")
    print(", ".join(card.get("changed_files") or []))
    print("\n--- issue preview ---")
    print((card.get("issue") or "")[:1500].strip())
    if show_patch_chars > 0:
        print("\n--- patch preview ---")
        print((card.get("patch") or "")[:show_patch_chars].rstrip())


def main() -> None:
    parser = argparse.ArgumentParser(description="Search solved bug cards.")
    parser.add_argument("query", nargs="+", help="Search query, for example: TypeError string indices table output")
    parser.add_argument("--cards", default="data/solved_bug_cards.jsonl")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--show-patch-chars", type=int, default=2500)
    args = parser.parse_args()

    path = Path(args.cards)
    if not path.exists():
        raise SystemExit(f"Card file not found: {path}. Run 02_build_solved_bug_cards.py first.")

    query = " ".join(args.query)
    query_tokens = tokenize(query)

    if not query_tokens:
        raise SystemExit("Empty query after tokenization.")

    cards = load_cards(path)
    print(f"Loaded {len(cards)} cards from {path}")
    print("Query:", query)

    scored = []
    for card in cards:
        s = score_card(query_tokens, card)
        if s > 0:
            scored.append((s, card))

    scored.sort(key=lambda x: x[0], reverse=True)

    if not scored:
        print("No matches.")
        return

    for rank, (score, card) in enumerate(scored[: args.top_k], start=1):
        print_result(card, rank, score, args.show_patch_chars)


if __name__ == "__main__":
    main()
