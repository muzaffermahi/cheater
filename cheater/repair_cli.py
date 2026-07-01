"""CLI handlers for the v0.6 repair-harness layer.

Commands:
  map           - build / print the repo map
  map search    - print a relevant excerpt for a query
  localize      - run the localizer and print the JSON result
  context       - print a compact context pack for a task
  test-summary  - run a command and print a compressed failure summary

All commands are model-free by default. The localizer will use a model if
CHEATER_PROVIDER is configured AND --use-model is passed.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _resolve_repo(args: argparse.Namespace) -> Path:
    raw = getattr(args, "repo", None)
    return Path(raw).resolve() if raw else Path.cwd().resolve()


# ---------- map ----------

def _cmd_map_build(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    from cheater.repo_map import build_repo_map, save_repo_map
    m = build_repo_map(repo)
    out_dir = Path(args.out_dir) if args.out_dir else (repo / ".cheater")
    paths = save_repo_map(m, out_dir)
    if args.json:
        sys.stdout.write(json.dumps({
            "repo_root": m.repo_root,
            "files": len(m.files),
            "tests": len(m.all_test_files()),
            "sources": len(m.all_source_files()),
            "warnings": m.warnings,
            "paths": paths,
        }, indent=2) + "\n")
    else:
        sys.stdout.write(f"=== repo map ===\n")
        sys.stdout.write(f"repo:       {m.repo_root}\n")
        sys.stdout.write(f"files:      {len(m.files)}  tests: {len(m.all_test_files())}  sources: {len(m.all_source_files())}\n")
        if m.warnings:
            sys.stdout.write("warnings:\n")
            for w in m.warnings:
                sys.stdout.write(f"  - {w}\n")
        sys.stdout.write(f"json:       {paths['json']}\n")
        sys.stdout.write(f"markdown:   {paths['md']}\n")
    return 0


def _cmd_map_search(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    from cheater.repo_map import build_repo_map, select_relevant_map
    m = build_repo_map(repo)
    excerpt = select_relevant_map(m, query=args.query, traceback=args.traceback or "",
                                  top_k=args.top_k)
    sys.stdout.write(excerpt + "\n")
    return 0


# ---------- localize ----------

def _cmd_localize(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    tb = args.traceback or ""
    if args.traceback_file:
        try:
            tb = Path(args.traceback_file).read_text(encoding="utf-8", errors="ignore")
        except OSError as e:
            sys.stderr.write(f"Cannot read traceback file: {e}\n")
            return 1
    from cheater.repo_map import build_repo_map
    from cheater.localizer import (
        deterministic_localize, localize_with_model, LocalizationResult,
    )
    m = build_repo_map(repo)
    if args.use_model:
        from cheater.config import load_config
        from cheater.providers import get_provider, ProviderConfig
        cfg = load_config(repo)
        pc = ProviderConfig(
            provider=cfg.provider.provider,
            model=cfg.provider.model,
            base_url=cfg.provider.base_url,
            api_key=cfg.provider.api_key,
        )
        provider = get_provider(pc)
        from cheater.context_pack import build_context_pack
        pack = build_context_pack(task=args.task, repo_root=repo,
                                  traceback=tb, include_repo_map=True)
        result = localize_with_model(provider, args.task, pack)
    else:
        result = deterministic_localize(args.task, tb, m)
    sys.stdout.write(json.dumps(result.to_dict(), indent=2) + "\n")
    return 0


# ---------- context ----------

def _cmd_context(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    from cheater.context_pack import build_context_pack, render_for_model
    store = None
    if args.memory_dir:
        from cheater.memory_store import MemoryStore
        store = MemoryStore(Path(args.memory_dir))
    pack = build_context_pack(
        task=args.task, repo_root=repo,
        traceback=args.traceback or "",
        memory_store=store,
        max_tokens=args.max_tokens,
    )
    sys.stdout.write(render_for_model(pack))
    return 0


# ---------- test-summary ----------

def _cmd_test_summary(args: argparse.Namespace) -> int:
    repo = _resolve_repo(args)
    cmd = args.command
    if not cmd:
        sys.stderr.write("test-summary: --command is required\n")
        return 2
    from cheater.runner import run as runner_run
    from cheater.failure_compressor import (
        compress_command_result, render_failure_for_model,
    )
    timeout = float(args.timeout or 120)
    r = runner_run(cmd, cwd=repo, timeout=timeout, yes=True)
    summary = compress_command_result(cmd, r.stdout or "", r.stderr or "", r.returncode)
    if args.json:
        sys.stdout.write(json.dumps(summary.to_dict(), indent=2) + "\n")
    else:
        sys.stdout.write(render_failure_for_model(summary, max_tokens=args.max_tokens))
    return 0 if summary.passed else 1


# ---------- dispatchers ----------

def _run_map(args: argparse.Namespace) -> int:
    sub = args.map_subcommand or "build"
    if sub == "build":
        return _cmd_map_build(args)
    if sub == "search":
        return _cmd_map_search(args)
    sys.stderr.write(f"Unknown map subcommand: {sub}\n")
    return 2


def run(args: argparse.Namespace) -> int:
    """The top-level dispatcher for the v0.6 CLI surface."""
    cmd = getattr(args, "repair_command", None)
    if cmd == "map":
        return _run_map(args)
    if cmd == "localize":
        return _cmd_localize(args)
    if cmd == "context":
        return _cmd_context(args)
    if cmd == "test-summary":
        return _cmd_test_summary(args)
    sys.stderr.write(f"Unknown repair subcommand: {cmd}\n")
    return 2
