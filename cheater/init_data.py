"""cheater init-data: create required folders and explain how to populate them."""
from __future__ import annotations

import sys
from pathlib import Path


REQUIRED_DIRS = [
    "data/cards",
    "data/indexes",
    "data/samples",
    "data/benchmarks",
    "docs",
]

OPTIONAL_DIRS = [
    "data/raw",         # for raw trajectory JSONL before normalization
    "data/eval_tasks",  # SWE-bench task files (legacy/harness use)
    "_archive",         # quarantined experimental artifacts
]


def run(args=None) -> int:
    """Create the data directory skeleton. Idempotent. No downloads."""
    repo_root = Path(__file__).resolve().parents[1]
    created: list[str] = []
    existed: list[str] = []
    for d in REQUIRED_DIRS + OPTIONAL_DIRS:
        p = repo_root / d
        if p.is_dir():
            existed.append(d)
        else:
            p.mkdir(parents=True, exist_ok=True)
            created.append(d)

    # .gitignore reminder (don't write to it, just print)
    gitignore = repo_root / ".gitignore"
    if gitignore.is_file():
        gitignore_hint = f"Existing .gitignore at {gitignore}"
    else:
        gitignore_hint = "No .gitignore found; consider ignoring data/cards/, data/indexes/, and large files."

    print("=== Cheater init-data ===")
    print(f"Repo root: {repo_root}")
    print()
    if created:
        print(f"Created: {', '.join(created)}")
    if existed:
        print(f"Already present: {', '.join(existed)}")
    print()
    print("How to populate the corpus:")
    print("  1. (Optional) Place raw trajectory JSONL files in data/raw/")
    print("  2. Build the full canonical corpus from HuggingFace:")
    print("     python -m cheater build-cards \\")
    print("         --hf-dataset nebius/SWE-agent-trajectories \\")
    print("         --output data/cards/cards.v1.jsonl \\")
    print("         --source 'nebius/SWE-agent-trajectories' \\")
    print("         --full")
    print("     (requires: pip install -e .[ingest])")
    print("  3. Or build from a local compact corpus:")
    print("     python -m cheater build-cards \\")
    print("         --input data/compact_bug_cards.jsonl \\")
    print("         --output data/cards/cards.v1.jsonl")
    print("  4. Audit the corpus:")
    print("     python -m cheater audit-cards data/cards/cards.v1.jsonl --quality")
    print("  5. Search and guide:")
    print("     python -m cheater search 'your query here' --cards data/cards/cards.v1.jsonl")
    print("     python -m cheater guide 'TypeError: cannot import foo' --cards data/cards/cards.v1.jsonl")
    print()
    print(gitignore_hint)
    return 0
