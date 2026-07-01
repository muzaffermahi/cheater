"""smoke CLI command: one-command local sanity check (no external APIs).

Steps:
  1. Audit the checked-in sample cards.
  2. Build the lexical index over the sample cards.
  3. Run a sample retrieval query.
  4. Run the sample retrieval benchmark.
  5. Run the small focused tests via pytest (if available).

Everything runs on data/samples/* and data/benchmarks/* which are checked in,
so this works from a clean checkout without API keys, network, or large data.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_CARDS = REPO_ROOT / "data" / "samples" / "sample_cards.v1.jsonl"
SAMPLE_BENCH = REPO_ROOT / "data" / "benchmarks" / "sample_benchmark.jsonl"
INDEX_DIR = REPO_ROOT / "data" / "indexes" / "lexical"
SMOKE_TESTS = [
    "tests/test_card_schema.py",
    "tests/test_card_audit.py",
    "tests/test_search_smoke.py",
    "tests/test_benchmark_smoke.py",
]


def _step(name: str) -> None:
    sys.stderr.write(f"\n--- {name} ---\n")


def run(args: argparse.Namespace) -> int:
    rc = 0

    _step("1/5 audit sample cards")
    from cheater.audit import audit_file, format_report
    report = audit_file(SAMPLE_CARDS)
    sys.stderr.write(format_report(report))
    if not report["passes"]:
        sys.stderr.write("FAIL: sample cards did not pass audit.\n")
        rc = 1
    else:
        sys.stderr.write("OK: sample cards passed audit.\n")

    _step("2/5 build lexical index")
    from cheater.index import build_index_metadata
    meta = build_index_metadata(SAMPLE_CARDS, INDEX_DIR)
    sys.stderr.write(f"OK: index built, usable cards={meta['card_count_usable']}\n")

    _step("3/5 sample retrieval")
    from cheater.retrieval import BM25FIndex, load_index_cards
    cards = load_index_cards(SAMPLE_CARDS)
    index = BM25FIndex(cards)
    results = index.search("pydantic validation error environment variable", top_k=3)
    if not results:
        sys.stderr.write("FAIL: retrieval returned no results.\n")
        rc = 1
    else:
        sys.stderr.write(
            f"OK: top result id={results[0][1].get('id')} score={results[0][0]:.2f}\n"
        )

    _step("4/5 sample benchmark")
    from cheater.benchmark import evaluate, format_summary, read_benchmark
    cases = read_benchmark(SAMPLE_BENCH)
    summary = evaluate(cases, index, top_k=5)
    sys.stderr.write(format_summary(summary) + "\n")
    if summary["recall_at_1"] < 1.0:
        sys.stderr.write(
            f"WARN: sample benchmark recall@1={summary['recall_at_1']} (< 1.0)\n"
        )

    _step("5/5 focused tests")
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", *SMOKE_TESTS, "-q"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        sys.stderr.write(proc.stdout)
        if proc.returncode != 0:
            sys.stderr.write(proc.stderr)
            sys.stderr.write(f"FAIL: pytest exited {proc.returncode}\n")
            rc = 1
        else:
            sys.stderr.write("OK: focused tests passed.\n")
    except FileNotFoundError:
        sys.stderr.write("SKIP: pytest not installed.\n")

    sys.stderr.write(f"\nsmoke result: {'PASS' if rc == 0 else 'FAIL'}\n")
    return rc
