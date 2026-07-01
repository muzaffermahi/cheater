from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from .benchmark_harness import BenchmarkError, BenchmarkHarness
from .cheater_config import (
    ConfigError,
    load_config,
    memory_db_path,
    resolve_real_pi_command,
    set_config_value,
)
from .cheater_core import CheaterSession
from .cheater_doctor import collect_doctor, print_doctor
from .cheater_tui import run_tui


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Cheater: native Pi wrapper with solved-bug memory.",
        epilog=(
            "Commands: doctor [--json], config show, config set <key> <value>, "
            "uninstall-pi-shim"
        ),
    )
    parser.add_argument(
        "repo_path", nargs="?", help="Target repo (default: current directory)."
    )
    parser.add_argument(
        "--repo", dest="repo_option", help="Prepared repo for benchmark mode."
    )
    parser.add_argument("--task", default="")
    parser.add_argument("--error", default="")
    parser.add_argument("--query", default="")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument(
        "--retrieval-strategy",
        choices=("legacy", "bm25", "bm25_filtered", "hybrid"),
        default="legacy",
    )
    parser.add_argument("--bm25-minimum-anchor-matches", type=int, default=2)
    parser.add_argument("--bm25-minimum-score-margin", type=float, default=5.0)
    parser.add_argument("--include-patch", action="store_true")
    parser.add_argument("--test-command", default="")
    parser.add_argument("--no-auto-send", action="store_true")
    parser.add_argument("--clip-only", action="store_true")
    parser.add_argument("--fast", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-weak-query", action="store_true")
    parser.add_argument("--min-score", type=float, default=50.0)
    parser.add_argument("--bench", help="Benchmark profile, such as swebench_verified.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--ids", help="Comma-separated benchmark instance IDs.")
    parser.add_argument("--sample", type=int, default=None)
    parser.add_argument(
        "--agent",
        choices=("pi", "qwen"),
        default="pi",
        help="Benchmark agent. Use qwen for the loopback-only local tool adapter.",
    )
    parser.add_argument("--test-timeout", type=float, default=900.0)
    parser.add_argument(
        "--qwen-base-url",
        default=os.getenv("CHEATER_QWEN_BASE_URL", "http://127.0.0.1:1234/v1"),
    )
    parser.add_argument("--qwen-model", default=os.getenv("CHEATER_QWEN_MODEL", ""))
    parser.add_argument("--qwen-max-turns", type=int, default=30)
    parser.add_argument("--qwen-max-tokens", type=int, default=4096)
    parser.add_argument("--qwen-seed", type=int, default=0)
    parser.add_argument(
        "--qwen-action-rescue",
        action="store_true",
        help="Enable one compact, separately labeled action phase after a Qwen stall.",
    )
    parser.add_argument(
        "--qwen-failure-critic",
        action="store_true",
        help="After a failed rescue test, require one compact evidence-only critic turn.",
    )
    parser.add_argument(
        "--qwen-evidence-budget",
        type=int,
        default=0,
        help="Trigger action rescue after N consecutive read/search/diff turns (0 disables).",
    )
    parser.add_argument("--max-retries", type=int, default=1)
    parser.add_argument(
        "--no-memory",
        action="store_true",
        help="Disable memory retrieval for an explicit benchmark baseline arm.",
    )
    parser.add_argument("--allow-download", action="store_true")
    parser.add_argument("--eval-command", default="")
    parser.add_argument(
        "--audit-incomplete-run",
        help="Finalize an interrupted benchmark run as aborted_runtime without inferring outcome.",
    )
    parser.add_argument(
        "--abort-reason",
        default="Runtime ended before benchmark finalization.",
    )
    parser.add_argument(
        "--local-eval-summary",
        help="summary.json proving the ten-task local gate before a real benchmark agent run.",
    )
    return parser


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.top_k < 1:
        parser.error("--top-k must be at least 1")
    if args.min_score < 0:
        parser.error("--min-score must be zero or greater")
    if args.bm25_minimum_anchor_matches < 0:
        parser.error("--bm25-minimum-anchor-matches cannot be negative")
    if args.bm25_minimum_score_margin < 0:
        parser.error("--bm25-minimum-score-margin cannot be negative")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.sample is not None and args.sample < 1:
        parser.error("--sample must be at least 1")
    if args.test_timeout <= 0:
        parser.error("--test-timeout must be greater than zero")
    if args.qwen_max_turns < 1:
        parser.error("--qwen-max-turns must be at least 1")
    if args.qwen_max_tokens < 1:
        parser.error("--qwen-max-tokens must be at least 1")
    if args.qwen_failure_critic and not args.qwen_action_rescue:
        parser.error("--qwen-failure-critic requires --qwen-action-rescue")
    if args.qwen_evidence_budget < 0:
        parser.error("--qwen-evidence-budget cannot be negative")
    if args.qwen_evidence_budget and not args.qwen_action_rescue:
        parser.error("--qwen-evidence-budget requires --qwen-action-rescue")
    if args.max_retries < 0:
        parser.error("--max-retries cannot be negative")
    return args


def resolve_repo(args: argparse.Namespace, *, required: bool) -> Path | None:
    values = [value for value in [args.repo_path, args.repo_option] if value]
    if len(values) == 2 and Path(values[0]).resolve() != Path(values[1]).resolve():
        raise SystemExit(
            "Provide the repository either positionally or with --repo, not both."
        )
    if not values:
        return Path.cwd().resolve() if required else None
    repo = Path(values[0]).expanduser().resolve()
    if not repo.is_dir():
        raise SystemExit(f"Repository directory not found: {repo}")
    return repo


def run_benchmark(args: argparse.Namespace, project_root: Path) -> int:
    harness = BenchmarkHarness(project_root)
    try:
        if args.sample is not None:
            harness.print_sample(
                args.bench, args.sample, allow_download=args.allow_download
            )
            return 0
        ids = [item for item in (args.ids or "").split(",") if item] or None
        if args.limit is None and not ids:
            raise BenchmarkError("Use --sample N, --limit N, or --ids id1,id2.")
        repo = resolve_repo(args, required=False)
        harness.run_profile(
            args.bench,
            limit=args.limit,
            ids=ids,
            repo=repo,
            dry_run=args.dry_run,
            auto_send=not args.no_auto_send,
            cards_path=memory_db_path(project_root),
            top_k=args.top_k,
            min_score=args.min_score,
            include_patch=args.include_patch,
            allow_download=args.allow_download,
            evaluator_command=args.eval_command,
            local_eval_summary=(
                Path(args.local_eval_summary).expanduser().resolve()
                if args.local_eval_summary
                else None
            ),
            agent=args.agent,
            test_command=args.test_command,
            test_timeout=args.test_timeout,
            qwen_base_url=args.qwen_base_url,
            qwen_model=args.qwen_model,
            qwen_max_turns=args.qwen_max_turns,
            qwen_max_tokens=args.qwen_max_tokens,
            qwen_seed=args.qwen_seed,
            qwen_action_rescue=args.qwen_action_rescue,
            qwen_failure_critic=args.qwen_failure_critic,
            qwen_evidence_budget=args.qwen_evidence_budget,
            max_retries=args.max_retries,
            use_memory=not args.no_memory,
            retrieval_strategy=args.retrieval_strategy,
            bm25_minimum_anchor_matches=args.bm25_minimum_anchor_matches,
            bm25_minimum_score_margin=args.bm25_minimum_score_margin,
        )
        return 0
    except (BenchmarkError, ConfigError) as exc:
        print("Benchmark setup:", exc)
        return 2


def handle_doctor(project_root: Path, argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cheater doctor")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    report = collect_doctor(project_root)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print_doctor(report)
    return 0 if report["ok"] else 1


def handle_config(project_root: Path, argv: list[str]) -> int:
    if not argv or argv[0] == "show":
        try:
            value = load_config(project_root)
        except ConfigError as exc:
            print("Config error:", exc)
            return 1
        print(json.dumps(value, indent=2, ensure_ascii=False))
        return 0
    if argv[0] == "set" and len(argv) >= 3:
        try:
            path = set_config_value(project_root, argv[1], " ".join(argv[2:]))
        except ConfigError as exc:
            print("Config error:", exc)
            return 1
        print(f"Set {argv[1]} in {path}")
        return 0
    print("Usage: cheater config show | cheater config set <key> <value>")
    return 2


def print_uninstall_pi_shim(project_root: Path) -> int:
    try:
        config = load_config(project_root)
    except ConfigError as exc:
        print("Config error:", exc)
        return 1
    shim_dir = config.get("shim_dir")
    if not shim_dir:
        print("No Pi shim directory is recorded in Cheater config.")
        return 0
    print("Pi shim uninstall instructions:")
    print(f"1. Remove this directory: {shim_dir}")
    print("2. Remove that same directory from your USER PATH.")
    print("3. Open a new PowerShell window and run: where.exe pi")
    print("The real Pi installation is not modified by these steps.")
    return 0


def run_real_pi_passthrough(project_root: Path, pi_args: list[str]) -> int:
    command = resolve_real_pi_command(project_root)
    if not command:
        print(
            "Real Pi not detected. Set CHEATER_REAL_PI_COMMAND or run cheater doctor."
        )
        return 127
    return subprocess.call([*command, *pi_args], cwd=str(Path.cwd()))


def run_pi_wrapper(project_root: Path, raw_args: list[str]) -> int:
    administrative = {"install", "remove", "uninstall", "update", "list", "config"}
    if raw_args and (
        raw_args[0] in administrative
        or raw_args[0] in {"--help", "-h", "--version", "-v"}
    ):
        return run_real_pi_passthrough(project_root, raw_args)

    fast = False
    no_auto_send = False
    clip_only = False
    dry_run = False
    pi_args: list[str] = []
    for arg in raw_args:
        if arg in {"--cheater-fast", "--fast"}:
            fast = True
        elif arg == "--no-auto-send":
            no_auto_send = True
        elif arg == "--clip-only":
            clip_only = True
        elif arg == "--dry-run":
            dry_run = True
        else:
            pi_args.append(arg)

    repo = Path.cwd().resolve()
    retrieve_memories = True
    launch = True
    task = ""
    error = ""
    print(f"Cheater detected repo: {repo}")
    if not fast:
        task = input("Task? [Enter for blank/exploratory]: ").strip()
        error = input("Observed error? [optional]: ").strip()
        retrieve_memories = input("Retrieve memories? [Y/n]: ").strip().lower() not in {
            "n",
            "no",
        }
        launch = input("Launch Pi? [Y/n]: ").strip().lower() not in {"n", "no"}

    cards_path = memory_db_path(project_root)
    session = CheaterSession(
        repo,
        cards_path,
        repo / ".cheater" / "sessions",
        task=task,
        error=error,
        auto_send=not no_auto_send,
        disable_memories=not retrieve_memories,
        pi_args=pi_args,
    )
    prompt_file = session.generate_prompt(mode="pi_shim", interactive_memory=False)
    if dry_run:
        session._update_summary({"status": "dry_run"})
        print("Dry run complete. Pi was not launched.")
        print("Prompt file:", prompt_file)
        return 0
    if clip_only:
        session.copy_latest_prompt()
        session._update_summary({"status": "clip_only"})
        return 0
    if not launch:
        print("Pi launch skipped. Prompt file:", prompt_file)
        return 0
    return session.launch_latest().exit_code


def run_normal(args: argparse.Namespace, project_root: Path) -> int:
    if args.audit_incomplete_run:
        try:
            BenchmarkHarness(project_root).audit_incomplete_run(
                Path(args.audit_incomplete_run), reason=args.abort_reason
            )
            return 0
        except BenchmarkError as exc:
            print("Benchmark audit:", exc)
            return 2
    if args.bench:
        return run_benchmark(args, project_root)
    repo = resolve_repo(args, required=True)
    assert repo is not None
    cards_path = memory_db_path(project_root)
    if not cards_path.exists():
        raise SystemExit(f"Compact memory database not found: {cards_path}")
    session = CheaterSession(
        repo,
        cards_path,
        repo / ".cheater" / "sessions",
        task=args.task,
        error=args.error,
        query=args.query,
        test_command=args.test_command,
        top_k=args.top_k,
        include_patch=args.include_patch,
        allow_weak_query=args.allow_weak_query,
        min_score=args.min_score,
        retrieval_strategy=args.retrieval_strategy,
        bm25_minimum_anchor_matches=args.bm25_minimum_anchor_matches,
        bm25_minimum_score_margin=args.bm25_minimum_score_margin,
        auto_send=not args.no_auto_send,
    )
    has_context = any([args.task.strip(), args.error.strip(), args.query.strip()])
    if not has_context and not args.dry_run and not args.fast and not args.clip_only:
        run_tui(session, project_root)
        return 0
    if args.dry_run:
        session.generate_prompt(mode="dry_run", interactive_memory=False)
        session._update_summary({"status": "dry_run"})
        print("Dry run complete. Pi was not launched.")
        return 0
    if args.clip_only:
        session.generate_prompt(mode="clip_only", interactive_memory=False)
        session.copy_latest_prompt()
        session._update_summary({"status": "clip_only"})
        return 0
    result = session.run(
        interactive_memory=False, mode="fast" if args.fast else "cheater"
    )
    if args.test_command and result.exit_code == 0:
        session.run_configured_tests()
    return result.exit_code


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    project_root = Path(__file__).resolve().parent
    if argv and argv[0] == "doctor":
        return handle_doctor(project_root, argv[1:])
    if argv and argv[0] == "config":
        return handle_config(project_root, argv[1:])
    if argv and argv[0] == "uninstall-pi-shim":
        return print_uninstall_pi_shim(project_root)
    if "--wrap-pi" in argv:
        argv.remove("--wrap-pi")
        return run_pi_wrapper(project_root, argv)
    return run_normal(parse_args(argv), project_root)


if __name__ == "__main__":
    raise SystemExit(main())
