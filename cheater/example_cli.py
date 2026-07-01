"""cheater example <name> -- run a built-in example task.

Examples:
  fix-sample-bug  : Asks the agent to read data/samples/sample_cards.v1.jsonl,
                    find a card with a known issue, and explain it. Read-only.

These exist so a new user can run `cheater example` and see the agent loop
work without any setup. The tasks are designed to be solvable without an
LLM (the agent will return "no model configured" if no provider is set,
which is the honest default for a no-network demo).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.config import load_config
from cheater.agent_loop_cli import _make_provider, _print_event
from cheater.agent_loop import AgentLoop


EXAMPLES: dict[str, dict] = {
    "fix-sample-bug": {
        "task": (
            "Read data/samples/sample_cards.v1.jsonl and tell me the id of the "
            "first card whose symptom mentions pydantic. Cite the file and line."
        ),
        "read_only": True,
        "description": "Find a card in the sample corpus and report its id.",
    },
    "explore-agent": {
        "task": (
            "Use list_files and read_file to find the agent loop module "
            "and tell me its filename."
        ),
        "read_only": True,
        "description": "Find cheater/agent_loop.py via the explorer's tools.",
    },
}


def run(args: argparse.Namespace) -> int:
    name = args.name or "fix-sample-bug"
    if name not in EXAMPLES:
        sys.stderr.write(f"Unknown example: {name!r}. Available: {', '.join(EXAMPLES)}\n")
        return 2
    ex = EXAMPLES[name]
    task = ex["task"]
    read_only = ex.get("read_only", False) or args.read_only
    sys.stdout.write(f"=== Example: {name} ===\n")
    sys.stdout.write(f"Description: {ex['description']}\n")
    sys.stdout.write(f"Task: {task}\n")
    sys.stdout.write(f"Read-only: {read_only}\n\n")
    provider, cards = _make_provider(args)
    root = Path.cwd()
    on_event = None if args.quiet else _print_event
    loop = AgentLoop(
        provider=provider, repo_root=root,
        max_steps=args.max_steps, read_only=read_only,
        verbose=args.verbose, cards=cards, on_event=on_event,
    )
    result = loop.run(task)
    if args.json:
        sys.stdout.write(json.dumps(result.to_dict(), indent=2, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write("\n=== Result ===\n")
        sys.stdout.write(f"Success:    {result.success}\n")
        sys.stdout.write(f"Finished by:{result.finished_by}\n")
        sys.stdout.write(f"Steps:      {len(result.steps)}\n")
        sys.stdout.write(f"Elapsed:    {result.elapsed:.1f}s\n")
        if result.error:
            sys.stdout.write(f"Error:      {result.error}\n")
    return 0 if result.success else 1
