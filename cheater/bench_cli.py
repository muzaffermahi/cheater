"""cheater bench -- run multiple benchmark modes."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.benchmark import (
    evaluate,
    evaluate_compare,
    format_compare,
    format_summary,
    read_benchmark,
)
from cheater.retrieval import BM25FIndex, load_index_cards


def _bench_retrieval(args: argparse.Namespace) -> int:
    bench_path = Path(args.benchmark or "data/benchmarks/sample_benchmark.jsonl")
    if not bench_path.is_file():
        sys.stderr.write(f"Benchmark file not found: {bench_path}\n")
        return 2
    cards_path = Path(args.cards or "data/cards/cards.v1.jsonl")
    if not cards_path.is_file():
        cards_path = Path(args.cards or "data/samples/sample_cards.v1.jsonl")
    if not cards_path.is_file():
        sys.stderr.write(f"Card file not found: {cards_path}\n")
        return 2
    cards = load_index_cards(cards_path)
    cases = read_benchmark(bench_path)
    sys.stderr.write(f"Loaded {len(cards)} cards, {len(cases)} cases\n")
    if args.compare:
        opts = {
            "default": {"top_k": args.top_k},
            "bm25f_symptom_heavy": {"top_k": args.top_k, "field_overrides": {
                "symptom": 3.0, "root_cause": 1.8, "fix_pattern": 1.6,
                "search_keywords": 1.4, "embedding_text": 1.2,
            }},
        }
        # Drop field_overrides (not in evaluate_compare signature); use compact_first only
        opts = {
            "default": {"top_k": args.top_k},
            "compact_first": {"top_k": args.top_k, "compact_cards_path": args.compact_cards},
        }
        results = evaluate_compare(cases, cards, opts, top_k=args.top_k)
        if args.json:
            sys.stdout.write(json.dumps([r.to_dict() for r in results], indent=2, ensure_ascii=False))
            sys.stdout.write("\n")
        else:
            sys.stdout.write(format_compare(results) + "\n")
        return 0
    idx = BM25FIndex(cards)
    summary = evaluate(cases, idx, top_k=args.top_k)
    if args.json:
        sys.stdout.write(json.dumps(summary, indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    else:
        sys.stdout.write(format_summary(summary) + "\n")
    return 0


def _bench_guide(args: argparse.Namespace) -> int:
    """Quick guide benchmark: a deterministic check that guide produces non-empty output."""
    from cheater.guide import generate_guide, guide_text
    bench_path = Path(args.benchmark or "data/benchmarks/sample_benchmark.jsonl")
    if not bench_path.is_file():
        sys.stderr.write(f"Benchmark file not found: {bench_path}\n")
        return 2
    cards_path = Path(args.cards or "data/samples/sample_cards.v1.jsonl")
    if not cards_path.is_file():
        sys.stderr.write(f"Card file not found: {cards_path}\n")
        return 2
    cards = load_index_cards(cards_path)
    cases = read_benchmark(bench_path)
    sys.stderr.write(f"Guide benchmark: {len(cases)} cases, {len(cards)} cards\n")
    results: list[dict] = []
    for c in cases:
        g = generate_guide(c["query"], cards, top_k=args.top_k)
        text = guide_text(c["query"], cards, top_k=args.top_k)
        expected = set(c.get("expected_card_ids") or [])
        returned = {r["id"] for r in g["results"]}
        hit = bool(expected & returned)
        results.append({
            "query": c["query"][:100],
            "expected": list(expected),
            "returned": list(returned),
            "hit": hit,
            "guide_length": len(text),
            "warnings": len(g.get("warnings") or []),
        })
    hits = sum(1 for r in results if r["hit"])
    sys.stdout.write(f"Guide benchmark: {hits}/{len(results)} cases where expected card appears in guide\n")
    for r in results:
        sys.stdout.write(
            f"  - hit={r['hit']:5}  guide_len={r['guide_length']:5}  warnings={r['warnings']:2}  q={r['query']}\n"
        )
    return 0


def _bench_explorer(args: argparse.Namespace) -> int:
    """Quick explorer benchmark on a tiny fixture or the current repo."""
    from cheater.explorer import explore
    bench_path = Path(args.benchmark or "data/benchmarks/explorer_smoke.jsonl")
    if not bench_path.is_file():
        sys.stderr.write(f"Explorer benchmark file not found: {bench_path}\n")
        sys.stderr.write("Creating a tiny inline benchmark against the current repo.\n")
        queries = [
            ("card quality scoring", ["cheater/quality.py"]),
            ("retrieval search", ["cheater/retrieval.py"]),
            ("tui commands", ["cheater/tui.py"]),
        ]
        root = Path.cwd()
        results = []
        for query, expected_files in queries:
            ex = explore(query, repo_root=root, max_files=300)
            got = {tf.get("path", "") for tf in ex.top_files}
            hit = any(any(ef in g for g in got) for ef in expected_files)
            results.append({"query": query, "expected": expected_files, "got": list(got)[:10], "hit": hit})
        hits = sum(1 for r in results if r["hit"])
        sys.stdout.write(f"Explorer benchmark (inline): {hits}/{len(results)} hit\n")
        for r in results:
            sys.stdout.write(f"  - hit={r['hit']:5}  q={r['query']}\n")
            for g in r["got"][:3]:
                sys.stdout.write(f"      {g}\n")
        return 0
    # File-based
    import json as _json
    cases = []
    with bench_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            cases.append(_json.loads(line))
    root = Path.cwd()
    hits = 0
    for c in cases:
        ex = explore(c["query"], repo_root=root, max_files=300)
        got = {tf.get("path", "") for tf in ex.top_files}
        expected = c.get("expected_files") or []
        hit = any(any(ef in g for g in got) for ef in expected)
        if hit:
            hits += 1
        sys.stdout.write(f"  - hit={hit:5}  q={c['query']}\n")
    sys.stdout.write(f"\nExplorer benchmark: {hits}/{len(cases)} hit\n")
    return 0


def _bench_smoke_agent(args: argparse.Namespace) -> int:
    """Tiny synthetic agent-loop smoke test. No model. Just walk the loop."""
    from cheater.agent import Agent
    from cheater.config import CheaterConfig
    cfg = CheaterConfig(mode="ask", provider=cfg_provider_none())
    cfg.project_root = str(Path.cwd().resolve())
    agent = Agent(cfg, project_root=cfg.project_root)
    tests = [
        ("ask", "where is card quality scoring implemented?"),
        ("ask", "how does retrieval work?"),
        ("plan", "fix a failing test in tests/test_quality.py"),
        ("review", None),
    ]
    sys.stdout.write("=== Agent loop smoke ===\n")
    for mode, task in tests:
        if mode == "ask":
            r = agent.ask(task)
            sys.stdout.write(f"  ask    task={task[:40]!r:42}  ok=True  plan_steps={len(r.plan.splitlines())}\n")
        elif mode == "plan":
            r = agent.plan(task)
            sys.stdout.write(f"  plan   task={task[:40]!r:42}  ok=True  steps={len(r.steps)}\n")
        elif mode == "review":
            r = agent.review()
            sys.stdout.write(f"  review files={len(r.files)}  diff_len={len(r.diff)}\n")
    sys.stdout.write("\nAgent smoke: PASS\n")
    return 0


def cfg_provider_none():
    from cheater.config import ProviderSettings
    return ProviderSettings()


def run(args: argparse.Namespace) -> int:
    sub = getattr(args, "bench_subcommand", "retrieval")
    if sub == "retrieval":
        return _bench_retrieval(args)
    if sub == "guide":
        return _bench_guide(args)
    if sub == "explorer":
        return _bench_explorer(args)
    if sub == "smoke-agent":
        return _bench_smoke_agent(args)
    if sub == "all":
        rc = 0
        for s in ("retrieval", "guide", "explorer", "smoke-agent"):
            args.bench_subcommand = s
            sys.stderr.write(f"\n--- bench {s} ---\n")
            if s == "retrieval":
                rc |= _bench_retrieval(args)
            elif s == "guide":
                rc |= _bench_guide(args)
            elif s == "explorer":
                rc |= _bench_explorer(args)
            elif s == "smoke-agent":
                rc |= _bench_smoke_agent(args)
        return rc
    sys.stderr.write(f"Unknown bench subcommand: {sub}\n")
    return 2
