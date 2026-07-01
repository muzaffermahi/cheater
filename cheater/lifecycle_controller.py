"""Lifecycle controller for the Cheater agent loop.

The controller is a thin glue layer between the agent loop and the
new lifecycle machinery. It:

  * wraps the existing runner so every command is classified and
    recorded in the registry, with no real process management.
  * owns a single ProcessRegistry, a single Watchdog, and a single
    CompletionLedger per run.
  * exposes ``wrap_runner`` so the existing ToolContext can be set
    up without changes to the existing runner.

Public API:

  LifecycleController(...)       -- construct one per AgentLoop
  controller.wrap_runner(runner) -- the runner to inject into ToolContext
  controller.feed_tool_result    -- the loop calls this with every ToolResult
  controller.feed_finish_attempt -- the loop calls this when the model asks to finish
  controller.feed_idk            -- the loop calls this when the model gives up
  controller.score               -- the final RobustnessReport
  controller.ledger              -- the CompletionLedger
  controller.watchdog            -- the Watchdog
  controller.registry            -- the ProcessRegistry
  controller.playbook            -- the selected Playbook
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from cheater.ledger import CompletionLedger, ledger_allows_finish
from cheater.lifecycle import (
    OwnedCommand,
    ProcessRegistry,
    ProcessStatus,
    classify_command,
    new_id,
    workspace_signature,
)
from cheater.one_shot_score import RobustnessReport, score_run
from cheater.playbooks import (
    Playbook,
    select_playbook,
    worker_brief_for,
)
from cheater.stuck import Watchdog, WatchdogConfig
from cheater.verification import (
    RunOutcome,
    StageResult,
    VerificationMachine,
    VerificationStage,
    VerificationStatus,
    make_collect_artifacts_handler,
    make_stop_services_handler,
    make_summarize_handler,
)


# ---------- controller ----------


@dataclass
class LifecycleController:
    """Owns the registry, watchdog, ledger, and playbook for one run.

    The controller does not start real processes. It tracks
    classifications, events, and verification outcomes, and surfaces
    a final report. The actual command execution is delegated to
    the runner the loop already uses; the controller only records
    what happened.
    """

    repo_root: str
    task: str
    playbook: Playbook
    registry: ProcessRegistry = field(default_factory=ProcessRegistry)
    watchdog: Watchdog = field(default_factory=Watchdog)
    ledger: CompletionLedger = field(
        default_factory=lambda: CompletionLedger(user_goal="")
    )
    worker_steps: int = 0
    worker_max_steps: int = 0
    # Optional probe: when a verification plan needs to know what
    # workspace the running server is serving, this is the callback.
    served_workspace_probe: Callable[[], str | None] | None = None
    # Optional override of the watchdog config (tests use this).
    watchdog_config: WatchdogConfig | None = None
    # Optional injection: a runner-shaped function that returns a
    # RunOutcome instead of a CommandResult. When None, the controller
    # cannot actually run verification stages; it will mark them
    # skipped unless an external machine is provided.
    verification_runner: Callable[..., RunOutcome] | None = None
    # Optional pre-computed verification results. When set, the
    # controller uses these as the verification record and skips
    # running its own machine. Tests use this.
    verification_results: list[StageResult] | None = None
    # v0.9: anti-stall controller. When provided, the lifecycle
    # controller forwards step observations to the anti-stall
    # controller and uses its banned-action set to gate certain
    # operations. The lifecycle controller does NOT create the
    # anti-stall controller; the caller does (via for_task_with_anti_stall
    # or by setting this field directly).
    anti_stall: Any | None = None
    # Last N command kinds observed (for watchdog heuristics).
    workspace_sig: str = ""

    def __post_init__(self) -> None:
        if not self.ledger.user_goal:
            self.ledger = CompletionLedger(user_goal=self.task)
        else:
            self.ledger.user_goal = self.ledger.user_goal or self.task
        self.workspace_sig = workspace_signature(self.repo_root)
        self.ledger.set_plan(
            self.playbook, self.playbook.title and [self.playbook.title] or []
        )
        self.ledger.playbook = self.playbook.kind
        self.ledger.add_entry(
            "playbook_selected",
            summary=self.playbook.title,
            playbook_kind=self.playbook.kind.value,
        )
        if self.watchdog_config is not None:
            self.watchdog = Watchdog(self.registry, self.watchdog_config)
        else:
            self.watchdog = Watchdog(self.registry)
        self.watchdog.expect_scoring(bool(self.playbook.expect_scoring))
        # Pre-populated verification results are part of the run from
        # the start. Recording them now lets the ledger allow a finish
        # before run_verification() is explicitly called.
        if self.verification_results is not None:
            self.ledger.record_verification(self.verification_results)

    # ---- factory ----

    @classmethod
    def for_task(
        cls,
        task: str,
        repo_root: str,
        *,
        playbook: Playbook | None = None,
        watchdog_config: WatchdogConfig | None = None,
        verification_runner: Callable[..., RunOutcome] | None = None,
        served_workspace_probe: Callable[[], str | None] | None = None,
        verification_results: list[StageResult] | None = None,
    ) -> "LifecycleController":
        chosen = playbook or select_playbook(task)
        return cls(
            repo_root=repo_root,
            task=task,
            playbook=chosen,
            watchdog_config=watchdog_config,
            verification_runner=verification_runner,
            served_workspace_probe=served_workspace_probe,
            verification_results=verification_results,
        )

    @classmethod
    def for_task_with_anti_stall(
        cls,
        task: str,
        repo_root: str,
        *,
        playbook: Playbook | None = None,
        watchdog_config: WatchdogConfig | None = None,
        verification_runner: Callable[..., RunOutcome] | None = None,
        served_workspace_probe: Callable[[], str | None] | None = None,
        verification_results: list[StageResult] | None = None,
    ) -> "LifecycleController":
        """Create a LifecycleController pre-wired with an AntiStallController.

        The lifecycle controller and anti-stall controller share the
        same ledger, watchdog, and playbook. The agent loop only
        needs to talk to the lifecycle controller; the anti-stall
        controller is invoked from the lifecycle hooks.
        """
        lc = cls.for_task(
            task=task,
            repo_root=repo_root,
            playbook=playbook,
            watchdog_config=watchdog_config,
            verification_runner=verification_runner,
            served_workspace_probe=served_workspace_probe,
            verification_results=verification_results,
        )
        # Lazy import to avoid pulling anti_stall_controller at module
        # import time (we want lifecycle_controller to be cheap to
        # import).
        from cheater.anti_stall_controller import AntiStallController
        lc.anti_stall = AntiStallController.for_task(
            user_goal=task,
            playbook=lc.playbook,
            ledger=lc.ledger,
            watchdog=lc.watchdog,
        )
        return lc

    # ---- runner wrapping ----

    def wrap_runner(self, runner: Callable[..., Any]) -> Callable[..., Any]:
        """Wrap the existing runner so every command is classified.

        The wrapped runner has the same signature as the original.
        The original is expected to return a CommandResult-like
        object with .cmd, .returncode, .stdout, .stderr, .elapsed,
        .timed_out, .error. The wrapper records the command in the
        registry, feeds the watchdog, and returns the result
        unchanged.
        """
        registry = self.registry
        watchdog = self.watchdog
        ledger = self.ledger

        def wrapped(cmd, *, cwd=None, timeout=None, **kwargs):
            cmd_str = cmd if isinstance(cmd, str) else " ".join(cmd or [])
            kind = classify_command(cmd_str)
            cmd_id = new_id("cmd")
            started = time.time()
            oc = OwnedCommand(
                cmd_id=cmd_id,
                cmd=cmd_str,
                kind=kind,
                cwd=str(cwd or self.repo_root),
                started_at=started,
                workspace_sig=self.workspace_sig,
            )
            registry.record_command(oc)
            watchdog.observe(
                {
                    "kind": "command_started",
                    "cmd": cmd_str,
                    "cmd_kind": kind.value,
                    "cmd_id": cmd_id,
                    "started_at": started,
                }
            )
            ledger.record_command(cmd_str)
            try:
                result = runner(cmd, cwd=cwd, timeout=timeout, **kwargs)
            except Exception:  # pragma: no cover -- defensive
                oc.status = ProcessStatus.FAILED
                oc.finished_at = time.time()
                oc.elapsed = oc.finished_at - oc.started_at
                watchdog.observe(
                    {
                        "kind": "command_finished",
                        "cmd": cmd_str,
                        "cmd_kind": kind.value,
                        "cmd_id": cmd_id,
                        "started_at": started,
                        "finished_at": oc.finished_at,
                        "exit_code": -1,
                        "timed_out": False,
                        "elapsed": oc.elapsed,
                    }
                )
                raise
            oc.finished_at = time.time()
            oc.elapsed = oc.elapsed or (oc.finished_at - oc.started_at)
            oc.exit_code = int(getattr(result, "returncode", 0) or 0)
            oc.timed_out = bool(getattr(result, "timed_out", False))
            oc.stdout = str(getattr(result, "stdout", "") or "")
            oc.stderr = str(getattr(result, "stderr", "") or "")
            if oc.timed_out:
                oc.status = ProcessStatus.TIMED_OUT
            elif oc.exit_code == 0:
                oc.status = ProcessStatus.SUCCEEDED
            else:
                oc.status = ProcessStatus.FAILED
            watchdog.observe(
                {
                    "kind": "command_finished",
                    "cmd": cmd_str,
                    "cmd_kind": kind.value,
                    "cmd_id": cmd_id,
                    "started_at": started,
                    "finished_at": oc.finished_at,
                    "exit_code": oc.exit_code,
                    "timed_out": oc.timed_out,
                    "elapsed": oc.elapsed,
                }
            )
            return result

        return wrapped

    # ---- loop integration ----

    def feed_tool_result(self, action: str, args: dict, result: Any) -> None:
        """Feed a tool result into the controller.

        The agent loop calls this once per step. We use it to
        update the watchdog, record file changes, and bump the
        step counter.
        """
        self.worker_steps += 1
        self.watchdog.observe(
            {
                "kind": "action",
                "action": action,
                "args": args or {},
                "success": bool(getattr(result, "success", True)),
                "summary": str(getattr(result, "summary", "") or ""),
            }
        )
        files_written = list(getattr(result, "files_written", []) or [])
        for f in files_written:
            self.ledger.record_file_change(f)
        commands_run = list(getattr(result, "commands_run", []) or [])
        for c in commands_run:
            # The wrap_runner already records commands; this is a
            # safety net for tools that run commands without going
            # through the wrapped runner.
            self.ledger.record_command(c)
        # v0.9: forward to the anti-stall controller if present.
        # We don't want to crash the loop if anti-stall is broken,
        # so the forward is best-effort.
        if self.anti_stall is not None:
            try:
                self.anti_stall.observe_step(
                    action=action,
                    args=args or {},
                    success=bool(getattr(result, "success", True)),
                    summary=str(getattr(result, "summary", "") or ""),
                    files_read=list(getattr(result, "files_read", []) or []),
                    files_changed=files_written,
                    commands_run=commands_run,
                    stdout=str(getattr(result, "output", "") or ""),
                    stderr=str(getattr(result, "error", "") or ""),
                )
            except Exception:
                pass

    def is_action_allowed(self, action: str, args: dict | None = None) -> tuple[bool, str]:
        """Should the loop dispatch this action right now?

        If an anti-stall controller is attached, it is the source
        of truth for banned actions. Otherwise, the answer is
        always yes.
        """
        if self.anti_stall is not None:
            return self.anti_stall.is_action_allowed(action, args)
        return True, ""

    def on_stall(self) -> Any:
        """Trigger an anti-stall assessment; return a RecoveryAction or None."""
        if self.anti_stall is None:
            return None
        return self.anti_stall.on_stall()

    def feed_finish_attempt(self, summary: str) -> tuple[bool, str]:
        """Feed a finish attempt; return (allowed, reason).

        The controller is the single source of truth for "is the
        ledger in a state that allows the loop to claim done?".
        """
        self.watchdog.observe(
            {
                "kind": "finish_attempt",
                "summary": summary or "",
            }
        )
        self.watchdog.reset_finish_tracker()
        # v0.9: anti-stall controller also gates finish. If the
        # controller is in a blocked state, finish is rejected
        # even if the ledger is otherwise fine.
        if self.anti_stall is not None:
            try:
                allowed_anti, reason_anti = self.anti_stall.is_finish_allowed()
                if not allowed_anti:
                    return False, reason_anti
                # Bump the anti-stall controller's finish-attempt
                # counter so the detector can fire REPEATED_FINISH.
                self.anti_stall.note_finish_attempt()
            except Exception:
                pass
        return ledger_allows_finish(self.ledger)

    def feed_idk(self, reason: str) -> None:
        self.watchdog.observe({"kind": "i_dont_know", "summary": reason or ""})
        self.ledger.add_entry("idk", summary=reason or "")
        # v0.9: forward to the anti-stall controller.
        if self.anti_stall is not None:
            try:
                self.anti_stall.observe_step(
                    action="i_dont_know",
                    args={"reason": reason or ""},
                    success=False,
                    summary=reason or "",
                )
            except Exception:
                pass

    def feed_ask_user(self, question: str) -> None:
        self.watchdog.observe({"kind": "ask_user", "summary": question or ""})

    # ---- verification ----

    def run_verification(
        self,
        *,
        runner: Callable[..., Any] | None = None,
        next_cmd_for_stage: dict[VerificationStage, str] | None = None,
    ) -> list[StageResult]:
        """Run the playbook's verification plan to completion.

        When ``verification_results`` was provided, returns that
        list unchanged. Otherwise builds a small machine and runs
        it with injected handlers. The default handlers wrap the
        provided ``runner`` (a CommandResult-returning function)
        into the RunOutcome shape the verification machine expects.
        """
        if self.verification_results is not None:
            self.ledger.record_verification(self.verification_results)
            return self.verification_results
        # Build a verification machine that uses the wrapped runner.
        actual_runner = runner or self.verification_runner
        handlers = _build_handlers(
            actual_runner,
            self.registry,
            next_cmd_for_stage or {},
            served_probe=self.served_workspace_probe,
            expected_workspace_sig=self.workspace_sig,
        )
        machine = VerificationMachine(
            self.playbook.plan,
            handlers,
            _build_context(
                repo_root=self.repo_root,
                workspace_sig=self.workspace_sig,
                registry=self.registry,
                served_probe=self.served_workspace_probe,
            ),
        )
        results = machine.run()
        self.ledger.record_verification(results)
        return results

    # ---- finalisation ----

    def finalize(
        self, *, success: bool, reason: str, confidence: str = "medium"
    ) -> None:
        # Make sure any owned services are accounted for.
        self.registry.stop_all_running()
        # Make sure the ledger knows whether verification passed.
        if not self.ledger.verification:
            self.ledger.add_entry(
                "verification_skipped",
                summary="verification was not run for this run",
            )
        self.ledger.finalize(done=bool(success), reason=reason, confidence=confidence)

    def score(self) -> RobustnessReport:
        return score_run(
            self.ledger,
            registry=self.registry,
            watchdog=self.watchdog,
            worker_steps=self.worker_steps,
            worker_max_steps=self.worker_max_steps,
            anti_stall=(self.anti_stall.outcome() if self.anti_stall is not None else None),
        )

    def anti_stall_outcome(self) -> Any:
        """Return the anti-stall controller's final outcome, or None."""
        if self.anti_stall is None:
            return None
        return self.anti_stall.outcome()

    # ---- worker brief for the model ----

    def worker_brief(self) -> str:
        return worker_brief_for(self.playbook)


# ---------- helpers ----------


def _build_context(
    *,
    repo_root: str,
    workspace_sig: str,
    registry: ProcessRegistry,
    served_probe: Callable[[], str | None] | None,
) -> Any:
    from cheater.verification import VerificationContext

    return VerificationContext(
        repo_root=repo_root,
        workspace_sig=workspace_sig,
        registry=registry,
        served_workspace_probe=served_probe,
    )


def _build_handlers(
    runner: Callable[..., Any] | None,
    registry: ProcessRegistry,
    next_cmd_for_stage: dict[VerificationStage, str],
    *,
    served_probe: Callable[[], str | None] | None,
    expected_workspace_sig: str,
) -> dict[VerificationStage, Any]:
    """Build the default handler set for a verification machine.

    The smoke / focused_tests / full_tests / scoring stages all use
    a runner-shaped callback. If no runner is available they are
    marked SKIPPED, which is fine for short-running tasks that do
    not need the harness to drive verification.
    """
    from cheater.verification import (
        VerificationContext,
        VerificationStage,
    )

    handlers: dict[VerificationStage, Any] = {}

    def identity_handler(ctx: VerificationContext, spec: Any) -> StageResult:
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        served = ctx.served_workspace_probe() if ctx.served_workspace_probe else None
        from cheater.verification import workspace_identity_check

        ok, mismatch = workspace_identity_check(served, ctx.workspace_sig)
        result.signals["served_signature"] = served
        result.signals["expected_signature"] = ctx.workspace_sig
        if mismatch is not None:
            ctx.mismatches.append(mismatch)
            result.status = VerificationStatus.FAILED
            result.summary = mismatch.evidence
            from cheater.lifecycle import FailureClass

            result.failure_class = FailureClass.STALE_WORKSPACE
        elif served is None:
            result.status = VerificationStatus.SKIPPED
            result.summary = "no served-workspace probe was available"
        else:
            result.status = VerificationStatus.OK
            result.summary = "served workspace matches current workspace"
        result.finished_at = time.time()
        return result

    def runnable_handler(ctx: VerificationContext, spec: Any) -> StageResult:
        if runner is None:
            result = StageResult(stage=spec.stage)
            result.status = VerificationStatus.SKIPPED
            result.summary = "no verification runner available"
            return result
        cmd = next_cmd_for_stage.get(spec.stage)
        if not cmd:
            result = StageResult(stage=spec.stage)
            result.status = VerificationStatus.SKIPPED
            result.summary = f"no command wired for {spec.stage.value}"
            return result
        # Translate the runner's return value (CommandResult) into a RunOutcome.
        raw = runner(cmd, cwd=ctx.repo_root, timeout=spec.timeout)
        outcome = RunOutcome(
            cmd=cmd,
            returncode=int(getattr(raw, "returncode", 0) or 0),
            stdout=str(getattr(raw, "stdout", "") or ""),
            stderr=str(getattr(raw, "stderr", "") or ""),
            elapsed=float(getattr(raw, "elapsed", 0.0) or 0.0),
            timed_out=bool(getattr(raw, "timed_out", False)),
        )
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        if outcome.timed_out:
            result.status = VerificationStatus.TIMED_OUT
            result.summary = f"timed out after {spec.timeout:.0f}s"
            from cheater.lifecycle import FailureClass

            result.failure_class = FailureClass.SERVER_RUNTIME
        elif outcome.ok:
            result.status = VerificationStatus.OK
            result.summary = f"exit=0 in {outcome.elapsed:.1f}s"
        else:
            from cheater.lifecycle import classify_failure, FailureClass

            result.status = VerificationStatus.FAILED
            result.failure_class = classify_failure(
                exit_code=outcome.returncode,
                stdout=outcome.stdout,
                stderr=outcome.stderr,
                timed_out=False,
            )
            result.summary = f"exit={outcome.returncode}; {result.failure_class.value}"
        result.finished_at = time.time()
        return result

    handlers[VerificationStage.WORKSPACE_IDENTITY] = identity_handler
    for stage in (
        VerificationStage.SMOKE,
        VerificationStage.FOCUSED_TESTS,
        VerificationStage.FULL_TESTS,
        VerificationStage.SCORING,
        VerificationStage.PREPARE_ENV,
    ):
        handlers[stage] = runnable_handler
    handlers[VerificationStage.STOP_SERVICES] = make_stop_services_handler()
    handlers[VerificationStage.COLLECT_ARTIFACTS] = make_collect_artifacts_handler()
    handlers[VerificationStage.SUMMARIZE] = make_summarize_handler()
    return handlers
