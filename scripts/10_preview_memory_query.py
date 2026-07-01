from __future__ import annotations

import argparse
from pathlib import Path

from cheater.legacy.bug_memory import format_memory_block, load_cards, search_cards


def main() -> None:
    parser = argparse.ArgumentParser(description="Preview compact bug memories for a query.")
    parser.add_argument("query", nargs="+", help="Memory search query.")
    parser.add_argument("--cards", default="data/compact_bug_cards.jsonl")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--include-patch", action="store_true")
    args = parser.parse_args()

    if args.top_k < 1:
        raise SystemExit("--top-k must be at least 1.")
    cards_path = Path(args.cards)
    if not cards_path.exists():
        raise SystemExit(
            f"Compact card file not found: {cards_path}. Run 04_compact_cards_llm.py first."
        )

    query = " ".join(args.query)
    cards = load_cards(cards_path)
    results = search_cards(query, cards, args.top_k)
    print(f"Loaded {len(cards)} compact cards from {cards_path}")
    print("Query:", query)
    print()
    print(format_memory_block(results, args.include_patch), end="")


if __name__ == "__main__":
    main()
