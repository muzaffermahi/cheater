"""cheater run / cheater test / cheater lint -- safe command runner."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.runner import (
    detect_lint_command,
    detect_test_command,
    run as runner_run,
    summarize_failure,
)


def _run_cmd(args: argparse.Namespace) -> int:
    cmd = args.cmd
    if not cmd:
        sys.stderr.write("Usage: cheater run <command...>\n")
        return 2
    root = Path(args.repo) if args.repo else Path.cwd()
    result = runner_run(cmd, cwd=root, timeout=args.timeout, yes=args.yes)
    sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    sys.stderr.write(f"\n[exit={result.returncode}  elapsed={result.elapsed:.2f}s  ok={result.ok}]\n")
    return 0 if result.ok else 1


def _test_cmd(args: argparse.Namespace) -> int:
    root = Path(args.repo) if args.repo else Path.cwd()
    cmd = args.cmd or detect_test_command(root)
    if not cmd:
        sys.stderr.write("Could not detect test command. Use `cheater run <cmd>` instead.\n")
        return 2
    sys.stderr.write(f"Running: {cmd}\n")
    result = runner_run(cmd, cwd=root, timeout=args.timeout, yes=args.yes)
    sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    sys.stderr.write(f"\n[exit={result.returncode}  elapsed={result.elapsed:.2f}s  ok={result.ok}]\n")
    if not result.ok:
        summary = summarize_failure(result)
        sys.stderr.write(f"\n--- Failure summary ---\n{json.dumps(summary, indent=2)}\n")
    return 0 if result.ok else 1


def _lint_cmd(args: argparse.Namespace) -> int:
    root = Path(args.repo) if args.repo else Path.cwd()
    cmd = args.cmd or detect_lint_command(root)
    if not cmd:
        sys.stderr.write("Could not detect lint command. Use `cheater run <cmd>` instead.\n")
        return 2
    sys.stderr.write(f"Running: {cmd}\n")
    result = runner_run(cmd, cwd=root, timeout=args.timeout, yes=args.yes)
    sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    sys.stderr.write(f"\n[exit={result.returncode}  elapsed={result.elapsed:.2f}s  ok={result.ok}]\n")
    return 0 if result.ok else 1
