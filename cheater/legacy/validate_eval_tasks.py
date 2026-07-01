from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from .cheater_core import save_json, write_text
from .cheater_retry_controller import (
    EvalTask,
    RepoSafetyError,
    ensure_clean_repo,
    run_test_command,
    save_task,
    snapshot_repo,
)
from .run_eval import load_tasks, safe_name


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a local evaluation task set without launching an agent. "
            "Every accepted task must start from a clean Git worktree with a "
            "deterministically failing test that leaves Git state unchanged."
        )
    )
    parser.add_argument("--tasks", required=True, help="JSONL task set to validate.")
    parser.add_argument("--minimum", type=int, default=10)
    parser.add_argument("--test-timeout", type=float, default=900.0)
    parser.add_argument("--output", default="local_task_checks")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check schema/repositories only; cannot satisfy the task gate.",
    )
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.minimum < 1:
        parser.error("--minimum must be at least 1")
    if args.test_timeout <= 0:
        parser.error("--test-timeout must be greater than zero")
    return args


def _make_run_dir(base: Path) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = base / stamp
    suffix = 2
    while run_dir.exists():
        run_dir = base / f"{stamp}_{suffix}"
        suffix += 1
    run_dir.mkdir()
    return run_dir.resolve()


def _command_not_found(exit_code: int, output: str) -> bool:
    lowered = output.casefold()
    return exit_code in {126, 127, 9009} or any(
        marker in lowered
        for marker in (
            "is not recognized as an internal or external command",
            "the term '",
            "command not found",
            "no such file or directory",
        )
    )


def _expected_file_warnings(task: EvalTask, repo: Path) -> list[str]:
    warnings: list[str] = []
    for value in task.expected_files or []:
        relative = Path(value)
        if relative.is_absolute():
            warnings.append(f"expected_files entry must be relative: {value}")
            continue
        candidate = (repo / relative).resolve(strict=False)
        try:
            candidate.relative_to(repo)
        except ValueError:
            warnings.append(f"expected_files entry escapes repo: {value}")
            continue
        if not candidate.exists():
            warnings.append(f"expected file does not currently exist: {value}")
    return warnings


def validate_task(
    task: EvalTask,
    task_dir: Path,
    *,
    dry_run: bool,
    test_timeout: float,
) -> dict[str, Any]:
    task_dir.mkdir(parents=True, exist_ok=True)
    save_task(task_dir / "task.json", task)
    repo = Path(task.repo).expanduser().resolve()
    before = snapshot_repo(repo)
    save_json(task_dir / "preflight_repo_before.json", before)
    result: dict[str, Any] = {
        "task_id": task.id,
        "repo": str(repo),
        "valid": False,
        "status": "not_checked",
        "test_exit_code": None,
        "repo_unchanged": None,
        "base_commit": before.get("commit"),
        "task_kind": task.task_kind,
        "expected_files": task.expected_files or [],
        "warnings": [],
        "error": None,
    }
    try:
        clean = ensure_clean_repo(repo, allow_dirty=False)
    except RepoSafetyError as exc:
        result.update({"status": "invalid_repo", "error": str(exc)})
        save_json(task_dir / "validation.json", result)
        return result
    if not clean.get("is_git") or not clean.get("commit"):
        result.update(
            {
                "status": "invalid_not_git",
                "error": "Local evaluation tasks require a Git worktree with a commit.",
            }
        )
        save_json(task_dir / "validation.json", result)
        return result
    if task.base_commit and task.base_commit != clean.get("commit"):
        result.update(
            {
                "status": "invalid_base_commit",
                "error": (
                    f"Task base_commit is {task.base_commit}, but repo is at "
                    f"{clean.get('commit')}."
                ),
            }
        )
        save_json(task_dir / "validation.json", result)
        return result
    result["warnings"] = _expected_file_warnings(task, repo)
    if not task.test_command.strip():
        result.update(
            {
                "status": "invalid_no_test_command",
                "error": "A gate-eligible local task requires a test command.",
            }
        )
        save_json(task_dir / "validation.json", result)
        return result
    if dry_run:
        result["status"] = "dry_run_not_proven"
        write_text(task_dir / "preflight_stdout.log", "Tests skipped by --dry-run.\n")
        save_json(task_dir / "validation.json", result)
        return result

    exit_code, output = run_test_command(
        repo,
        task.test_command,
        task_dir / "preflight_stdout.log",
        timeout_seconds=test_timeout,
    )
    after = snapshot_repo(repo)
    save_json(task_dir / "preflight_repo_after.json", after)
    unchanged = all(
        before.get(field) == after.get(field)
        for field in ("status", "commit", "branch")
    )
    result["test_exit_code"] = exit_code
    result["repo_unchanged"] = unchanged
    if not unchanged:
        result.update(
            {
                "status": "invalid_test_modified_repo",
                "error": "The test command changed Git status, commit, or branch.",
            }
        )
    elif exit_code == 0:
        result.update(
            {
                "status": "invalid_already_passing",
                "error": "The test command passed before any agent attempt.",
            }
        )
    elif exit_code == 124:
        result.update({"status": "invalid_timeout", "error": "Preflight test timed out."})
    elif _command_not_found(exit_code, output):
        result.update(
            {"status": "invalid_test_command", "error": "Test command could not be started."}
        )
    else:
        result.update({"valid": True, "status": "confirmed_failing"})
    save_json(task_dir / "validation.json", result)
    return result


def run_validation(args: argparse.Namespace) -> tuple[Path, bool]:
    task_file = Path(args.tasks).expanduser().resolve()
    tasks = load_tasks(task_file)
    run_dir = _make_run_dir(Path(args.output).expanduser().resolve())
    save_json(
        run_dir / "validation_config.json",
        {
            "tasks_file": str(task_file),
            "task_count": len(tasks),
            "minimum": args.minimum,
            "test_timeout": args.test_timeout,
            "dry_run": args.dry_run,
        },
    )
    results: list[dict[str, Any]] = []
    for index, task in enumerate(tasks, start=1):
        print(f"[{index}/{len(tasks)}] validating {task.id}...")
        result = validate_task(
            task,
            run_dir / "tasks" / safe_name(task.id),
            dry_run=args.dry_run,
            test_timeout=args.test_timeout,
        )
        results.append(result)
        print(f"  {result['status']}")
    valid_count = sum(item["valid"] is True for item in results)
    valid_real_count = sum(
        item["valid"] is True and item.get("task_kind") == "real" for item in results
    )
    gate_met = (
        not args.dry_run
        and len(tasks) >= args.minimum
        and valid_real_count >= args.minimum
    )
    summary = {
        "task_count": len(tasks),
        "valid_failing_task_count": valid_count,
        "valid_real_failing_task_count": valid_real_count,
        "minimum": args.minimum,
        "task_set_gate_met": gate_met,
        "dry_run": args.dry_run,
        "results": results,
        "note": "This validates task preconditions only; it is not an agent evaluation or score.",
    }
    save_json(run_dir / "summary.json", summary)
    print("Validation artifacts:", run_dir)
    print("Task-set gate:", "MET" if gate_met else "NOT MET")
    return run_dir, gate_met


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        _, gate_met = run_validation(args)
    except (RepoSafetyError, ValueError) as exc:
        print("Task validation stopped:", exc, file=sys.stderr)
        return 2
    return 0 if gate_met else 1


if __name__ == "__main__":
    raise SystemExit(main())
