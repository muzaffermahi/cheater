from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .memory_schema import MemoryCard


@dataclass
class IndexMetadata:
    index_type: str = ""
    card_count: int = 0
    dense_model: str = ""
    bm25_available: bool = False
    dense_available: bool = False
    created_at: str = ""
    cards_path: str = ""
    manifest: dict[str, Any] = field(default_factory=dict)


def load_cards(path: str | Path) -> list[MemoryCard]:
    p = Path(path).expanduser().resolve()
    cards: list[MemoryCard] = []
    with p.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
                cards.append(MemoryCard.from_dict(value))
            except (json.JSONDecodeError, KeyError) as exc:
                print(f"Warning: skipping invalid card on line {line_number}: {exc}")
    return cards


def save_index_metadata(meta: IndexMetadata, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "index_type": meta.index_type,
                "card_count": meta.card_count,
                "dense_model": meta.dense_model,
                "bm25_available": meta.bm25_available,
                "dense_available": meta.dense_available,
                "created_at": meta.created_at,
                "cards_path": meta.cards_path,
                "manifest": meta.manifest,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )


def load_index_metadata(path: Path) -> IndexMetadata:
    if not path.is_file():
        return IndexMetadata()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return IndexMetadata(
            index_type=raw.get("index_type", ""),
            card_count=raw.get("card_count", 0),
            dense_model=raw.get("dense_model", ""),
            bm25_available=raw.get("bm25_available", False),
            dense_available=raw.get("dense_available", False),
            created_at=raw.get("created_at", ""),
            cards_path=raw.get("cards_path", ""),
            manifest=raw.get("manifest", {}),
        )
    except (json.JSONDecodeError, OSError):
        return IndexMetadata()
