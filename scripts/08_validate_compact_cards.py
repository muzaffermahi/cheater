from __future__ import annotations

import argparse
import json
from pathlib import Path


REQUIRED_FIELDS = {
    "id",
    "title",
    "error_signature",
    "symptoms",
    "root_cause",
    "fix_pattern",
    "patch_essence",
    "avoid",
    "changed_files",
    "search_text",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate compact bug-memory JSONL cards.")
    parser.add_argument("--cards", default="data/compact_bug_cards.jsonl")
    args = parser.parse_args()
    path = Path(args.cards)
    if not path.exists():
        raise SystemExit(f"Compact card file not found: {path}")

    count = 0
    invalid = 0
    duplicate_ids = 0
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            count += 1
            try:
                card = json.loads(line)
            except json.JSONDecodeError as exc:
                invalid += 1
                print(f"[INVALID] line {line_number}: {exc}")
                continue
            if not isinstance(card, dict):
                invalid += 1
                print(f"[INVALID] line {line_number}: expected a JSON object")
                continue
            missing = sorted(REQUIRED_FIELDS - set(card))
            if missing:
                invalid += 1
                print(f"[INVALID] line {line_number}: missing {', '.join(missing)}")
            card_id = str(card.get("id") or "")
            if card_id in seen:
                duplicate_ids += 1
                print(f"[DUPLICATE] line {line_number}: {card_id}")
            seen.add(card_id)

    print(f"Cards: {count}")
    print(f"Invalid: {invalid}")
    print(f"Duplicate IDs: {duplicate_ids}")
    if invalid or duplicate_ids:
        raise SystemExit(1)
    print("Compact card validation passed.")


if __name__ == "__main__":
    main()
