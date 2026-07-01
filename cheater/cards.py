"""Streaming JSONL readers for memory cards.

Never loads the whole dataset into memory. Invalid JSON produces a clear
CardError naming the file and 1-based line number. Duplicate ids are detected.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

from cheater.errors import CardError
from cheater.schema import normalize_and_validate, validate_card


class CardLineError(CardError):
    """A card error tied to a specific file:line."""

    def __init__(self, path: Path, line: int, message: str) -> None:
        self.path = path
        self.line = line
        super().__init__(f"{path}:{line}: {message}")


def read_jsonl(path: str | Path) -> Iterator[dict[str, Any]]:
    """Stream raw JSON objects from a JSONL file. Raises CardLineError on bad JSON."""
    p = Path(path)
    if not p.is_file():
        raise CardError(f"Card file not found: {p}")
    with p.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            text = line.strip()
            if not text:
                continue
            import json
            try:
                value = json.loads(text)
            except json.JSONDecodeError as exc:
                raise CardLineError(p, line_no, f"invalid JSON: {exc}") from exc
            if not isinstance(value, dict):
                raise CardLineError(p, line_no, "expected a JSON object")
            yield value


def read_cards(
    path: str | Path,
    *,
    normalize: bool = True,
    skip_invalid: bool = False,
) -> Iterator[tuple[int, dict[str, Any]]]:
    """Stream cards as (line_no, card). If normalize, yields canonical v1 cards.

    With skip_invalid=False (default), schema-invalid cards raise CardLineError.
    With skip_invalid=True, invalid cards are skipped (errors collected by caller).
    """
    for line_no, raw in read_jsonl(path):
        if normalize:
            card, result = normalize_and_validate(raw)
            if not result.ok and not skip_invalid:
                raise CardLineError(Path(path), line_no, "; ".join(result.errors))
            yield line_no, card
        else:
            yield line_no, raw


def load_card_ids(path: str | Path) -> set[str]:
    """Read only ids (for resume/dedup). Tolerant of incomplete records."""
    ids: set[str] = set()
    p = Path(path)
    if not p.is_file():
        return ids
    import json
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            text = line.strip()
            if not text:
                continue
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                cid = value.get("id")
                if isinstance(cid, str) and cid:
                    ids.add(cid)
    return ids


def detect_duplicates(path: str | Path) -> list[tuple[str, int]]:
    """Return list of (id, line) for duplicate ids (second+ occurrence)."""
    seen: set[str] = set()
    dups: list[tuple[str, int]] = []
    for line_no, raw in read_jsonl(path):
        cid = str(raw.get("id") or "")
        if cid in seen:
            dups.append((cid, line_no))
        else:
            seen.add(cid)
    return dups
