"""cheater sessions / cheater resume / cheater show-session."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cheater.sessions import format_session_list, list_sessions, load_session, session_root_for


def run_sessions(args: argparse.Namespace) -> int:
    root = Path(args.repo) if args.repo else Path.cwd()
    items = list_sessions(root)
    sys.stdout.write(format_session_list(items) + "\n")
    return 0


def run_resume(args: argparse.Namespace) -> int:
    root = Path(args.repo) if args.repo else Path.cwd()
    try:
        s = load_session(root, args.id)
    except Exception as e:
        sys.stderr.write(f"Failed to load session {args.id}: {e}\n")
        return 2
    sys.stdout.write(s.to_summary() + "\n")
    return 0


def run_show_session(args: argparse.Namespace) -> int:
    return run_resume(args)
