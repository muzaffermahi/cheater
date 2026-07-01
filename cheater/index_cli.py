"""build-index CLI command."""

from __future__ import annotations

import argparse
import sys

from cheater.index import build_index_metadata


def run(args: argparse.Namespace) -> int:
    meta = build_index_metadata(args.cards, args.index_dir)
    sys.stderr.write("=== build-index ===\n")
    for k, v in meta.items():
        sys.stderr.write(f"  {k}: {v}\n")
    return 0
