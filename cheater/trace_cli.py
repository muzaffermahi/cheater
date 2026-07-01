"""cheater trace: list, show, summarize, export trace files."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cheater.trace_recorder import load_trace, summarize_trace


def _trace_dir(repo: str | Path | None) -> Path:
    root = Path(repo) if repo else Path.cwd()
    return root / ".cheater" / "traces"


def _list(args: argparse.Namespace) -> int:
    d = _trace_dir(args.repo)
    if not d.is_dir():
        sys.stdout.write(f"no trace dir: {d}\n")
        return 0
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        sys.stdout.write(f"no traces under {d}\n")
        return 0
    sys.stdout.write(f"=== {len(files)} traces (newest first) ===\n")
    for f in files:
        size = f.stat().st_size
        sys.stdout.write(f"  {f.stem:20s}  {size:>8d} bytes  {f}\n")
    return 0


def _show(args: argparse.Namespace) -> int:
    d = _trace_dir(args.repo)
    path = d / f"{args.run_id}.jsonl"
    if not path.is_file():
        sys.stderr.write(f"trace not found: {path}\n")
        return 2
    events = load_trace(path)
    if args.json:
        sys.stdout.write(json.dumps(events, indent=2, default=str))
        sys.stdout.write("\n")
        return 0
    for ev in events:
        ev_type = str(ev.get("event", "?"))
        ts = ev.get("ts", "")
        payload = ev.get("payload", {}) or {}
        sys.stdout.write(f"[{ts}] {ev_type}\n")
        for k, v in payload.items():
            s = repr(v)
            if len(s) > 200:
                s = s[:197] + "..."
            sys.stdout.write(f"    {k}: {s}\n")
    return 0


def _summary_cmd(args: argparse.Namespace) -> int:
    d = _trace_dir(args.repo)
    path = d / f"{args.run_id}.jsonl"
    if not path.is_file():
        sys.stderr.write(f"trace not found: {path}\n")
        return 2
    events = load_trace(path)
    summary = summarize_trace(events)
    if args.json:
        sys.stdout.write(json.dumps(summary, indent=2, default=str))
        sys.stdout.write("\n")
        return 0
    sys.stdout.write(f"=== trace summary: {args.run_id} ===\n")
    sys.stdout.write(f"events:       {summary['event_count']}\n")
    sys.stdout.write(f"elapsed_sec:  {summary['elapsed_sec']}\n")
    sys.stdout.write(f"tool_calls:   {summary['tool_call_count']}\n")
    sys.stdout.write(f"model_calls:  {summary['model_call_count']}\n")
    sys.stdout.write(f"prompt_tok:   ~{summary['total_prompt_tokens_est']}\n")
    sys.stdout.write(f"output_tok:   ~{summary['total_output_tokens_est']}\n")
    sys.stdout.write(f"finished_by:  {summary['finished_by']}\n")
    sys.stdout.write(f"success:      {summary['success']}\n")
    if summary["error_type"]:
        sys.stdout.write(f"error_type:   {summary['error_type']}\n")
    if summary["files_touched"]:
        sys.stdout.write("files_touched:\n")
        for f in summary["files_touched"]:
            sys.stdout.write(f"  - {f}\n")
    if summary["actions"]:
        sys.stdout.write(f"actions:      {' -> '.join(summary['actions'][:10])}\n")
    return 0


def _export(args: argparse.Namespace) -> int:
    d = _trace_dir(args.repo)
    path = d / f"{args.run_id}.jsonl"
    if not path.is_file():
        sys.stderr.write(f"trace not found: {path}\n")
        return 2
    events = load_trace(path)
    fmt = args.format or "jsonl"
    out = Path(args.out) if args.out else None
    if fmt == "jsonl":
        text = "\n".join(json.dumps(e, default=str) for e in events) + "\n"
    elif fmt == "json":
        text = json.dumps(events, indent=2, default=str)
    else:
        sys.stderr.write(f"unknown format: {fmt}\n")
        return 2
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        sys.stdout.write(f"wrote {out}\n")
    else:
        sys.stdout.write(text)
    return 0


def run(args: argparse.Namespace) -> int:
    sub = args.trace_subcommand or "list"
    if sub == "list":
        return _list(args)
    if sub == "show":
        return _show(args)
    if sub == "summary":
        return _summary_cmd(args)
    if sub == "export":
        return _export(args)
    sys.stderr.write(f"unknown trace subcommand: {sub}\n")
    return 2
