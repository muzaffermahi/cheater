"""cheater guide CLI command."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.guide import generate_guide, guide_text
from cheater.retrieval import load_index_cards


def _read_stdin_text() -> str | None:
    """Read stdin if it's not a tty. Returns None if not piped."""
    if sys.stdin.isatty():
        return None
    try:
        return sys.stdin.read()
    except (OSError, KeyboardInterrupt):
        return None


def _read_file_text(path: str) -> str:
    p = Path(path)
    if not p.is_file():
        sys.stderr.write(f"File not found: {p}\n")
        return ""
    return p.read_text(encoding="utf-8", errors="ignore")


def run(args: argparse.Namespace) -> int:
    path = Path(args.cards)
    if not path.is_file():
        sys.stderr.write(f"Card file not found: {path}\n")
        return 2
    cards = load_index_cards(path)
    sys.stderr.write(f"Loaded {len(cards)} usable cards from {path}\n")
    if not cards:
        sys.stderr.write("No usable cards to search.\n")
        return 0

    query = args.query
    if args.from_stdin and not query:
        query = _read_stdin_text() or ""
    if args.from_file and not query:
        query = _read_file_text(args.from_file)
    if not query:
        sys.stderr.write("No query provided.\n")
        return 2

    # Repo context
    repo_context: dict | None = None
    if args.repo_context:
        from cheater.explorer import explore
        root = Path(args.repo) if args.repo else Path.cwd()
        ex = explore(query, repo_root=root, max_files=300)
        repo_context = ex.to_dict()
        sys.stderr.write(f"Explored repo: {len(ex.top_files)} files matched.\n")

    if args.json:
        g = generate_guide(
            args.query, cards, top_k=args.top_k,
            repo_context=repo_context, same_language=args.same_language,
        )
        print(json.dumps(g, ensure_ascii=False, indent=2))
    else:
        text = guide_text(
            query, cards, top_k=args.top_k,
            repo_context=repo_context, same_language=args.same_language,
        )
        sys.stdout.write(text + "\n")
    return 0
