"""Index metadata for the lexical retrieval baseline.

The "built index" for the std-lib BM25F baseline is metadata pointing at the
canonical card file plus validation stats. The BM25F index itself is rebuilt
in memory at search time (fast for Cheater's corpus sizes). This keeps the
core dependency-free and avoids a custom on-disk format. Dense/embedding
backends are a future extension point (see cheater/errors.RetrievalBackend).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cheater import SCHEMA_VERSION
from cheater.retrieval import DEFAULT_FIELD_BOOSTS, stream_usable_cards


def build_index_metadata(cards_path: str | Path, index_dir: str | Path) -> dict[str, Any]:
    cards_p = Path(cards_path).resolve()
    index_d = Path(index_dir)
    index_d.mkdir(parents=True, exist_ok=True)

    usable = 0
    total = 0
    for card in stream_usable_cards(cards_p):
        usable += 1
        total = usable  # stream_usable_cards only yields usable
    # count total lines too (cheap separate pass for the manifest stat)
    from cheater.cards import read_jsonl
    total_lines = sum(1 for _ in read_jsonl(cards_p))

    meta = {
        "index_type": "bm25f_lexical",
        "schema_version": SCHEMA_VERSION,
        "cards_path": str(cards_p),
        "card_count_usable": usable,
        "card_count_total_lines": total_lines,
        "field_boosts": DEFAULT_FIELD_BOOSTS,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "backend": "stdlib_bm25f",
        "notes": "In-memory BM25F rebuilt at search time; no external services.",
    }
    meta_path = index_d / "index_metadata.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    meta["index_metadata_path"] = str(meta_path)
    return meta
