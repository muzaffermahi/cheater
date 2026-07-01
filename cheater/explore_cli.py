"""cheater explore <query> -- explore a repo and return focused context.

Public API: run(args) -> int
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.explorer import explore, format_explorer, save_explorer


def run(args: argparse.Namespace) -> int:
    query = args.query
    if not query:
        sys.stderr.write("Usage: cheater explore <query>\n")
        return 2
    repo_root = Path(args.repo) if args.repo else Path.cwd()
    result = explore(query, repo_root=repo_root, max_files=args.max_files)
    if args.json:
        sys.stdout.write(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    elif args.save:
        save_explorer(result, args.save)
        sys.stdout.write(f"Saved to: {args.save}\n")
    else:
        sys.stdout.write(format_explorer(result, text=True))
        sys.stdout.write("\n")
    return 0
