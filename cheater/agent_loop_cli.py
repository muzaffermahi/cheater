"""cheater agent -- the v0.3 multi-step agent loop.

Replaces the old ask/plan/build/review commands.

Public API: run(args) -> int

Usage:
  cheater agent "fix the failing test in tests/test_quality.py"
  cheater agent --dry-run "refactor cheater/quality.py"
  cheater agent --read-only "what is the test command?"
  cheater agent --max-steps 5 --verbose "small task"
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.config import load_config
from cheater.providers import (
    ModelNotConfigured,
    OpenAIProvider,
    ProviderConfig,
    get_provider,
)
from cheater.agent_loop import AgentLoop, LoopEvent, LoopResult
from cheater.retrieval import load_index_cards


def _make_provider(args: argparse.Namespace) -> tuple[Any, list[dict]]:
    cfg = load_config(getattr(args, "repo", None))
    root = Path(args.repo) if getattr(args, "repo", None) else Path.cwd()
    pc = ProviderConfig(
        provider=cfg.provider.provider,
        model=cfg.provider.model,
        base_url=cfg.provider.base_url,
        api_key=cfg.provider.api_key,
        temperature=cfg.provider.temperature,
        max_tokens=cfg.provider.max_tokens,
        timeout=cfg.provider.timeout,
        max_retries=cfg.provider.max_retries,
    )
    provider = get_provider(pc)
    # Load cards from default corpus
    cards: list[dict] = []
    for path in (root / cfg.cards_path, root / cfg.sample_cards_path):
        if path.is_file():
            cards = load_index_cards(path)
            if cards:
                break
    return provider, cards


def _print_event(ev: LoopEvent) -> None:
    """Default progress printer."""
    if ev.kind == "plan":
        sys.stdout.write(f"\n{ev.message}\n")
        sys.stdout.flush()
    elif ev.kind == "step":
        mark = "✓" if ev.success else "✗"
        sys.stdout.write(
            f"  {mark} [{ev.step_num}] {ev.result_summary}  ({ev.elapsed:.1f}s)\n"
        )
        sys.stdout.flush()
    elif ev.kind == "finish":
        sys.stdout.write(f"\n{ev.message}\n")
        sys.stdout.flush()
    elif ev.kind == "warn" or ev.kind == "error":
        sys.stdout.write(f"  ! {ev.message}\n")
        sys.stdout.flush()


def run(args: argparse.Namespace) -> int:
    from cheater.config import load_config
    from cheater.memory_store import MemoryStore
    from cheater.trace_recorder import TraceRecorder

    provider, cards = _make_provider(args)
    root = Path(args.repo) if getattr(args, "repo", None) else Path.cwd()
    on_event = None if args.quiet else _print_event
    # v0.5: agent-curated memory
    memory_dir = getattr(args, "memory_dir", None)
    memory_store = None
    if memory_dir:
        memory_store = MemoryStore(Path(memory_dir))
    else:
        # Default: ~/.config/cheater/memory
        memory_store = MemoryStore()
    # v0.7: optional trace recorder
    cfg = load_config(root)
    recorder = None
    if cfg.arena.trace_enabled:
        import uuid as _uuid

        run_id = _uuid.uuid4().hex[:12]
        recorder = TraceRecorder(
            run_id=run_id,
            root_dir=root,
            store_prompts=cfg.arena.trace_full_prompts,
            store_outputs=cfg.arena.trace_full_prompts,
        )
    loop = AgentLoop(
        provider=provider,
        repo_root=root,
        max_steps=args.max_steps,
        read_only=args.read_only,
        verbose=args.verbose,
        cards=cards,
        on_event=on_event,
        memory_store=memory_store,
        trace_recorder=recorder,
        tool_policy_enabled=cfg.arena.tool_policy_enabled,
    )
    if args.dry_run:
        # Plan only, no execution
        try:
            plan = loop._plan(args.task)
        except ModelNotConfigured as e:
            sys.stderr.write(f"Cannot dry-run: {e}\n")
            return 2
        except Exception as e:
            sys.stderr.write(f"Plan failed: {e}\n")
            return 1
        sys.stdout.write("DRY RUN: plan for " + args.task + "\n")
        for i, step in enumerate(plan, start=1):
            sys.stdout.write(f"  {i}. {step}\n")
        sys.stdout.write("\n(finish the loop with `cheater agent ...` to execute)\n")
        return 0
    result: LoopResult = loop.run(args.task)
    if recorder is not None:
        try:
            recorder.close()
            sys.stdout.write(f"\nTrace: {recorder.path}\n")
        except Exception:
            pass
    if args.json:
        sys.stdout.write(
            json.dumps(result.to_dict(), indent=2, ensure_ascii=False) + "\n"
        )
    else:
        sys.stdout.write("\n=== Agent Result ===\n")
        sys.stdout.write(f"Task:       {result.task}\n")
        sys.stdout.write(f"Success:    {result.success}\n")
        sys.stdout.write(f"Finished by:{result.finished_by}\n")
        sys.stdout.write(f"Steps:      {len(result.steps)}\n")
        sys.stdout.write(f"Elapsed:    {result.elapsed:.1f}s\n")
        if result.summary:
            sys.stdout.write(f"Summary:    {result.summary}\n")
        if result.error:
            sys.stdout.write(f"Error:      {result.error}\n")
        if result.plan and args.verbose:
            sys.stdout.write("\nPlan:\n")
            for i, p in enumerate(result.plan, start=1):
                sys.stdout.write(f"  {i}. {p}\n")
    return 0 if result.success else 1
