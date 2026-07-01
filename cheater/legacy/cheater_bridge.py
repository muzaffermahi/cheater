from __future__ import annotations

import argparse
import contextlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .agent_harness import copy_text_to_clipboard
from .bug_memory import load_cards, search_cards
from .cheater_core import format_cheater_memories, is_weak_query, save_json, write_text
from .cheater_session import update_session_record


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bridge Pi extension commands to Cheater.")
    parser.add_argument("action", choices=["status", "memory", "tests", "retry", "logs", "prompt", "clip"])
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--query", default="")
    return parser.parse_args()


def load_summary(run_dir: Path) -> tuple[Path, dict[str, Any]]:
    path = run_dir / "run_summary.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = {}
    return path, value


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False))


def read_text(path: Path, max_chars: int | None = None) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-max_chars:] if max_chars else text


def retrieve_memories(
    project_root: Path,
    summary: dict[str, Any],
    query: str,
) -> tuple[list[tuple[float, dict[str, Any]]], str]:
    task = str(summary.get("task") or "")
    error = str(summary.get("error") or "")
    effective_query = query.strip() or "\n".join(part for part in [task, error] if part)
    if is_weak_query(effective_query):
        return [], effective_query
    cards_path = project_root / "data" / "compact_bug_cards.jsonl"
    with contextlib.redirect_stdout(sys.stderr):
        cards = load_cards(cards_path)
    top_k = int(summary.get("top_k") or 3)
    min_score = float(summary.get("min_score") or 50.0)
    results = [item for item in search_cards(effective_query, cards, top_k) if item[0] >= min_score]
    return results, effective_query


def next_retry_number(run_dir: Path) -> int:
    numbers: list[int] = []
    for path in run_dir.glob("retry_*_prompt.md"):
        try:
            numbers.append(int(path.stem.split("_")[1]))
        except (IndexError, ValueError):
            continue
    return max(numbers, default=0) + 1


def main() -> int:
    args = parse_args()
    run_dir = Path(args.run_dir).resolve()
    summary_path, summary = load_summary(run_dir)
    project_root = Path(__file__).resolve().parent
    repo = Path(str(summary.get("repo") or ".")).resolve()

    if args.action == "status":
        emit(
            {
                "ok": True,
                "summary": (
                    f"Repo: {repo}\n"
                    f"Run: {run_dir}\n"
                    f"Task: {summary.get('task') or '(exploratory)'}\n"
                    f"Memories: {len(summary.get('memory_ids') or [])}\n"
                    f"Tests: {summary.get('test_exit_code', 'not run')}"
                ),
                "sendToAgent": False,
            }
        )
        return 0

    if args.action == "logs":
        existing = [str(path) for path in sorted(run_dir.iterdir()) if path.is_file()]
        emit({"ok": True, "summary": "\n".join(existing), "sendToAgent": False})
        return 0

    if args.action == "prompt":
        prompt = read_text(run_dir / "initial_prompt.md")
        emit(
            {
                "ok": bool(prompt),
                "summary": "Initial Cheater prompt queued." if prompt else "Initial prompt file is missing.",
                "message": prompt,
                "sendToAgent": bool(prompt),
            }
        )
        return 0 if prompt else 1

    if args.action == "clip":
        prompt = read_text(run_dir / "initial_prompt.md")
        if not prompt:
            emit({"ok": False, "summary": "Initial prompt file is missing.", "sendToAgent": False})
            return 1
        try:
            copy_text_to_clipboard(prompt)
        except (OSError, subprocess.CalledProcessError) as exc:
            emit({"ok": False, "summary": f"Clipboard copy failed: {exc}", "sendToAgent": False})
            return 1
        emit({"ok": True, "summary": "Prompt copied to clipboard.", "sendToAgent": False})
        return 0

    if args.action == "tests":
        test_command = str(summary.get("test_command") or "").strip()
        if not test_command:
            emit({"ok": False, "summary": "No test command configured for this run.", "sendToAgent": False})
            return 1
        result = subprocess.run(
            test_command,
            cwd=str(repo),
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        output = result.stdout + result.stderr
        write_text(run_dir / "test_stdout.log", output)
        summary.update(
            {
                "test_exit_code": result.returncode,
                "status": "tests_passed" if result.returncode == 0 else "tests_failed",
            }
        )
        save_json(summary_path, summary)
        update_session_record(run_dir, {"test_exit_code": result.returncode, "status": summary["status"]})
        if result.returncode == 0:
            emit({"ok": True, "summary": "Tests passed.", "sendToAgent": False})
        else:
            message = (
                "The configured tests failed. Inspect this failure, fix the implementation, "
                "and rerun the relevant tests:\n\n" + output[-5000:]
            )
            emit(
                {
                    "ok": True,
                    "summary": f"Tests failed with exit code {result.returncode}; failure queued to Pi.",
                    "message": message,
                    "sendToAgent": True,
                }
            )
        return 0

    if args.action == "memory":
        results, query = retrieve_memories(project_root, summary, args.query)
        block = format_cheater_memories(results, bool(summary.get("include_patch")))
        refresh_number = len(list(run_dir.glob("memory_refresh_*.md"))) + 1
        refresh_path = run_dir / f"memory_refresh_{refresh_number}.md"
        write_text(refresh_path, block)
        summary["last_memory_refresh"] = str(refresh_path)
        summary["last_memory_query"] = query
        save_json(summary_path, summary)
        update_session_record(run_dir, {"last_memory_refresh": str(refresh_path)})
        message = (
            "Cheater retrieved additional analogous bug memories. Do not assume they come "
            "from this repository; use them only if inspection confirms the analogy.\n\n" + block
        )
        emit(
            {
                "ok": True,
                "summary": f"Retrieved {len(results)} memories for: {query or '(empty query)'}",
                "message": message,
                "sendToAgent": bool(results),
            }
        )
        return 0

    failure = "\n".join(
        text
        for text in [
            read_text(run_dir / "test_stdout.log", 5000),
            read_text(run_dir / "pi_stdout.log", 3000),
            read_text(run_dir / "agent_stdout.log", 1000),
        ]
        if text.strip()
    )
    retry_query = "\n".join(
        part
        for part in [str(summary.get("task") or ""), str(summary.get("error") or ""), failure]
        if part
    )
    results, _ = retrieve_memories(project_root, summary, retry_query)
    block = format_cheater_memories(results, bool(summary.get("include_patch")))
    retry_number = next_retry_number(run_dir)
    message = (
        "Retry the current task using the failure evidence and fresh analogous memories below. "
        "Reinspect the repository; do not blindly copy a memory patch.\n\n"
        "# Failure evidence\n\n"
        + (failure or "No failure log was available; re-evaluate the current implementation.")
        + "\n\n# Fresh memories\n\n"
        + block
    )
    retry_path = run_dir / f"retry_{retry_number}_prompt.md"
    write_text(retry_path, message)
    summary.update({"last_retry_prompt": str(retry_path), "status": "retry_queued"})
    save_json(summary_path, summary)
    update_session_record(run_dir, {"last_retry_prompt": str(retry_path), "status": "retry_queued"})
    emit(
        {
            "ok": True,
            "summary": f"Retry {retry_number} queued with {len(results)} memories.",
            "message": message,
            "sendToAgent": True,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
