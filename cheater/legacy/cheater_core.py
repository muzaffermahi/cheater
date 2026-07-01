from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .agent_harness import (
    copy_text_to_clipboard,
    run_tests,
)
from .bug_memory import load_cards, search_cards_with_diagnostics, tokenize
from .cheater_config import resolve_real_pi_command
from .cheater_session import (
    CheaterSessionRecord,
    ensure_repo_artifacts_excluded,
    save_session_record,
    update_session_record,
)


GENERIC_QUERY_WORDS = {
    "bug",
    "code",
    "do",
    "edit",
    "explain",
    "files",
    "fix",
    "help",
    "issue",
    "memory",
    "only",
    "please",
    "problem",
    "repo",
    "repository",
    "retrieved",
    "something",
    "test",
    "wrong",
}
WEAK_PHRASES = {
    "test only",
    "explain retrieved memory",
    "do not edit files",
    "no error provided",
    "fix bug",
    "help me",
}


def is_weak_query(query: str) -> bool:
    normalized = " ".join(query.lower().split())
    if not normalized or normalized in WEAK_PHRASES:
        return True
    informative = tokenize(normalized) - GENERIC_QUERY_WORDS
    return len(informative) < 2


def make_timestamped_dir(base: Path, mode: str) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    safe_mode = "".join(
        char if char.isalnum() or char in "-_" else "_" for char in mode
    )
    stem = datetime.now().strftime(f"%Y%m%d_%H%M%S_{safe_mode}")
    candidate = base / stem
    suffix = 2
    while candidate.exists():
        candidate = base / f"{stem}_{suffix}"
        suffix += 1
    candidate.mkdir(parents=True)
    return candidate.resolve()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def save_json(path: Path, value: dict[str, Any]) -> None:
    write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def console_safe(value: Any, encoding: str | None = None) -> str:
    text = str(value)
    target_encoding = encoding or getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        return text.encode(target_encoding, errors="backslashreplace").decode(
            target_encoding
        )
    except LookupError:
        return text.encode("utf-8", errors="backslashreplace").decode("utf-8")


def print_memory_preview(results: list[tuple[float, dict[str, Any]]]) -> None:
    if not results:
        print("[MEMORY] No memories attached.")
        return
    for rank, (score, card) in enumerate(results, start=1):
        title = " ".join(
            str(card.get("title") or _raw_card_title(card) or "(untitled)").split()
        )
        fix = " ".join(
            str(
                card.get("fix_pattern") or card.get("patch_summary") or "(none)"
            ).split()
        )
        if len(fix) > 180:
            fix = fix[:177] + "..."
        print(console_safe(f"[MEMORY {rank}] {title} | score={score:.1f}"))
        print(console_safe(f"           id: {card.get('id') or ''}"))
        print(console_safe(f"           fix: {fix}"))


def _sqlite_fts_query(query: str) -> str:
    terms = sorted(tokenize(query))
    if not terms:
        return ""
    # Use prefix terms so traceback fragments and symbol-ish tokens still match.
    escaped = []
    for term in terms[:32]:
        safe = term.replace('"', '""')
        escaped.append(f'"{safe}"*')
    return " OR ".join(escaped)


def search_sqlite_memory_index(
    index_dir: Path,
    query: str,
    top_k: int,
) -> tuple[list[tuple[float, dict[str, Any]]], dict[str, Any]]:
    db_path = index_dir / "cards_fts.sqlite"
    if not db_path.is_file():
        return [], {
            "strategy": "sqlite_fts",
            "returned": 0,
            "reason": "sqlite_fts_missing",
            "path": str(db_path),
        }
    fts_query = _sqlite_fts_query(query)
    if not fts_query:
        return [], {
            "strategy": "sqlite_fts",
            "returned": 0,
            "reason": "empty_query",
            "path": str(db_path),
        }
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            "SELECT bm25(cards_fts) AS score, card_json "
            "FROM cards_fts WHERE cards_fts MATCH ? "
            "ORDER BY score LIMIT ?",
            (fts_query, top_k),
        ).fetchall()
    finally:
        conn.close()

    results: list[tuple[float, dict[str, Any]]] = []
    for raw_score, card_json in rows:
        try:
            card = json.loads(card_json)
        except json.JSONDecodeError:
            continue
        # SQLite FTS bm25 returns lower-is-better negative-ish numbers. Convert
        # to a positive display score while preserving rank order.
        score = float(-raw_score)
        results.append((score, card))

    return results, {
        "strategy": "sqlite_fts",
        "returned": len(results),
        "reason": "sqlite_fts_ranked",
        "path": str(db_path),
        "fts_query": fts_query,
    }


def _list_text(value: Any) -> str:
    if not isinstance(value, list) or not value:
        return "(none)"
    return "; ".join(str(item) for item in value)


def _raw_card_title(card: dict[str, Any]) -> str:
    issue = str(card.get("issue") or "")
    lines = [line.strip() for line in issue.splitlines() if line.strip()]
    ignored = {
        "we're currently solving the following issue within our repository. here's the issue text:",
        "issue:",
    }
    return next((line for line in lines if line.casefold() not in ignored), "")


def format_cheater_memories(
    results: list[tuple[float, dict[str, Any]]], include_patch: bool = False
) -> str:
    if not results:
        return "No bug memories were attached for this run."
    blocks: list[str] = []
    for rank, (score, card) in enumerate(results, start=1):
        if card.get("issue") and not card.get("root_cause"):
            lines = [
                f"## Memory {rank}: {_raw_card_title(card) or card.get('id') or '(untitled)'}",
                f"- retrieval_score: {score:.1f}",
                "- memory_format: solved_trajectory_card (raw; may contain noisy reasoning)",
                f"- changed_files: {_list_text(card.get('changed_files'))}",
                f"- patch_summary: {card.get('patch_summary') or '(none)'}",
                "",
                "### Raw issue",
                str(card.get("issue") or "")[:3500].rstrip(),
                "",
                "### Raw error excerpt",
                str(card.get("error_excerpt") or "")[:2500].rstrip(),
                "",
                "### Raw trajectory preview",
                str(card.get("trajectory_preview") or "")[:2500].rstrip(),
            ]
        else:
            lines = [
                f"## Memory {rank}: {card.get('title') or '(untitled)'}",
                f"- retrieval_score: {score:.1f}",
                f"- error_signature: {card.get('error_signature') or '(none)'}",
                f"- symptoms: {_list_text(card.get('symptoms'))}",
                f"- root_cause: {card.get('root_cause') or '(none)'}",
                f"- fix_pattern: {card.get('fix_pattern') or '(none)'}",
                f"- patch_essence: {card.get('patch_essence') or '(none)'}",
                f"- avoid: {_list_text(card.get('avoid'))}",
                f"- changed_files: {_list_text(card.get('changed_files'))}",
            ]
        if include_patch:
            lines.extend(["", "```diff", str(card.get("patch") or "").rstrip(), "```"])
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + "\n"


def build_cheater_prompt(
    repo: Path | str,
    task: str,
    error: str,
    test_command: str,
    memory_block: str,
) -> str:
    task_text = task.strip() or (
        "Exploratory mode. Inspect the repository and report likely issues. "
        "Do not edit files until the user explicitly asks you to make a change."
    )
    error_text = error.strip() or "No observed error was provided."
    test_line = (
        f"Run this configured test command before finishing: `{test_command}`"
        if test_command.strip()
        else "Run the most relevant tests you can identify."
    )
    return f"""# Cheater Context

You are Pi running inside the current repository root.
You have retrieved bug memories from prior solved bugs.
Use memories as hints only.
Do not assume the retrieved memory is from this repo. It may be only an analogy.

# Task

{task_text}

# Observed Error / Failure

{error_text}

# Retrieved Bug Memories

{memory_block.strip()}

# Instructions

* First inspect the current repo.
* Determine whether any memory truly applies.
* If no memory applies, ignore it.
* Make the smallest correct code change.
* Do not edit unrelated files.
* Do not add permanent reproduction scripts unless necessary.
* Clean temporary files before finishing.
* {test_line}
* Explain the fix briefly.
"""


def collect_git_diff(repo_path: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "diff", "--binary"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return ""
    return result.stdout if result.returncode == 0 else ""


@dataclass
class PiLaunchResult:
    exit_code: int
    status: str
    command: list[str] | None
    process_id: int | None
    paste_attempted: bool
    paste_succeeded: bool
    paste_detail: str


def launch_pi_with_prompt(
    repo_path: Path,
    prompt_text: str,
    prompt_file: Path,
    auto_send: bool = True,
    pi_args: list[str] | None = None,
) -> PiLaunchResult:
    run_dir = prompt_file.parent
    summary_path = run_dir / "run_summary.json"
    log_path = run_dir / "pi_stdout.log"
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        summary = {"repo": str(repo_path), "prompt_file": str(prompt_file)}

    command = resolve_real_pi_command(Path(__file__).resolve().parent)
    if not command:
        message = (
            "Pi not detected. Run python 12_test_pi_detection.py or set "
            "CHEATER_REAL_PI_COMMAND."
        )
        print(message)
        write_text(log_path, message + "\n")
        summary.update({"status": "pi_not_detected", "pi_command": None})
        save_json(summary_path, summary)
        update_session_record(
            run_dir, {"status": "pi_not_detected", "pi_command": None}
        )
        return PiLaunchResult(127, "pi_not_detected", None, None, False, False, message)

    extension_path = Path(__file__).resolve().parent / "cheater_pi_extension.ts"
    clipboard_attempted = True
    try:
        copy_text_to_clipboard(prompt_text)
        clipboard_succeeded = True
        clipboard_detail = "Prompt copied as a fallback."
    except (OSError, subprocess.SubprocessError) as exc:
        clipboard_succeeded = False
        clipboard_detail = f"Clipboard fallback unavailable: {exc}"
        print("WARNING:", clipboard_detail)
    launch_command = [
        *command,
        "--extension",
        str(extension_path),
        "--name",
        f"cheater-{run_dir.name}",
        *(pi_args or []),
    ]
    if auto_send:
        launch_command.extend(
            [
                f"@{prompt_file}",
                "Begin the task now using the attached Cheater context.",
            ]
        )
    env = os.environ.copy()
    env.update(
        {
            "CHEATER_RUN_DIR": str(run_dir),
            "CHEATER_PROJECT_ROOT": str(Path(__file__).resolve().parent),
            "CHEATER_REPO": str(repo_path.resolve()),
            "CHEATER_PYTHON": sys.executable,
            "PYTHONUTF8": "1",
        }
    )
    print("Launching native Pi TUI:", subprocess.list2cmdline(launch_command))
    if auto_send:
        print("Cheater context will be submitted as Pi's initial message.")
    else:
        if clipboard_succeeded:
            print(
                "Pi will open without auto-send. Prompt copied; press Ctrl+V then Enter."
            )
        else:
            print("Pi will open without an initial Cheater message (--no-auto-send).")
    try:
        process = subprocess.Popen(launch_command, cwd=str(repo_path), env=env)
    except OSError as exc:
        message = f"Pi could not be launched: {exc}"
        print(message)
        write_text(log_path, message + "\n")
        summary.update({"status": "pi_launch_failed", "launch_error": str(exc)})
        save_json(summary_path, summary)
        update_session_record(run_dir, {"status": "pi_launch_failed"})
        return PiLaunchResult(
            127, "pi_launch_failed", launch_command, None, False, False, message
        )

    launch_log = (
        f"Pi command: {subprocess.list2cmdline(launch_command)}\n"
        f"Process ID: {process.pid}\n"
        f"Native initial message submitted: {auto_send}\n"
        f"Extension: {extension_path}\n"
    )
    write_text(log_path, launch_log)
    summary.update(
        {
            "status": "pi_running",
            "pi_command": launch_command,
            "pi_process_id": process.pid,
            "integration_mode": "native_pi_tui",
            "initial_message_submitted": auto_send,
            "clipboard_fallback_ready": clipboard_succeeded,
            "pi_extension": str(extension_path),
        }
    )
    save_json(summary_path, summary)
    update_session_record(
        run_dir,
        {
            "status": "pi_running",
            "pi_command": launch_command,
            "mode": "native_pi_tui",
        },
    )

    try:
        exit_code = process.wait()
    except KeyboardInterrupt:
        try:
            latest_summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            latest_summary = summary
        latest_summary["status"] = "launcher_interrupted"
        save_json(summary_path, latest_summary)
        update_session_record(run_dir, {"status": "launcher_interrupted"})
        return PiLaunchResult(
            130,
            "launcher_interrupted",
            launch_command,
            process.pid,
            clipboard_attempted,
            clipboard_succeeded,
            clipboard_detail,
        )

    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"Pi window exited with code {exit_code}.\n")
    try:
        latest_summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        latest_summary = summary
    latest_summary.update({"status": "completed", "pi_exit_code": exit_code})
    save_json(summary_path, latest_summary)
    update_session_record(
        run_dir,
        {
            "status": "completed",
            "pi_command": launch_command,
            "ended_at": datetime.now().isoformat(timespec="seconds"),
        },
    )
    return PiLaunchResult(
        exit_code,
        "completed",
        launch_command,
        process.pid,
        clipboard_attempted,
        clipboard_succeeded,
        clipboard_detail,
    )


class CheaterSession:
    def __init__(
        self,
        repo: Path,
        cards_path: Path,
        runs_root: Path,
        *,
        task: str = "",
        error: str = "",
        query: str = "",
        test_command: str = "",
        top_k: int = 3,
        include_patch: bool = False,
        allow_weak_query: bool = False,
        min_score: float = 50.0,
        retrieval_strategy: str = "legacy",
        bm25_minimum_anchor_matches: int = 2,
        bm25_minimum_score_margin: float = 5.0,
        auto_send: bool = True,
        disable_memories: bool = False,
        pi_args: list[str] | None = None,
        memory_index: str = "",
        dense_model: str = "",
        candidate_k: int = 20,
        bm25_weight: float = 0.4,
        dense_weight: float = 0.6,
    ) -> None:
        self.repo = repo.resolve()
        self.cards_path = cards_path.resolve()
        self.runs_root = runs_root.resolve()
        self.task = task
        self.error = error
        self.query = query
        self.test_command = test_command
        self.top_k = top_k
        self.include_patch = include_patch
        self.allow_weak_query = allow_weak_query
        self.min_score = min_score
        self.retrieval_strategy = retrieval_strategy
        self.bm25_minimum_anchor_matches = bm25_minimum_anchor_matches
        self.bm25_minimum_score_margin = bm25_minimum_score_margin
        self.auto_send = auto_send
        self.disable_memories = disable_memories
        self.pi_args = list(pi_args or [])
        self.memory_index = memory_index
        self.dense_model = dense_model
        self.candidate_k = candidate_k
        self.bm25_weight = bm25_weight
        self.dense_weight = dense_weight
        self._hybrid_retriever = None
        self._cards: list[dict[str, Any]] | None = None
        self.last_results: list[tuple[float, dict[str, Any]]] = []
        self.last_retrieval_diagnostics: dict[str, Any] = {
            "strategy": retrieval_strategy,
            "returned": 0,
            "reason": "not_run",
        }
        self.last_run_dir: Path | None = None
        self.last_prompt_file: Path | None = None

    @property
    def cards(self) -> list[dict[str, Any]]:
        if self._cards is None:
            print("[1/5] Loading cards...")
            self._cards = load_cards(self.cards_path)
        return self._cards

    @property
    def default_index_dir(self) -> Path:
        return Path(__file__).resolve().parent / "memory_store" / "indexes" / "default"

    @property
    def retrieval_query(self) -> str:
        return self.query.strip() or "\n".join(
            part for part in [self.task.strip(), self.error.strip()] if part
        )

    def pi_command(self) -> list[str] | None:
        return resolve_real_pi_command(Path(__file__).resolve().parent)

    def retrieve(
        self,
        *,
        interactive: bool = False,
        input_fn: Callable[[str], str] = input,
    ) -> list[tuple[float, dict[str, Any]]]:
        query = self.retrieval_query
        print(f"[2/5] Retrieving top {self.top_k} memories...")
        if self.disable_memories:
            print("Memory retrieval disabled for this session.")
            self.last_results = []
            self.last_retrieval_diagnostics = {
                "strategy": self.retrieval_strategy,
                "returned": 0,
                "reason": "memory_disabled",
            }
            return []
        if is_weak_query(query) and not self.allow_weak_query:
            print(
                "Warning: the retrieval query is too vague to select reliable memories."
            )
            if interactive:
                better = input_fn(
                    "Enter a better bug/error/search query (blank for no memories): "
                ).strip()
                if better:
                    self.query = better
                    query = better
                else:
                    self.last_results = []
                    self.last_retrieval_diagnostics = {
                        "strategy": self.retrieval_strategy,
                        "returned": 0,
                        "reason": "weak_query_rejected",
                    }
                    return []
            else:
                print(
                    "Continuing with zero memories. Use --allow-weak-query to override."
                )
                self.last_results = []
                self.last_retrieval_diagnostics = {
                    "strategy": self.retrieval_strategy,
                    "returned": 0,
                    "reason": "weak_query_rejected",
                }
                return []

        if self.retrieval_strategy == "hybrid":
            try:
                results = self._hybrid_retrieve(query)
                self.last_results = results
                return results
            except Exception as exc:
                print(f"Hybrid retrieval failed ({exc}), falling back to BM25.")
                self.retrieval_strategy = "bm25"

        if self.retrieval_strategy in {"bm25", "bm25_filtered"}:
            index_dir = Path(self.memory_index).expanduser().resolve() if self.memory_index else self.default_index_dir
            raw_results, diagnostics = search_sqlite_memory_index(
                index_dir,
                query,
                self.top_k,
            )
            if diagnostics.get("reason") == "sqlite_fts_ranked":
                self.last_retrieval_diagnostics = diagnostics
                if self.retrieval_strategy == "bm25_filtered" and not raw_results:
                    print("BM25 confidence filter:", diagnostics.get("reason"))
                self.last_results = raw_results
                print_memory_preview(raw_results)
                return raw_results
            print(
                f"SQLite memory index unavailable ({diagnostics.get('reason')}); "
                "falling back to loading cards."
            )

        cards = self.cards

        raw_results, diagnostics = (
            search_cards_with_diagnostics(
                query,
                cards,
                self.top_k,
                strategy=self.retrieval_strategy,
                minimum_anchor_matches=self.bm25_minimum_anchor_matches,
                minimum_score_margin=self.bm25_minimum_score_margin,
            )
            if query
            else ([], {"strategy": self.retrieval_strategy, "reason": "empty_query"})
        )
        self.last_retrieval_diagnostics = diagnostics
        if self.retrieval_strategy == "bm25_filtered":
            print(
                "BM25 confidence filter:",
                diagnostics.get("reason"),
                f"margin={diagnostics.get('score_margin')}",
                f"anchors={len(diagnostics.get('matched_anchors') or [])}",
            )
        if (
            self.retrieval_strategy == "legacy"
            and raw_results
            and raw_results[0][0] < self.min_score
        ):
            print(
                f"Warning: top memory score {raw_results[0][0]:.1f} is below "
                f"the minimum {self.min_score:.1f}."
            )
            if interactive:
                use_anyway = (
                    input_fn("Use these memories anyway? y/n: ").strip().lower()
                )
                results = raw_results if use_anyway in {"y", "yes"} else []
            else:
                results = []
        else:
            results = (
                [item for item in raw_results if item[0] >= self.min_score]
                if self.retrieval_strategy == "legacy"
                else raw_results
            )
        self.last_results = results
        print_memory_preview(results)
        return results

    def _hybrid_retrieve(self, query: str) -> list[tuple[float, dict[str, Any]]]:
        from .hybrid_retriever import HybridRetriever, format_hybrid_results

        index_dir = self.memory_index or (
            Path(__file__).resolve().parent / "memory_store" / "indexes" / "default"
        )
        print(f"[2/5] Hybrid retrieval from {index_dir}...")
        retriever = HybridRetriever.load(index_dir)
        retriever.bm25_weight = self.bm25_weight
        retriever.dense_weight = self.dense_weight
        results = retriever.search(
            query,
            top_k=self.top_k,
            candidate_k=self.candidate_k,
            strategy="hybrid",
        )
        formatted = format_hybrid_results(results, top_k=self.top_k)
        self.last_results = formatted
        self.last_retrieval_diagnostics = {
            "strategy": "hybrid",
            "returned": len(formatted),
            "method": "bm25_dense_fusion",
            "bm25_weight": self.bm25_weight,
            "dense_weight": self.dense_weight,
            "candidate_k": self.candidate_k,
        }
        print_memory_preview(formatted)
        return formatted

    def generate_prompt(
        self,
        *,
        mode: str = "cheater",
        interactive_memory: bool = False,
        run_dir: Path | None = None,
    ) -> Path:
        results = self.retrieve(interactive=interactive_memory)
        print("[3/5] Writing prompt and run artifacts...")
        if run_dir is None:
            run_dir = make_timestamped_dir(self.runs_root, mode)
        else:
            run_dir = run_dir.resolve()
            run_dir.mkdir(parents=True, exist_ok=True)
        ensure_repo_artifacts_excluded(self.repo)
        memory_block = format_cheater_memories(results, self.include_patch)
        prompt = build_cheater_prompt(
            self.repo, self.task, self.error, self.test_command, memory_block
        )
        write_text(run_dir / "task.txt", self.task.strip() + "\n")
        write_text(run_dir / "error.txt", self.error.strip() + "\n")
        write_text(run_dir / "retrieval_query.txt", self.retrieval_query + "\n")
        write_text(run_dir / "memory_block.md", memory_block)
        write_text(run_dir / "initial_prompt.md", prompt)
        write_text(run_dir / "pi_stdout.log", "")
        write_text(run_dir / "agent_stdout.log", "")
        write_text(run_dir / "test_stdout.log", "")
        diff = collect_git_diff(self.repo)
        if diff:
            write_text(run_dir / "git_diff.patch", diff)
        summary = {
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "mode": mode,
            "repo": str(self.repo),
            "task": self.task,
            "error": self.error,
            "retrieval_query": self.retrieval_query,
            "test_command": self.test_command,
            "top_k": self.top_k,
            "min_score": self.min_score,
            "retrieval_strategy": self.retrieval_strategy,
            "retrieval_diagnostics": self.last_retrieval_diagnostics,
            "bm25_minimum_anchor_matches": self.bm25_minimum_anchor_matches,
            "bm25_minimum_score_margin": self.bm25_minimum_score_margin,
            "allow_weak_query": self.allow_weak_query,
            "include_patch": self.include_patch,
            "memory_ids": [card.get("id") for _, card in results],
            "memories": [
                {"id": card.get("id"), "title": card.get("title"), "score": score}
                for score, card in results
            ],
            "run_dir": str(run_dir),
            "prompt_file": str(run_dir / "initial_prompt.md"),
            "status": "prompt_generated",
        }
        save_json(run_dir / "run_summary.json", summary)
        record = CheaterSessionRecord(
            session_id=run_dir.name,
            repo_path=str(self.repo),
            task=self.task,
            error=self.error,
            retrieval_query=self.retrieval_query,
            memories=summary["memories"],
            prompt_path=str(run_dir / "initial_prompt.md"),
            run_dir=str(run_dir),
            pi_command=self.pi_command(),
            test_command=self.test_command,
            mode=mode,
            status="prompt_generated",
        )
        save_session_record(run_dir, record)
        self.last_run_dir = run_dir
        self.last_prompt_file = run_dir / "initial_prompt.md"
        print("Prompt file:", self.last_prompt_file)
        return self.last_prompt_file

    def launch_latest(self) -> PiLaunchResult:
        if self.last_prompt_file is None or not self.last_prompt_file.exists():
            self.generate_prompt(interactive_memory=True)
        assert self.last_prompt_file is not None
        print("[4/5] Launching Pi...")
        result = launch_pi_with_prompt(
            self.repo,
            self.last_prompt_file.read_text(encoding="utf-8"),
            self.last_prompt_file,
            auto_send=self.auto_send,
            pi_args=self.pi_args,
        )
        self._refresh_diff_and_summary()
        print("[5/5] Saved run summary.")
        return result

    def run(
        self, *, interactive_memory: bool = False, mode: str = "cheater"
    ) -> PiLaunchResult:
        self.generate_prompt(mode=mode, interactive_memory=interactive_memory)
        return self.launch_latest()

    def run_configured_tests(self) -> tuple[int, str] | None:
        if not self.test_command.strip():
            print("No test command configured. Use /test <command> first.")
            return None
        if self.last_run_dir is None:
            self.generate_prompt(interactive_memory=True)
        assert self.last_run_dir is not None
        print("Running tests:", self.test_command)
        code, output = run_tests(
            self.test_command, self.repo, self.last_run_dir / "test_stdout.log"
        )
        self._update_summary(
            {
                "test_exit_code": code,
                "status": "tests_passed" if code == 0 else "tests_failed",
            }
        )
        self._refresh_diff_and_summary()
        print("Tests passed." if code == 0 else f"Tests failed with exit code {code}.")
        return code, output

    def retry(self) -> PiLaunchResult:
        failure_chunks: list[str] = []
        if self.last_run_dir:
            for name in ("test_stdout.log", "pi_stdout.log", "agent_stdout.log"):
                path = self.last_run_dir / name
                if path.exists():
                    failure_chunks.append(
                        path.read_text(encoding="utf-8", errors="replace")[-4000:]
                    )
        failure = "\n".join(chunk for chunk in failure_chunks if chunk.strip())
        if not failure:
            print("No failure logs found; retrying with the current task/error query.")
        self.query = "\n".join(
            part for part in [self.task, self.error, failure] if part
        )
        return self.run(interactive_memory=True, mode="retry")

    def copy_latest_prompt(self) -> bool:
        if self.last_prompt_file is None or not self.last_prompt_file.exists():
            print("No generated prompt. Use /prompt first.")
            return False
        try:
            copy_text_to_clipboard(self.last_prompt_file.read_text(encoding="utf-8"))
        except (OSError, subprocess.CalledProcessError) as exc:
            print(f"Clipboard copy failed: {exc}")
            return False
        print("Prompt copied to clipboard.")
        return True

    def show_logs(self) -> None:
        if not self.last_run_dir:
            print("No run artifacts yet.")
            return
        print("Run folder:", self.last_run_dir)
        for name in (
            "initial_prompt.md",
            "memory_block.md",
            "agent_stdout.log",
            "pi_stdout.log",
            "test_stdout.log",
            "git_diff.patch",
            "run_summary.json",
        ):
            path = self.last_run_dir / name
            if path.exists():
                print(f"  {name}: {path}")

    def open_run_folder(self) -> bool:
        if not self.last_run_dir:
            print("No run folder yet.")
            return False
        try:
            os.startfile(self.last_run_dir)  # type: ignore[attr-defined]
        except (AttributeError, OSError) as exc:
            print(f"Could not open Explorer: {exc}")
            return False
        return True

    def _update_summary(self, updates: dict[str, Any]) -> None:
        if not self.last_run_dir:
            return
        path = self.last_run_dir / "run_summary.json"
        try:
            summary = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            summary = {}
        summary.update(updates)
        save_json(path, summary)
        update_session_record(self.last_run_dir, updates)

    def _refresh_diff_and_summary(self) -> None:
        if not self.last_run_dir:
            return
        diff = collect_git_diff(self.repo)
        diff_path = self.last_run_dir / "git_diff.patch"
        if diff:
            write_text(diff_path, diff)
        self._update_summary({"git_diff_file": str(diff_path) if diff else None})
