"""Embed all 13,389 usable v1 cards with nomic-embed and cache to disk."""
from __future__ import annotations

import json
import time
from pathlib import Path
import numpy as np

REPO_ROOT = Path(__file__).resolve().parent
CARDS_PATH = REPO_ROOT / "data" / "cards" / "cards.v1.jsonl"
CACHE_PATH = REPO_ROOT / "data" / "indexes" / "v1_usable_embeddings.npy"
IDS_PATH = REPO_ROOT / "data" / "indexes" / "v1_usable_ids.json"

EMBED_MODEL = "nomic-embed"
LLM_BASE_URL = "http://127.0.0.1:1234/v1"
LLM_API_KEY = "lm-studio"
BATCH = 128


def make_rich_text(card: dict) -> str:
    """Combine fields for embedding."""
    parts = []
    for field in ("symptom", "root_cause", "fix_pattern", "embedding_text"):
        val = str(card.get(field) or "").strip()
        if val:
            parts.append(val)
    kws = card.get("search_keywords") or []
    if isinstance(kws, list):
        parts.extend(str(k) for k in kws if str(k).strip())
    return " ".join(parts)[:2000]


def main():
    from openai import OpenAI
    client = OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)

    # Load all usable cards
    print("Loading usable v1 cards...", flush=True)
    cards = []
    with CARDS_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                c = json.loads(line)
                if c.get("usable") is True:
                    cards.append(c)
    print(f"  {len(cards)} usable cards", flush=True)

    # Check if cache already exists and is valid
    if CACHE_PATH.is_file() and IDS_PATH.is_file():
        cached_ids = json.loads(IDS_PATH.read_text(encoding="utf-8"))
        if len(cached_ids) == len(cards):
            print(f"Cache already exists with {len(cached_ids)} cards. Skipping.")
            return

    # Build rich texts
    print("Building rich embedding texts...", flush=True)
    texts = [make_rich_text(c) for c in cards]
    ids = [str(c.get("id") or "") for c in cards]

    # Embed in batches
    print(f"Embedding {len(texts)} cards (batch={BATCH})...", flush=True)
    all_embs = []
    t0 = time.perf_counter()
    for i in range(0, len(texts), BATCH):
        chunk = texts[i:i+BATCH]
        r = client.embeddings.create(model=EMBED_MODEL, input=chunk)
        all_embs.extend([d.embedding for d in r.data])
        done = min(i + BATCH, len(texts))
        if done % 512 == 0 or done == len(texts):
            elapsed = time.perf_counter() - t0
            rate = done / elapsed
            eta = (len(texts) - done) / rate if rate > 0 else 0
            print(f"  embedded {done}/{len(texts)} ({rate:.0f}/s, ETA {eta:.0f}s)", flush=True)

    embeddings = np.array(all_embs, dtype=np.float32)
    elapsed = time.perf_counter() - t0
    print(f"Done in {elapsed:.0f}s. Shape: {embeddings.shape}", flush=True)

    # Save
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    np.save(str(CACHE_PATH), embeddings)
    IDS_PATH.write_text(json.dumps(ids, ensure_ascii=False), encoding="utf-8")
    print(f"Saved embeddings to {CACHE_PATH} ({embeddings.nbytes / 1024 / 1024:.1f} MB)", flush=True)
    print(f"Saved ids to {IDS_PATH}", flush=True)


if __name__ == "__main__":
    main()
