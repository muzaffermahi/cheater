from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from .bug_memory import load_cards, search_cards_with_diagnostics
from .cheater_core import (
    build_cheater_prompt,
    format_cheater_memories,
    is_weak_query,
    save_json,
    write_text,
)
from .cheater_retry_controller import (
    RepoSafetyError,
    collect_changed_files,
    collect_git_diff,
    ensure_clean_repo,
    run_test_command,
    snapshot_repo,
)
from .pi_rpc import run_pi_rpc
from .qwen_local_agent import LocalQwenConfig, run_local_qwen_agent
from .cheater_session import CheaterSessionRecord, save_session_record, update_session_record


class BenchmarkError(RuntimeError):
    pass


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return [value] if value else []
        return parsed if isinstance(parsed, list) else [parsed]
    return []


def _safe_id(value: str) -> str:
    return "".join(char if char.isalnum() or char in "-_." else "_" for char in value)


def _prediction_model_name(
    agent: str,
    *,
    use_memory: bool,
    qwen_model: str = "",
    qwen_action_rescue: bool = False,
    qwen_failure_critic: bool = False,
    qwen_evidence_budget: int = 0,
    retrieval_strategy: str = "legacy",
) -> str:
    if agent != "qwen":
        return "cheater-pi" if use_memory else "baseline-pi"
    retrieval_label = (
        f"-{retrieval_strategy.replace('_', '-')}" if use_memory and retrieval_strategy != "legacy" else ""
    )
    return (
        f"{'cheater' if use_memory else 'baseline'}-qwen"
        f"{retrieval_label}"
        f"{'-action-rescue' if qwen_action_rescue else ''}"
        f"{'-failure-critic' if qwen_failure_critic else ''}"
        f"{'-evidence-' + str(qwen_evidence_budget) if qwen_evidence_budget else ''}"
        f"-local:{qwen_model or 'auto'}"
    )


def _qwen_event_metrics(path: Path) -> dict[str, int]:
    metrics = {
        "assistant_turns": 0,
        "tool_events": 0,
        "reasoning_chars": 0,
        "visible_chars": 0,
        "length_exhaustions": 0,
        "forced_tool_requests": 0,
        "action_rescues": 0,
        "failure_critics": 0,
        "unchanged_failure_critics": 0,
    }
    if not path.is_file():
        return metrics
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            metrics["assistant_turns"] += 1
            metrics["reasoning_chars"] += len(str(event.get("reasoning_content") or ""))
            message = event.get("message") if isinstance(event.get("message"), dict) else {}
            metrics["visible_chars"] += len(str(message.get("content") or ""))
            metrics["length_exhaustions"] += int(event.get("finish_reason") == "length")
            metrics["forced_tool_requests"] += int(
                event.get("requested_tool_choice") == "required"
            )
        elif event.get("type") == "tool":
            metrics["tool_events"] += 1
        elif event.get("type") == "action_rescue":
            metrics["action_rescues"] += 1
        elif event.get("type") == "failure_critic":
            metrics["failure_critics"] += 1
            metrics["unchanged_failure_critics"] += int(
                event.get("failure_unchanged") is True
            )
    return metrics


def normalize_instance(row: dict[str, Any], index: int) -> dict[str, Any]:
    problem = str(row.get("problem_statement") or row.get("task") or row.get("description") or "")
    instance_id = str(row.get("instance_id") or row.get("id") or f"instance_{index}")
    title = next((line.strip() for line in problem.splitlines() if line.strip()), instance_id)
    return {
        "instance_id": instance_id,
        "title": title[:240],
        "repo": row.get("repo") or row.get("repository") or "",
        "base_commit": row.get("base_commit") or "",
        "problem_statement": problem,
        "test_patch": row.get("test_patch") or "",
        "FAIL_TO_PASS": _json_list(row.get("FAIL_TO_PASS")),
        "PASS_TO_PASS": _json_list(row.get("PASS_TO_PASS")),
    }


class BenchmarkHarness:
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root.resolve()
        self.profiles_path = self.project_root / "bench_profiles.json"
        self.runs_root = self.project_root / "bench_runs"
        self._cache: dict[str, list[dict[str, Any]]] = {}

    def profiles(self) -> dict[str, dict[str, Any]]:
        if not self.profiles_path.exists():
            raise BenchmarkError(f"Benchmark profile file not found: {self.profiles_path}")
        value = json.loads(self.profiles_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise BenchmarkError("bench_profiles.json must contain a JSON object.")
        return value

    def help_text(self) -> str:
        return """Benchmark commands:
  /bench list
  /bench load <profile>
  /bench sample <profile> [count]
  /bench run <profile> --limit N
  /bench run <profile> --ids id1,id2
  /bench status
  /bench export
  /bench eval <official evaluator command>
"""

    def print_profiles(self) -> None:
        for name, profile in self.profiles().items():
            source = profile.get("dataset") or profile.get("path") or ""
            print(f"{name}: {profile.get('type')} - {source}")

    def load_instances(
        self, profile_name: str, *, allow_download: bool = False
    ) -> list[dict[str, Any]]:
        if profile_name in self._cache:
            return self._cache[profile_name]
        profiles = self.profiles()
        if profile_name not in profiles:
            raise BenchmarkError(
                f"Unknown benchmark profile '{profile_name}'. Available: {', '.join(profiles)}"
            )
        profile = profiles[profile_name]
        profile_type = profile.get("type")

        rows: list[dict[str, Any]] = []
        if profile_type == "jsonl":
            path = Path(str(profile.get("path") or ""))
            if not path.is_absolute():
                path = self.project_root / path
            if not path.exists():
                raise BenchmarkError(
                    f"Custom benchmark file not found: {path}. Create it or edit bench_profiles.json."
                )
            with path.open("r", encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, start=1):
                    if not line.strip():
                        continue
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise BenchmarkError(f"Invalid JSONL line {line_number}: {exc}") from exc
                    if isinstance(value, dict):
                        rows.append(value)
        elif profile_type == "hf_dataset":
            try:
                from datasets import DownloadConfig, load_dataset
            except ImportError as exc:
                raise BenchmarkError(
                    "The 'datasets' package is required. Run: python -m pip install datasets"
                ) from exc
            dataset_name = str(profile.get("dataset") or "")
            split = str(profile.get("split") or "test")
            kwargs: dict[str, Any] = {}
            if not allow_download:
                kwargs["download_config"] = DownloadConfig(local_files_only=True)
                print(f"Loading cached benchmark metadata only: {dataset_name} ({split})")
            else:
                print(f"Downloading/loading benchmark metadata: {dataset_name} ({split})")
            try:
                dataset = load_dataset(dataset_name, split=split, **kwargs)
            except Exception as exc:
                if not allow_download:
                    raise BenchmarkError(
                        f"{dataset_name} is not available from the local cache. "
                        "No download was started. In the TUI use /bench load and confirm, "
                        "or pass --allow-download on the command line."
                    ) from exc
                raise BenchmarkError(f"Could not load {dataset_name}: {exc}") from exc
            rows = [dict(row) for row in dataset]
        else:
            raise BenchmarkError(f"Unsupported benchmark profile type: {profile_type}")

        instances = [normalize_instance(row, index) for index, row in enumerate(rows)]
        self._cache[profile_name] = instances
        return instances

    def print_sample(
        self,
        profile_name: str,
        count: int = 5,
        *,
        allow_download: bool = False,
    ) -> None:
        instances = self.load_instances(profile_name, allow_download=allow_download)
        for instance in instances[: max(0, count)]:
            print(f"{instance['instance_id']}: {instance['title']}")

    def parse_run_args(self, parts: list[str]) -> tuple[str, int | None, list[str] | None]:
        if not parts:
            raise BenchmarkError("Usage: /bench run <profile> --limit N | --ids id1,id2")
        profile = parts[0]
        limit: int | None = None
        ids: list[str] | None = None
        index = 1
        while index < len(parts):
            option = parts[index]
            if option == "--limit" and index + 1 < len(parts):
                limit = int(parts[index + 1])
                index += 2
            elif option == "--ids" and index + 1 < len(parts):
                ids = [item for item in parts[index + 1].split(",") if item]
                index += 2
            else:
                raise BenchmarkError(f"Unknown benchmark run option: {option}")
        if limit is None and not ids:
            raise BenchmarkError("Benchmark runs require --limit N or --ids id1,id2.")
        return profile, limit, ids

    def run_profile(
        self,
        profile_name: str,
        *,
        limit: int | None,
        ids: list[str] | None,
        repo: Path | None,
        dry_run: bool,
        auto_send: bool,
        cards_path: Path,
        top_k: int,
        min_score: float,
        include_patch: bool,
        allow_download: bool = False,
        evaluator_command: str = "",
        local_eval_summary: Path | None = None,
        agent: str = "pi",
        test_command: str = "",
        test_timeout: float = 900.0,
        qwen_base_url: str = "http://127.0.0.1:1234/v1",
        qwen_model: str = "",
        qwen_max_turns: int = 30,
        qwen_max_tokens: int = 4096,
        qwen_seed: int = 0,
        qwen_action_rescue: bool = False,
        qwen_failure_critic: bool = False,
        qwen_evidence_budget: int = 0,
        retrieval_strategy: str = "legacy",
        bm25_minimum_anchor_matches: int = 2,
        bm25_minimum_score_margin: float = 5.0,
        max_retries: int = 1,
        use_memory: bool = True,
    ) -> Path:
        agent = agent.casefold()
        if agent not in {"pi", "qwen"}:
            raise BenchmarkError("Benchmark agent must be 'pi' or 'qwen'.")
        if qwen_failure_critic and not qwen_action_rescue:
            raise BenchmarkError(
                "--qwen-failure-critic requires --qwen-action-rescue so the optimization "
                "remains a separately labeled rescue ablation."
            )
        if qwen_evidence_budget < 0:
            raise BenchmarkError("--qwen-evidence-budget cannot be negative.")
        if qwen_evidence_budget and not qwen_action_rescue:
            raise BenchmarkError(
                "--qwen-evidence-budget requires --qwen-action-rescue."
            )
        if retrieval_strategy not in {"legacy", "bm25", "bm25_filtered"}:
            raise BenchmarkError(f"Unknown retrieval strategy: {retrieval_strategy}")
        if bm25_minimum_anchor_matches < 0:
            raise BenchmarkError("BM25 minimum anchor matches cannot be negative.")
        if bm25_minimum_score_margin < 0:
            raise BenchmarkError("BM25 minimum score margin cannot be negative.")
        instances = self.load_instances(profile_name, allow_download=allow_download)
        if ids:
            wanted = set(ids)
            selected = [item for item in instances if item["instance_id"] in wanted]
            missing = wanted - {item["instance_id"] for item in selected}
            if missing:
                raise BenchmarkError(f"Unknown instance IDs: {', '.join(sorted(missing))}")
        else:
            selected = instances[: max(0, limit or 0)]
        if not selected:
            raise BenchmarkError("No benchmark instances selected.")

        local_gate: dict[str, Any] | None = None
        if repo and not dry_run and auto_send:
            if not local_eval_summary:
                raise BenchmarkError(
                    "Prepared benchmark agent runs require --local-eval-summary pointing "
                    "to a comparison summary whose ten-task local gate is met."
                )
            try:
                local_gate_value = json.loads(local_eval_summary.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise BenchmarkError(
                    f"Could not read local evaluation summary: {local_eval_summary}: {exc}"
                ) from exc
            if not isinstance(local_gate_value, dict) or not local_gate_value.get(
                "ten_task_local_eval_gate_met"
            ):
                raise BenchmarkError(
                    "The supplied local evaluation summary does not prove ten complete "
                    "ablation tasks. Finish Gate 4 before running benchmark agents."
                )
            local_gate = local_gate_value

        repo_snapshot: dict[str, Any] | None = None
        if repo:
            try:
                repo_snapshot = ensure_clean_repo(repo, allow_dirty=False)
            except RepoSafetyError as exc:
                raise BenchmarkError(str(exc)) from exc
            if not repo_snapshot.get("is_git") or not repo_snapshot.get("commit"):
                raise BenchmarkError("A prepared benchmark repo must be a clean Git worktree.")
        if repo and not dry_run and auto_send and len(selected) > 1:
            raise BenchmarkError(
                "One prepared repo cannot safely run multiple benchmark instances without "
                "isolated worktrees. Run one instance at a time with the exact base commit."
            )

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = self.runs_root / timestamp
        suffix = 2
        while run_dir.exists():
            run_dir = self.runs_root / f"{timestamp}_{suffix}"
            suffix += 1
        (run_dir / "per_instance").mkdir(parents=True)
        profile = self.profiles()[profile_name]
        config = {
            "profile": profile_name,
            "profile_config": profile,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "dry_run": dry_run,
            "repo": str(repo.resolve()) if repo else None,
            "selected_count": len(selected),
            "agent": agent,
            "test_command": test_command or None,
            "test_timeout": test_timeout,
            "qwen_base_url": qwen_base_url if agent == "qwen" else None,
            "qwen_model": qwen_model or None if agent == "qwen" else None,
            "qwen_max_turns": qwen_max_turns if agent == "qwen" else None,
            "qwen_max_tokens": qwen_max_tokens if agent == "qwen" else None,
            "qwen_seed": qwen_seed if agent == "qwen" else None,
            "qwen_action_rescue": qwen_action_rescue if agent == "qwen" else None,
            "qwen_failure_critic": qwen_failure_critic if agent == "qwen" else None,
            "qwen_evidence_budget": qwen_evidence_budget if agent == "qwen" else None,
            "memory_enabled": use_memory,
            "retrieval_strategy": retrieval_strategy,
            "bm25_minimum_anchor_matches": bm25_minimum_anchor_matches,
            "bm25_minimum_score_margin": bm25_minimum_score_margin,
            "max_retries": max_retries,
            "official_evaluator_command": evaluator_command or None,
            "local_eval_summary": str(local_eval_summary) if local_eval_summary else None,
            "ten_task_local_eval_gate_met": bool(
                local_gate and local_gate.get("ten_task_local_eval_gate_met")
            ),
        }
        save_json(run_dir / "benchmark_config.json", config)
        self._write_jsonl(run_dir / "selected_instances.jsonl", selected)

        cards = load_cards(cards_path) if use_memory else []
        predictions: list[dict[str, str]] = []
        results_summary: list[dict[str, Any]] = []
        for number, instance in enumerate(selected, start=1):
            instance_id = str(instance["instance_id"])
            print(f"\n[BENCH {number}/{len(selected)}] {instance_id}")
            print("Required repo:", instance.get("repo") or "(unknown)")
            print("Required base commit:", instance.get("base_commit") or "(unknown)")
            instance_dir = run_dir / "per_instance" / _safe_id(instance_id)
            instance_dir.mkdir(parents=True)
            if repo:
                current_snapshot = snapshot_repo(repo)
                save_json(instance_dir / "pre_run_repo.json", current_snapshot)
                expected_commit = str(instance.get("base_commit") or "")
                if (
                    not dry_run
                    and auto_send
                    and expected_commit
                    and current_snapshot.get("commit") != expected_commit
                ):
                    raise BenchmarkError(
                        f"Prepared repo is at {current_snapshot.get('commit')}, but "
                        f"{instance_id} requires {expected_commit}. Cheater will not check out "
                        "or reset it automatically."
                    )
            preflight_exit_code: int | None = None
            preflight_output = ""
            invalid_preflight: str | None = None
            if repo and not dry_run and auto_send and test_command:
                before_preflight = snapshot_repo(repo)
                preflight_exit_code, preflight_output = run_test_command(
                    repo,
                    test_command,
                    instance_dir / "preflight_stdout.log",
                    timeout_seconds=test_timeout,
                )
                after_preflight = snapshot_repo(repo)
                save_json(instance_dir / "post_preflight_repo.json", after_preflight)
                unchanged = all(
                    before_preflight.get(field) == after_preflight.get(field)
                    for field in ("status", "commit", "branch")
                )
                if not unchanged:
                    invalid_preflight = "invalid_preflight_modified_repo"
                elif preflight_exit_code == 0:
                    invalid_preflight = "invalid_preflight_already_passing"
            problem = str(instance.get("problem_statement") or "")
            query = "\n".join(part for part in (problem, preflight_output) if part).strip()
            if use_memory and not is_weak_query(query):
                raw_memories, retrieval_diagnostics = search_cards_with_diagnostics(
                    query,
                    cards,
                    top_k,
                    strategy=retrieval_strategy,
                    minimum_anchor_matches=bm25_minimum_anchor_matches,
                    minimum_score_margin=bm25_minimum_score_margin,
                )
            else:
                raw_memories, retrieval_diagnostics = [], {
                    "strategy": retrieval_strategy,
                    "returned": 0,
                    "reason": "memory_disabled" if not use_memory else "weak_query_rejected",
                }
            memories = (
                [item for item in raw_memories if item[0] >= min_score]
                if retrieval_strategy == "legacy"
                else raw_memories
            )
            memory_block = format_cheater_memories(memories, include_patch)
            repo_label: str | Path = repo.resolve() if repo else (
                f"workspace required for {instance.get('repo')} at {instance.get('base_commit')}"
            )
            benchmark_task = (
                problem
                + "\n\nBenchmark metadata:\n"
                + f"instance_id: {instance_id}\n"
                + f"repo: {instance.get('repo')}\n"
                + f"base_commit: {instance.get('base_commit')}"
            )
            if test_command:
                benchmark_task += f"\nconfigured_test_command: {test_command}"
            prompt = build_cheater_prompt(
                repo_label,
                benchmark_task,
                preflight_output[-12000:],
                test_command,
                memory_block,
            )
            write_text(instance_dir / "task.txt", benchmark_task + "\n")
            write_text(instance_dir / "error.txt", "")
            write_text(instance_dir / "retrieval_query.txt", query + "\n")
            write_text(instance_dir / "memory_block.md", memory_block)
            prompt_file = instance_dir / "initial_prompt.md"
            write_text(prompt_file, prompt)
            write_text(instance_dir / "agent_stdout.log", "")
            write_text(instance_dir / "pi_stdout.log", "")
            write_text(instance_dir / "test_stdout.log", "")
            instance_summary = {
                "instance_id": instance_id,
                "required_repo": instance.get("repo"),
                "base_commit": instance.get("base_commit"),
                "memory_ids": [card.get("id") for _, card in memories],
                "retrieved_memories": [
                    {
                        "id": card.get("id"),
                        "title": card.get("title"),
                        "score": score,
                    }
                    for score, card in memories
                ],
                "memory_enabled": use_memory,
                "top_memory_used": None if memories else False,
                "memory_relevance": "not_reviewed" if memories else "no_memory_retrieved",
                "retrieval_strategy": retrieval_strategy,
                "retrieval_diagnostics": retrieval_diagnostics,
                "qwen_action_rescue_enabled": bool(agent == "qwen" and qwen_action_rescue),
                "qwen_failure_critic_enabled": bool(agent == "qwen" and qwen_failure_critic),
                "qwen_evidence_budget": qwen_evidence_budget if agent == "qwen" else 0,
                "status": "prompt_generated",
                "preflight_test_exit_code": preflight_exit_code,
                "preflight_status": (
                    invalid_preflight
                    or ("confirmed_failing" if preflight_exit_code is not None else "not_run")
                ),
            }
            save_json(instance_dir / "run_summary.json", instance_summary)
            save_session_record(
                instance_dir,
                CheaterSessionRecord(
                    session_id=_safe_id(instance_id),
                    repo_path=str(repo_label),
                    task=benchmark_task,
                    error="",
                    retrieval_query=query,
                    memories=[
                        {"id": card.get("id"), "title": card.get("title"), "score": score}
                        for score, card in memories
                    ],
                    prompt_path=str(prompt_file),
                    run_dir=str(instance_dir),
                    pi_command=None,
                    test_command=test_command,
                    mode=(
                        "benchmark_qwen_memory_action_rescue_failure_critic"
                        if agent == "qwen" and use_memory and qwen_failure_critic
                        else "benchmark_qwen_baseline_action_rescue_failure_critic"
                        if agent == "qwen" and qwen_failure_critic
                        else "benchmark_qwen_memory_action_rescue"
                        if agent == "qwen" and use_memory and qwen_action_rescue
                        else "benchmark_qwen_baseline_action_rescue"
                        if agent == "qwen" and qwen_action_rescue
                        else "benchmark_qwen_memory"
                        if agent == "qwen" and use_memory
                        else "benchmark_qwen_baseline"
                        if agent == "qwen"
                        else "benchmark_rpc_memory"
                        if use_memory
                        else "benchmark_rpc_baseline"
                    ),
                    status="prompt_generated",
                ),
            )

            if invalid_preflight:
                instance_summary["status"] = invalid_preflight
                instance_summary["agent_executed"] = False
            elif repo and not dry_run and auto_send:
                if agent == "qwen":
                    qwen_test_runner = (
                        (
                            lambda log_path: run_test_command(
                                repo,
                                test_command,
                                log_path,
                                timeout_seconds=test_timeout,
                            )
                        )
                        if test_command
                        else None
                    )
                    qwen_result = run_local_qwen_agent(
                        repo,
                        prompt,
                        instance_dir,
                        config=LocalQwenConfig(
                            base_url=qwen_base_url,
                            model=qwen_model,
                            max_turns=qwen_max_turns,
                            max_tokens=qwen_max_tokens,
                            seed=qwen_seed,
                            action_rescue=qwen_action_rescue,
                            failure_critic=qwen_failure_critic,
                            evidence_turn_budget=qwen_evidence_budget,
                        ),
                        test_runner=qwen_test_runner,
                        diff_reader=lambda: collect_git_diff(
                            repo,
                            base_commit=str(instance.get("base_commit") or "") or None,
                        ),
                        initial_failure_output=preflight_output,
                    )
                    qwen_metrics = _qwen_event_metrics(instance_dir / "qwen_events.jsonl")
                    instance_summary.update(
                        {
                            "status": qwen_result.status,
                            "agent_status": qwen_result.status,
                            "agent_executed": True,
                            "qwen_exit_code": qwen_result.exit_code,
                            "qwen_integration": "loopback_tools",
                            "qwen_event_count": qwen_result.event_count,
                            "qwen_event_metrics": qwen_metrics,
                            "qwen_action_rescue_used": qwen_metrics["action_rescues"] > 0,
                            "qwen_failure_critic_used": qwen_metrics["failure_critics"] > 0,
                            "qwen_model": qwen_result.model,
                            "qwen_error": qwen_result.error or None,
                        }
                    )
                else:
                    rpc_result = run_pi_rpc(
                        repo,
                        prompt,
                        instance_dir,
                        name=f"cheater-bench-{_safe_id(instance_id)}",
                    )
                    instance_summary.update(
                        {
                            "status": rpc_result.status,
                            "agent_status": rpc_result.status,
                            "agent_executed": True,
                            "pi_exit_code": rpc_result.exit_code,
                            "pi_integration": "rpc",
                            "pi_event_count": rpc_result.event_count,
                            "pi_error": rpc_result.error or None,
                        }
                    )

                if test_command:
                    test_exit_code, test_output = run_test_command(
                        repo,
                        test_command,
                        instance_dir / "test_stdout.log",
                        timeout_seconds=test_timeout,
                    )
                    instance_summary["test_exit_code"] = test_exit_code
                    instance_summary["first_attempt_failed"] = test_exit_code != 0
                    retry_summaries: list[dict[str, Any]] = []
                    if agent == "qwen" and test_exit_code != 0:
                        for retry_number in range(1, max_retries + 1):
                            retry_dir = instance_dir / f"retry_{retry_number}"
                            current_diff = collect_git_diff(
                                repo,
                                base_commit=str(instance.get("base_commit") or "") or None,
                            )
                            retry_prompt = (
                                prompt
                                + "\n\n# Closed-loop repair\n\n"
                                + "The previous attempt did not pass the configured local test. "
                                + "Use the failure and current diff below to make a focused repair.\n\n"
                                + "## Latest failure\n\n"
                                + test_output[-12000:]
                                + "\n\n## Current diff\n\n```diff\n"
                                + current_diff[-12000:]
                                + "\n```\n"
                            )
                            retry_result = run_local_qwen_agent(
                                repo,
                                retry_prompt,
                                retry_dir,
                                config=LocalQwenConfig(
                                    base_url=qwen_base_url,
                                    model=qwen_model,
                                    max_turns=qwen_max_turns,
                                    max_tokens=qwen_max_tokens,
                                    seed=qwen_seed,
                                    action_rescue=qwen_action_rescue,
                                    failure_critic=qwen_failure_critic,
                                    evidence_turn_budget=qwen_evidence_budget,
                                ),
                                test_runner=qwen_test_runner,
                                diff_reader=lambda: collect_git_diff(
                                    repo,
                                    base_commit=(
                                        str(instance.get("base_commit") or "") or None
                                    ),
                                ),
                                initial_failure_output=test_output,
                            )
                            test_exit_code, test_output = run_test_command(
                                repo,
                                test_command,
                                retry_dir / "test_stdout.log",
                                timeout_seconds=test_timeout,
                            )
                            retry_summaries.append(
                                {
                                    "retry": retry_number,
                                    "agent_status": retry_result.status,
                                    "agent_exit_code": retry_result.exit_code,
                                    "agent_error": retry_result.error or None,
                                    "test_exit_code": test_exit_code,
                                    "qwen_event_metrics": _qwen_event_metrics(
                                        retry_dir / "qwen_events.jsonl"
                                    ),
                                }
                            )
                            if test_exit_code == 0:
                                break
                    instance_summary["retries_used"] = len(retry_summaries)
                    instance_summary["retry_attempts"] = retry_summaries
                    instance_summary["retry_solved"] = bool(
                        retry_summaries and test_exit_code == 0
                    )
                    instance_summary["test_exit_code"] = test_exit_code
                    instance_summary["local_test_passed"] = test_exit_code == 0
                    instance_summary["status"] = (
                        "solved_after_retry"
                        if instance_summary["retry_solved"]
                        else "solved_local_test"
                        if test_exit_code == 0
                        else "failed_local_test"
                    )
            elif repo and not dry_run:
                instance_summary["status"] = "prompt_generated_no_send"
                print(f"--no-auto-send set: benchmark prompt generated but not sent to {agent}.")
            elif dry_run:
                instance_summary["status"] = "dry_run"
            else:
                instance_summary["status"] = "workspace_required"
                print(
                    "No prepared --repo was supplied. Prepare the required repo/commit and rerun; "
                    "Cheater did not clone anything automatically."
                )

            patch = (
                collect_git_diff(repo, base_commit=str(instance.get("base_commit") or "") or None)
                if repo
                else ""
            )
            write_text(instance_dir / "git_diff.patch", patch)
            prediction = {
                "instance_id": instance_id,
                "model_name_or_path": _prediction_model_name(
                    agent,
                    use_memory=use_memory,
                    qwen_model=qwen_model,
                    qwen_action_rescue=qwen_action_rescue,
                    qwen_failure_critic=qwen_failure_critic,
                    qwen_evidence_budget=qwen_evidence_budget,
                    retrieval_strategy=retrieval_strategy,
                ),
                "model_patch": patch,
            }
            predictions.append(prediction)
            instance_summary["prediction_has_patch"] = bool(patch)
            if repo:
                final_snapshot = snapshot_repo(repo)
                save_json(instance_dir / "post_run_repo.json", final_snapshot)
                instance_summary["changed_files"] = collect_changed_files(
                    repo,
                    base_commit=str(instance.get("base_commit") or "") or None,
                )
            save_json(instance_dir / "run_summary.json", instance_summary)
            update_session_record(
                instance_dir,
                {
                    "status": instance_summary["status"],
                    "prediction_has_patch": bool(patch),
                },
            )
            results_summary.append(instance_summary)
            self._write_jsonl(run_dir / "predictions.jsonl", predictions)

        summary = {
            "profile": profile_name,
            "selected": len(selected),
            "with_patches": sum(1 for item in predictions if item["model_patch"]),
            "results": results_summary,
            "predictions_file": str(run_dir / "predictions.jsonl"),
            "official_evaluation_run": False,
            "note": "No benchmark score is computed without the official evaluator.",
        }
        save_json(run_dir / "summary.json", summary)
        if evaluator_command:
            self.run_official_evaluator(evaluator_command, run_dir=run_dir)
        print("Benchmark run folder:", run_dir)
        print("Predictions:", run_dir / "predictions.jsonl")
        print("Use the official SWE-bench evaluator/container harness to compute scores.")
        return run_dir

    def audit_incomplete_run(self, run_dir: Path, *, reason: str) -> Path:
        run_dir = run_dir.expanduser().resolve()
        config_path = run_dir / "benchmark_config.json"
        selected_path = run_dir / "selected_instances.jsonl"
        if not config_path.is_file() or not selected_path.is_file():
            raise BenchmarkError(
                "Incomplete-run audit requires benchmark_config.json and "
                "selected_instances.jsonl."
            )
        if (run_dir / "summary.json").exists():
            raise BenchmarkError("Run already has summary.json; refusing to overwrite it.")
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            selected = [
                json.loads(line)
                for line in selected_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        except (OSError, json.JSONDecodeError) as exc:
            raise BenchmarkError(f"Could not read incomplete run metadata: {exc}") from exc
        if not isinstance(config, dict) or not all(isinstance(item, dict) for item in selected):
            raise BenchmarkError("Incomplete run metadata has an invalid shape.")

        repo_value = config.get("repo")
        repo = Path(str(repo_value)).resolve() if repo_value else None
        if repo and not repo.is_dir():
            repo = None
        agent = str(config.get("agent") or "pi")
        use_memory = bool(config.get("memory_enabled", True))
        predictions: list[dict[str, str]] = []
        results: list[dict[str, Any]] = []
        for instance in selected:
            instance_id = str(instance.get("instance_id") or "unknown")
            instance_dir = run_dir / "per_instance" / _safe_id(instance_id)
            instance_dir.mkdir(parents=True, exist_ok=True)
            instance_summary_path = instance_dir / "run_summary.json"
            try:
                instance_summary = json.loads(
                    instance_summary_path.read_text(encoding="utf-8")
                )
            except (OSError, json.JSONDecodeError):
                instance_summary = {
                    "instance_id": instance_id,
                    "required_repo": instance.get("repo"),
                    "base_commit": instance.get("base_commit"),
                }
            base_commit = str(instance.get("base_commit") or "") or None
            patch = collect_git_diff(repo, base_commit=base_commit) if repo else ""
            write_text(instance_dir / "git_diff.patch", patch)
            metrics = _qwen_event_metrics(instance_dir / "qwen_events.jsonl")
            instance_summary.update(
                {
                    "status": "aborted_runtime",
                    "agent_status": "aborted_runtime",
                    "agent_executed": (instance_dir / "qwen_events.jsonl").is_file(),
                    "abort_reason": reason,
                    "recovered_from_incomplete_run": True,
                    "recovered_at": datetime.now().isoformat(timespec="seconds"),
                    "outcome_definitive": False,
                    "local_test_passed": None,
                    "test_exit_code": None,
                    "prediction_has_patch": bool(patch),
                    "qwen_event_metrics": metrics if agent == "qwen" else None,
                    "qwen_action_rescue_used": metrics["action_rescues"] > 0,
                    "qwen_failure_critic_used": metrics["failure_critics"] > 0,
                }
            )
            if repo:
                save_json(instance_dir / "post_run_repo.json", snapshot_repo(repo))
                instance_summary["changed_files"] = collect_changed_files(
                    repo, base_commit=base_commit
                )
            save_json(instance_summary_path, instance_summary)
            update_session_record(
                instance_dir,
                {
                    "status": "aborted_runtime",
                    "abort_reason": reason,
                    "prediction_has_patch": bool(patch),
                },
            )
            predictions.append(
                {
                    "instance_id": instance_id,
                    "model_name_or_path": _prediction_model_name(
                        agent,
                        use_memory=use_memory,
                        qwen_model=str(config.get("qwen_model") or ""),
                        qwen_action_rescue=bool(config.get("qwen_action_rescue")),
                        qwen_failure_critic=bool(config.get("qwen_failure_critic")),
                        qwen_evidence_budget=int(config.get("qwen_evidence_budget") or 0),
                        retrieval_strategy=str(config.get("retrieval_strategy") or "legacy"),
                    ),
                    "model_patch": patch,
                }
            )
            results.append(instance_summary)

        self._write_jsonl(run_dir / "predictions.jsonl", predictions)
        summary = {
            "profile": config.get("profile"),
            "selected": len(selected),
            "with_patches": sum(1 for item in predictions if item["model_patch"]),
            "results": results,
            "predictions_file": str(run_dir / "predictions.jsonl"),
            "official_evaluation_run": False,
            "run_incomplete_recovered": True,
            "note": (
                "Runtime ended before normal finalization. Outcomes are unknown; no score "
                "or pass/fail result was inferred."
            ),
        }
        save_json(run_dir / "summary.json", summary)
        print("Audited incomplete benchmark run:", run_dir)
        return run_dir

    def latest_run(self) -> Path | None:
        if not self.runs_root.exists():
            return None
        runs = sorted((path for path in self.runs_root.iterdir() if path.is_dir()), reverse=True)
        return runs[0] if runs else None

    def print_status(self) -> None:
        latest = self.latest_run()
        if not latest:
            print("No benchmark runs found.")
            return
        print("Latest benchmark run:", latest)
        summary = latest / "summary.json"
        print(summary.read_text(encoding="utf-8") if summary.exists() else "summary.json missing")

    def export_latest(self, destination: Path | None = None) -> Path:
        latest = self.latest_run()
        if not latest:
            raise BenchmarkError("No benchmark run is available to export.")
        source = latest / "predictions.jsonl"
        if not source.exists():
            raise BenchmarkError(f"Predictions file missing: {source}")
        destination = destination or (self.runs_root / "predictions_latest.jsonl")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        print("Exported predictions:", destination)
        return destination

    def run_official_evaluator(self, command: str, *, run_dir: Path | None = None) -> int:
        run_dir = run_dir or self.latest_run()
        if not run_dir:
            raise BenchmarkError("No benchmark run exists for evaluation.")
        print("Running user-provided official evaluator command:", command)
        result = subprocess.run(
            command,
            cwd=str(run_dir),
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        write_text(run_dir / "official_evaluator.log", result.stdout + result.stderr)
        summary_path = run_dir / "summary.json"
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            summary = {}
        summary.update(
            {
                "official_evaluation_run": True,
                "official_evaluator_command": command,
                "official_evaluator_exit_code": result.returncode,
            }
        )
        save_json(summary_path, summary)
        print("Official evaluator exit code:", result.returncode)
        return result.returncode

    @staticmethod
    def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
