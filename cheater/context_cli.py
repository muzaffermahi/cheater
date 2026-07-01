"""cheater context: build / optimize / ablate context packs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cheater.context_optimizer import (
    Budget,
    OptimizationResult,
    context_ablation_report,
    estimate_tokens,
    optimize_context_pack,
)
from cheater.context_pack import build_context_pack, render_for_model
from cheater.trace_recorder import load_trace


def _resolve_repo(args: argparse.Namespace) -> Path:
    raw = getattr(args, "repo", None)
    return Path(raw).resolve() if raw else Path.cwd().resolve()


def _build_pack(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    memory_dir = Path(args.memory_dir) if args.memory_dir else None
    pack = build_context_pack(
        task=args.task,
        repo_root=repo,
        traceback=args.traceback or "",
        memory_store=None,
        max_tokens=args.max_tokens,
    )
    if args.json:
        out = pack.to_dict()
        sys.stdout.write(json.dumps(out, indent=2, default=str))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_for_model(pack))
    return 0


def _optimize(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    traceback = args.traceback or ""
    if args.traceback_file:
        try:
            traceback = Path(args.traceback_file).read_text(
                encoding="utf-8", errors="ignore"
            )
        except OSError as e:
            sys.stderr.write(f"cannot read traceback file: {e}\n")
            return 1
    pack = build_context_pack(
        task=args.task,
        repo_root=repo,
        traceback=traceback,
        memory_store=None,
        max_tokens=max(2000, args.max_tokens),
    )
    budget = args.budget
    if budget == "custom":
        budget = args.max_chars
    result = optimize_context_pack(pack, budget=budget, task_signature=args.task)
    if args.json:
        sys.stdout.write(json.dumps(result.to_dict(), indent=2, default=str))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(
            f"=== optimized context pack (budget={result.budget_name}) ===\n"
        )
        sys.stdout.write(f"max_chars:           {result.max_chars}\n")
        sys.stdout.write(f"total before:        {result.total_chars_before}\n")
        sys.stdout.write(f"total after:         {result.total_chars_after}\n")
        sys.stdout.write(f"estimated_tokens:    {result.estimated_tokens}\n")
        sys.stdout.write("kept:\n")
        for s in result.kept:
            sys.stdout.write(
                f"  - {s.name:18s} chars={s.char_len():>6d}  score={s.last_score:.2f}\n"
            )
        if result.dropped:
            sys.stdout.write("dropped:\n")
            for s in result.dropped:
                sys.stdout.write(f"  - {s.name}\n")
        if result.clipped:
            sys.stdout.write("clipped:\n")
            for s in result.clipped:
                sys.stdout.write(f"  - {s.name}\n")
        if result.actions:
            sys.stdout.write(f"actions: {', '.join(result.actions)}\n")
    return 0


def _ablate(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    src = Path(args.traces) if args.traces else (repo / ".cheater" / "traces")
    if not src.is_dir():
        sys.stderr.write(f"trace dir not found: {src}\n")
        return 2
    traces: list[list[dict[str, Any]]] = []
    for f in sorted(src.glob("*.jsonl")):
        if f.name == "latest.jsonl":
            continue
        events = load_trace(f)
        if events:
            traces.append(events)
    if not traces:
        sys.stderr.write(f"no traces under {src}\n")
        return 2
    report = context_ablation_report(traces)
    if args.json:
        sys.stdout.write(json.dumps(report, indent=2, default=str))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(f"=== context ablation ({report['runs_total']} runs) ===\n")
        sys.stdout.write(f"runs_with_pack: {report['runs_with_pack']}\n")
        sys.stdout.write("section_uses:\n")
        for s, n in (report.get("section_uses") or {}).items():
            sys.stdout.write(f"  {s:20s} {n}\n")
        sys.stdout.write("recommendations:\n")
        for b, kept in report.get("recommendations", {}).items():
            sys.stdout.write(f"  {b:8s} keep: {', '.join(kept) or '(none)'}\n")
    return 0


def run(args: argparse.Namespace) -> int:
    sub = args.context_subcommand or "optimize"
    if sub == "build":
        return _build_pack(args)
    if sub == "optimize":
        return _optimize(args)
    if sub == "ablate":
        return _ablate(args)
    sys.stderr.write(f"unknown context subcommand: {sub}\n")
    return 2
