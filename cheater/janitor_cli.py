"""cheater janitor: audit skills + memory, suggest merges/deletions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cheater.skill_janitor import (
    AuditReport,
    audit_memories,
    audit_skills,
    compress_skill,
    load_skills,
)


def _resolve(args: argparse.Namespace) -> Path:
    raw = getattr(args, "repo", None)
    return Path(raw).resolve() if raw else Path.cwd().resolve()


def _print_report(name: str, report: AuditReport, json_out: bool) -> None:
    if json_out:
        sys.stdout.write(json.dumps(report.to_dict(), indent=2, default=str))
        sys.stdout.write("\n")
        return
    sys.stdout.write(f"=== {name} ===\n")
    sys.stdout.write(f"items:      {len(report.items)}\n")
    if report.merges:
        sys.stdout.write("merges:\n")
        for m in report.merges[:20]:
            sys.stdout.write(f"  - {m.a}  <->  {m.b}  overlap={m.overlap:.2f}\n")
            sys.stdout.write(f"      {m.reason}\n")
    if report.deletions:
        sys.stdout.write("deletions:\n")
        for d in report.deletions[:20]:
            sys.stdout.write(f"  - {d.name}  (conf={d.confidence:.2f})\n")
            sys.stdout.write(f"      {d.reason}\n")
    if report.conflicts:
        sys.stdout.write("conflicts:\n")
        for c in report.conflicts[:20]:
            sys.stdout.write(f"  - {c.get('a')}  vs  {c.get('b')}\n")
            sys.stdout.write(f"      {c.get('reason')}\n")
    if report.low_success:
        sys.stdout.write("low_success:\n")
        for c in report.low_success[:20]:
            sys.stdout.write(f"  - {c.get('name')}  rate={c.get('success_rate')}\n")
            sys.stdout.write(f"      {c.get('reason')}\n")
    if not any([report.merges, report.deletions, report.conflicts, report.low_success]):
        sys.stdout.write("(nothing to suggest)\n")


def _skills(args: argparse.Namespace) -> int:
    repo = _resolve(args)
    skill_dir = Path(args.skill_dir) if args.skill_dir else None
    report = audit_skills(skill_dir)
    _print_report("skill audit", report, args.json)
    return 0


def _memory(args: argparse.Namespace) -> int:
    from cheater.memory_store import MemoryStore

    mem_dir = Path(args.memory_dir) if args.memory_dir else None
    try:
        store = MemoryStore(mem_dir) if mem_dir else MemoryStore()
    except Exception as e:
        sys.stderr.write(f"cannot open memory store: {e}\n")
        return 1
    report = audit_memories(store)
    _print_report("memory audit", report, args.json)
    return 0


def _all(args: argparse.Namespace) -> int:
    _skills(args)
    sys.stdout.write("\n")
    _memory(args)
    return 0


def run(args: argparse.Namespace) -> int:
    sub = args.janitor_subcommand or "all"
    if sub == "skills":
        return _skills(args)
    if sub == "memory":
        return _memory(args)
    if sub == "all":
        return _all(args)
    sys.stderr.write(f"unknown janitor subcommand: {sub}\n")
    return 2
