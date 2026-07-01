from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cheater.legacy.run_eval as run_eval
import cheater.legacy.benchmark_harness as benchmark_harness
from cheater.legacy.benchmark_harness import BenchmarkError, BenchmarkHarness
from cheater.legacy.cheater_retry_controller import (
    AgentRun,
    EvalTask,
    RepoSafetyError,
    collect_changed_files,
    collect_git_diff,
    collect_failure_source_context,
    create_disposable_worktree,
    ensure_clean_repo,
    get_variant_spec,
    reset_repo,
    memory_telemetry,
    remove_disposable_worktree,
    run_cheater_retry,
    run_variant_agent,
)
from cheater.legacy.compare_eval_results import build_summary, load_results_many, write_reports
from cheater.legacy.qwen_local_agent import (
    LocalQwenConfig,
    LocalQwenError,
    LocalQwenResult,
    RepoTools,
    run_local_qwen_agent,
    validate_loopback_url,
)
import cheater.legacy.qwen_local_agent as qwen_local_agent
from cheater.legacy.validate_eval_tasks import validate_task


def _args(**updates: object) -> argparse.Namespace:
    values = {
        "dry_run": False,
        "allow_dirty": True,
        "no_auto_send": False,
        "preflight_only": False,
        "top_k": 3,
        "include_patch": False,
        "max_retries": 1,
        "skip_preflight": True,
        "test_timeout": 30.0,
        "agent_timeout": 30.0,
        "qwen_base_url": "http://127.0.0.1:1234/v1",
        "qwen_model": "",
        "qwen_max_turns": 5,
        "qwen_seed": 0,
        "qwen_retry_focus": False,
        "retrieval_query_mode": "runtime",
        "restore_after": False,
    }
    values.update(updates)
    return argparse.Namespace(**values)


def _agent_run(
    output_dir: Path,
    *,
    variant: str,
    memories: bool,
    query: str = "task query",
) -> AgentRun:
    output_dir.mkdir(parents=True, exist_ok=True)
    prompt = output_dir / "initial_prompt.md"
    prompt.write_text("prompt\n", encoding="utf-8")
    retrieved = (
        [{"id": "memory-1", "title": "Relevant memory", "score": 88.0}]
        if memories
        else []
    )
    return AgentRun(
        variant=variant,
        backend="pi",
        run_dir=output_dir,
        prompt_file=prompt,
        status="completed",
        launch_exit_code=0,
        retrieval_query=query,
        retrieved_memories=retrieved,
        executed=True,
        available=True,
    )


class EvalLoopTests(unittest.TestCase):
    def test_attempt_telemetry_counts_qwen_events(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            attempt = Path(temp)
            run = _agent_run(
                attempt,
                variant="cheater_qwen_retry_repair",
                memories=False,
            )
            run.backend = "qwen"
            (attempt / "qwen_events.jsonl").write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "assistant",
                                "reasoning_content": "think",
                                "message": {"content": "act"},
                                "finish_reason": "length",
                                "requested_tool_choice": "required",
                            }
                        ),
                        json.dumps({"type": "tool", "tool": "read_file"}),
                        json.dumps({"type": "action_rescue"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            telemetry = run_eval.save_attempt_telemetry(attempt, run, 2)

            metrics = telemetry["qwen_event_metrics"]
            self.assertEqual(metrics["assistant_turns"], 1)
            self.assertEqual(metrics["tool_counts"], {"read_file": 1})
            self.assertEqual(metrics["action_rescues"], 1)

    def test_failure_source_context_is_bounded_hashed_and_repo_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            repo.mkdir()
            source = repo / "module.py"
            source.write_text(
                "\n".join(f"line {index}" for index in range(1, 31)) + "\n",
                encoding="utf-8",
            )
            failure = (
                '  File "<REPO>\\module.py", line 15, in repair\n'
                "    broken()\n"
                '  File "<REPO>\\..\\outside.py", line 1, in escape\n'
            )

            context = collect_failure_source_context(failure, repo, radius=2)

            self.assertIn("File: module.py", context)
            self.assertIn("Traceback line: 15", context)
            self.assertIn("    13: line 13", context)
            self.assertIn("    17: line 17", context)
            self.assertIn(hashlib.sha256(source.read_bytes()).hexdigest(), context)
            self.assertNotIn("outside.py", context)

    def test_failure_evidence_normalization_removes_arm_specific_values(self) -> None:
        repo = Path(r"C:\eval\arm-1")
        raw = (
            r"File \"C:\eval\arm-1\module.py\", line 3" + "\n"
            + "BadTimeSignature: Signature b'abc_123' does not match"
        )
        normalized = run_eval.normalize_failure_evidence(raw, repo)
        self.assertNotIn(str(repo), normalized)
        self.assertIn(r'<REPO>\module.py', normalized)
        self.assertIn("Signature <BYTES> does not match", normalized)

    def test_retry_prompt_contains_latest_failure_and_existing_diff(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            repo.mkdir()
            task = EvalTask(
                "retry-context",
                str(repo),
                "Fix it",
                error="Original failure",
                test_command="check",
            )
            with (
                patch(
                    "cheater.legacy.cheater_retry_controller.collect_git_diff",
                    return_value="diff --git a/x.py b/x.py\n+bad edit\n",
                ),
                patch("cheater.legacy.cheater_retry_controller._run_agent") as agent,
            ):
                run_cheater_retry(
                    task,
                    "TypeError: latest post-edit failure",
                    variant="cheater_qwen_retry",
                )

            retry_task = EvalTask.from_value(agent.call_args.args[0])
            self.assertIn("latest post-edit failure", retry_task.error)
            self.assertIn("Existing uncommitted patch", retry_task.error)
            self.assertIn("+bad edit", retry_task.error)
            self.assertIn("latest post-edit failure", agent.call_args.kwargs["query"])

    def test_task_id_selector_is_repeatable(self) -> None:
        args = run_eval.parse_args(
            [
                "--tasks",
                "tasks.jsonl",
                "--task-id",
                "one",
                "--task-id",
                "two",
                "--dry-run",
            ]
        )
        self.assertEqual(args.task_ids, ["one", "two"])

    def test_no_test_command_is_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            task = EvalTask("no-tests", str(repo), "Fix it", test_command="")

            def fake_agent(*_args: object, **kwargs: object) -> AgentRun:
                return _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="baseline_pi",
                    memories=False,
                )

            with patch.object(run_eval, "run_variant_agent", side_effect=fake_agent):
                result = run_eval.evaluate_variant(
                    task, "baseline_pi", root / "artifacts", _args()
                )

            self.assertEqual(result["solved_status"], "unknown_no_tests")
            self.assertIsNone(result["solved"])
            self.assertIsNone(result["test_exit_code"])

    def test_no_auto_send_never_runs_tests_or_claims_an_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            task = EvalTask("prompt-only", str(repo), "Fix it", test_command="check")

            def fake_agent(*_args: object, **kwargs: object) -> AgentRun:
                return _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="baseline_qwen",
                    memories=False,
                )

            with (
                patch.object(run_eval, "run_variant_agent", side_effect=fake_agent),
                patch.object(run_eval, "run_test_command") as test_runner,
            ):
                result = run_eval.evaluate_variant(
                    task,
                    "baseline_qwen",
                    root / "artifacts",
                    _args(no_auto_send=True),
                )

            test_runner.assert_not_called()
            self.assertEqual(result["solved_status"], "not_run_no_auto_send")
            self.assertIsNone(result["solved"])
            self.assertFalse(result["agent_executed"])
            self.assertIsNone(result["test_exit_code"])

    def test_preflight_only_builds_runtime_query_without_agent_or_post_test(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            task = EvalTask("preflight", str(repo), "Fix it", test_command="check")
            test_calls = 0

            def failing_test(
                _repo: Path, _command: str, log: Path, **_kwargs: object
            ) -> tuple[int, str]:
                nonlocal test_calls
                test_calls += 1
                output = "Traceback: distinctive runtime failure"
                Path(log).write_text(output + "\n", encoding="utf-8")
                return 1, output

            def fake_agent(*_args: object, **kwargs: object) -> AgentRun:
                self.assertFalse(kwargs["auto_send"])
                self.assertIn("distinctive runtime failure", kwargs["query"])
                self.assertIn(
                    "distinctive runtime failure", EvalTask.from_value(_args[0]).error
                )
                run = _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="cheater_qwen",
                    memories=True,
                    query=str(kwargs["query"]),
                )
                run.executed = False
                return run

            with (
                patch.object(run_eval, "run_variant_agent", side_effect=fake_agent),
                patch.object(run_eval, "run_test_command", side_effect=failing_test),
            ):
                result = run_eval.evaluate_variant(
                    task,
                    "cheater_qwen",
                    root / "artifacts",
                    _args(preflight_only=True, skip_preflight=False),
                )

            self.assertEqual(test_calls, 1)
            self.assertEqual(result["preflight_status"], "confirmed_failing")
            self.assertEqual(result["solved_status"], "not_run_preflight_only")
            self.assertFalse(result["agent_executed"])
            self.assertIsNone(result["test_exit_code"])
            self.assertIn("distinctive runtime failure", result["retrieval_query"])

    def test_semantic_retrieval_query_keeps_runtime_failure_in_agent_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            task = EvalTask(
                "semantic", str(repo), "Fix semantic bug", error="DeclaredError", test_command="check"
            )

            def failing_test(
                _repo: Path, _command: str, log: Path, **_kwargs: object
            ) -> tuple[int, str]:
                output = "Traceback: noisy runtime path"
                Path(log).write_text(output + "\n", encoding="utf-8")
                return 1, output

            def fake_agent(task_value: object, *_args: object, **kwargs: object) -> AgentRun:
                prompt_task = EvalTask.from_value(task_value)
                self.assertEqual(kwargs["query"], "Fix semantic bug\nDeclaredError")
                self.assertIn("noisy runtime path", prompt_task.error)
                run = _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="cheater_qwen",
                    memories=True,
                    query=str(kwargs["query"]),
                )
                run.executed = False
                return run

            with (
                patch.object(run_eval, "run_variant_agent", side_effect=fake_agent),
                patch.object(run_eval, "run_test_command", side_effect=failing_test),
            ):
                result = run_eval.evaluate_variant(
                    task,
                    "cheater_qwen",
                    root / "artifacts",
                    _args(
                        preflight_only=True,
                        skip_preflight=False,
                        retrieval_query_mode="semantic",
                    ),
                )

            self.assertEqual(result["retrieval_query"], "Fix semantic bug\nDeclaredError")
            self.assertEqual(result["solved_status"], "not_run_preflight_only")

    def test_memory_only_variant_does_not_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            task = EvalTask("memory", str(repo), "Fix it", test_command="fail")
            calls = 0

            def fake_agent(*_args: object, **kwargs: object) -> AgentRun:
                return _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="cheater_pi",
                    memories=True,
                )

            def fake_test(
                _repo: Path, _command: str, log: Path, **_kwargs: object
            ) -> tuple[int, str]:
                nonlocal calls
                calls += 1
                Path(log).write_text("still failing\n", encoding="utf-8")
                return 1, "still failing"

            with (
                patch.object(run_eval, "run_variant_agent", side_effect=fake_agent),
                patch.object(run_eval, "run_test_command", side_effect=fake_test),
                patch.object(run_eval, "run_cheater_retry") as retry,
            ):
                result = run_eval.evaluate_variant(
                    task, "cheater_pi", root / "artifacts", _args()
                )

            self.assertEqual(calls, 1)
            retry.assert_not_called()
            self.assertEqual(result["solved_status"], "failed_tests")
            self.assertEqual(result["retries_used"], 0)

    def test_retry_variant_preserves_first_failure_and_can_repair(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            task = EvalTask("repair", str(repo), "Fix it", test_command="check")
            test_results = [(1, "first failure evidence"), (0, "passed")]

            def fake_agent(*_args: object, **kwargs: object) -> AgentRun:
                return _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="cheater_qwen_retry",
                    memories=True,
                )

            def fake_retry(*_args: object, **kwargs: object) -> AgentRun:
                return _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="cheater_qwen_retry_repair",
                    memories=True,
                    query="Fix it\nfirst failure evidence",
                )

            def fake_test(
                _repo: Path, _command: str, log: Path, **_kwargs: object
            ) -> tuple[int, str]:
                code, output = test_results.pop(0)
                Path(log).write_text(output + "\n", encoding="utf-8")
                return code, output

            with (
                patch.object(run_eval, "run_variant_agent", side_effect=fake_agent),
                patch.object(
                    run_eval, "run_cheater_retry", side_effect=fake_retry
                ) as retry_mock,
                patch.object(run_eval, "run_test_command", side_effect=fake_test),
            ):
                result = run_eval.evaluate_variant(
                    task,
                    "cheater_qwen_retry",
                    root / "artifacts",
                    _args(qwen_retry_focus=True),
                )

            run_dir = root / "artifacts" / "cheater_qwen_retry"
            self.assertEqual(result["solved_status"], "solved_after_retry")
            self.assertTrue(result["first_attempt_failed"])
            self.assertTrue(result["retry_solved"])
            self.assertEqual(result["retries_used"], 1)
            self.assertTrue(retry_mock.call_args.kwargs["qwen_repair_focus"])
            self.assertIn("first failure evidence", result["retry_query"])
            self.assertEqual(len(result["attempts"]), 2)
            self.assertEqual(
                (run_dir / "attempt_1" / "test_stdout.log").read_text(encoding="utf-8"),
                "first failure evidence\n",
            )
            self.assertEqual(
                (run_dir / "test_stdout.log").read_text(encoding="utf-8"),
                "passed\n",
            )

    def test_qwen_matrix_uses_qwen_backend(self) -> None:
        for variant in ("baseline_qwen", "cheater_qwen", "cheater_qwen_retry"):
            self.assertEqual(get_variant_spec(variant).backend, "qwen")

    def test_task_annotation_marks_retrieved_memory_relevance(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            run = _agent_run(
                Path(temp),
                variant="cheater_qwen",
                memories=True,
            )
            run.relevant_memory_ids = ["memory-1"]
            telemetry = memory_telemetry(run)
            self.assertTrue(telemetry["memory_appeared_relevant"])
            self.assertEqual(
                telemetry["memory_relevance_method"],
                "task_relevant_memory_ids_annotation",
            )

    def test_preflight_pass_prevents_agent_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            task = EvalTask("already-green", str(repo), "Fix it", test_command="check")

            def fake_agent(*_args: object, **kwargs: object) -> AgentRun:
                run = _agent_run(
                    Path(str(kwargs["output_dir"])),
                    variant="baseline_pi",
                    memories=False,
                )
                run.status = "dry_run"
                run.executed = False
                return run

            def passing_test(
                _repo: Path, _command: str, log: Path, **_kwargs: object
            ) -> tuple[int, str]:
                Path(log).write_text("passed before agent\n", encoding="utf-8")
                return 0, "passed before agent"

            with (
                patch.object(run_eval, "run_variant_agent", side_effect=fake_agent) as agent,
                patch.object(run_eval, "run_test_command", side_effect=passing_test),
            ):
                result = run_eval.evaluate_variant(
                    task,
                    "baseline_pi",
                    root / "artifacts",
                    _args(skip_preflight=False),
                )

            self.assertEqual(result["solved_status"], "invalid_preflight_already_passing")
            self.assertIsNone(result["solved"])
            self.assertFalse(result["agent_executed"])
            self.assertTrue(agent.call_args.kwargs["dry_run"])


class GitSafetyTests(unittest.TestCase):
    def _git(self, repo: Path, *args: str) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()

    def test_dirty_detection_and_diff_include_commits_and_untracked_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            repo.mkdir()
            self._git(repo, "init")
            self._git(repo, "config", "user.email", "eval@example.invalid")
            self._git(repo, "config", "user.name", "Eval Harness")
            tracked = repo / "tracked.txt"
            tracked.write_text("before\n", encoding="utf-8")
            self._git(repo, "add", "tracked.txt")
            self._git(repo, "commit", "-m", "base")
            base = self._git(repo, "rev-parse", "HEAD")
            base_branch = self._git(repo, "branch", "--show-current")

            tracked.write_text("after\n", encoding="utf-8")
            self._git(repo, "add", "tracked.txt")
            self._git(repo, "commit", "-m", "agent commit")
            (repo / "new.txt").write_text("new file\n", encoding="utf-8")

            with self.assertRaises(RepoSafetyError):
                ensure_clean_repo(repo)
            diff = collect_git_diff(repo, base_commit=base)
            changed = collect_changed_files(repo, base_commit=base)
            self.assertIn("+after", diff)
            self.assertIn("new.txt", diff)
            self.assertEqual(set(changed), {"tracked.txt", "new.txt"})
            with self.assertRaises(RepoSafetyError):
                reset_repo(repo, hard=False, target_commit=base)
            self._git(repo, "checkout", "-b", "agent-created-branch")
            reset_repo(
                repo,
                hard=True,
                target_commit=base,
                target_branch=base_branch,
            )
            self.assertEqual(self._git(repo, "branch", "--show-current"), base_branch)
            self.assertEqual(self._git(repo, "rev-parse", "HEAD"), base)
            self.assertEqual(self._git(repo, "status", "--porcelain"), "")

    def test_disposable_worktree_is_isolated_and_safely_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "source"
            owned = root / "owned"
            target = owned / "arm-1"
            repo.mkdir()
            self._git(repo, "init")
            self._git(repo, "config", "user.email", "eval@example.invalid")
            self._git(repo, "config", "user.name", "Eval Harness")
            (repo / "tracked.txt").write_text("source\n", encoding="utf-8")
            self._git(repo, "add", "tracked.txt")
            self._git(repo, "commit", "-m", "base")
            base = self._git(repo, "rev-parse", "HEAD")

            lifecycle = create_disposable_worktree(
                repo,
                target,
                owner_root=owned,
                target_commit=base,
            )
            self.assertEqual(lifecycle["target_commit"], base)
            self.assertTrue(target.is_dir())
            self.assertEqual(self._git(target, "branch", "--show-current"), "")
            (target / "tracked.txt").write_text("agent edit\n", encoding="utf-8")
            (target / "untracked.txt").write_text("agent file\n", encoding="utf-8")

            remove_disposable_worktree(repo, target, owner_root=owned)
            self.assertFalse(target.exists())
            self.assertEqual((repo / "tracked.txt").read_text(encoding="utf-8"), "source\n")
            self.assertEqual(self._git(repo, "status", "--porcelain"), "")
            self.assertEqual(self._git(repo, "rev-parse", "HEAD"), base)

    def test_disposable_worktree_refuses_paths_outside_owned_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "source"
            repo.mkdir()
            self._git(repo, "init")
            self._git(repo, "config", "user.email", "eval@example.invalid")
            self._git(repo, "config", "user.name", "Eval Harness")
            (repo / "tracked.txt").write_text("source\n", encoding="utf-8")
            self._git(repo, "add", "tracked.txt")
            self._git(repo, "commit", "-m", "base")
            base = self._git(repo, "rev-parse", "HEAD")

            with self.assertRaises(RepoSafetyError):
                create_disposable_worktree(
                    repo,
                    root / "outside",
                    owner_root=root / "owned",
                    target_commit=base,
                )

    def test_eval_runner_wires_each_arm_to_owned_worktree_and_cleans_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "source"
            output = root / "artifacts"
            repo.mkdir()
            self._git(repo, "init")
            self._git(repo, "config", "user.email", "eval@example.invalid")
            self._git(repo, "config", "user.name", "Eval Harness")
            (repo / "tracked.txt").write_text("source\n", encoding="utf-8")
            self._git(repo, "add", "tracked.txt")
            self._git(repo, "commit", "-m", "base")
            base = self._git(repo, "rev-parse", "HEAD")
            task_file = root / "tasks.jsonl"
            task_file.write_text(
                json.dumps(
                    {
                        "id": "isolated",
                        "repo": str(repo),
                        "task": "Edit tracked.txt",
                        "error": "failing",
                        "test_command": "check",
                        "expected_files": ["tracked.txt"],
                        "notes": "integration smoke",
                        "base_commit": base,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            seen_repos: list[Path] = []

            def fake_evaluate(
                task: EvalTask,
                variant: str,
                task_root: Path,
                job_args: argparse.Namespace,
            ) -> dict[str, object]:
                seen_repo = Path(task.repo).resolve()
                seen_repos.append(seen_repo)
                self.assertNotEqual(seen_repo, repo.resolve())
                (seen_repo / "tracked.txt").write_text("agent edit\n", encoding="utf-8")
                label = f"{variant}__trial_{job_args.trial_index:02d}"
                run_dir = task_root / label
                run_dir.mkdir(parents=True, exist_ok=True)
                result = run_eval.base_result(task, label, run_dir, spec_variant=variant)
                result["trial_index"] = job_args.trial_index
                result["trial_count"] = job_args.trials
                return result

            args = run_eval.parse_args(
                [
                    "--tasks",
                    str(task_file),
                    "--variant",
                    "baseline_pi",
                    "--output",
                    str(output),
                    "--isolate-worktrees",
                    "--no-auto-send",
                    "--trials",
                    "2",
                ]
            )
            with patch.object(run_eval, "evaluate_variant", side_effect=fake_evaluate):
                eval_root = run_eval.run_evaluation(args)

            payload = json.loads(
                (eval_root / "evaluation_results.json").read_text(encoding="utf-8")
            )
            self.assertEqual(len(payload["results"]), 2)
            self.assertEqual(
                {item["trial_index"] for item in payload["results"]}, {1, 2}
            )
            self.assertEqual(
                {item["variant"] for item in payload["results"]},
                {"baseline_pi__trial_01", "baseline_pi__trial_02"},
            )
            for item in payload["results"]:
                isolation = item["repository_isolation"]
                self.assertTrue(isolation["created"])
                self.assertTrue(isolation["removed"])
                self.assertIsNone(isolation["cleanup_error"])
            self.assertEqual(len(seen_repos), 2)
            self.assertTrue(all(not seen_repo.exists() for seen_repo in seen_repos))
            self.assertEqual((repo / "tracked.txt").read_text(encoding="utf-8"), "source\n")
            self.assertEqual(self._git(repo, "status", "--porcelain"), "")
            self.assertEqual(self._git(repo, "rev-parse", "HEAD"), base)


class ComparisonTests(unittest.TestCase):
    def test_unknown_results_are_not_counted_as_failures(self) -> None:
        results = [
            {"task_id": "a", "variant": "baseline_pi", "solved_status": "dry_run", "solved": None},
            {"task_id": "a", "variant": "cheater_pi", "solved_status": "unavailable", "solved": None},
        ]
        summary = build_summary(Path("eval"), results)
        for counts in summary["variant_counts"].values():
            self.assertEqual(counts["solved"], 0)
            self.assertEqual(counts["failed"], 0)
            self.assertEqual(counts["unknown_or_not_run"], 1)
        self.assertEqual(summary["pairwise"][0]["comparable_tasks"], 0)

    def test_pairwise_comparison_includes_retrieval_strategy_variants(self) -> None:
        results = [
            {
                "task_id": "a",
                "variant": "baseline_qwen",
                "solved": True,
                "initial_prompt_sha256": "same",
            },
            {
                "task_id": "a",
                "variant": "cheater_qwen__bm25_filtered",
                "solved": False,
                "initial_prompt_sha256": "same",
                "retrieved_memory_ids": [],
            },
            {
                "task_id": "a",
                "variant": "cheater_qwen_retry__bm25_filtered",
                "solved": True,
                "initial_prompt_sha256": "with-memory",
                "retrieved_memory_ids": ["memory-1"],
            },
        ]
        summary = build_summary(Path("eval"), results)
        by_candidate = {item["candidate"]: item for item in summary["pairwise"]}

        memory = by_candidate["cheater_qwen__bm25_filtered"]
        retry = by_candidate["cheater_qwen_retry__bm25_filtered"]
        self.assertEqual(memory["comparable_tasks"], 1)
        self.assertEqual(memory["regressed"], 1)
        self.assertEqual(memory["prompt_hash_identical"], 1)
        self.assertEqual(memory["no_memory_prompt_mismatches"], [])
        self.assertEqual(retry["comparable_tasks"], 1)
        self.assertEqual(retry["same"], 1)
        self.assertEqual(retry["prompt_hash_identical"], 0)
        self.assertEqual(retry["no_memory_prompt_mismatches"], [])

    def test_pairwise_reports_no_memory_prompt_mismatch(self) -> None:
        summary = build_summary(
            Path("eval"),
            [
                {
                    "task_id": "a",
                    "variant": "baseline_qwen",
                    "solved": True,
                    "initial_prompt_sha256": "left",
                },
                {
                    "task_id": "a",
                    "variant": "cheater_qwen__bm25_filtered",
                    "solved": True,
                    "initial_prompt_sha256": "right",
                    "retrieved_memory_ids": [],
                },
            ],
        )
        self.assertEqual(summary["pairwise"][0]["no_memory_prompt_mismatches"], ["a"])

    def test_repeated_trials_are_paired_without_cross_product(self) -> None:
        results = [
            {
                "task_id": "a",
                "variant": "baseline_qwen__trial_01",
                "solved": True,
                "initial_prompt_sha256": "prompt-1",
            },
            {
                "task_id": "a",
                "variant": "cheater_qwen__bm25_filtered__trial_01",
                "solved": False,
                "initial_prompt_sha256": "prompt-1",
                "retrieved_memory_ids": [],
            },
            {
                "task_id": "a",
                "variant": "baseline_qwen__trial_02",
                "solved": False,
                "initial_prompt_sha256": "prompt-2",
            },
            {
                "task_id": "a",
                "variant": "cheater_qwen__bm25_filtered__trial_02",
                "solved": True,
                "initial_prompt_sha256": "prompt-2",
                "retrieved_memory_ids": [],
            },
        ]
        summary = build_summary(Path("eval"), results)
        paired = [
            item
            for item in summary["pairwise"]
            if item["candidate"].startswith("cheater_qwen__bm25_filtered")
        ]
        aggregate = next(
            item
            for item in summary["pairwise_aggregate"]
            if item["candidate"] == "cheater_qwen__bm25_filtered"
        )

        self.assertEqual(len(paired), 2)
        self.assertEqual(sum(item["comparable_tasks"] for item in paired), 2)
        self.assertEqual(aggregate["comparable_task_trials"], 2)
        self.assertEqual(aggregate["improved"], 1)
        self.assertEqual(aggregate["regressed"], 1)
        self.assertEqual(aggregate["paired_delta"], 0.0)
        self.assertEqual(aggregate["mcnemar_exact_p"], 1.0)
        self.assertEqual(aggregate["prompt_hash_identical"], 2)
        self.assertEqual(len(aggregate["identical_prompt_outcome_divergences"]), 2)
        self.assertEqual(len(aggregate["no_intervention_outcome_divergences"]), 2)
        self.assertEqual(
            summary["configuration_counts"]["baseline_qwen"]["mixed_outcome_tasks"],
            ["a"],
        )
        self.assertEqual(
            summary["configuration_counts"]["baseline_qwen"]["mixed_prompt_hash_tasks"],
            ["a"],
        )

    def test_configuration_labels_and_bug_types_are_stratified(self) -> None:
        results = [
            {
                "task_id": "a",
                "bug_type": "validation",
                "variant": "baseline_qwen",
                "solved": False,
            },
            {
                "task_id": "b",
                "bug_type": "compatibility",
                "variant": "baseline_qwen",
                "solved": True,
            },
            {
                "task_id": "a",
                "bug_type": "validation",
                "variant": "cheater_qwen__bm25__cfg_compact_top3",
                "solved": True,
            },
            {
                "task_id": "b",
                "bug_type": "compatibility",
                "variant": "cheater_qwen__bm25__cfg_compact_top3",
                "solved": True,
            },
            {
                "task_id": "a",
                "bug_type": "validation",
                "variant": "cheater_qwen__bm25__cfg_raw_top1",
                "solved": False,
            },
            {
                "task_id": "b",
                "bug_type": "compatibility",
                "variant": "cheater_qwen__bm25__cfg_raw_top1",
                "solved": False,
            },
        ]
        summary = build_summary(Path("eval"), results)

        self.assertIn("cheater_qwen__bm25__cfg_compact_top3", summary["configuration_counts"])
        self.assertIn("cheater_qwen__bm25__cfg_raw_top1", summary["configuration_counts"])
        compact_types = summary["configuration_bug_type_counts"][
            "cheater_qwen__bm25__cfg_compact_top3"
        ]
        self.assertEqual(compact_types["validation"]["solved"], 1)
        self.assertEqual(compact_types["compatibility"]["solved"], 1)
        candidates = {item["candidate"] for item in summary["pairwise_aggregate"]}
        self.assertIn("cheater_qwen__bm25__cfg_compact_top3", candidates)
        self.assertIn("cheater_qwen__bm25__cfg_raw_top1", candidates)

    def test_custom_configuration_pairing_matches_equal_trials(self) -> None:
        reference = "cheater_qwen_retry__bm25_filtered__cfg_control"
        candidate = "cheater_qwen_retry__bm25_filtered__cfg_focus"
        results = [
            {
                "task_id": "a",
                "variant": reference + "__trial_01",
                "solved": False,
            },
            {
                "task_id": "a",
                "variant": candidate + "__trial_01",
                "solved": True,
            },
            {
                "task_id": "a",
                "variant": reference + "__trial_02",
                "solved": False,
            },
            {
                "task_id": "a",
                "variant": candidate + "__trial_02",
                "solved": False,
            },
        ]

        summary = build_summary(
            Path("eval"), results, configuration_pairings=[(reference, candidate)]
        )
        aggregate = next(
            item
            for item in summary["pairwise_aggregate"]
            if item["baseline"] == reference and item["candidate"] == candidate
        )

        self.assertEqual(aggregate["comparable_task_trials"], 2)
        self.assertEqual(aggregate["improved"], 1)
        self.assertEqual(aggregate["regressed"], 0)
        self.assertEqual(aggregate["mcnemar_exact_p"], 1.0)

    def test_markdown_renders_each_candidate_aggregate_once(self) -> None:
        results = [
            {"task_id": "a", "variant": "baseline_qwen", "solved": True},
            {
                "task_id": "a",
                "variant": "cheater_qwen__bm25__cfg_compact",
                "solved": True,
            },
            {
                "task_id": "a",
                "variant": "cheater_qwen__bm25__cfg_raw",
                "solved": False,
            },
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_reports(root, results)
            markdown = (root / "summary.md").read_text(encoding="utf-8")
        aggregate_section = markdown.split("## Paired-trial aggregates", 1)[1].split(
            "## Bug-type stratification", 1
        )[0]
        self.assertEqual(aggregate_section.count("cfg_compact"), 1)
        self.assertEqual(aggregate_section.count("cfg_raw"), 1)

    def test_multiple_run_merge_refuses_duplicate_task_variant(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            baseline = root / "baseline"
            memory = root / "memory"
            duplicate = root / "duplicate"
            for path in (baseline, memory, duplicate):
                path.mkdir()
            (baseline / "evaluation_results.json").write_text(
                json.dumps(
                    {
                        "results": [
                            {
                                "task_id": "task-1",
                                "variant": "baseline_qwen",
                                "solved": True,
                                "solved_status": "solved",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (memory / "evaluation_results.json").write_text(
                json.dumps(
                    {
                        "results": [
                            {
                                "task_id": "task-1",
                                "variant": "cheater_qwen",
                                "solved": False,
                                "solved_status": "failed_tests",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (duplicate / "evaluation_results.json").write_text(
                (baseline / "evaluation_results.json").read_text(encoding="utf-8"),
                encoding="utf-8",
            )

            merged = load_results_many([baseline, memory])
            self.assertEqual(len(merged), 2)
            self.assertTrue(all(item.get("source_eval_run") for item in merged))
            with self.assertRaisesRegex(ValueError, "Duplicate task/variant"):
                load_results_many([baseline, duplicate])


class BenchmarkGateTests(unittest.TestCase):
    def test_benchmark_bm25_filtered_is_labeled_and_auditable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "bench_profiles.json").write_text(
                '{"local":{"type":"jsonl","path":"tasks.jsonl"}}\n',
                encoding="utf-8",
            )
            (root / "tasks.jsonl").write_text(
                json.dumps(
                    {
                        "instance_id": "one",
                        "repo": "local/repo",
                        "base_commit": "abc",
                        "problem_statement": "negative future timestamp signature age",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            cards = root / "cards.jsonl"
            cards.write_text(
                json.dumps(
                    {
                        "id": "specific",
                        "title": "negative future timestamp",
                        "search_text": "negative future timestamp signature age",
                    }
                )
                + "\n"
                + json.dumps(
                    {
                        "id": "generic",
                        "title": "generic timestamp",
                        "search_text": "generic timestamp value",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            harness = BenchmarkHarness(root)
            run_dir = harness.run_profile(
                "local",
                limit=1,
                ids=None,
                repo=None,
                dry_run=True,
                auto_send=True,
                cards_path=cards,
                top_k=3,
                min_score=50,
                include_patch=False,
                use_memory=True,
                agent="qwen",
                qwen_model="qwen-local",
                retrieval_strategy="bm25_filtered",
                bm25_minimum_anchor_matches=1,
                bm25_minimum_score_margin=0,
            )

            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            result = summary["results"][0]
            self.assertEqual(result["memory_ids"], ["specific"])
            self.assertEqual(
                result["retrieval_diagnostics"]["reason"],
                "confidence_filter_passed",
            )
            prediction = json.loads(
                (run_dir / "predictions.jsonl").read_text(encoding="utf-8").strip()
            )
            self.assertEqual(
                prediction["model_name_or_path"],
                "cheater-qwen-bm25-filtered-local:qwen-local",
            )

    def test_incomplete_run_audit_records_unknown_aborted_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            run_dir = root / "bench_runs" / "interrupted"
            instance_dir = run_dir / "per_instance" / "one"
            instance_dir.mkdir(parents=True)
            (run_dir / "benchmark_config.json").write_text(
                json.dumps(
                    {
                        "profile": "local",
                        "agent": "qwen",
                        "repo": None,
                        "memory_enabled": False,
                        "qwen_model": "qwen-local",
                        "qwen_action_rescue": True,
                        "qwen_failure_critic": True,
                        "qwen_evidence_budget": 5,
                    }
                ),
                encoding="utf-8",
            )
            (run_dir / "selected_instances.jsonl").write_text(
                '{"instance_id":"one","repo":"local/repo","base_commit":"abc"}\n',
                encoding="utf-8",
            )
            (instance_dir / "run_summary.json").write_text(
                '{"instance_id":"one","status":"prompt_generated"}',
                encoding="utf-8",
            )
            (instance_dir / "session.json").write_text("{}", encoding="utf-8")
            (instance_dir / "qwen_events.jsonl").write_text(
                json.dumps(
                    {
                        "turn": 1,
                        "type": "assistant",
                        "message": {"content": None},
                        "reasoning_content": "unfinished",
                        "finish_reason": "length",
                        "requested_tool_choice": "auto",
                    }
                )
                + "\n"
                + json.dumps(
                    {"turn": 1, "type": "action_rescue", "checkpoint_chars": 10}
                )
                + "\n",
                encoding="utf-8",
            )

            harness = BenchmarkHarness(root)
            harness.audit_incomplete_run(run_dir, reason="simulated process exit")

            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            result = summary["results"][0]
            self.assertEqual(result["status"], "aborted_runtime")
            self.assertIsNone(result["local_test_passed"])
            self.assertIsNone(result["test_exit_code"])
            self.assertFalse(result["outcome_definitive"])
            self.assertTrue(summary["run_incomplete_recovered"])
            self.assertFalse(summary["official_evaluation_run"])
            prediction = json.loads(
                (run_dir / "predictions.jsonl").read_text(encoding="utf-8").strip()
            )
            self.assertEqual(
                prediction["model_name_or_path"],
                "baseline-qwen-action-rescue-failure-critic-evidence-5-local:qwen-local",
            )
            with self.assertRaisesRegex(BenchmarkError, "already has summary"):
                harness.audit_incomplete_run(run_dir, reason="second audit")

    def test_dry_run_no_memory_does_not_require_cards_database(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "bench_profiles.json").write_text(
                '{"local":{"type":"jsonl","path":"tasks.jsonl"}}\n',
                encoding="utf-8",
            )
            (root / "tasks.jsonl").write_text(
                '{"instance_id":"one","repo":"local/repo",'
                '"base_commit":"abc","problem_statement":"Fix it"}\n',
                encoding="utf-8",
            )
            harness = BenchmarkHarness(root)
            run_dir = harness.run_profile(
                "local",
                limit=1,
                ids=None,
                repo=None,
                dry_run=True,
                auto_send=True,
                cards_path=root / "missing-cards.jsonl",
                top_k=1,
                min_score=0,
                include_patch=False,
                use_memory=False,
                agent="qwen",
                qwen_action_rescue=True,
                qwen_failure_critic=True,
                qwen_evidence_budget=2,
            )

            config = json.loads((run_dir / "benchmark_config.json").read_text())
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertFalse(config["memory_enabled"])
            self.assertTrue(config["qwen_action_rescue"])
            self.assertTrue(config["qwen_failure_critic"])
            self.assertEqual(config["qwen_evidence_budget"], 2)
            self.assertFalse(summary["results"][0]["memory_enabled"])
            self.assertEqual(summary["results"][0]["memory_ids"], [])
            prediction = json.loads(
                (run_dir / "predictions.jsonl").read_text(encoding="utf-8").strip()
            )
            self.assertEqual(
                prediction["model_name_or_path"],
                "baseline-qwen-action-rescue-failure-critic-evidence-2-local:auto",
            )

    def test_real_prepared_run_requires_ten_task_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "config", "user.email", "eval@example.invalid"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Eval Harness"],
                cwd=repo,
                check=True,
            )
            (repo / "file.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True)
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            (root / "bench_profiles.json").write_text(
                '{"local":{"type":"jsonl","path":"tasks.jsonl"}}\n',
                encoding="utf-8",
            )
            (root / "tasks.jsonl").write_text(
                "{\"instance_id\":\"one\",\"repo\":\"local/repo\","
                f"\"base_commit\":\"{commit}\",\"problem_statement\":\"Fix it\"}}\n",
                encoding="utf-8",
            )
            harness = BenchmarkHarness(root)
            with self.assertRaisesRegex(BenchmarkError, "local-eval-summary"):
                harness.run_profile(
                    "local",
                    limit=1,
                    ids=None,
                    repo=repo,
                    dry_run=False,
                    auto_send=True,
                    cards_path=root / "missing.jsonl",
                    top_k=1,
                    min_score=0,
                    include_patch=False,
                )

    def test_prepared_qwen_run_exports_local_patch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "config", "user.email", "eval@example.invalid"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Eval Harness"],
                cwd=repo,
                check=True,
            )
            target = repo / "file.txt"
            target.write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True
            )
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            (root / "bench_profiles.json").write_text(
                '{"local":{"type":"jsonl","path":"tasks.jsonl"}}\n',
                encoding="utf-8",
            )
            (root / "tasks.jsonl").write_text(
                json.dumps(
                    {
                        "instance_id": "one",
                        "repo": "local/repo",
                        "base_commit": commit,
                        "problem_statement": "Fix the file",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            cards = root / "cards.jsonl"
            cards.write_text("", encoding="utf-8")
            local_summary = root / "local_summary.json"
            local_summary.write_text(
                json.dumps({"ten_task_local_eval_gate_met": True}), encoding="utf-8"
            )

            def fake_qwen(
                _repo: Path,
                _prompt: str,
                _run_dir: Path,
                **_kwargs: object,
            ) -> LocalQwenResult:
                target.write_text("changed\n", encoding="utf-8")
                return LocalQwenResult(
                    True,
                    0,
                    "completed",
                    "changed file",
                    2,
                    "qwen3.5-9b-local",
                )

            harness = BenchmarkHarness(root)
            test_command = (
                f'"{sys.executable}" -c "from pathlib import Path; '
                "raise SystemExit(0 if Path('file.txt').read_text() == 'changed\\n' else 1)\""
            )
            with patch.object(
                benchmark_harness, "run_local_qwen_agent", side_effect=fake_qwen
            ):
                run_dir = harness.run_profile(
                    "local",
                    limit=1,
                    ids=None,
                    repo=repo,
                    dry_run=False,
                    auto_send=True,
                    cards_path=cards,
                    top_k=1,
                    min_score=0,
                    include_patch=False,
                    local_eval_summary=local_summary,
                    agent="qwen",
                    qwen_model="qwen3.5-9b-local",
                    test_command=test_command,
                )

            prediction = json.loads(
                (run_dir / "predictions.jsonl").read_text(encoding="utf-8").strip()
            )
            self.assertEqual(
                prediction["model_name_or_path"], "cheater-qwen-local:qwen3.5-9b-local"
            )
            self.assertIn("+changed", prediction["model_patch"])
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["results"][0]["qwen_integration"], "loopback_tools")
            self.assertEqual(summary["results"][0]["preflight_test_exit_code"], 1)
            self.assertEqual(summary["results"][0]["test_exit_code"], 0)
            self.assertEqual(summary["results"][0]["status"], "solved_local_test")


class LocalQwenAdapterTests(unittest.TestCase):
    def test_agent_attempt_saves_pre_and_post_agent_diffs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            output = root / "run"
            repo.mkdir()
            target = repo / "module.py"
            target.write_text("value = 1\n", encoding="utf-8")
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "config", "user.email", "test@example.com"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Test"], cwd=repo, check=True
            )
            subprocess.run(["git", "add", "module.py"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "-m", "base"],
                cwd=repo,
                check=True,
                capture_output=True,
            )

            def fake_completion(*_args: object, **_kwargs: object) -> LocalQwenResult:
                target.write_text("value = 2\n", encoding="utf-8")
                return LocalQwenResult(True, 0, "completed", "done", 1, "local")

            with patch(
                "cheater.legacy.cheater_retry_controller.run_local_qwen_agent",
                side_effect=fake_completion,
            ):
                run_variant_agent(
                    EvalTask("diffs", str(repo), "Change value"),
                    "baseline_qwen",
                    output_dir=output,
                    qwen_model="local",
                )

            self.assertEqual(
                (output / "pre_agent_git_diff.patch").read_text(encoding="utf-8"),
                "",
            )
            self.assertIn("+value = 2", (output / "git_diff.patch").read_text(encoding="utf-8"))

    def test_non_loopback_endpoint_is_rejected(self) -> None:
        with self.assertRaises(LocalQwenError):
            validate_loopback_url("https://api.example.com/v1")

    def test_root_search_skips_linked_worktree_git_metadata_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            (repo / ".git").write_text("gitdir: elsewhere\n", encoding="utf-8")
            (repo / "module.py").write_text(
                "class TimestampSigner:\n    pass\n", encoding="utf-8"
            )
            tools = RepoTools(repo, run_dir)

            listed = tools.list_files(".", "*")
            searched = tools.search_text("TimestampSigner")

            self.assertNotIn(".git", listed["files"])
            self.assertEqual(
                searched["matches"], ["module.py:1:class TimestampSigner:"]
            )

    def test_qwen_auto_send_false_never_reaches_completion_loop(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            output = root / "run"
            repo.mkdir()
            task = EvalTask("prompt-only", str(repo), "Fix it", test_command="check")

            with (
                patch(
                    "cheater.legacy.cheater_retry_controller.discover_local_qwen",
                    return_value=("qwen3.5-9b-cheater", ["qwen3.5-9b-cheater"], ""),
                ),
                patch("cheater.legacy.cheater_retry_controller.run_local_qwen_agent") as completion,
            ):
                run = run_variant_agent(
                    task,
                    "baseline_qwen",
                    output_dir=output,
                    auto_send=False,
                )

            completion.assert_not_called()
            self.assertFalse(run.executed)
            self.assertEqual(run.status, "not_run_no_auto_send")
            self.assertTrue(run.available)

    def test_action_rescue_compacts_stall_and_reuses_safe_tools(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            target = repo / "module.py"
            target.write_text("value = 1\n", encoding="utf-8")
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            calls = 0
            rescue_payload: dict[str, object] | None = None

            def fake_request(
                url: str,
                *,
                payload: dict[str, object] | None = None,
                timeout: float,
            ) -> dict[str, object]:
                nonlocal calls, rescue_payload
                if url.endswith("/models"):
                    return {"data": [{"id": "qwen3.5-9b-cheater"}]}
                calls += 1
                if calls <= 3:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "reasoning_content": (
                                        "The exact safe edit is value = 1 to value = 2 in module.py."
                                    ),
                                    "tool_calls": [],
                                },
                                "finish_reason": "length",
                            }
                        ]
                    }
                if calls == 4:
                    rescue_payload = payload
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "edit-1",
                                            "type": "function",
                                            "function": {
                                                "name": "replace_text",
                                                "arguments": json.dumps(
                                                    {
                                                        "path": "module.py",
                                                        "old_text": "value = 1\n",
                                                        "new_text": "value = 2\n",
                                                        "expected_sha256": digest,
                                                    }
                                                ),
                                            },
                                        }
                                    ],
                                },
                                "finish_reason": "tool_calls",
                            }
                        ]
                    }
                if calls == 5:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "test-1",
                                            "type": "function",
                                            "function": {
                                                "name": "run_tests",
                                                "arguments": "{}",
                                            },
                                        }
                                    ],
                                },
                                "finish_reason": "tool_calls",
                            }
                        ]
                    }
                return {
                    "choices": [
                        {
                            "message": {"content": "Edited and tested.", "tool_calls": []},
                            "finish_reason": "stop",
                        }
                    ]
                }

            with patch.object(qwen_local_agent, "_request_json", side_effect=fake_request):
                result = run_local_qwen_agent(
                    repo,
                    "Fix module.py",
                    run_dir,
                    config=LocalQwenConfig(
                        model="qwen3.5-9b-cheater",
                        max_turns=8,
                        action_rescue=True,
                    ),
                    test_runner=lambda _path: (0, "ok"),
                )

            self.assertTrue(result.success)
            self.assertEqual(target.read_text(encoding="utf-8"), "value = 2\n")
            self.assertIsNotNone(rescue_payload)
            self.assertEqual(rescue_payload["tool_choice"], "required")
            self.assertIn("bounded action phase", str(rescue_payload["messages"]))
            rescue_tools = {
                tool["function"]["name"]  # type: ignore[index]
                for tool in rescue_payload["tools"]  # type: ignore[union-attr]
            }
            self.assertEqual(
                rescue_tools,
                {"replace_text", "write_file", "run_tests", "git_diff"},
            )
            events = (run_dir / "qwen_events.jsonl").read_text(encoding="utf-8")
            self.assertIn('"type": "action_rescue"', events)

    def test_repair_focus_requires_action_and_removes_broad_listing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            (repo / "module.py").write_text("value = 1\n", encoding="utf-8")
            calls = 0
            first_payload: dict[str, object] | None = None

            def fake_request(
                url: str,
                *,
                payload: dict[str, object] | None = None,
                timeout: float,
            ) -> dict[str, object]:
                nonlocal calls, first_payload
                if url.endswith("/models"):
                    return {"data": [{"id": "qwen3.5-9b-cheater"}]}
                calls += 1
                if calls == 1:
                    first_payload = payload
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "diff-1",
                                            "type": "function",
                                            "function": {
                                                "name": "git_diff",
                                                "arguments": "{}",
                                            },
                                        }
                                    ],
                                },
                                "finish_reason": "tool_calls",
                            }
                        ]
                    }
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "Inspected the existing patch truthfully.",
                                "tool_calls": [],
                            },
                            "finish_reason": "stop",
                        }
                    ]
                }

            with patch.object(qwen_local_agent, "_request_json", side_effect=fake_request):
                result = run_local_qwen_agent(
                    repo,
                    "Latest failure and current patch",
                    run_dir,
                    config=LocalQwenConfig(
                        model="qwen3.5-9b-cheater",
                        max_turns=3,
                        repair_focus=True,
                    ),
                    diff_reader=lambda: "diff --git a/module.py b/module.py",
                )

            self.assertTrue(result.success)
            self.assertIsNotNone(first_payload)
            assert first_payload is not None
            self.assertEqual(first_payload["tool_choice"], "required")
            self.assertIn("focused repair continuation", str(first_payload["messages"]))
            tool_names = {
                tool["function"]["name"]  # type: ignore[index]
                for tool in first_payload["tools"]  # type: ignore[union-attr]
            }
            self.assertNotIn("list_files", tool_names)
            self.assertIn("git_diff", tool_names)
            self.assertIn("replace_text", tool_names)

    def test_local_retry_focus_enables_bounded_action_rescue(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            output = root / "run"
            repo.mkdir()
            task = EvalTask("focused", str(repo), "Fix it", test_command="check")
            completion_result = LocalQwenResult(
                True,
                0,
                "completed",
                "done",
                1,
                "qwen3.5-9b-cheater",
            )

            with patch(
                "cheater.legacy.cheater_retry_controller.run_local_qwen_agent",
                return_value=completion_result,
            ) as completion:
                run_variant_agent(
                    task,
                    "cheater_qwen_retry",
                    output_dir=output,
                    qwen_model="qwen3.5-9b-cheater",
                    qwen_repair_focus=True,
                )

            config = completion.call_args.kwargs["config"]
            self.assertTrue(config.repair_focus)
            self.assertTrue(config.action_rescue)
            self.assertEqual(config.evidence_turn_budget, 2)

    def test_failure_critic_requires_evidence_before_second_edit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            target = repo / "module.py"
            target.write_text("value = 1\n", encoding="utf-8")
            first_digest = hashlib.sha256(target.read_bytes()).hexdigest()
            second_bytes = target.read_bytes().replace(b"1", b"2", 1)
            second_digest = hashlib.sha256(second_bytes).hexdigest()
            calls = 0
            critic_payload: dict[str, object] | None = None

            def fake_request(
                url: str,
                *,
                payload: dict[str, object] | None = None,
                timeout: float,
            ) -> dict[str, object]:
                nonlocal calls, critic_payload
                if url.endswith("/models"):
                    return {"data": [{"id": "qwen3.5-9b-cheater"}]}
                calls += 1
                tool_name = ""
                arguments: dict[str, object] = {}
                if calls == 1:
                    tool_name = "replace_text"
                    arguments = {
                        "path": "module.py",
                        "old_text": "value = 1\n",
                        "new_text": "value = 2\n",
                        "expected_sha256": first_digest,
                    }
                elif calls == 2:
                    tool_name = "run_tests"
                elif calls == 3:
                    critic_payload = payload
                    tool_name = "git_diff"
                elif calls == 4:
                    tool_name = "replace_text"
                    arguments = {
                        "path": "module.py",
                        "old_text": "value = 2\n",
                        "new_text": "value = 3\n",
                        "expected_sha256": second_digest,
                    }
                elif calls == 5:
                    tool_name = "run_tests"
                else:
                    return {
                        "choices": [
                            {
                                "message": {"content": "Second edit passed.", "tool_calls": []},
                                "finish_reason": "stop",
                            }
                        ]
                    }
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": f"tool-{calls}",
                                        "type": "function",
                                        "function": {
                                            "name": tool_name,
                                            "arguments": json.dumps(arguments),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                }

            def test_runner(_path: Path) -> tuple[int, str]:
                solved = target.read_text(encoding="utf-8") == "value = 3\n"
                return (0, "passed") if solved else (1, "same failure")

            with patch.object(qwen_local_agent, "_request_json", side_effect=fake_request):
                result = run_local_qwen_agent(
                    repo,
                    "Fix module.py",
                    run_dir,
                    config=LocalQwenConfig(
                        model="qwen3.5-9b-cheater",
                        max_turns=8,
                        action_rescue=True,
                        failure_critic=True,
                    ),
                    test_runner=test_runner,
                    diff_reader=lambda: "diff --git a/module.py b/module.py\n",
                    initial_failure_output="same failure",
                )

            self.assertTrue(result.success)
            events = (run_dir / "qwen_events.jsonl").read_text(encoding="utf-8")
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                "value = 3\n",
                events,
            )
            self.assertIsNotNone(critic_payload)
            critic_tools = {
                tool["function"]["name"] for tool in critic_payload["tools"]
            }
            self.assertEqual(critic_tools, {"read_file", "search_text", "git_diff"})
            self.assertEqual(critic_payload["tool_choice"], "required")
            self.assertIn('"type": "failure_critic"', events)
            self.assertIn('"failure_unchanged": true', events)

    def test_evidence_budget_triggers_compact_action_phase(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            target = repo / "module.py"
            target.write_text("value = 1\n", encoding="utf-8")
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            calls = 0
            rescue_payload: dict[str, object] | None = None

            def fake_request(
                url: str,
                *,
                payload: dict[str, object] | None = None,
                timeout: float,
            ) -> dict[str, object]:
                nonlocal calls, rescue_payload
                if url.endswith("/models"):
                    return {"data": [{"id": "qwen3.5-9b-cheater"}]}
                calls += 1
                if calls == 1:
                    tool_name = "search_text"
                    arguments = {"pattern": "value", "path": ".", "glob": "*.py"}
                elif calls == 2:
                    tool_name = "read_file"
                    arguments = {"path": "module.py"}
                elif calls == 3:
                    rescue_payload = payload
                    tool_name = "replace_text"
                    arguments = {
                        "path": "module.py",
                        "old_text": "value = 1\n",
                        "new_text": "value = 2\n",
                        "expected_sha256": digest,
                    }
                elif calls == 4:
                    tool_name = "run_tests"
                    arguments = {}
                else:
                    return {
                        "choices": [
                            {
                                "message": {"content": "Edited and tested.", "tool_calls": []},
                                "finish_reason": "stop",
                            }
                        ]
                    }
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "reasoning_content": "The source value is in module.py.",
                                "tool_calls": [
                                    {
                                        "id": f"tool-{calls}",
                                        "type": "function",
                                        "function": {
                                            "name": tool_name,
                                            "arguments": json.dumps(arguments),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                }

            def test_runner(_path: Path) -> tuple[int, str]:
                solved = target.read_text(encoding="utf-8") == "value = 2\n"
                return (0, "passed") if solved else (1, "failed")

            with patch.object(qwen_local_agent, "_request_json", side_effect=fake_request):
                result = run_local_qwen_agent(
                    repo,
                    "Fix module.py",
                    run_dir,
                    config=LocalQwenConfig(
                        model="qwen3.5-9b-cheater",
                        max_turns=6,
                        action_rescue=True,
                        evidence_turn_budget=2,
                    ),
                    test_runner=test_runner,
                )

            self.assertTrue(result.success)
            self.assertEqual(target.read_text(encoding="utf-8"), "value = 2\n")
            self.assertIsNotNone(rescue_payload)
            self.assertEqual(rescue_payload["tool_choice"], "required")
            self.assertIn("2 consecutive turns", str(rescue_payload["messages"]))
            events = (run_dir / "qwen_events.jsonl").read_text(encoding="utf-8")
            self.assertIn('"type": "action_rescue"', events)
            self.assertIn("read/search/diff tools", events)

    def test_repo_tools_require_fresh_hash_and_block_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            run_dir.mkdir()
            target = repo / "module.py"
            target.write_text("value = 1\n", encoding="utf-8")
            tools = RepoTools(repo, run_dir)
            read = tools.read_file("module.py")
            self.assertEqual(read["content"], "value = 1")
            self.assertIn("module.py", tools.list_files(glob="**/*.py")["files"])
            stale = tools.execute(
                "write_file",
                {"path": "module.py", "content": "value = 2\n", "expected_sha256": "bad"},
            )
            self.assertFalse(stale["ok"])
            written = tools.execute(
                "write_file",
                {
                    "path": "module.py",
                    "content": "value = 2\n",
                    "expected_sha256": read["sha256"],
                },
            )
            self.assertTrue(written["ok"])
            self.assertEqual(target.read_text(encoding="utf-8"), "value = 2\n")
            current = tools.read_file("module.py")
            stale_replace = tools.execute(
                "replace_text",
                {
                    "path": "module.py",
                    "old_text": "value = 2",
                    "new_text": "value = 3",
                    "expected_sha256": "bad",
                },
            )
            self.assertFalse(stale_replace["ok"])
            replaced = tools.execute(
                "replace_text",
                {
                    "path": "module.py",
                    "old_text": "value = 2",
                    "new_text": "value = 3",
                    "expected_sha256": current["sha256"],
                },
            )
            self.assertTrue(replaced["ok"])
            self.assertEqual(target.read_text(encoding="utf-8"), "value = 3\n")
            target.write_bytes(b"first = 1\r\nsecond = 2\r\n")
            crlf_read = tools.read_file("module.py")
            crlf_replace = tools.execute(
                "replace_text",
                {
                    "path": "module.py",
                    "old_text": "first = 1\nsecond = 2",
                    "new_text": "first = 1\nsecond = 3",
                    "expected_sha256": crlf_read["sha256"],
                },
            )
            self.assertTrue(crlf_replace["ok"])
            self.assertEqual(target.read_bytes(), b"first = 1\r\nsecond = 3\r\n")
            escaped = tools.execute("read_file", {"path": "../outside.txt"})
            self.assertFalse(escaped["ok"])

    def test_local_qwen_tool_loop_can_read_and_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            target = repo / "module.py"
            target.write_text("value = 1\n", encoding="utf-8")
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            chat_turn = 0

            def fake_request(
                url: str,
                *,
                payload: dict[str, object] | None = None,
                timeout: float,
            ) -> dict[str, object]:
                nonlocal chat_turn
                if url.endswith("/models"):
                    return {"data": [{"id": "qwen3.5-9b-cheater"}]}
                chat_turn += 1
                if chat_turn == 1:
                    message = {
                        "content": "I will inspect the file.",
                        "tool_calls": [
                            {
                                "id": "read-1",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"module.py"}',
                                },
                            }
                        ],
                    }
                elif chat_turn == 2:
                    message = {
                        "content": "Applying the fix.",
                        "tool_calls": [
                            {
                                "id": "write-1",
                                "type": "function",
                                "function": {
                                    "name": "write_file",
                                    "arguments": json.dumps(
                                        {
                                            "path": "module.py",
                                            "content": "value = 2\n",
                                            "expected_sha256": digest,
                                        }
                                    ),
                                },
                            }
                        ],
                    }
                else:
                    message = {"content": "Updated module.py.", "tool_calls": []}
                return {"choices": [{"message": message}]}

            with patch.object(qwen_local_agent, "_request_json", side_effect=fake_request):
                result = run_local_qwen_agent(
                    repo,
                    "Fix module.py",
                    run_dir,
                    config=LocalQwenConfig(model="qwen3.5-9b-cheater", max_turns=5),
                )

            self.assertTrue(result.success)
            self.assertEqual(result.status, "completed")
            self.assertEqual(target.read_text(encoding="utf-8"), "value = 2\n")
            self.assertTrue((run_dir / "qwen_events.jsonl").is_file())

    def test_reasoning_only_turn_is_not_treated_as_completion(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            calls = 0
            requested_tool_choices: list[object] = []
            request_payloads: list[dict[str, object]] = []

            def fake_request(
                url: str,
                *,
                payload: dict[str, object] | None = None,
                timeout: float,
            ) -> dict[str, object]:
                nonlocal calls
                if url.endswith("/models"):
                    return {"data": [{"id": "qwen3.5-9b-cheater"}]}
                request_payloads.append(payload or {})
                requested_tool_choices.append((payload or {}).get("tool_choice"))
                calls += 1
                if calls == 1:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "reasoning_content": "I should continue with a tool.",
                                    "tool_calls": [],
                                },
                                "finish_reason": "stop",
                            }
                        ]
                    }
                return {
                    "choices": [
                        {
                            "message": {"content": "Finished truthfully.", "tool_calls": []},
                            "finish_reason": "stop",
                        }
                    ]
                }

            with patch.object(qwen_local_agent, "_request_json", side_effect=fake_request):
                result = run_local_qwen_agent(
                    repo,
                    "Inspect the task",
                    run_dir,
                    config=LocalQwenConfig(model="qwen3.5-9b-cheater", max_turns=3),
                )

            self.assertTrue(result.success)
            self.assertEqual(calls, 2)
            self.assertEqual(requested_tool_choices, ["auto", "required"])
            second_messages = request_payloads[1]["messages"]
            self.assertIn("Analysis checkpoint", str(second_messages))
            self.assertIn("I should continue with a tool.", str(second_messages))
            events = (run_dir / "qwen_events.jsonl").read_text(encoding="utf-8")
            self.assertIn("I should continue with a tool.", events)

    def test_length_truncated_visible_answer_is_not_completion(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            run_dir = root / "run"
            repo.mkdir()
            calls = 0
            requested_tool_choices: list[object] = []

            def fake_request(
                url: str,
                *,
                payload: dict[str, object] | None = None,
                timeout: float,
            ) -> dict[str, object]:
                nonlocal calls
                if url.endswith("/models"):
                    return {"data": [{"id": "qwen3.5-9b-cheater"}]}
                requested_tool_choices.append((payload or {}).get("tool_choice"))
                calls += 1
                if calls == 1:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "Partial answer that must not count as done.",
                                    "tool_calls": [],
                                },
                                "finish_reason": "length",
                            }
                        ]
                    }
                return {
                    "choices": [
                        {
                            "message": {"content": "Finished truthfully.", "tool_calls": []},
                            "finish_reason": "stop",
                        }
                    ]
                }

            with patch.object(qwen_local_agent, "_request_json", side_effect=fake_request):
                result = run_local_qwen_agent(
                    repo,
                    "Inspect the task",
                    run_dir,
                    config=LocalQwenConfig(model="qwen3.5-9b-cheater", max_turns=3),
                )

            self.assertTrue(result.success)
            self.assertEqual(calls, 2)
            self.assertEqual(requested_tool_choices, ["auto", "required"])


class LocalTaskValidationTests(unittest.TestCase):
    def test_clean_git_task_with_failing_test_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "config", "user.email", "eval@example.invalid"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Eval Harness"],
                cwd=repo,
                check=True,
            )
            (repo / "module.py").write_text("value = 1\n", encoding="utf-8")
            subprocess.run(["git", "add", "module.py"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "-m", "base"],
                cwd=repo,
                check=True,
                capture_output=True,
            )
            command = f'"{sys.executable}" -c "raise SystemExit(1)"'
            task = EvalTask(
                "failing-task",
                str(repo),
                "Fix it",
                error="expected failure",
                test_command=command,
                expected_files=["module.py"],
                notes="test fixture",
            )
            result = validate_task(
                task,
                root / "validation",
                dry_run=False,
                test_timeout=10,
            )
            self.assertTrue(result["valid"])
            self.assertEqual(result["status"], "confirmed_failing")


if __name__ == "__main__":
    unittest.main()
