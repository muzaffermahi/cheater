# Hybrid Retrieval Report

Date: 2026-06-23

## Overview

Hybrid retrieval combines BM25 lexical scores with dense embedding similarity for
memory-card retrieval. It is an optional extension to Cheater's existing retrieval
strategies (legacy, bm25, bm25_filtered).

## Architecture

### Index Building (`build_memory_index.py`)

Two index types:
1. **BM25 cache** — token cache stored as JSON (always built with `--bm25`)
2. **Dense embeddings** — float16 `.npy` files + id_map.json (built with `--dense <model>`)

Supported dense models:
- `sentence-transformers/all-MiniLM-L6-v2`
- `BAAI/bge-small-en-v1.5`

Dense index building is optional and gracefully skips if `sentence-transformers` is not installed.

### Storage (`memory_index.py`)

Index directory structure:
```
indexes/<name>/
  index_metadata.json     # Model, card count, paths
  bm25_token_cache.json   # BM25 token stats
  dense/<model>/          # Optional dense embeddings
    embeddings.npy        # float16 numpy array
    id_map.json           # Card ID to index mapping
```

### Runtime Retrieval (`hybrid_retriever.py`)

The `HybridRetriever` class:
- Loads BM25 and/or dense index from disk
- Supports strategies: legacy, bm25, bm25_filtered, hybrid
- Fallback: if dense index is unavailable, hybrid falls back to BM25

#### Scoring Formula

```
score = bm25_weight * normalized_bm25
      + dense_weight * normalized_dense
      + language_bonus
      + bug_type_bonus
      - contamination_penalty
      - known_bad_memory_penalty
```

Default weights:
- bm25_weight: 0.4
- dense_weight: 0.6
- language_bonus: 0.1
- bug_type_bonus: 0.05
- contamination_penalty: -10.0

## Integration

### CLI Flags

| Flag | Description |
|---|---|
| `--retrieval-strategy hybrid` | Enable hybrid retrieval |
| `--memory-index <path>` | Path to built index directory |
| `--dense-model <name>` | Dense model identifier |
| `--candidate-k N` | Candidates per retriever before fusion (default: 20) |
| `--bm25-weight N` | BM25 weight in fusion (default: 0.4) |
| `--dense-weight N` | Dense weight in fusion (default: 0.6) |

### Acceptance Commands

```powershell
# Build BM25 index
python build_memory_index.py --cards memory_store/cards.jsonl --out memory_store/indexes/default --bm25

# Build BM25 + dense index
python build_memory_index.py --cards memory_store/cards.jsonl --out memory_store/indexes/minilm --bm25 --dense all-MiniLM-L6-v2

# Dry run eval with hybrid retrieval
python run_eval.py --tasks eval_tasks.example.jsonl --variant qwen --limit 1 --dry-run --retrieval-strategy hybrid --memory-index memory_store/indexes/default
```

## Limitations

1. Dense retrieval requires `sentence-transformers` and the model downloaded
2. Float16 `.npy` embeddings can be large (10000 cards x 384 dims ≈ 15 MB for MiniLM, ~30 MB for bge-small)
3. Hybrid retrieval is slower than pure BM25 due to embedding computation
4. The dense model is loaded on first search, which may take several seconds
5. No approximate nearest neighbor (ANN) index — uses brute-force dot product
