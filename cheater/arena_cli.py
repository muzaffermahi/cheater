"""cheater arena: run component / repair evals and produce reports."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from cheater.arena import (
    ComponentConfig,
    RepairConfig,
    compare_reports,
    load_eval_cases,
    read_arena_report,
    render_arena_summary,
    run_component_eval,
    run_repair_eval,
    write_arena_report,
)


def _resolve_repo(args: argparse.Namespace) -> Path:
    raw = getattr(args, "repo", None)
    return Path(raw).resolve() if raw else Path.cwd().resolve()


def _arena_dir(repo: Path) -> Path:
    return repo / ".cheater" / "arena"


def _run(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    cases_path = Path(args.cases) if args.cases else (repo / ".cheater" / "eval_cases")
    if not cases_path.is_dir():
        sys.stderr.write(f"cases dir not found: {cases_path}\n")
        return 2
    cases = load_eval_cases(cases_path)
    if not cases:
        sys.stderr.write(f"no eval cases in {cases_path}\n")
        return 2
    sys.stderr.write(f"loaded {len(cases)} case(s) from {cases_path}\n")
    component = args.component or "all"
    if component == "all" and args.mode in ("component", None):
        report = run_component_eval(
            cases, ComponentConfig(component="all", repo_root=repo)
        )
    elif args.mode == "repair":
        report = run_repair_eval(
            cases,
            RepairConfig(
                repo_root=repo,
                max_steps=args.max_steps,
                max_cases=args.max_cases,
            ),
        )
    else:
        report = run_component_eval(
            cases, ComponentConfig(component=component, repo_root=repo)
        )
    out_dir = _arena_dir(repo)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    out_path = out_dir / f"{ts}.json"
    write_arena_report(report, out_path)
    # also update latest.json
    latest = out_dir / "latest.json"
    write_arena_report(report, latest)
    sys.stdout.write(render_arena_summary(report) + "\n")
    sys.stdout.write(f"\nwrote {out_path}\n")
    return 0 if report.get("ok") else 1


def _report(args: argparse.Namespace) -> int:
    path = Path(args.path)
    report = read_arena_report(path)
    if args.json:
        sys.stdout.write(json.dumps(report, indent=2, default=str))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_arena_summary(report) + "\n")
    return 0 if report.get("ok") else 1


def _compare(args: argparse.Namespace) -> int:
    if not args.old or not args.new:
        sys.stderr.write(
            "Usage: cheater arena compare --old <old.json> --new <new.json>\n"
        )
        return 2
    old = read_arena_report(Path(args.old))
    new = read_arena_report(Path(args.new))
    cmp = compare_reports(old, new)
    if args.json:
        sys.stdout.write(json.dumps(cmp, indent=2, default=str))
        sys.stdout.write("\n")
        return 0
    sys.stdout.write("=== arena compare ===\n")
    sys.stdout.write(f"old: {cmp['old_kind']}\nnew: {cmp['new_kind']}\n")
    s = cmp["summary"]
    sys.stdout.write(
        f"improved={s['improved']}  regressed={s['regressed']}  flat={s['flat']}\n\n"
    )
    sys.stdout.write(
        f"{'metric':38s} {'old':>10s} {'new':>10s} {'delta':>8s} {'dir':>10s}\n"
    )
    for r in cmp["metrics"]:
        sys.stdout.write(
            f"{r['metric']:38s} {str(r['old']):>10s} {str(r['new']):>10s} "
            f"{str(r['delta']):>8s} {r['direction']:>10s}\n"
        )
    return 0


def run(args: argparse.Namespace) -> int:
    sub = args.arena_subcommand or "run"
    if sub == "run":
        return _run(args)
    if sub == "report":
        return _report(args)
    if sub == "compare":
        return _compare(args)
    sys.stderr.write(f"unknown arena subcommand: {sub}\n")
    return 2
