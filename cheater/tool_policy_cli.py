"""cheater tool-policy: state-based tool recommendations."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cheater.tool_policy import (
    ToolState,
    infer_state,
    recommend_tools,
    render_tool_policy_nudge,
)
from cheater.trace_recorder import load_trace


def _registry_tools() -> list[str]:
    try:
        from cheater.tools import default_tool_registry

        reg = default_tool_registry(read_only=False)
        return reg.names()
    except Exception:
        return []


def _from_task(args: argparse.Namespace) -> int:
    tools = _registry_tools()
    last_event: dict | None = None
    failure_summary: dict | None = None
    if args.traceback:
        failure_summary = {
            "passed": False,
            "summary": args.traceback[:1000],
            "error_type": "",
        }
    state = infer_state(args.task, last_event, failure_summary)
    rec = recommend_tools(state, available_tools=tools)
    if args.json:
        sys.stdout.write(json.dumps(rec.to_dict(), indent=2, default=str))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_tool_policy_nudge(rec) + "\n")
    return 0


def _from_trace(args: argparse.Namespace) -> int:
    repo = Path(args.repo) if args.repo else Path.cwd()
    src = repo / ".cheater" / "traces" / f"{args.run_id}.jsonl"
    if not src.is_file():
        sys.stderr.write(f"trace not found: {src}\n")
        return 2
    events = load_trace(src)
    if not events:
        sys.stderr.write("empty trace\n")
        return 1
    # Pick the last failure_summary or repair_attempt
    last: dict | None = None
    failure_summary: dict | None = None
    task = ""
    for ev in events:
        ev_type = str(ev.get("event", ""))
        payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
        if ev_type == "run_start":
            task = str(payload.get("task", ""))
        if ev_type == "failure_summary":
            failure_summary = payload
            last = ev
        elif ev_type == "repair_attempt":
            last = ev
    state = infer_state(task, last, failure_summary)
    tools = _registry_tools()
    rec = recommend_tools(state, available_tools=tools)
    if args.json:
        sys.stdout.write(
            json.dumps(
                {"state": state, "task": task, "recommendation": rec.to_dict()},
                indent=2,
                default=str,
            )
        )
        sys.stdout.write("\n")
    else:
        sys.stdout.write(f"task: {task}\n")
        sys.stdout.write(render_tool_policy_nudge(rec) + "\n")
    return 0


def run(args: argparse.Namespace) -> int:
    if args.run_id:
        return _from_trace(args)
    return _from_task(args)
