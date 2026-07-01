"""cheater distill: turn traces into training rows, skills, anti-patterns."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cheater.trace_distiller import (
    ROLES,
    distill_trace,
    distill_traces,
    load_trace_file,
    suggest_antipatterns,
    write_training_rows,
)
from cheater.trace_recorder import load_trace


def _trace_dir(repo: Path) -> Path:
    return repo / ".cheater" / "traces"


def _traces(args: argparse.Namespace) -> int:
    repo = Path(args.repo) if args.repo else Path.cwd()
    out_dir = Path(args.out) if args.out else (repo / ".cheater" / "distilled")
    src = _trace_dir(repo)
    if not src.is_dir() or not any(src.glob("*.jsonl")):
        sys.stderr.write(f"no traces under {src}\n")
        return 2
    summary = distill_traces(src, out_dir, min_success_only=not args.include_failed)
    if not summary.get("ok"):
        sys.stderr.write(f"distill failed: {summary.get('error')}\n")
        return 1
    sys.stdout.write(json.dumps(summary, indent=2, default=str))
    sys.stdout.write("\n")
    return 0


def _trace(args: argparse.Namespace) -> int:
    repo = Path(args.repo) if args.repo else Path.cwd()
    src = _trace_dir(repo) / f"{args.run_id}.jsonl"
    if not src.is_file():
        sys.stderr.write(f"trace not found: {src}\n")
        return 2
    events = load_trace(src)
    result = distill_trace(events, run_id=args.run_id)
    if args.json:
        sys.stdout.write(json.dumps(result.to_dict(), indent=2, default=str))
        sys.stdout.write("\n")
        return 0
    sys.stdout.write(f"=== distill trace {args.run_id} ===\n")
    sys.stdout.write(f"is_success: {result.is_success}\n")
    sys.stdout.write(f"rows:      {len(result.rows)}\n")
    for r in result.rows:
        sys.stdout.write(f"  - {r.role}: {r.metadata.get('tokens_est', 0)} tok\n")
    if result.skill_suggestion:
        sys.stdout.write(f"skill:     {result.skill_suggestion.get('name')}\n")
    if result.bug_card:
        sys.stdout.write(f"bug_card:  {result.bug_card.get('bug_type')}\n")
    if result.prompt_suggestion:
        sys.stdout.write(f"prompt:    {result.prompt_suggestion}\n")
    return 0


def _training(args: argparse.Namespace) -> int:
    """Emit a single training JSONL for a given role by scanning the
    .cheater/distilled/<role>_sft.jsonl files (or by re-distilling traces
    on the fly if those files don't exist).
    """
    role = args.role
    if role not in ROLES:
        sys.stderr.write(f"unknown role: {role}\n")
        sys.stderr.write(f"valid: {', '.join(ROLES)}\n")
        return 2
    repo = Path(args.repo) if args.repo else Path.cwd()
    out = (
        Path(args.out)
        if args.out
        else (repo / ".cheater" / "distilled" / f"{role}_sft.jsonl")
    )
    candidate = repo / ".cheater" / "distilled" / f"{role}_sft.jsonl"
    src = candidate if candidate.is_file() else None
    if src is None:
        # Distill on the fly
        summary = distill_traces(
            _trace_dir(repo),
            repo / ".cheater" / "distilled",
            min_success_only=not args.include_failed,
        )
        if not summary.get("ok"):
            sys.stderr.write(f"distill failed: {summary.get('error')}\n")
            return 1
        src = candidate
        if not src.is_file():
            src.write_text("", encoding="utf-8")
    if args.out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            src.read_text(encoding="utf-8", errors="ignore"), encoding="utf-8"
        )
        sys.stdout.write(
            f"wrote {out} ({sum(1 for _ in out.open('r', encoding='utf-8') if _.strip())} rows)\n"
        )
    else:
        sys.stdout.write(src.read_text(encoding="utf-8", errors="ignore"))
    return 0


def _antipatterns(args: argparse.Namespace) -> int:
    repo = Path(args.repo) if args.repo else Path.cwd()
    src = _trace_dir(repo)
    if not src.is_dir():
        sys.stderr.write(f"no trace dir: {src}\n")
        return 2
    failed: list[list[dict[str, Any]]] = []
    for f in sorted(src.glob("*.jsonl")):
        if f.name == "latest.jsonl":
            continue
        events = load_trace(f)
        if not events:
            continue
        # crude: success comes from run_finished
        from cheater.trace_distiller import _is_success  # internal but stable

        if not _is_success(events):
            failed.append(events)
    anti = suggest_antipatterns(failed)
    out = Path(args.out) if args.out else None
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(anti, indent=2, default=str), encoding="utf-8")
        sys.stdout.write(f"wrote {out}\n")
    else:
        sys.stdout.write(json.dumps(anti, indent=2, default=str))
        sys.stdout.write("\n")
    return 0


def run(args: argparse.Namespace) -> int:
    sub = args.distill_subcommand or "traces"
    if sub == "traces":
        return _traces(args)
    if sub == "trace":
        return _trace(args)
    if sub == "training":
        return _training(args)
    if sub == "antipatterns":
        return _antipatterns(args)
    sys.stderr.write(f"unknown distill subcommand: {sub}\n")
    return 2
