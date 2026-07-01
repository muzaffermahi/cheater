from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

from .bug_memory import MAX_DEFAULT_CORPUS_BYTES, inspect_cards_corpus
from .cheater_config import memory_db_path
from .cheater_core import save_json, write_text
from .cheater_retry_controller import (
    QWEN_SETUP_INSTRUCTIONS,
    VARIANT_SPECS,
    AgentRun,
    EvalTask,
    RepoSafetyError,
    collect_changed_files,
    collect_git_diff,
    create_disposable_worktree,
    ensure_clean_repo,
    get_variant_spec,
    memory_telemetry,
    remove_disposable_worktree,
    reset_repo,
    run_cheater_retry,
    run_test_command,
    run_variant_agent,
    save_task,
    snapshot_repo,
)
from .contamination_filters import (
    ContaminationFilter,
    DEFAULT_BENCHMARK_HOLDOUTS,
    build_contamination_report,
)


VARIANT_ALIASES: dict[str, list[str]] = {
    "both": ["baseline_pi", "cheater_pi", "cheater_pi_retry"],
    "pi": ["baseline_pi", "cheater_pi", "cheater_pi_retry"],
    "qwen": ["baseline_qwen", "cheater_qwen", "cheater_qwen_retry"],
    "all": list(VARIANT_SPECS),
}


def build_parser() -> argparse.ArgumentParser:
    choices = tuple(VARIANT_SPECS) + tuple(VARIANT_ALIASES)
    parser = argparse.ArgumentParser(
        description=(
            "Run honest local bug-fix ablations with baseline, memory, and "
            "memory-plus-retry agents."
        ),
        epilog=(
            "Aliases: both/pi = the three Pi variants; qwen = the three Qwen "
            "variants; all = all six. Qwen uses a loopback-only local tool adapter."
        ),
    )
    parser.add_argument("--tasks", required=True, help="JSONL evaluation task file.")
    parser.add_argument("--variant", choices=choices, default="both")
    parser.add_argument("--limit", type=int, help="Run only the first N tasks.")
    parser.add_argument(
        "--trials",
        type=int,
        default=1,
        help=(
            "Repeat every selected task/variant N times. Repeated real runs require "
            "--isolate-worktrees or explicitly authorized reset mode."
        ),
    )
    parser.add_argument(
        "--task-id",
        dest="task_ids",
        action="append",
        help="Run one task ID; repeat to select multiple specific tasks before --limit.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=1,
        help="Repair attempts for *_retry variants after the first failed test run.",
    )
    parser.add_argument(
        "--output", default="eval_runs", help="Artifact root directory."
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Allow a dirty target repo. This can contaminate results and disables reset mode.",
    )
    parser.add_argument(
        "--reset-between",
        action="store_true",
        help="Request destructive restoration between runs; confirmation is still required.",
    )
    parser.add_argument(
        "--hard-reset",
        action="store_true",
        help=(
            "Explicitly authorize git reset --hard <captured commit> and git clean -fd. "
            "Only valid with --reset-between."
        ),
    )
    parser.add_argument(
        "--restore-after",
        action="store_true",
        help="Also restore the final target repo; only valid with --reset-between.",
    )
    parser.add_argument(
        "--isolate-worktrees",
        action="store_true",
        help=(
            "Run each task/variant in a fresh detached Git worktree owned by the "
            "evaluation run. This avoids resetting the prepared source repository."
        ),
    )
    parser.add_argument(
        "--keep-worktrees",
        action="store_true",
        help=(
            "Keep disposable worktrees after the run for inspection; only valid with "
            "--isolate-worktrees."
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Generate artifacts only."
    )
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument(
        "--memory-cards",
        dest="cards_path",
        help=(
            "Explicit JSONL memory corpus. Supports compact cards, new memory-store cards, or "
            "converted solved trajectory cards; defaults to data/compact_bug_cards.jsonl."
        ),
    )
    parser.add_argument(
        "--memory-index",
        default="",
        help=(
            "Path to a built memory index directory (for hybrid retrieval). "
            "When set, --retrieval-strategy hybrid uses the dense embeddings from this index."
        ),
    )
    parser.add_argument(
        "--allow-large-cards",
        action="store_true",
        help=(
            "Authorize loading a supported memory-card file larger than 256 MB. Raw "
            "trajectory rows remain unsupported and must be converted first."
        ),
    )
    parser.add_argument(
        "--dense-model",
        default="",
        help=(
            "Dense embedding model for hybrid retrieval "
            "(e.g. all-MiniLM-L6-v2, BAAI/bge-small-en-v1.5). "
            "Only used when --retrieval-strategy is hybrid."
        ),
    )
    parser.add_argument(
        "--candidate-k",
        type=int,
        default=20,
        help="Number of candidates to retrieve from each retriever before fusion (hybrid only).",
    )
    parser.add_argument(
        "--bm25-weight",
        type=float,
        default=0.4,
        help="BM25 weight in hybrid fusion score (default: 0.4).",
    )
    parser.add_argument(
        "--dense-weight",
        type=float,
        default=0.6,
        help="Dense weight in hybrid fusion score (default: 0.6).",
    )
    parser.add_argument(
        "--exclude-source-dataset",
        action="append",
        default=None,
        help=(
            "Exclude cards from a specific source dataset. Repeatable. "
            "Useful for benchmark hygiene."
        ),
    )
    parser.add_argument(
        "--allow-quarantined-memory",
        action="store_true",
        help="DANGEROUS: Allow retrieving from quarantined benchmark holdout datasets.",
    )
    parser.add_argument(
        "--configuration-label",
        default="",
        help=(
            "Stable label appended to memory-enabled variants, for example compact_top3 "
            "or raw_top1_patches."
        ),
    )
    parser.add_argument(
        "--retrieval-strategy",
        choices=("legacy", "bm25", "bm25_filtered", "hybrid"),
        default="legacy",
        help=(
            "legacy: weighted token overlap; bm25: BM25F ranking; "
            "bm25_filtered: BM25F + confidence threshold; "
            "hybrid: BM25 + dense embedding fusion (requires built index)."
        ),
    )
    parser.add_argument("--bm25-minimum-anchor-matches", type=int, default=2)
    parser.add_argument("--bm25-minimum-score-margin", type=float, default=5.0)
    parser.add_argument(
        "--retrieval-query-mode",
        choices=("runtime", "semantic"),
        default="runtime",
        help=(
            "runtime includes the preflight traceback in memory retrieval; semantic uses "
            "only the task and declared error. Both modes put preflight evidence in the "
            "agent prompt."
        ),
    )
    parser.add_argument("--include-patch", action="store_true")
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="Skip the initial failing-test validation (recorded and discouraged).",
    )
    parser.add_argument(
        "--test-timeout",
        type=float,
        default=900.0,
        help="Seconds allowed for each preflight or post-agent test command.",
    )
    parser.add_argument(
        "--agent-timeout",
        type=float,
        default=3600.0,
        help="Seconds allowed for each Pi RPC agent attempt.",
    )
    parser.add_argument(
        "--qwen-base-url",
        default=os.getenv("CHEATER_QWEN_BASE_URL", "http://127.0.0.1:1234/v1"),
        help="Loopback-only LM Studio/OpenAI-compatible endpoint.",
    )
    parser.add_argument(
        "--qwen-model",
        default=os.getenv("CHEATER_QWEN_MODEL", ""),
        help="Loaded Qwen 3.5 9B model identifier (auto-detected when omitted).",
    )
    parser.add_argument("--qwen-max-turns", type=int, default=30)
    parser.add_argument("--qwen-max-tokens", type=int, default=4096)
    parser.add_argument("--qwen-seed", type=int, default=0)
    parser.add_argument(
        "--qwen-retry-focus",
        action="store_true",
        help=(
            "For Qwen retry attempts only, use the captured diff and latest failure as a "
            "focused continuation and disable repository-wide listing. This is an opt-in "
            "ablation; the initial attempt is unchanged."
        ),
    )
    parser.add_argument(
        "--no-auto-send",
        action="store_true",
        help="Generate prompts but do not execute the agent (tests are not run).",
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help=(
            "Run the failing-test preflight and build the exact retrieval prompt, but "
            "do not send an agent or run a post-agent test."
        ),
    )
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.trials < 1:
        parser.error("--trials must be at least 1")
    if args.max_retries < 0:
        parser.error("--max-retries cannot be negative")
    if args.top_k < 1:
        parser.error("--top-k must be at least 1")
    if args.configuration_label and not safe_name(args.configuration_label):
        parser.error(
            "--configuration-label must contain a letter, number, '.', '-', or '_'"
        )
    if args.bm25_minimum_anchor_matches < 0:
        parser.error("--bm25-minimum-anchor-matches cannot be negative")
    if args.bm25_minimum_score_margin < 0:
        parser.error("--bm25-minimum-score-margin cannot be negative")
    if args.test_timeout <= 0:
        parser.error("--test-timeout must be greater than zero")
    if args.agent_timeout <= 0:
        parser.error("--agent-timeout must be greater than zero")
    if args.qwen_max_turns < 1:
        parser.error("--qwen-max-turns must be at least 1")
    if args.qwen_max_tokens < 1:
        parser.error("--qwen-max-tokens must be at least 1")
    if args.hard_reset and not args.reset_between:
        parser.error("--hard-reset is only valid with --reset-between")
    if args.restore_after and not args.reset_between:
        parser.error("--restore-after is only valid with --reset-between")
    if args.allow_dirty and args.reset_between:
        parser.error("--allow-dirty cannot be combined with destructive reset mode")
    if args.isolate_worktrees and args.reset_between:
        parser.error("--isolate-worktrees cannot be combined with --reset-between")
    if args.isolate_worktrees and args.allow_dirty:
        parser.error("--isolate-worktrees requires clean source repositories")
    if args.keep_worktrees and not args.isolate_worktrees:
        parser.error("--keep-worktrees is only valid with --isolate-worktrees")
    if args.preflight_only and args.no_auto_send:
        parser.error(
            "--preflight-only and --no-auto-send are distinct modes; choose one"
        )
    if args.preflight_only and args.dry_run:
        parser.error(
            "--preflight-only executes tests and cannot be combined with --dry-run"
        )
    if getattr(args, "retrieval_strategy", "legacy") == "hybrid":
        if args.candidate_k < 1:
            parser.error("--candidate-k must be at least 1")
        if args.bm25_weight < 0 or args.dense_weight < 0:
            parser.error("--bm25-weight and --dense-weight must be non-negative")
    if getattr(args, "candidate_k", 20) < 1:
        parser.error("--candidate-k must be at least 1")
    return args


def expand_variants(value: str) -> list[str]:
    return list(VARIANT_ALIASES.get(value, [value]))


def load_tasks(path: Path) -> list[EvalTask]:
    if not path.is_file():
        raise ValueError(f"Task file not found: {path}")
    tasks: list[EvalTask] = []
    seen_ids: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_number}: {exc}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"Task on line {line_number} must be a JSON object.")
            required_fields = {
                "id",
                "repo",
                "task",
                "error",
                "test_command",
                "expected_files",
                "notes",
            }
            missing = sorted(required_fields - set(value))
            if missing:
                raise ValueError(
                    f"Task on line {line_number} is missing fields: {', '.join(missing)}"
                )
            try:
                task = EvalTask.from_value(value)
            except ValueError as exc:
                raise ValueError(f"Invalid task on line {line_number}: {exc}") from exc
            if not task.id.strip() or not task.repo.strip() or not task.task.strip():
                raise ValueError(
                    f"Task on line {line_number} requires id, repo, and task."
                )
            if task.id in seen_ids:
                raise ValueError(f"Duplicate task id: {task.id}")
            repo = Path(task.repo).expanduser()
            if not repo.is_absolute():
                task.repo = str((path.parent / repo).resolve())
            seen_ids.add(task.id)
            tasks.append(task)
    if not tasks:
        raise ValueError(f"No tasks found in {path}")
    return tasks


def safe_name(value: str) -> str:
    safe = "".join(char if char.isalnum() or char in "-_." else "_" for char in value)
    return safe.strip("._") or "task"


def make_eval_root(base: Path) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    candidate = base / stamp
    suffix = 2
    while candidate.exists():
        candidate = base / f"{stamp}_{suffix}"
        suffix += 1
    candidate.mkdir(parents=True)
    return candidate.resolve()


def path_is_inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def normalize_failure_evidence(text: str, repo: Path) -> str:
    """Remove arm-specific paths and volatile signature bytes from prompt evidence."""
    normalized = text
    repo_forms = {str(repo.resolve()), repo.resolve().as_posix()}
    for value in sorted(repo_forms, key=len, reverse=True):
        normalized = re.sub(re.escape(value), "<REPO>", normalized, flags=re.IGNORECASE)
    normalized = re.sub(
        r"(Signature\s+)b['\"][^'\"]+['\"](\s+does not match)",
        r"\1<BYTES>\2",
        normalized,
    )
    return normalized


def confirm_reset(args: argparse.Namespace) -> bool:
    if not args.reset_between or args.dry_run:
        return False
    if args.hard_reset:
        print(
            "--hard-reset supplied: destructive restoration between runs is authorized."
        )
        return True
    print(
        "WARNING: reset mode permanently discards tracked and untracked target-repo changes."
    )
    answer = input("Type RESET to authorize this evaluation: ").strip()
    if answer != "RESET":
        raise RepoSafetyError("Reset was not confirmed; evaluation cancelled.")
    return True


def base_result(
    task: EvalTask,
    variant: str,
    run_dir: Path,
    *,
    spec_variant: str | None = None,
) -> dict[str, Any]:
    spec = get_variant_spec(spec_variant or variant)
    return {
        "schema_version": 2,
        "task_id": task.id,
        "variant": variant,
        "backend": spec.backend,
        "task_kind": task.task_kind,
        "memory_enabled": spec.use_memory,
        "retry_enabled": spec.retry_on_failure,
        "run_folder": str(run_dir),
        "solved_status": "not_run",
        "solved": None,
        "test_exit_code": None,
        "preflight_status": "not_run",
        "preflight_test_exit_code": None,
        "preflight_repo_unchanged": None,
        "first_attempt_failed": None,
        "retries_used": 0,
        "retry_solved": False,
        "retry_query": None,
        "retry_queries": [],
        "changed_files": [],
        "changed_files_count": 0,
        "initial_prompt_sha256": None,
        "initial_prompt_bytes": None,
        "repository_isolation": {"mode": "in_place"},
        "restored_after_run": False,
        "post_restore_repo": None,
        "expected_files": task.expected_files or [],
        "agent_status": None,
        "agent_exit_code": None,
        "agent_available": None,
        "agent_executed": False,
        "unavailable_reason": None,
        "retrieval_query": "",
        "retrieved_memory_ids": [],
        "retrieval_scores": [],
        "memory_ids": [],
        "top_memory_id": None,
        "top_memory_in_prompt": False,
        "top_memory_used": False,
        "top_memory_usage_method": "no_memory_retrieved",
        "memory_appeared_relevant": False,
        "memory_relevance_method": "no_memory_retrieved",
        "attempts": [],
        "error": None,
    }


def save_attempt_telemetry(
    attempt_dir: Path, run: AgentRun, attempt: int
) -> dict[str, Any]:
    prompt_sha256 = (
        hashlib.sha256(run.prompt_file.read_bytes()).hexdigest()
        if run.prompt_file.is_file()
        else None
    )
    prompt_bytes = run.prompt_file.stat().st_size if run.prompt_file.is_file() else None
    qwen_metrics: dict[str, Any] | None = None
    event_log = attempt_dir / "qwen_events.jsonl"
    if event_log.is_file():
        qwen_metrics = {
            "assistant_turns": 0,
            "tool_events": 0,
            "tool_counts": {},
            "reasoning_chars": 0,
            "visible_chars": 0,
            "length_exhaustions": 0,
            "forced_tool_requests": 0,
            "action_rescues": 0,
            "failure_critics": 0,
        }
        for line in event_log.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            if event_type == "assistant":
                qwen_metrics["assistant_turns"] += 1
                qwen_metrics["reasoning_chars"] += len(
                    str(event.get("reasoning_content") or "")
                )
                message = (
                    event.get("message")
                    if isinstance(event.get("message"), dict)
                    else {}
                )
                qwen_metrics["visible_chars"] += len(str(message.get("content") or ""))
                qwen_metrics["length_exhaustions"] += int(
                    event.get("finish_reason") == "length"
                )
                qwen_metrics["forced_tool_requests"] += int(
                    event.get("requested_tool_choice") == "required"
                )
            elif event_type == "tool":
                qwen_metrics["tool_events"] += 1
                tool = str(event.get("tool") or "unknown")
                tool_counts = qwen_metrics["tool_counts"]
                tool_counts[tool] = int(tool_counts.get(tool, 0)) + 1
            elif event_type == "action_rescue":
                qwen_metrics["action_rescues"] += 1
            elif event_type == "failure_critic":
                qwen_metrics["failure_critics"] += 1
    telemetry = {
        "attempt": attempt,
        "variant": run.variant,
        "backend": run.backend,
        "run_folder": str(attempt_dir),
        "agent_status": run.status,
        "agent_exit_code": run.launch_exit_code,
        "agent_available": run.available,
        "agent_executed": run.executed,
        "unavailable_reason": run.unavailable_reason,
        "agent_error": run.error,
        "initial_prompt_sha256": prompt_sha256,
        "initial_prompt_bytes": prompt_bytes,
        "qwen_repair_focus": run.qwen_repair_focus,
        "qwen_event_metrics": qwen_metrics,
        **memory_telemetry(run),
        "test_exit_code": None,
        "test_status": "not_run",
    }
    save_json(attempt_dir / "telemetry.json", telemetry)
    return telemetry


def finalize_result(
    repo: Path, run_dir: Path, result: dict[str, Any]
) -> dict[str, Any]:
    pre_snapshot = result.get("pre_run_repo") or {}
    base_commit = pre_snapshot.get("commit") if isinstance(pre_snapshot, dict) else None
    diff = collect_git_diff(repo, base_commit=base_commit)
    write_text(run_dir / "git_diff.patch", diff)
    changed_files = collect_changed_files(repo, base_commit=base_commit)
    result["changed_files"] = changed_files
    result["changed_files_count"] = len(changed_files)
    post_snapshot = snapshot_repo(repo)
    result["post_run_repo"] = post_snapshot
    save_json(run_dir / "post_run_repo.json", post_snapshot)
    save_json(run_dir / "result.json", result)
    return result


def _record_test(
    task: EvalTask,
    repo: Path,
    attempt_dir: Path,
    telemetry: dict[str, Any],
    timeout_seconds: float,
) -> tuple[int, str]:
    test_exit, test_output = run_test_command(
        repo,
        task.test_command,
        attempt_dir / "test_stdout.log",
        timeout_seconds=timeout_seconds,
    )
    telemetry["test_exit_code"] = test_exit
    telemetry["test_status"] = "passed" if test_exit == 0 else "failed"
    save_json(attempt_dir / "telemetry.json", telemetry)
    return test_exit, test_output


def _command_not_found(exit_code: int, output: str) -> bool:
    lowered = output.casefold()
    markers = (
        "is not recognized as an internal or external command",
        "the term '",
        "command not found",
        "no such file or directory",
    )
    return exit_code in {126, 127, 9009} or any(marker in lowered for marker in markers)


def evaluate_variant(
    task: EvalTask,
    variant: str,
    task_root: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    spec = get_variant_spec(variant)
    retrieval_strategy = getattr(args, "retrieval_strategy", "legacy")
    variant_label = (
        f"{variant}__{retrieval_strategy}"
        if spec.use_memory and retrieval_strategy != "legacy"
        else variant
    )
    configuration_label = str(getattr(args, "configuration_label", "")).strip()
    if spec.use_memory and configuration_label:
        variant_label = f"{variant_label}__cfg_{safe_name(configuration_label)[:64]}"
    trial_index = int(getattr(args, "trial_index", 1))
    trial_count = int(getattr(args, "trials", 1))
    if trial_count > 1:
        variant_label = f"{variant_label}__trial_{trial_index:02d}"
    run_dir = task_root / variant_label
    run_dir.mkdir(parents=True, exist_ok=True)
    save_task(run_dir / "task.json", task)
    result = base_result(task, variant_label, run_dir, spec_variant=variant)
    result["trial_index"] = trial_index
    result["trial_count"] = trial_count
    result["bug_type"] = task.bug_type or "unclassified"
    result["configuration_label"] = configuration_label or None
    result["top_k"] = args.top_k
    result["include_patch"] = bool(args.include_patch)
    repo = Path(task.repo).expanduser().resolve()
    pre_snapshot = snapshot_repo(repo)
    result["pre_run_repo"] = pre_snapshot
    save_json(run_dir / "pre_run_repo.json", pre_snapshot)

    if (
        not args.dry_run
        and task.base_commit.strip()
        and pre_snapshot.get("commit") != task.base_commit.strip()
    ):
        message = (
            f"Task requires base commit {task.base_commit.strip()}, but the prepared "
            f"repo is at {pre_snapshot.get('commit')}. Cheater will not check out or reset "
            "it automatically."
        )
        result.update({"solved_status": "safety_refused", "error": message})
        write_text(run_dir / "error.txt", message + "\n")
        write_text(run_dir / "test_stdout.log", "")
        print(f"SAFETY REFUSAL [{task.id}/{variant}]: {message}")
        return finalize_result(repo, run_dir, result)

    if not args.dry_run:
        try:
            ensure_clean_repo(repo, allow_dirty=args.allow_dirty)
        except RepoSafetyError as exc:
            result.update(
                {
                    "solved_status": "safety_refused",
                    "error": str(exc),
                    "agent_available": None,
                }
            )
            write_text(run_dir / "error.txt", str(exc) + "\n")
            write_text(run_dir / "test_stdout.log", "")
            print(f"SAFETY REFUSAL [{task.id}/{variant}]: {exc}")
            return finalize_result(repo, run_dir, result)
    elif pre_snapshot["warning"]:
        print("DRY RUN WARNING:", pre_snapshot["warning"])

    invalid_preflight: str | None = None
    preflight_output = ""
    if args.dry_run or args.no_auto_send:
        result["preflight_status"] = "not_run_dry_or_no_send"
    elif not task.test_command.strip():
        result["preflight_status"] = "unknown_no_tests"
    elif args.skip_preflight:
        result["preflight_status"] = "skipped_explicitly"
    else:
        status_before = snapshot_repo(repo)
        preflight_exit, preflight_output = run_test_command(
            repo,
            task.test_command,
            run_dir / "preflight_stdout.log",
            timeout_seconds=args.test_timeout,
        )
        status_after = snapshot_repo(repo)
        unchanged = all(
            status_before.get(field) == status_after.get(field)
            for field in ("status", "commit", "branch")
        )
        result["preflight_test_exit_code"] = preflight_exit
        result["preflight_repo_unchanged"] = unchanged
        save_json(run_dir / "post_preflight_repo.json", status_after)
        if not unchanged:
            invalid_preflight = "invalid_preflight_modified_repo"
        elif preflight_exit == 0:
            invalid_preflight = "invalid_preflight_already_passing"
        elif preflight_exit == 124:
            invalid_preflight = "invalid_preflight_timeout"
        elif _command_not_found(preflight_exit, preflight_output):
            invalid_preflight = "invalid_preflight_test_command"
        else:
            result["preflight_status"] = "confirmed_failing"
        if invalid_preflight:
            result["preflight_status"] = invalid_preflight
            print(f"[{task.id}/{variant}] {invalid_preflight}; agent will not run.")

    attempt_dir = run_dir / "attempt_1"
    retrieval_query = ""
    agent_task = task
    if preflight_output:
        failure_tail = normalize_failure_evidence(preflight_output[-8000:], repo)
        agent_task = replace(
            task,
            error="\n\n".join(
                part for part in [task.error.strip(), failure_tail.strip()] if part
            ),
        )
        query_parts = [task.task, task.error]
        if getattr(args, "retrieval_query_mode", "runtime") == "runtime":
            query_parts.append(failure_tail)
        retrieval_query = "\n".join(part for part in query_parts if part.strip())
    cf: ContaminationFilter | None = getattr(args, "_contamination_filter", None)
    if cf is None:
        cf = ContaminationFilter(benchmark_datasets=DEFAULT_BENCHMARK_HOLDOUTS)
    if cf and cf.benchmark_datasets:
        if getattr(args, "allow_quarantined_memory", False):
            cf.benchmark_datasets = set()
    contamination_excluded: list[dict[str, Any]] = []

    try:
        agent_run = run_variant_agent(
            agent_task,
            variant,
            output_dir=attempt_dir,
            dry_run=args.dry_run or invalid_preflight is not None,
            auto_send=not (args.no_auto_send or args.preflight_only),
            top_k=args.top_k,
            include_patch=args.include_patch,
            agent_timeout=args.agent_timeout,
            test_timeout=args.test_timeout,
            qwen_base_url=args.qwen_base_url,
            qwen_model=args.qwen_model,
            qwen_max_turns=args.qwen_max_turns,
            qwen_max_tokens=getattr(args, "qwen_max_tokens", 4096),
            qwen_seed=args.qwen_seed,
            cards_path=getattr(args, "cards_path", None),
            retrieval_strategy=getattr(args, "retrieval_strategy", "legacy"),
            bm25_minimum_anchor_matches=getattr(args, "bm25_minimum_anchor_matches", 2),
            bm25_minimum_score_margin=getattr(args, "bm25_minimum_score_margin", 5.0),
            query=retrieval_query,
            memory_index=getattr(args, "memory_index", ""),
            dense_model=getattr(args, "dense_model", ""),
            candidate_k=getattr(args, "candidate_k", 20),
            bm25_weight=getattr(args, "bm25_weight", 0.4),
            dense_weight=getattr(args, "dense_weight", 0.6),
            exclude_source_datasets=getattr(args, "exclude_source_dataset", None),
            allow_quarantined_memory=getattr(args, "allow_quarantined_memory", False),
            contamination_filter=cf,
        )
        agent_run.variant = variant_label
    except Exception as exc:
        result.update(
            {
                "solved_status": (
                    "unknown_no_tests"
                    if not task.test_command.strip()
                    else "agent_error"
                ),
                "agent_status": "agent_error",
                "agent_executed": True,
                "error": str(exc),
            }
        )
        attempt_dir.mkdir(parents=True, exist_ok=True)
        write_text(attempt_dir / "error.txt", str(exc) + "\n")
        write_text(attempt_dir / "test_stdout.log", "")
        print(f"ERROR [{task.id}/{variant}]: {exc}")
        return finalize_result(repo, run_dir, result)

    first_telemetry = save_attempt_telemetry(attempt_dir, agent_run, 1)
    result["attempts"].append(first_telemetry)
    result["initial_prompt_sha256"] = first_telemetry["initial_prompt_sha256"]
    result["initial_prompt_bytes"] = first_telemetry["initial_prompt_bytes"]
    result.update(
        {
            "agent_status": agent_run.status,
            "agent_exit_code": agent_run.launch_exit_code,
            "agent_available": agent_run.available,
            "agent_executed": agent_run.executed,
            "unavailable_reason": agent_run.unavailable_reason,
            "error": agent_run.error,
            **memory_telemetry(agent_run),
        }
    )
    result["memory_ids"] = result["retrieved_memory_ids"]
    result["contamination_excluded"] = contamination_excluded

    if invalid_preflight:
        result.update(
            {
                "solved_status": invalid_preflight,
                "solved": None,
                "agent_status": "not_run_invalid_preflight",
                "agent_executed": False,
            }
        )
        return finalize_result(repo, run_dir, result)

    if args.no_auto_send:
        result.update(
            {
                "solved_status": "not_run_no_auto_send",
                "solved": None,
                "agent_status": "prompt_generated_no_auto_send",
                "agent_executed": False,
            }
        )
        write_text(
            run_dir / "test_stdout.log",
            "Tests not run: --no-auto-send generated artifacts without agent execution.\n",
        )
        return finalize_result(repo, run_dir, result)

    if args.preflight_only:
        result.update(
            {
                "solved_status": "not_run_preflight_only",
                "solved": None,
                "agent_status": "prompt_generated_preflight_only",
                "agent_executed": False,
            }
        )
        write_text(
            run_dir / "test_stdout.log",
            "No post-agent test run: --preflight-only stopped after prompt generation.\n",
        )
        return finalize_result(repo, run_dir, result)

    if args.dry_run:
        result["solved_status"] = "dry_run"
        if not agent_run.available:
            print(f"[{task.id}/{variant}] Qwen prompt generated; runtime unavailable.")
            print(QWEN_SETUP_INSTRUCTIONS)
        return finalize_result(repo, run_dir, result)

    if not task.test_command.strip():
        result["solved_status"] = "unknown_no_tests"
        write_text(
            run_dir / "test_stdout.log",
            "No test command supplied; outcome is unknown.\n",
        )
        print(f"[{task.id}/{variant}] No test command; result is unknown_no_tests.")
        return finalize_result(repo, run_dir, result)

    if not agent_run.available:
        result["solved_status"] = "unavailable"
        write_text(run_dir / "test_stdout.log", "Tests not run: agent unavailable.\n")
        print(f"[{task.id}/{variant}] unavailable: {agent_run.unavailable_reason}")
        return finalize_result(repo, run_dir, result)

    if not agent_run.executed:
        result["solved_status"] = "not_run"
        write_text(
            run_dir / "test_stdout.log", "Tests not run: agent execution was skipped.\n"
        )
        return finalize_result(repo, run_dir, result)

    test_exit, failure_output = _record_test(
        task, repo, attempt_dir, first_telemetry, args.test_timeout
    )
    result["attempts"][0] = first_telemetry
    result["test_exit_code"] = test_exit
    result["first_attempt_failed"] = test_exit != 0
    result["solved"] = test_exit == 0
    result["solved_status"] = "solved" if test_exit == 0 else "failed_tests"
    shutil.copyfile(attempt_dir / "test_stdout.log", run_dir / "test_stdout.log")

    if spec.retry_on_failure and test_exit != 0:
        for retry_number in range(1, args.max_retries + 1):
            retry_dir = run_dir / f"retry_{retry_number}"
            print(f"[{task.id}/{variant}] repair {retry_number}/{args.max_retries}...")
            try:
                retry_run = run_cheater_retry(
                    task,
                    normalize_failure_evidence(failure_output, repo),
                    variant=variant,
                    output_dir=retry_dir,
                    dry_run=False,
                    auto_send=not args.no_auto_send,
                    top_k=args.top_k,
                    include_patch=args.include_patch,
                    agent_timeout=args.agent_timeout,
                    test_timeout=args.test_timeout,
                    qwen_base_url=args.qwen_base_url,
                    qwen_model=args.qwen_model,
                    qwen_max_turns=args.qwen_max_turns,
                    qwen_max_tokens=getattr(args, "qwen_max_tokens", 4096),
                    qwen_seed=args.qwen_seed,
                    qwen_repair_focus=(
                        spec.backend == "qwen"
                        and getattr(args, "qwen_retry_focus", False)
                    ),
                    cards_path=getattr(args, "cards_path", None),
                    retrieval_strategy=getattr(args, "retrieval_strategy", "legacy"),
                    bm25_minimum_anchor_matches=getattr(
                        args, "bm25_minimum_anchor_matches", 2
                    ),
                    bm25_minimum_score_margin=getattr(
                        args, "bm25_minimum_score_margin", 5.0
                    ),
                    memory_index=getattr(args, "memory_index", ""),
                    dense_model=getattr(args, "dense_model", ""),
                    candidate_k=getattr(args, "candidate_k", 20),
                    bm25_weight=getattr(args, "bm25_weight", 0.4),
                    dense_weight=getattr(args, "dense_weight", 0.6),
                    exclude_source_datasets=getattr(
                        args, "exclude_source_dataset", None
                    ),
                    allow_quarantined_memory=getattr(
                        args, "allow_quarantined_memory", False
                    ),
                )
                retry_run.variant = f"{variant_label}_repair"
            except Exception as exc:
                result["error"] = f"Retry {retry_number} failed: {exc}"
                write_text(retry_dir / "error.txt", str(exc) + "\n")
                print("ERROR:", result["error"])
                break
            retry_telemetry = save_attempt_telemetry(
                retry_dir, retry_run, retry_number + 1
            )
            result["attempts"].append(retry_telemetry)
            result["retries_used"] = retry_number
            result["retry_queries"].append(retry_run.retrieval_query)
            result["retry_query"] = result["retry_queries"][0]
            if not retry_run.available or not retry_run.executed:
                result["error"] = retry_run.error or retry_run.unavailable_reason
                break
            retry_exit, failure_output = _record_test(
                task, repo, retry_dir, retry_telemetry, args.test_timeout
            )
            result["attempts"][-1] = retry_telemetry
            result["test_exit_code"] = retry_exit
            result["solved"] = retry_exit == 0
            shutil.copyfile(retry_dir / "test_stdout.log", run_dir / "test_stdout.log")
            if retry_exit == 0:
                result.update(
                    {
                        "solved_status": "solved_after_retry",
                        "retry_solved": True,
                    }
                )
                break

    return finalize_result(repo, run_dir, result)


def _validate_output_location(output_base: Path, tasks: list[EvalTask]) -> None:
    for task in tasks:
        repo = Path(task.repo).expanduser().resolve()
        snapshot = snapshot_repo(repo)
        git_root = (
            Path(str(snapshot["git_root"])).resolve() if snapshot["git_root"] else repo
        )
        if snapshot["is_git"] and path_is_inside(output_base, git_root):
            raise RepoSafetyError(
                f"Evaluation output {output_base} is inside target Git repo {git_root}. "
                "Choose --output outside the evaluated repository so artifacts do not "
                "contaminate status or patches."
            )


def run_evaluation(args: argparse.Namespace) -> Path:
    task_file = Path(args.tasks).expanduser().resolve()
    tasks = load_tasks(task_file)
    available_task_count = len(tasks)
    if args.task_ids:
        requested_ids = list(dict.fromkeys(args.task_ids))
        known = {task.id for task in tasks}
        missing = [task_id for task_id in requested_ids if task_id not in known]
        if missing:
            raise ValueError(f"Unknown --task-id value(s): {', '.join(missing)}")
        requested = set(requested_ids)
        tasks = [task for task in tasks if task.id in requested]
    if args.limit is not None:
        tasks = tasks[: args.limit]
    variants = expand_variants(args.variant)
    selected_cards = (
        Path(args.cards_path).expanduser().resolve()
        if args.cards_path
        else memory_db_path(Path(__file__).resolve().parent)
    )
    cards_info = inspect_cards_corpus(selected_cards)
    memory_requested = any(get_variant_spec(variant).use_memory for variant in variants)
    if memory_requested:
        if not cards_info["supported"]:
            raise ValueError(
                str(cards_info.get("error") or "Unsupported memory corpus")
                + f" Path: {selected_cards}"
            )
        size_bytes = int(cards_info.get("size_bytes") or 0)
        if size_bytes > MAX_DEFAULT_CORPUS_BYTES and not args.allow_large_cards:
            raise RepoSafetyError(
                f"Memory corpus is {size_bytes:,} bytes, above the default 256 MB safety "
                "limit. Inspect it, then pass --allow-large-cards explicitly if intended."
            )
    args.cards_path = str(selected_cards)
    needs_fair_reset = (
        len(variants) * args.trials > 1
        and not args.dry_run
        and not args.no_auto_send
        and bool(variants)
    )
    if needs_fair_reset and not (args.reset_between or args.isolate_worktrees):
        raise RepoSafetyError(
            "A real multi-variant agent ablation requires --isolate-worktrees or "
            "--reset-between so every arm starts from the same commit. Disposable "
            "worktrees are recommended because they do not reset the source repository."
        )
    output_base = Path(args.output).expanduser().resolve()
    _validate_output_location(output_base, tasks)
    reset_authorized = confirm_reset(args)
    eval_root = make_eval_root(output_base)
    save_json(
        eval_root / "evaluation_config.json",
        {
            "schema_version": 2,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "tasks_file": str(task_file),
            "available_task_count": available_task_count,
            "selected_task_count": len(tasks),
            "variant_argument": args.variant,
            "expanded_variants": variants,
            "limit": args.limit,
            "trials": args.trials,
            "task_ids": list(args.task_ids or []),
            "max_retries": args.max_retries,
            "allow_dirty": args.allow_dirty,
            "reset_between": args.reset_between,
            "hard_reset": args.hard_reset,
            "restore_after": args.restore_after,
            "isolate_worktrees": args.isolate_worktrees,
            "keep_worktrees": args.keep_worktrees,
            "dry_run": args.dry_run,
            "top_k": args.top_k,
            "cards_corpus": cards_info,
            "allow_large_cards": args.allow_large_cards,
            "configuration_label": args.configuration_label or None,
            "retrieval_strategy": getattr(args, "retrieval_strategy", "legacy"),
            "retrieval_query_mode": getattr(args, "retrieval_query_mode", "runtime"),
            "bm25_minimum_anchor_matches": getattr(
                args, "bm25_minimum_anchor_matches", 2
            ),
            "bm25_minimum_score_margin": getattr(
                args, "bm25_minimum_score_margin", 5.0
            ),
            "include_patch": args.include_patch,
            "memory_index": getattr(args, "memory_index", ""),
            "dense_model": getattr(args, "dense_model", ""),
            "candidate_k": getattr(args, "candidate_k", 20),
            "bm25_weight": getattr(args, "bm25_weight", 0.4),
            "dense_weight": getattr(args, "dense_weight", 0.6),
            "exclude_source_dataset": getattr(args, "exclude_source_dataset", None),
            "allow_quarantined_memory": getattr(
                args, "allow_quarantined_memory", False
            ),
            "skip_preflight": args.skip_preflight,
            "test_timeout": args.test_timeout,
            "agent_timeout": args.agent_timeout,
            "qwen_base_url": args.qwen_base_url,
            "qwen_model": args.qwen_model or None,
            "qwen_max_turns": args.qwen_max_turns,
            "qwen_max_tokens": getattr(args, "qwen_max_tokens", 4096),
            "qwen_seed": args.qwen_seed,
            "qwen_retry_focus": getattr(args, "qwen_retry_focus", False),
            "auto_send": not (args.no_auto_send or args.preflight_only),
            "preflight_only": args.preflight_only,
            "official_benchmark_score": None,
            "note": "Local test outcomes only; this is not an official benchmark score.",
        },
    )
    if len(tasks) < 10:
        print(
            f"LOCAL EVAL GATE: selected {len(tasks)} task(s); at least 10 complete local "
            "tasks are required before benchmark optimization claims."
        )

    jobs = [
        (task, variant, trial_index)
        for task in tasks
        for trial_index in range(1, args.trials + 1)
        for variant in variants
    ]
    reset_states: dict[str, tuple[str, str | None]] = {}
    if reset_authorized:
        for task in tasks:
            repo = Path(task.repo).expanduser().resolve()
            key = str(repo).casefold()
            if key in reset_states:
                continue
            clean = ensure_clean_repo(repo, allow_dirty=False)
            if not clean["is_git"] or not clean["commit"]:
                raise RepoSafetyError(
                    f"Reset mode requires a clean Git worktree with a commit: {repo}"
                )
            if Path(str(clean["git_root"])).resolve() != repo:
                raise RepoSafetyError(
                    f"Reset mode requires task.repo to be the worktree root: {repo}"
                )
            reset_states[key] = (str(clean["commit"]), clean.get("branch"))

    isolation_sources: dict[str, dict[str, Any]] = {}
    if args.isolate_worktrees and not args.dry_run:
        for task in tasks:
            repo = Path(task.repo).expanduser().resolve()
            key = str(repo).casefold()
            if key in isolation_sources:
                continue
            clean = ensure_clean_repo(repo, allow_dirty=False)
            if not clean["is_git"] or not clean["commit"]:
                raise RepoSafetyError(
                    f"Disposable isolation requires a clean Git repository: {repo}"
                )
            if Path(str(clean["git_root"])).resolve() != repo:
                raise RepoSafetyError(
                    f"Disposable isolation requires task.repo to be the worktree root: {repo}"
                )
            isolation_sources[key] = clean
        save_json(
            eval_root / "source_repositories.json",
            {"schema_version": 1, "repositories": list(isolation_sources.values())},
        )

    args._contamination_filter = ContaminationFilter(
        benchmark_datasets=set(
            getattr(args, "exclude_source_dataset", None) or DEFAULT_BENCHMARK_HOLDOUTS
        ),
    )

    all_results: list[dict[str, Any]] = []
    for job_index, (task, variant, trial_index) in enumerate(jobs):
        task_number = tasks.index(task) + 1
        print(f"\n=== Task {task_number}/{len(tasks)}: {task.id} ===")
        trial_suffix = f"; trial {trial_index}/{args.trials}" if args.trials > 1 else ""
        print(f"--- Variant: {variant}{trial_suffix} ---")
        task_root = eval_root / safe_name(task.id)
        task_root.mkdir(parents=True, exist_ok=True)
        save_task(task_root / "task.json", task)
        source_repo = Path(task.repo).expanduser().resolve()
        effective_task = task
        isolation: dict[str, Any] = {"mode": "in_place"}
        worktree_path: Path | None = None
        if args.isolate_worktrees and args.dry_run:
            isolation = {
                "mode": "planned_disposable_git_worktree",
                "created": False,
                "kept": False,
                "removed": False,
                "cleanup_error": None,
                "source_repo": str(source_repo),
                "target_commit": task.base_commit.strip() or None,
            }
        if args.isolate_worktrees and not args.dry_run:
            owned_root = eval_root / "_worktrees"
            worktree_path = owned_root / (
                f"{job_index + 1:04d}_t{trial_index:02d}_"
                f"{safe_name(task.id)[:36]}_{safe_name(variant)[:26]}"
            )
            source_state = isolation_sources[str(source_repo).casefold()]
            target_commit = task.base_commit.strip() or str(source_state["commit"])
            isolation = create_disposable_worktree(
                source_repo,
                worktree_path,
                owner_root=owned_root,
                target_commit=target_commit,
            )
            isolation.update(
                {
                    "created": True,
                    "kept": bool(args.keep_worktrees),
                    "removed": False,
                    "cleanup_error": None,
                }
            )
            effective_task = replace(task, repo=str(worktree_path))

        result: dict[str, Any]
        job_values = dict(vars(args))
        job_values["trial_index"] = trial_index
        job_args = argparse.Namespace(**job_values)
        try:
            result = evaluate_variant(effective_task, variant, task_root, job_args)
            result["repository_isolation"] = isolation
        finally:
            if worktree_path is not None and not args.keep_worktrees:
                try:
                    remove_disposable_worktree(
                        source_repo,
                        worktree_path,
                        owner_root=eval_root / "_worktrees",
                    )
                    isolation["removed"] = True
                except RepoSafetyError as exc:
                    isolation["cleanup_error"] = str(exc)

        isolation["source_post_snapshot"] = snapshot_repo(source_repo)
        result["repository_isolation"] = isolation
        save_json(
            Path(str(result["run_folder"])) / "repository_isolation.json", isolation
        )
        save_json(Path(str(result["run_folder"])) / "result.json", result)
        if isolation.get("cleanup_error"):
            raise RepoSafetyError(str(isolation["cleanup_error"]))
        all_results.append(result)

        repo = source_repo
        same_repo_later = any(
            Path(later_task.repo).expanduser().resolve() == repo
            for later_task, _, _ in jobs[job_index + 1 :]
        )
        if reset_authorized and (same_repo_later or args.restore_after):
            reset_commit, reset_branch = reset_states[str(repo).casefold()]
            reset_repo(
                repo,
                hard=True,
                target_commit=reset_commit,
                target_branch=reset_branch,
            )
            restored_snapshot = snapshot_repo(repo)
            result["restored_after_run"] = True
            result["post_restore_repo"] = restored_snapshot
            variant_dir = task_root / str(result["variant"])
            save_json(variant_dir / "post_restore_repo.json", restored_snapshot)
            save_json(variant_dir / "result.json", result)

    save_json(
        eval_root / "evaluation_results.json",
        {
            "schema_version": 2,
            "run_folder": str(eval_root),
            "results": all_results,
        },
    )
    print("\nEvaluation run folder:", eval_root)
    print("Compare with: python compare_eval_results.py", eval_root)
    return eval_root


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        run_evaluation(args)
    except (RepoSafetyError, ValueError) as exc:
        print("Evaluation stopped:", exc, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
