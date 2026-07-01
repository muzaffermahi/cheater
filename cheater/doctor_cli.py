"""cheater doctor: report what can run locally and what is missing/experimental."""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_CARDS = REPO_ROOT / "data" / "samples" / "sample_cards.v1.jsonl"
SAMPLE_BENCH = REPO_ROOT / "data" / "benchmarks" / "sample_benchmark.jsonl"
HELDOUT_BENCH = REPO_ROOT / "data" / "benchmarks" / "heldout_retrieval.v1.jsonl"
CARDS = REPO_ROOT / "data" / "cards" / "cards.v1.jsonl"
MANIFEST = REPO_ROOT / "data" / "cards" / "manifest.v1.json"
COMPACT = REPO_ROOT / "data" / "compact_bug_cards.jsonl"


def run(args=None) -> int:
    out: list[str] = ["=== cheater doctor ==="]

    # Python version
    py = sys.version_info
    out.append(f"Python: {py.major}.{py.minor}.{py.micro}")
    if py < (3, 10):
        out.append("  WARNING: Python 3.10+ recommended")

    # Package import
    try:
        import cheater
        out.append(f"cheater: v{cheater.__version__}")
    except ImportError as exc:
        out.append(f"cheater: IMPORT FAILED ({exc})")

    # Sample cards
    out.append(f"sample cards:     {'OK' if SAMPLE_CARDS.is_file() else 'MISSING'} ({SAMPLE_CARDS})")
    out.append(f"sample benchmark: {'OK' if SAMPLE_BENCH.is_file() else 'MISSING'} ({SAMPLE_BENCH})")
    out.append(f"heldout benchmark: {'OK' if HELDOUT_BENCH.is_file() else 'MISSING (run: make heldout)'}")

    # Full corpus
    if CARDS.is_file():
        import json
        n = 0
        usable = 0
        with CARDS.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    n += 1
                    try:
                        c = json.loads(line)
                        if c.get("usable"):
                            usable += 1
                    except json.JSONDecodeError:
                        pass
        out.append(f"full corpus:      OK ({n} cards, {usable} usable)")
    else:
        out.append(f"full corpus:      MISSING (run: make build-full, needs pip -e .[ingest])")

    # Manifest
    if MANIFEST.is_file():
        import json
        m = json.loads(MANIFEST.read_text(encoding="utf-8"))
        out.append(f"manifest:          OK ({m.get('source', '?')}, {m.get('count_usable', '?')} usable)")
    else:
        out.append(f"manifest:          MISSING")

    # Compact corpus
    if COMPACT.is_file():
        out.append(f"compact corpus:   OK (for --compare mode)")
    else:
        out.append(f"compact corpus:   MISSING (optional, improves --compare results)")

    # Optional dependencies
    out.append("")
    out.append("Optional dependencies:")
    for name, hint in [
        ("datasets", "needed for: cheater build-cards --hf-dataset"),
        ("openai", "needed for: LLM compaction (cheater build-cards --llm-compact)"),
        ("pytest", "needed for: make test"),
    ]:
        try:
            __import__(name)
            out.append(f"  {name}: installed ({hint})")
        except ImportError:
            out.append(f"  {name}: NOT installed ({hint})")

    # Experimental status
    out.append("")
    out.append("Experimental / out of core scope:")
    legacy = REPO_ROOT / "cheater" / "legacy"
    if legacy.is_dir():
        n_legacy = sum(1 for _ in legacy.glob("*.py"))
        out.append(f"  cheater/legacy/ ({n_legacy} files, quarantined Pi/Qwen harness)")
    out.append("  scripts/ (original numbered scripts, install scripts)")
    out.append("  _archive/experiments/ (earlier benchmark experiments)")

    out.append("")
    out.append("Runnable without API keys:")
    out.append("  python -m cheater smoke")
    out.append("  python -m cheater audit-cards data/samples/sample_cards.v1.jsonl --quality")
    out.append("  python -m cheater search '<query>' --cards data/samples/sample_cards.v1.jsonl")
    out.append("  python -m cheater benchmark data/benchmarks/sample_benchmark.jsonl --cards data/samples/sample_cards.v1.jsonl")
    out.append("  python -m cheater guide '<bug>' --cards data/samples/sample_cards.v1.jsonl")
    print("\n".join(out))
    return 0
