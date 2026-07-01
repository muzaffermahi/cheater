from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
from dataclasses import asdict, dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from .agent_harness import run_tests
from .bug_memory import inspect_cards_corpus
from .cheater_config import memory_db_path
from .cheater_core import CheaterSession, write_text
from .pi_rpc import PiRpcResult, run_pi_rpc
from .qwen_local_agent import (
    LOCAL_QWEN_SETUP,
    LocalQwenConfig,
    LocalQwenResult,
    discover_local_qwen,
    run_local_qwen_agent,
)


class RepoSafetyError(RuntimeError):
    """Raised when an evaluation could damage or contaminate a repository."""


QWEN_SETUP_INSTRUCTIONS = LOCAL_QWEN_SETUP


@dataclass(frozen=True)
class VariantSpec:
    name: str
    backend: str
    use_memory: bool
    retry_on_failure: bool


VARIANT_SPECS: dict[str, VariantSpec] = {
    "baseline_pi": VariantSpec("baseline_pi", "pi", False, False),
    "cheater_pi": VariantSpec("cheater_pi", "pi", True, False),
    "cheater_pi_retry": VariantSpec("cheater_pi_retry", "pi", True, True),
    "baseline_qwen": VariantSpec("baseline_qwen", "qwen", False, False),
    "cheater_qwen": VariantSpec("cheater_qwen", "qwen", True, False),
    "cheater_qwen_retry": VariantSpec("cheater_qwen_retry", "qwen", True, True),
}


@dataclass
class EvalTask:
    id: str
    repo: str
    task: str
    error: str = ""
    test_command: str = ""
    expected_files: list[str] | None = None
    notes: str = ""
    base_commit: str = ""
    task_kind: str = "real"
    bug_type: str = ""
    relevant_memory_ids: list[str] | None = None
    relevance_annotation_method: str = ""
    relevance_notes: str = ""

    @classmethod
    def from_value(cls, value: Mapping[str, Any] | "EvalTask") -> "EvalTask":
        if isinstance(value, cls):
            return value
        expected = value.get("expected_files") or []
        if not isinstance(expected, list):
            raise ValueError("expected_files must be a JSON array of paths.")
        relevant_memory_ids = value.get("relevant_memory_ids") or []
        if not isinstance(relevant_memory_ids, list):
            raise ValueError("relevant_memory_ids must be a JSON array of memory IDs.")
        return cls(
            id=str(value.get("id") or "task"),
            repo=str(value.get("repo") or ""),
            task=str(value.get("task") or ""),
            error=str(value.get("error") or ""),
            test_command=str(value.get("test_command") or ""),
            expected_files=[str(item) for item in expected],
            notes=str(value.get("notes") or ""),
            base_commit=str(value.get("base_commit") or ""),
            task_kind=str(value.get("task_kind") or "real"),
            bug_type=str(value.get("bug_type") or ""),
            relevant_memory_ids=[str(item) for item in relevant_memory_ids],
            relevance_annotation_method=str(
                value.get("relevance_annotation_method") or ""
            ),
            relevance_notes=str(value.get("relevance_notes") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["expected_files"] = value["expected_files"] or []
        value["relevant_memory_ids"] = value["relevant_memory_ids"] or []
        return value


@dataclass
class AgentRun:
    variant: str
    backend: str
    run_dir: Path
    prompt_file: Path
    status: str
    launch_exit_code: int | None
    retrieval_query: str
    retrieved_memories: list[dict[str, Any]]
    executed: bool
    available: bool
    unavailable_reason: str | None = None
    error: str | None = None
    launch_result: PiRpcResult | LocalQwenResult | None = None
    relevant_memory_ids: list[str] | None = None
    retrieval_strategy: str = "legacy"
    retrieval_diagnostics: dict[str, Any] | None = None
    cards_path: str = ""
    cards_format: str = ""
    qwen_repair_focus: bool = False
    memory_index: str = ""
    dense_model: str = ""
    candidate_k: int = 20
    bm25_weight: float = 0.4
    dense_weight: float = 0.6
    exclude_source_datasets: list[str] | None = None
    allow_quarantined_memory: bool = False

    @property
    def memory_ids(self) -> list[str]:
        return [str(item.get("id")) for item in self.retrieved_memories]


def get_variant_spec(variant: str) -> VariantSpec:
    try:
        return VARIANT_SPECS[variant]
    except KeyError as exc:
        raise ValueError(f"Unknown evaluation variant: {variant}") from exc


def _run_git(
    repo_path: Path, args: list[str]
) -> subprocess.CompletedProcess[str] | None:
    repo = repo_path.expanduser().resolve()
    try:
        return subprocess.run(
            ["git", "-c", f"safe.directory={repo}", *args],
            cwd=str(repo),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None


def snapshot_repo(repo_path: str | Path) -> dict[str, Any]:
    repo = Path(repo_path).expanduser().resolve()
    snapshot: dict[str, Any] = {
        "repo_path": str(repo),
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "exists": repo.exists(),
        "is_directory": repo.is_dir(),
        "is_git": False,
        "git_root": None,
        "commit": None,
        "branch": None,
        "status": "",
        "dirty": None,
        "warning": None,
        "git_error": None,
    }
    if not repo.is_dir():
        snapshot["warning"] = f"Repository directory does not exist: {repo}"
        return snapshot

    root_result = _run_git(repo, ["rev-parse", "--show-toplevel"])
    if not root_result or root_result.returncode != 0:
        detail = ""
        if root_result is not None:
            detail = root_result.stderr.strip()
        snapshot["git_error"] = detail or "Git could not be executed."
        snapshot["warning"] = (
            f"Not a Git worktree; Git snapshots are unavailable: {repo}"
            + (f" ({snapshot['git_error']})" if snapshot["git_error"] else "")
        )
        return snapshot

    snapshot["is_git"] = True
    snapshot["git_root"] = root_result.stdout.strip()
    commit_result = _run_git(repo, ["rev-parse", "HEAD"])
    if commit_result and commit_result.returncode == 0:
        snapshot["commit"] = commit_result.stdout.strip()
    branch_result = _run_git(repo, ["branch", "--show-current"])
    if branch_result and branch_result.returncode == 0:
        snapshot["branch"] = branch_result.stdout.strip() or None
    status_result = _run_git(
        repo, ["status", "--porcelain=v1", "--untracked-files=all"]
    )
    if status_result and status_result.returncode == 0:
        snapshot["status"] = status_result.stdout
        snapshot["dirty"] = bool(status_result.stdout.strip())
    return snapshot


def ensure_clean_repo(
    repo_path: str | Path, allow_dirty: bool = False
) -> dict[str, Any]:
    snapshot = snapshot_repo(repo_path)
    if not snapshot["exists"] or not snapshot["is_directory"]:
        raise RepoSafetyError(snapshot["warning"] or "Repository path is invalid.")
    if snapshot["warning"]:
        print("WARNING:", snapshot["warning"])
    if snapshot["is_git"] and snapshot["dirty"] and not allow_dirty:
        raise RepoSafetyError(
            f"Repository has uncommitted or untracked changes: {snapshot['repo_path']}\n"
            "Commit/stash them or pass --allow-dirty. Resets require separate explicit flags."
        )
    return snapshot


def _path_is_inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _listed_worktrees(repo: Path) -> set[Path]:
    result = _run_git(repo, ["worktree", "list", "--porcelain"])
    if not result or result.returncode != 0:
        detail = (
            (result.stderr or result.stdout).strip() if result else "git unavailable"
        )
        raise RepoSafetyError(f"Could not list Git worktrees: {detail}")
    paths: set[Path] = set()
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            paths.add(Path(line.removeprefix("worktree ")).resolve())
    return paths


def create_disposable_worktree(
    source_repo: str | Path,
    worktree_path: str | Path,
    *,
    owner_root: str | Path,
    target_commit: str | None = None,
) -> dict[str, Any]:
    """Create a detached worktree without modifying the prepared source checkout."""
    source = Path(source_repo).expanduser().resolve()
    target = Path(worktree_path).expanduser().resolve()
    owned = Path(owner_root).expanduser().resolve()
    source_snapshot = ensure_clean_repo(source, allow_dirty=False)
    if not source_snapshot["is_git"] or not source_snapshot["commit"]:
        raise RepoSafetyError(
            f"Disposable isolation requires a Git repository: {source}"
        )
    if Path(str(source_snapshot["git_root"])).resolve() != source:
        raise RepoSafetyError(
            f"Disposable isolation requires task.repo to be the worktree root: {source}"
        )
    if target == owned or not _path_is_inside(target, owned):
        raise RepoSafetyError(
            f"Refusing to create a disposable worktree outside its owned root: {target}"
        )
    if target.exists():
        raise RepoSafetyError(f"Disposable worktree target already exists: {target}")
    commit = (target_commit or str(source_snapshot["commit"])).strip()
    verify = _run_git(source, ["cat-file", "-e", f"{commit}^{{commit}}"])
    if not verify or verify.returncode != 0:
        raise RepoSafetyError(f"Disposable worktree commit is not valid: {commit}")

    owned.mkdir(parents=True, exist_ok=True)
    result = _run_git(source, ["worktree", "add", "--detach", str(target), commit])
    if not result or result.returncode != 0:
        detail = (
            (result.stderr or result.stdout).strip() if result else "git unavailable"
        )
        raise RepoSafetyError(f"Could not create disposable worktree: {detail}")
    created = snapshot_repo(target)
    if (
        not created["is_git"]
        or created["commit"] != commit
        or created["dirty"]
        or created["branch"] is not None
    ):
        cleanup_detail = ""
        try:
            remove_disposable_worktree(source, target, owner_root=owned)
        except RepoSafetyError as exc:
            cleanup_detail = f" Cleanup also failed: {exc}"
        raise RepoSafetyError(
            f"Disposable worktree was not created at the requested clean commit: {target}."
            + cleanup_detail
        )
    return {
        "mode": "disposable_git_worktree",
        "source_repo": str(source),
        "source_snapshot": source_snapshot,
        "worktree_path": str(target),
        "target_commit": commit,
        "worktree_snapshot": created,
    }


def remove_disposable_worktree(
    source_repo: str | Path,
    worktree_path: str | Path,
    *,
    owner_root: str | Path,
) -> None:
    """Remove only a worktree registered by Git beneath the caller's owned root."""
    source = Path(source_repo).expanduser().resolve()
    target = Path(worktree_path).expanduser().resolve()
    owned = Path(owner_root).expanduser().resolve()
    if target == owned or not _path_is_inside(target, owned):
        raise RepoSafetyError(
            f"Refusing to remove a disposable worktree outside its owned root: {target}"
        )
    if target not in _listed_worktrees(source):
        raise RepoSafetyError(
            f"Refusing to remove a path that Git does not list as a worktree: {target}"
        )
    result = _run_git(source, ["worktree", "remove", "--force", str(target)])
    if not result or result.returncode != 0:
        detail = (
            (result.stderr or result.stdout).strip() if result else "git unavailable"
        )
        raise RepoSafetyError(f"Could not remove disposable worktree: {detail}")
    if target.exists():
        raise RepoSafetyError(
            f"Git reported removal but the worktree still exists: {target}"
        )


def reset_repo(
    repo_path: str | Path,
    *,
    hard: bool = False,
    target_commit: str | None = None,
    target_branch: str | None = None,
) -> None:
    repo = Path(repo_path).expanduser().resolve()
    if not hard:
        raise RepoSafetyError(
            "Refusing to reset without hard=True. The CLI requires --reset-between "
            "plus --hard-reset or interactive RESET confirmation."
        )
    if not repo.is_dir() or repo == Path(repo.anchor):
        raise RepoSafetyError(f"Refusing to reset an invalid or unsafe path: {repo}")
    snapshot = snapshot_repo(repo)
    if not snapshot["is_git"] or not snapshot["git_root"]:
        raise RepoSafetyError(f"Refusing to reset a non-Git directory: {repo}")
    git_root = Path(str(snapshot["git_root"])).resolve()
    if git_root != repo:
        raise RepoSafetyError(
            f"Reset path must be the Git worktree root. Requested {repo}; root is {git_root}."
        )
    if not target_commit:
        raise RepoSafetyError("Refusing to reset without the captured pre-run commit.")
    verify = _run_git(repo, ["cat-file", "-e", f"{target_commit}^{{commit}}"])
    if not verify or verify.returncode != 0:
        raise RepoSafetyError(f"Captured reset commit is not valid: {target_commit}")

    print("!" * 72)
    print("DANGER: permanently restoring the worktree and removing untracked files:")
    print(repo)
    print("Target commit:", target_commit)
    print("!" * 72)
    restore_ref = (
        ["checkout", "-B", target_branch, target_commit]
        if target_branch
        else ["checkout", "--detach", target_commit]
    )
    steps = (
        ["reset", "--hard", target_commit],
        ["clean", "-fd"],
        restore_ref,
        ["reset", "--hard", target_commit],
        ["clean", "-fd"],
    )
    for args in steps:
        result = _run_git(repo, list(args))
        if not result or result.returncode != 0:
            detail = (
                (result.stderr or result.stdout).strip()
                if result
                else "git unavailable"
            )
            raise RepoSafetyError(f"Git reset step failed ({' '.join(args)}): {detail}")
        output = (result.stdout + result.stderr).strip()
        if output:
            print(output)
    restored = snapshot_repo(repo)
    if (
        restored["commit"] != target_commit
        or restored["dirty"]
        or restored["branch"] != target_branch
    ):
        raise RepoSafetyError("Repository did not return to the captured clean state.")


def _untracked_files(repo: Path) -> list[str]:
    result = _run_git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    if not result or result.returncode != 0:
        return []
    return [item for item in result.stdout.split("\0") if item]


def collect_git_diff(
    repo_path: str | Path,
    base_commit: str | None = None,
) -> str:
    repo = Path(repo_path).expanduser().resolve()
    snapshot = snapshot_repo(repo)
    if not snapshot["is_git"]:
        return ""
    args = ["diff", "--binary"]
    comparison_base = base_commit or snapshot["commit"]
    if comparison_base:
        args.extend([comparison_base, "--"])
    result = _run_git(repo, args)
    chunks = (
        [result.stdout] if result and result.returncode == 0 and result.stdout else []
    )
    for relative_path in _untracked_files(repo):
        untracked = _run_git(
            repo,
            ["diff", "--binary", "--no-index", "--", "/dev/null", relative_path],
        )
        # git diff --no-index returns 1 when it successfully finds a difference.
        if untracked and untracked.returncode in {0, 1} and untracked.stdout:
            chunks.append(untracked.stdout)
    return "".join(chunks)


def collect_changed_files(
    repo_path: str | Path,
    base_commit: str | None = None,
) -> list[str]:
    snapshot = snapshot_repo(repo_path)
    if not snapshot["is_git"]:
        return []
    files: list[str] = []
    repo = Path(repo_path).expanduser().resolve()
    if base_commit:
        committed = _run_git(repo, ["diff", "--name-only", base_commit, "--"])
        if committed and committed.returncode == 0:
            files.extend(item for item in committed.stdout.splitlines() if item)
    for line in str(snapshot["status"]).splitlines():
        if len(line) < 4:
            continue
        name = line[3:].strip()
        if " -> " in name:
            name = name.split(" -> ", 1)[1]
        name = name.strip('"')
        if name and name not in files:
            files.append(name)
    for name in _untracked_files(repo):
        if name not in files:
            files.append(name)
    return files


def run_test_command(
    repo_path: str | Path,
    test_command: str,
    log_file: str | Path,
    timeout_seconds: float | None = None,
) -> tuple[int, str]:
    repo = Path(repo_path).expanduser().resolve()
    if not repo.is_dir():
        message = f"Repository directory does not exist: {repo}\n"
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        Path(log_file).write_text(message, encoding="utf-8")
        print(message, end="")
        return 127, message
    if timeout_seconds is None:
        return run_tests(test_command, repo, Path(log_file))

    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    with log_path.open("w", encoding="utf-8") as log:
        try:
            process = subprocess.Popen(
                test_command,
                cwd=str(repo),
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=True,
                creationflags=creationflags,
                start_new_session=os.name != "nt",
            )
        except OSError as exc:
            message = f"Unable to start test command: {exc}\n"
            log.write(message)
            return 127, message
        try:
            return_code = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    capture_output=True,
                    check=False,
                )
            else:
                try:
                    os.killpg(process.pid, 9)
                except (OSError, ProcessLookupError):
                    process.kill()
            process.wait()
            log.write(
                f"\nTest command timed out after {timeout_seconds:.0f} seconds.\n"
            )
            return_code = 124
    output = log_path.read_text(encoding="utf-8", errors="replace")
    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    return return_code, output


def _default_output_dir(task: EvalTask, variant: str) -> Path:
    repo = Path(task.repo).expanduser().resolve()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return repo / ".cheater" / "sessions" / f"{stamp}_{task.id}_{variant}"


def _safe_name(value: str) -> str:
    return "".join(char if char.isalnum() or char in "-_." else "_" for char in value)


def collect_failure_source_context(
    failure_output: str,
    repo_path: str | Path,
    *,
    radius: int = 8,
    max_files: int = 2,
) -> str:
    """Return bounded, hash-addressed source windows named by a traceback."""
    repo = Path(repo_path).expanduser().resolve()
    matches = re.findall(
        r'File\s+["\'](?:<REPO>[\\/])?([^"\']+)["\'],\s+line\s+(\d+)',
        failure_output,
        flags=re.IGNORECASE,
    )
    windows: list[str] = []
    seen: set[tuple[str, int]] = set()
    for raw_path, raw_line in reversed(matches):
        normalized = raw_path.replace("\\", "/").lstrip("/")
        candidate = (repo / normalized).resolve()
        try:
            relative = candidate.relative_to(repo)
        except ValueError:
            continue
        line_number = int(raw_line)
        key = (str(relative).casefold(), line_number)
        if (
            key in seen
            or not candidate.is_file()
            or candidate.stat().st_size > 2_000_000
        ):
            continue
        seen.add(key)
        lines = candidate.read_text(encoding="utf-8", errors="replace").splitlines()
        if not lines:
            continue
        start = max(1, line_number - radius)
        end = min(len(lines), line_number + radius)
        numbered = "\n".join(
            f"{index:>6}: {lines[index - 1]}" for index in range(start, end + 1)
        )
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        windows.append(
            f"File: {relative.as_posix()}\nSHA-256: {digest}\n"
            f"Traceback line: {line_number}\n```text\n{numbered}\n```"
        )
        if len(windows) >= max_files:
            break
    return "\n\n".join(windows)


def _run_agent(
    task_value: Mapping[str, Any] | EvalTask,
    *,
    variant: str,
    use_memory: bool,
    backend: str,
    query: str = "",
    output_dir: str | Path | None = None,
    dry_run: bool = False,
    auto_send: bool = True,
    top_k: int = 3,
    include_patch: bool = False,
    agent_timeout: float = 3600.0,
    test_timeout: float = 900.0,
    qwen_base_url: str = "http://127.0.0.1:1234/v1",
    qwen_model: str = "",
    qwen_max_turns: int = 30,
    qwen_max_tokens: int = 4096,
    qwen_seed: int = 0,
    qwen_repair_focus: bool = False,
    cards_path: str | Path | None = None,
    retrieval_strategy: str = "legacy",
    bm25_minimum_anchor_matches: int = 2,
    bm25_minimum_score_margin: float = 5.0,
    project_root: str | Path | None = None,
    memory_index: str = "",
    dense_model: str = "",
    candidate_k: int = 20,
    bm25_weight: float = 0.4,
    dense_weight: float = 0.6,
    exclude_source_datasets: list[str] | None = None,
    allow_quarantined_memory: bool = False,
    contamination_filter: Any = None,
) -> AgentRun:
    task = EvalTask.from_value(task_value)
    project = Path(project_root or Path(__file__).resolve().parent).resolve()
    repo = Path(task.repo).expanduser().resolve()
    run_dir = (
        Path(output_dir).expanduser().resolve()
        if output_dir
        else _default_output_dir(task, variant)
    )
    run_dir.mkdir(parents=True, exist_ok=True)
    selected_cards = (
        Path(cards_path).expanduser().resolve()
        if cards_path is not None
        else memory_db_path(project)
    )
    cards_info = inspect_cards_corpus(selected_cards)
    session = CheaterSession(
        repo,
        selected_cards,
        run_dir.parent,
        task=task.task,
        error=task.error,
        query=query,
        test_command=task.test_command,
        top_k=top_k,
        include_patch=include_patch,
        retrieval_strategy=retrieval_strategy,
        bm25_minimum_anchor_matches=bm25_minimum_anchor_matches,
        bm25_minimum_score_margin=bm25_minimum_score_margin,
        auto_send=auto_send,
        disable_memories=not use_memory,
        memory_index=memory_index,
        dense_model=dense_model,
        candidate_k=candidate_k,
        bm25_weight=bm25_weight,
        dense_weight=dense_weight,
    )
    prompt_file = session.generate_prompt(
        mode=variant,
        interactive_memory=False,
        run_dir=run_dir,
    )
    write_text(run_dir / "pre_agent_git_diff.patch", collect_git_diff(repo))
    memories = [
        {"id": card.get("id"), "title": card.get("title"), "score": float(score)}
        for score, card in session.last_results
    ]
    common = {
        "eval_variant": variant,
        "eval_backend": backend,
        "retrieved_memories": memories,
        "retrieval_strategy": retrieval_strategy,
        "retrieval_diagnostics": session.last_retrieval_diagnostics,
        "cards_path": str(selected_cards),
        "cards_format": str(cards_info.get("format") or "unknown"),
        "qwen_repair_focus": bool(qwen_repair_focus),
    }

    def build_run(*args: Any) -> AgentRun:
        return AgentRun(
            *args,
            retrieval_strategy=retrieval_strategy,
            retrieval_diagnostics=dict(session.last_retrieval_diagnostics),
            cards_path=str(selected_cards),
            cards_format=str(cards_info.get("format") or "unknown"),
            qwen_repair_focus=bool(qwen_repair_focus),
            memory_index=memory_index,
            dense_model=dense_model,
            candidate_k=candidate_k,
            bm25_weight=bm25_weight,
            dense_weight=dense_weight,
            exclude_source_datasets=exclude_source_datasets or [],
            allow_quarantined_memory=allow_quarantined_memory,
        )

    base_commit = snapshot_repo(repo).get("commit")

    if backend == "qwen":
        qwen_config = LocalQwenConfig(
            base_url=qwen_base_url,
            model=qwen_model,
            max_turns=qwen_max_turns,
            max_tokens=qwen_max_tokens,
            request_timeout=agent_timeout,
            seed=qwen_seed,
            repair_focus=qwen_repair_focus,
            action_rescue=qwen_repair_focus,
            evidence_turn_budget=2 if qwen_repair_focus else 0,
        )
        if dry_run:
            loaded_model, loaded_models, unavailable = discover_local_qwen(qwen_config)
            status = "dry_run"
            session._update_summary(
                {
                    **common,
                    "status": status,
                    "agent_available": loaded_model is not None,
                    "qwen_model": loaded_model,
                    "qwen_loaded_models": loaded_models,
                    "unavailable_reason": unavailable or None,
                }
            )
            return build_run(
                variant,
                backend,
                run_dir,
                prompt_file,
                status,
                None,
                session.retrieval_query,
                memories,
                False,
                loaded_model is not None,
                unavailable or None,
                None,
                None,
                list(task.relevant_memory_ids or []),
            )

        if not auto_send:
            loaded_model, loaded_models, unavailable = discover_local_qwen(qwen_config)
            reason = "Qwen execution was skipped because automatic sending is disabled."
            status = "not_run_no_auto_send"
            session._update_summary(
                {
                    **common,
                    "status": status,
                    "agent_available": loaded_model is not None,
                    "qwen_model": loaded_model,
                    "qwen_loaded_models": loaded_models,
                    "unavailable_reason": unavailable or None,
                }
            )
            return build_run(
                variant,
                backend,
                run_dir,
                prompt_file,
                status,
                None,
                session.retrieval_query,
                memories,
                False,
                loaded_model is not None,
                unavailable or None,
                reason,
                None,
                list(task.relevant_memory_ids or []),
            )

        qwen_result = run_local_qwen_agent(
            repo,
            prompt_file.read_text(encoding="utf-8"),
            run_dir,
            config=qwen_config,
            test_runner=(
                lambda log_path: (
                    run_test_command(
                        repo,
                        task.test_command,
                        log_path,
                        timeout_seconds=test_timeout,
                    )
                    if task.test_command.strip()
                    else None
                )
            ),
            diff_reader=lambda: collect_git_diff(repo, base_commit=base_commit),
        )
        write_text(
            run_dir / "git_diff.patch",
            collect_git_diff(repo, base_commit=base_commit),
        )
        available = qwen_result.exit_code != 127
        session._update_summary(
            {
                **common,
                "status": qwen_result.status,
                "agent_available": available,
                "agent_exit_code": qwen_result.exit_code,
                "qwen_model": qwen_result.model,
                "qwen_event_count": qwen_result.event_count,
                "agent_error": qwen_result.error or None,
                "unavailable_reason": qwen_result.error if not available else None,
            }
        )
        return build_run(
            variant,
            backend,
            run_dir,
            prompt_file,
            qwen_result.status,
            qwen_result.exit_code,
            session.retrieval_query,
            memories,
            available,
            available,
            qwen_result.error if not available else None,
            qwen_result.error or None,
            qwen_result,
            list(task.relevant_memory_ids or []),
        )

    if dry_run:
        session._update_summary(
            {**common, "status": "dry_run", "agent_available": True}
        )
        return build_run(
            variant,
            backend,
            run_dir,
            prompt_file,
            "dry_run",
            None,
            session.retrieval_query,
            memories,
            False,
            True,
            None,
            None,
            None,
            list(task.relevant_memory_ids or []),
        )

    if not auto_send:
        reason = "Agent execution was skipped because --no-auto-send was supplied."
        session._update_summary({**common, "status": "not_run_no_auto_send"})
        return build_run(
            variant,
            backend,
            run_dir,
            prompt_file,
            "not_run_no_auto_send",
            None,
            session.retrieval_query,
            memories,
            False,
            True,
            None,
            reason,
            None,
            list(task.relevant_memory_ids or []),
        )

    rpc_result = run_pi_rpc(
        repo,
        prompt_file.read_text(encoding="utf-8"),
        run_dir,
        name=f"cheater-eval-{_safe_name(task.id)}-{_safe_name(variant)}",
        timeout=agent_timeout,
    )
    write_text(
        run_dir / "git_diff.patch",
        collect_git_diff(repo, base_commit=base_commit),
    )
    write_text(run_dir / "agent_stdout.log", rpc_result.last_assistant_text)
    session._update_summary(
        {
            **common,
            "status": rpc_result.status,
            "agent_available": rpc_result.exit_code != 127,
            "agent_exit_code": rpc_result.exit_code,
            "pi_integration": "rpc",
            "pi_event_count": rpc_result.event_count,
            "agent_error": rpc_result.error or None,
        }
    )
    return build_run(
        variant,
        backend,
        run_dir,
        prompt_file,
        rpc_result.status,
        rpc_result.exit_code,
        session.retrieval_query,
        memories,
        True,
        rpc_result.exit_code != 127,
        "Pi RPC could not be started." if rpc_result.exit_code == 127 else None,
        rpc_result.error or None,
        rpc_result,
        list(task.relevant_memory_ids or []),
    )


def run_variant_agent(
    task: Mapping[str, Any] | EvalTask,
    variant: str,
    **kwargs: Any,
) -> AgentRun:
    spec = get_variant_spec(variant)
    return _run_agent(
        task,
        variant=variant,
        use_memory=spec.use_memory,
        backend=spec.backend,
        **kwargs,
    )


def run_agent_with_hybrid(
    task: Mapping[str, Any] | EvalTask,
    variant: str,
    **kwargs: Any,
) -> AgentRun:
    spec = get_variant_spec(variant)
    return _run_agent(
        task,
        variant=variant,
        use_memory=spec.use_memory,
        backend=spec.backend,
        **kwargs,
    )


def run_baseline_pi(task: Mapping[str, Any] | EvalTask, **kwargs: Any) -> AgentRun:
    return run_variant_agent(task, "baseline_pi", **kwargs)


def run_cheater_pi(task: Mapping[str, Any] | EvalTask, **kwargs: Any) -> AgentRun:
    return run_variant_agent(task, "cheater_pi", **kwargs)


def run_cheater_retry(
    task: Mapping[str, Any] | EvalTask,
    previous_failure_output: str,
    *,
    variant: str = "cheater_pi_retry",
    **kwargs: Any,
) -> AgentRun:
    normalized = EvalTask.from_value(task)
    spec = get_variant_spec(variant)
    if not spec.retry_on_failure:
        raise ValueError(f"Variant does not support retries: {variant}")
    failure = previous_failure_output.strip()
    if len(failure) > 8000:
        failure = failure[-8000:]
    query = "\n".join(
        part for part in [normalized.task, normalized.error, failure] if part
    )
    current_diff = collect_git_diff(normalized.repo)
    if len(current_diff) > 6000:
        current_diff = current_diff[-6000:]
    retry_error_parts = [
        normalized.error.strip(),
        "Latest failed test after the previous repair attempt:\n" + failure,
    ]
    if current_diff.strip():
        retry_error_parts.append(
            "Existing uncommitted patch from the previous attempt:\n```diff\n"
            + current_diff.rstrip()
            + "\n```"
        )
    source_context = collect_failure_source_context(failure, normalized.repo)
    if source_context:
        retry_error_parts.append(
            "Focused source context from the latest traceback (line numbers are display "
            "metadata, not source text):\n" + source_context
        )
    retry_task = replace(
        normalized,
        error="\n\n".join(part for part in retry_error_parts if part.strip()),
    )
    return _run_agent(
        retry_task,
        variant=f"{variant}_repair",
        use_memory=spec.use_memory,
        backend=spec.backend,
        query=query,
        **kwargs,
    )


def memory_telemetry(agent_run: AgentRun) -> dict[str, Any]:
    memories = agent_run.retrieved_memories
    has_top = bool(memories)
    top_used: bool | None = None if has_top else False
    usage_method = (
        "not_observable_from_agent_artifacts" if has_top else "no_memory_retrieved"
    )
    if has_top and agent_run.launch_result:
        assistant_text = agent_run.launch_result.last_assistant_text.casefold()
        top = memories[0]
        references = [str(top.get("id") or ""), str(top.get("title") or "")]
        if any(
            reference.casefold() in assistant_text
            for reference in references
            if reference
        ):
            top_used = True
            usage_method = "explicit_reference_in_agent_response"
    relevance_labels = set(agent_run.relevant_memory_ids or [])
    if has_top and relevance_labels:
        appeared_relevant: bool | None = str(memories[0].get("id")) in relevance_labels
        relevance_method = "task_relevant_memory_ids_annotation"
    else:
        appeared_relevant = None if has_top else False
        relevance_method = "not_reviewed" if has_top else "no_memory_retrieved"
    return {
        "retrieval_strategy": agent_run.retrieval_strategy,
        "retrieval_diagnostics": agent_run.retrieval_diagnostics or {},
        "cards_path": agent_run.cards_path,
        "cards_format": agent_run.cards_format,
        "retrieval_query": agent_run.retrieval_query,
        "retrieved_memory_ids": agent_run.memory_ids,
        "retrieval_scores": [item.get("score") for item in memories],
        "retrieved_memories": memories,
        "top_memory_id": memories[0].get("id") if has_top else None,
        "top_memory_in_prompt": has_top,
        "top_memory_used": top_used,
        "top_memory_usage_method": usage_method,
        "memory_appeared_relevant": appeared_relevant,
        "memory_relevance_method": relevance_method,
        "memory_index": agent_run.memory_index,
        "dense_model": agent_run.dense_model,
        "candidate_k": agent_run.candidate_k,
        "bm25_weight": agent_run.bm25_weight,
        "dense_weight": agent_run.dense_weight,
        "exclude_source_datasets": agent_run.exclude_source_datasets or [],
        "allow_quarantined_memory": agent_run.allow_quarantined_memory,
    }


def save_task(path: str | Path, task: Mapping[str, Any] | EvalTask) -> None:
    normalized = EvalTask.from_value(task)
    Path(path).write_text(
        json.dumps(normalized.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
