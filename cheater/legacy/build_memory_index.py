from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

from .bug_memory import tokenize_terms
from .memory_index import IndexMetadata, save_index_metadata


try:
    import orjson
except ImportError:
    orjson = None


def _loads_json(line: str) -> Any:
    if orjson is not None:
        return orjson.loads(line)
    return json.loads(line)


def _iter_card_dicts(cards_path: Path) -> Any:
    with cards_path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                card = _loads_json(line)
            except json.JSONDecodeError as exc:
                print(f"Warning: skipping invalid card on line {line_number}: {exc}")
                continue
            except Exception as exc:
                print(f"Warning: skipping invalid card on line {line_number}: {exc}")
                continue
            if isinstance(card, dict):
                yield card


def _bm25_token_count(card: dict[str, Any]) -> int:
    text = str(card.get("card_text_bm25") or card.get("search_text") or "")
    return len(tokenize_terms(text))


def _fts_text(card: dict[str, Any]) -> str:
    fields = [
        card.get("card_text_bm25"),
        card.get("title"),
        card.get("error_signature"),
        card.get("symptoms"),
        card.get("root_cause_summary") or card.get("root_cause"),
        card.get("fix_pattern_summary") or card.get("fix_pattern"),
        card.get("changed_files"),
        card.get("language"),
        card.get("source_repo"),
    ]
    parts: list[str] = []
    for value in fields:
        if isinstance(value, list):
            parts.append(" ".join(str(item) for item in value))
        elif value:
            parts.append(str(value))
    return "\n".join(parts)


def _build_sqlite_fts(
    cards_path: Path,
    output_dir: Path,
    *,
    progress_every: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    db_path = output_dir / "cards_fts.sqlite"
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA cache_size=-200000")
        conn.execute(
            "CREATE VIRTUAL TABLE cards_fts USING fts5("
            "card_id UNINDEXED, text, card_json UNINDEXED)"
        )

        batch: list[tuple[str, str, str]] = []
        card_count = 0
        with conn:
            for card in _iter_card_dicts(cards_path):
                card_count += 1
                card_id = str(card.get("card_id") or card.get("id") or f"card_{card_count}")
                batch.append(
                    (
                        card_id,
                        _fts_text(card),
                        json.dumps(card, ensure_ascii=False, separators=(",", ":")),
                    )
                )
                if len(batch) >= 5_000:
                    conn.executemany(
                        "INSERT INTO cards_fts(card_id, text, card_json) VALUES (?, ?, ?)",
                        batch,
                    )
                    batch.clear()
                if progress_every and card_count % progress_every == 0:
                    elapsed = max(0.001, time.perf_counter() - started)
                    print(
                        f"  indexed {card_count} cards into SQLite FTS "
                        f"({card_count / elapsed:.0f} cards/s)"
                    )
            if batch:
                conn.executemany(
                    "INSERT INTO cards_fts(card_id, text, card_json) VALUES (?, ?, ?)",
                    batch,
                )
        conn.execute("INSERT INTO cards_fts(cards_fts) VALUES ('optimize')")
    finally:
        conn.close()

    return {
        "status": "built",
        "path": str(db_path),
        "card_count": card_count,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
    }


def _build_bm25_cache(
    cards_path: Path,
    output_dir: Path,
    *,
    workers: int,
    chunksize: int,
    progress_every: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    token_counts: list[int] = []

    if workers <= 1:
        for card_count, card in enumerate(_iter_card_dicts(cards_path), start=1):
            token_counts.append(_bm25_token_count(card))
            if progress_every and card_count % progress_every == 0:
                elapsed = max(0.001, time.perf_counter() - started)
                print(
                    f"  tokenized {card_count} cards "
                    f"({card_count / elapsed:.0f} cards/s)"
                )
    else:
        with ProcessPoolExecutor(max_workers=workers) as executor:
            for card_count, token_count in enumerate(
                executor.map(
                    _bm25_token_count,
                    _iter_card_dicts(cards_path),
                    chunksize=chunksize,
                ),
                start=1,
            ):
                token_counts.append(token_count)
                if progress_every and card_count % progress_every == 0:
                    elapsed = max(0.001, time.perf_counter() - started)
                    print(
                        f"  tokenized {card_count} cards "
                        f"({card_count / elapsed:.0f} cards/s)"
                    )

    cache_path = output_dir / "bm25_token_cache.json"
    with cache_path.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "card_count": len(token_counts),
                "tokens_per_card": token_counts,
                "workers": workers,
                "chunksize": chunksize,
                "elapsed_seconds": round(time.perf_counter() - started, 3),
            },
            f,
            separators=(",", ":"),
        )
    fts = _build_sqlite_fts(
        cards_path,
        output_dir,
        progress_every=progress_every,
    )

    return {
        "card_count": len(token_counts),
        "cache_path": str(cache_path),
        "workers": workers,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "sqlite_fts": fts,
    }


def _load_cards_for_dense(cards_path: Path) -> list[dict[str, Any]]:
    cards_dicts = list(_iter_card_dicts(cards_path))
    print(f"Loaded {len(cards_dicts)} cards from {cards_path}")
    return cards_dicts


def _try_build_dense(
    cards: list[dict[str, Any]],
    model_name: str,
    output_dir: Path,
) -> dict[str, Any]:
    import importlib.util

    has_sentence_transformers = (
        importlib.util.find_spec("sentence_transformers") is not None
    )

    if not has_sentence_transformers:
        print(
            "sentence-transformers not installed. Install with: "
            "pip install sentence-transformers"
        )
        return {
            "status": "skipped",
            "reason": "sentence_transformers_not_installed",
        }

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        return {
            "status": "skipped",
            "reason": "sentence_transformers_import_failed",
        }

    short_name = model_name.replace("/", "_").replace("-", "_")
    model_dir = output_dir / "dense" / short_name
    model_dir.mkdir(parents=True, exist_ok=True)

    try:
        model = SentenceTransformer(model_name)
        texts = [
            str(card.get("card_text_dense") or card.get("card_text_bm25") or "")
            for card in cards
        ]
        embeddings = model.encode(texts, show_progress_bar=False)

        import numpy as np

        emb_path = model_dir / "embeddings.npy"
        np.save(str(emb_path), embeddings.astype(np.float16))

        id_map = [
            {"index": i, "card_id": card.get("card_id") or f"card_{i}"}
            for i, card in enumerate(cards)
        ]
        id_map_path = model_dir / "id_map.json"
        with id_map_path.open("w", encoding="utf-8") as f:
            json.dump(id_map, f, indent=2)

        return {
            "status": "built",
            "model": model_name,
            "embedding_dim": embeddings.shape[1],
            "card_count": len(cards),
            "embeddings_path": str(emb_path),
            "device": str(model.device),
        }
    except Exception as exc:
        return {
            "status": "error",
            "model": model_name,
            "error": str(exc),
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build memory indexes (BM25 + optional dense)."
    )
    parser.add_argument("--cards", required=True, help="Input cards JSONL file.")
    parser.add_argument(
        "--out",
        default="memory_store/indexes/default",
        help="Output index directory.",
    )
    parser.add_argument("--bm25", action="store_true", help="Build BM25 index.")
    parser.add_argument(
        "--dense",
        default=None,
        help="Dense model name (e.g. all-MiniLM-L6-v2 or BAAI/bge-small-en-v1.5).",
    )
    parser.add_argument(
        "--force", action="store_true", help="Rebuild even if index exists."
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, (os.cpu_count() or 2) - 1),
        help="Worker processes for BM25 tokenization (default: CPU count - 1).",
    )
    parser.add_argument(
        "--chunksize",
        type=int,
        default=1_000,
        help="Cards per multiprocessing task chunk for BM25 (default: 1000).",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=50_000,
        help="Print BM25 progress every N cards (default: 50000).",
    )
    args = parser.parse_args(argv)

    if not args.bm25 and not args.dense:
        print("Specify --bm25 and/or --dense <model>.")
        return 2

    cards_path = Path(args.cards).expanduser().resolve()
    if not cards_path.is_file():
        print(f"Cards file not found: {cards_path}")
        return 1

    output_dir = Path(args.out).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {}
    bm25_available = False
    dense_available = False
    dense_model = args.dense or ""
    card_count = 0
    cards_dicts: list[dict[str, Any]] | None = None

    if args.bm25:
        workers = max(1, args.workers)
        print(f"Building BM25 index with {workers} worker(s)...")
        bm25_cache = _build_bm25_cache(
            cards_path,
            output_dir,
            workers=workers,
            chunksize=max(1, args.chunksize),
            progress_every=max(0, args.progress_every),
        )
        manifest["bm25"] = bm25_cache
        bm25_available = True
        card_count = int(bm25_cache["card_count"])
        print(f"  BM25 token cache: {bm25_cache['cache_path']}")

    if args.dense:
        cards_dicts = _load_cards_for_dense(cards_path)
        card_count = len(cards_dicts)
        print(f"Building dense index with model: {args.dense}")
        dense_result = _try_build_dense(cards_dicts, args.dense, output_dir)
        manifest["dense"] = dense_result
        if dense_result.get("status") == "built":
            dense_available = True
            print(f"  Dense embeddings: {dense_result['embeddings_path']}")
        else:
            print(
                f"  Dense index skipped: {dense_result.get('reason', dense_result.get('error', 'unknown'))}"
            )

    meta = IndexMetadata(
        index_type="bm25_dense" if dense_available else "bm25",
        card_count=card_count,
        dense_model=dense_model,
        bm25_available=bm25_available,
        dense_available=dense_available,
        created_at=datetime.now().isoformat(timespec="seconds"),
        cards_path=str(cards_path.resolve()),
        manifest=manifest,
    )
    meta_path = output_dir / "index_metadata.json"
    save_index_metadata(meta, meta_path)
    print(f"\nIndex metadata saved to {meta_path}")
    print(f"BM25: {'available' if bm25_available else 'not built'}")
    print(f"Dense: {'available' if dense_available else 'not available'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
