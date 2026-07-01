"""cheater patch / cheater undo / cheater snapshots -- patch engine CLI."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.patch_engine import (
    PatchProposal,
    apply,
    list_snapshots,
    load_snapshots,
    make_create,
    make_replace,
    preview,
    save_snapshots,
    undo,
)


def _snapshots_path(root: Path) -> Path:
    return root / ".cheater" / "patch_snapshots.json"


def run_patch(args: argparse.Namespace) -> int:
    """Apply a patch from --old/--new or from --from-file JSON."""
    root = Path(args.repo) if args.repo else Path.cwd()
    if args.from_file:
        try:
            data = json.loads(Path(args.from_file).read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            sys.stderr.write(f"Failed to read --from-file: {e}\n")
            return 2
        prop = PatchProposal(
            path=data["path"],
            old=data.get("old", ""),
            new=data.get("new", ""),
            description=data.get("description", ""),
        )
    elif args.create:
        if not args.path:
            sys.stderr.write("--path required for create\n")
            return 2
        try:
            content = Path(args.content).read_text(encoding="utf-8")
        except (OSError, TypeError):
            content = args.content or ""
        prop = make_create(args.path, content, description=args.description or "")
    else:
        if not (args.path and args.old is not None and args.new is not None):
            sys.stderr.write("Need --path, --old, --new (or --from-file / --create)\n")
            return 2
        prop = make_replace(args.path, args.old, args.new, description=args.description or "")
    if args.preview or not args.yes:
        sys.stdout.write(preview(prop) + "\n")
    if args.preview:
        return 0
    if not args.yes:
        ans = input("\nApply this patch? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            sys.stdout.write("Rejected.\n")
            return 1
    try:
        snap_id = apply(prop)
    except (ValueError, PermissionError, OSError) as e:
        sys.stderr.write(f"Apply failed: {e}\n")
        return 1
    save_snapshots(_snapshots_path(root))
    sys.stdout.write(f"Applied. snapshot_id={snap_id}\n")
    return 0


def run_undo(args: argparse.Namespace) -> int:
    root = Path(args.repo) if args.repo else Path.cwd()
    load_snapshots(_snapshots_path(root))
    ok = undo(args.snapshot_id)
    if not ok:
        sys.stderr.write("Nothing to undo (or undo failed).\n")
        return 1
    save_snapshots(_snapshots_path(root))
    sys.stdout.write("Undone.\n")
    return 0


def run_snapshots(args: argparse.Namespace) -> int:
    root = Path(args.repo) if args.repo else Path.cwd()
    load_snapshots(_snapshots_path(root))
    snaps = list_snapshots()
    if not snaps:
        sys.stdout.write("No pending snapshots.\n")
        return 0
    for s in snaps:
        sys.stdout.write(
            f"  {s['snapshot_id']}  via={s['via']:5}  path={s['path']}\n"
        )
    return 0
