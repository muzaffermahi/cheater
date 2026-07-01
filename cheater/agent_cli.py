"""cheater ask / plan / build / review CLI shims."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.agent import Agent
from cheater.config import load_config


def _make_agent(args: argparse.Namespace) -> Agent:
    cfg = load_config(getattr(args, "repo", None))
    root = Path(args.repo) if getattr(args, "repo", None) else Path.cwd()
    cfg.project_root = str(root.resolve())
    return Agent(cfg, project_root=root)


def run_ask(args: argparse.Namespace) -> int:
    agent = _make_agent(args)
    ans = agent.ask(args.query)
    if args.json:
        out = {
            "task": ans.task,
            "mode": ans.mode,
            "explorer": ans.explorer,
            "memory_brief": ans.memory_brief,
            "plan": ans.plan,
            "final": ans.final,
        }
        sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    else:
        sys.stdout.write("=== Cheater Answer ===\n")
        sys.stdout.write(f"Task: {ans.task}\n\n")
        sys.stdout.write("--- Repo context (top files) ---\n")
        for tf in (ans.explorer.get("top_files") or [])[:10]:
            why = ", ".join(tf.get("why") or [])
            sys.stdout.write(f"  - {tf.get('path', '?')}  ({why})\n")
        sys.stdout.write("\n--- Memory brief ---\n")
        sys.stdout.write(ans.memory_brief + "\n")
        sys.stdout.write("\n--- Plan ---\n")
        sys.stdout.write(ans.plan + "\n")
        sys.stdout.write("\n--- Final answer ---\n")
        sys.stdout.write(ans.final + "\n")
    return 0


def run_plan(args: argparse.Namespace) -> int:
    agent = _make_agent(args)
    p = agent.plan(args.query)
    if args.json:
        out = {
            "task": p.task,
            "steps": p.steps,
            "files_to_inspect": p.files_to_inspect,
            "tests_to_run": p.tests_to_run,
            "memory_brief": p.memory_brief,
            "repo_context": p.repo_context,
        }
        sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(f"=== Plan: {p.task} ===\n")
        sys.stdout.write("Steps:\n")
        for s in p.steps:
            sys.stdout.write(f"  {s}\n")
        if p.files_to_inspect:
            sys.stdout.write("\nFiles to inspect:\n")
            for f in p.files_to_inspect:
                sys.stdout.write(f"  - {f}\n")
        if p.tests_to_run:
            sys.stdout.write("\nTests to run:\n")
            for t in p.tests_to_run:
                sys.stdout.write(f"  - {t}\n")
        sys.stdout.write("\n--- Memory brief ---\n")
        sys.stdout.write(p.memory_brief + "\n")
    return 0


def run_build(args: argparse.Namespace) -> int:
    agent = _make_agent(args)
    br = agent.build(args.query, dry_run=getattr(args, "dry_run", False))
    if args.json:
        out = {
            "task": br.task,
            "plan": {
                "steps": br.plan.steps,
                "files_to_inspect": br.plan.files_to_inspect,
                "tests_to_run": br.plan.tests_to_run,
            },
            "proposed_patch": br.proposed_patch,
            "applied": br.applied,
            "snapshot_id": br.snapshot_id,
            "command_results": br.command_results,
            "summary": br.summary,
        }
        sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(f"=== Build: {br.task} ===\n")
        sys.stdout.write("\n--- Plan ---\n")
        for s in br.plan.steps:
            sys.stdout.write(f"  {s}\n")
        sys.stdout.write("\n--- Memory brief ---\n")
        sys.stdout.write(br.plan.memory_brief + "\n")
        if br.proposed_patch is None:
            sys.stdout.write("\n--- No patch proposed ---\n")
            sys.stdout.write(br.summary + "\n")
        else:
            sys.stdout.write("\n--- Proposed patch ---\n")
            sys.stdout.write(br.proposed_patch + "\n")
            sys.stdout.write("\n" + br.summary + "\n")
    return 0


def run_review(args: argparse.Namespace) -> int:
    agent = _make_agent(args)
    rr = agent.review()
    if args.json:
        out = {
            "diff": rr.diff,
            "files": rr.files,
            "memory_brief": rr.memory_brief,
            "suggestions": rr.suggestions,
            "summary": rr.summary,
        }
        sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    else:
        sys.stdout.write("=== Review ===\n")
        sys.stdout.write(f"Files changed: {len(rr.files)}\n")
        for f in rr.files[:20]:
            sys.stdout.write(f"  - {f}\n")
        sys.stdout.write("\n--- Memory brief ---\n")
        sys.stdout.write(rr.memory_brief + "\n")
        sys.stdout.write("\n--- Suggestions ---\n")
        for s in rr.suggestions:
            sys.stdout.write(f"  - {s}\n")
        sys.stdout.write("\n--- Diff ---\n")
        if rr.diff.strip():
            sys.stdout.write(rr.diff[:4000] + ("\n... (truncated)" if len(rr.diff) > 4000 else ""))
        else:
            sys.stdout.write("(no diff)\n")
    return 0
