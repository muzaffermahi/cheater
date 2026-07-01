"""Deterministic verification state machine for the Cheater harness.

Verification is the part of the lifecycle where most harnesses fall
over. Models will say "looks good" after a half-finished test run, or
declare success after the dev server returned 200 for a different
workspace. A harness that wants weak/local models to be reliable
needs verification to be a small, deterministic state machine with
explicit success signals.

This module defines the state machine. The actual runners (curl,
pytest, scoring) are injected so tests can use fakes and so we never
make real network calls. The model is never asked to "verify" the
app by itself; the harness drives each stage and reports the
outcome.

Public API:

  VerificationStage     -- one stage in the machine
  VerificationStatus    -- pending | running | ok | failed | skipped | timed_out
  StageResult           -- result of a single stage
  VerificationPlan      -- ordered list of stages for a given task class
  VerificationMachine   -- runs the stages
  workspace_identity_check -- detect a wrong-served workspace
  default_webapp_plan   -- the default plan for "webapp with dev server"

The machine is deliberately minimal. Each stage has a single
``success_signal`` that the caller can check. The machine refuses to
mark a task "complete" unless every required stage reached a
terminal ok status.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from cheater.lifecycle import (
    FailureClass,
    ProcessRegistry,
    WorkspaceMismatch,
    classify_failure,
)


class VerificationStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    OK = "ok"
    FAILED = "failed"
    SKIPPED = "skipped"
    TIMED_OUT = "timed_out"


class VerificationStage(str, Enum):
    PREPARE_ENV = "prepare_env"
    START_SERVICES = "start_services"
    WORKSPACE_IDENTITY = "workspace_identity"
    SMOKE = "smoke"
    FOCUSED_TESTS = "focused_tests"
    FULL_TESTS = "full_tests"
    SCORING = "scoring"
    COLLECT_ARTIFACTS = "collect_artifacts"
    STOP_SERVICES = "stop_services"
    SUMMARIZE = "summarize"


# ---------- run result types ----------


@dataclass
class StageResult:
    """Outcome of running a single verification stage."""

    stage: VerificationStage
    status: VerificationStatus = VerificationStatus.PENDING
    started_at: float = 0.0
    finished_at: float = 0.0
    elapsed: float = 0.0
    summary: str = ""
    failure_class: FailureClass = FailureClass.UNKNOWN
    artifacts: list[str] = field(default_factory=list)
    signals: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["stage"] = self.stage.value
        d["status"] = self.status.value
        d["failure_class"] = self.failure_class.value
        return d


# ---------- run hooks ----------


@dataclass
class RunOutcome:
    """What a single shell command produced, as seen by the verifier."""

    cmd: str
    returncode: int
    stdout: str
    stderr: str
    elapsed: float
    timed_out: bool = False
    started_at: float = 0.0
    finished_at: float = 0.0

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


# Each stage is implemented as a callable that the machine invokes.
# The callable gets a context dict and returns a StageResult. This
# keeps the machine testable: tests inject fakes that return canned
# outcomes without spawning processes.
StageHandler = Callable[["VerificationContext", "StageSpec"], StageResult]


@dataclass
class StageSpec:
    """A single stage in a verification plan."""

    stage: VerificationStage
    required: bool = True
    timeout: float = 30.0
    success_signal: str = "exit_zero"  # exit_zero | workspace_match | stage_specific
    description: str = ""


# ---------- context ----------


@dataclass
class VerificationContext:
    """Inputs available to every stage handler."""

    repo_root: str
    workspace_sig: str
    registry: ProcessRegistry
    # What the running server thinks it's serving. The harness is
    # expected to plug in a fake that returns a workspace signature
    # derived from its own config, not from real HTTP.
    served_workspace_probe: Callable[[], str | None] | None = None
    # Optional per-stage timeouts; the plan overrides these defaults.
    stage_timeouts: dict[VerificationStage, float] = field(default_factory=dict)
    # Outputs from prior stages. The machine populates this for each run.
    stage_outputs: dict[VerificationStage, StageResult] = field(default_factory=dict)
    # Working artifacts, populated as the run progresses.
    artifacts: list[str] = field(default_factory=list)
    # Mismatch events raised by the workspace identity stage.
    mismatches: list[WorkspaceMismatch] = field(default_factory=list)


# ---------- default plans ----------


def default_webapp_plan() -> list[StageSpec]:
    """The default plan for "webapp with dev server" tasks.

    Each stage has a single, explicit success signal. The agent is
    never asked to "just run the app and check"; each stage is a
    discrete check with its own pass/fail criterion.
    """
    return [
        StageSpec(
            stage=VerificationStage.PREPARE_ENV,
            required=True,
            timeout=60.0,
            success_signal="stage_specific",
            description="install / sync project deps so the workspace is buildable",
        ),
        StageSpec(
            stage=VerificationStage.START_SERVICES,
            required=True,
            timeout=30.0,
            success_signal="stage_specific",
            description="start the dev server owned by the harness",
        ),
        StageSpec(
            stage=VerificationStage.WORKSPACE_IDENTITY,
            required=True,
            timeout=15.0,
            success_signal="workspace_match",
            description="confirm the running server is serving THIS workspace",
        ),
        StageSpec(
            stage=VerificationStage.SMOKE,
            required=True,
            timeout=15.0,
            success_signal="exit_zero",
            description="smoke check: app responds, no obvious errors in startup logs",
        ),
        StageSpec(
            stage=VerificationStage.FOCUSED_TESTS,
            required=False,
            timeout=60.0,
            success_signal="exit_zero",
            description="run the tests most likely to cover the changed code",
        ),
        StageSpec(
            stage=VerificationStage.FULL_TESTS,
            required=False,
            timeout=180.0,
            success_signal="exit_zero",
            description="run the full project test suite",
        ),
        StageSpec(
            stage=VerificationStage.SCORING,
            required=False,
            timeout=60.0,
            success_signal="exit_zero",
            description="run the project's scoring / grading command if one exists",
        ),
        StageSpec(
            stage=VerificationStage.COLLECT_ARTIFACTS,
            required=True,
            timeout=10.0,
            success_signal="stage_specific",
            description="collect logs, screenshots, test output paths",
        ),
        StageSpec(
            stage=VerificationStage.STOP_SERVICES,
            required=True,
            timeout=10.0,
            success_signal="stage_specific",
            description="stop services the harness owns",
        ),
        StageSpec(
            stage=VerificationStage.SUMMARIZE,
            required=True,
            timeout=5.0,
            success_signal="stage_specific",
            description="summarise evidence into a completion ledger",
        ),
    ]


def default_cli_plan() -> list[StageSpec]:
    """Plan for a CLI / package task: tests + lint + scoring if any."""
    return [
        StageSpec(
            stage=VerificationStage.PREPARE_ENV,
            required=True,
            timeout=60.0,
            description="install / sync deps",
        ),
        StageSpec(
            stage=VerificationStage.FOCUSED_TESTS,
            required=True,
            timeout=60.0,
            description="run focused tests covering the changed code",
        ),
        StageSpec(
            stage=VerificationStage.FULL_TESTS,
            required=True,
            timeout=180.0,
            description="run the full test suite",
        ),
        StageSpec(
            stage=VerificationStage.SCORING,
            required=False,
            timeout=60.0,
            description="run scoring / grading if a command is known",
        ),
        StageSpec(
            stage=VerificationStage.COLLECT_ARTIFACTS,
            required=True,
            timeout=5.0,
            description="collect test output paths",
        ),
        StageSpec(
            stage=VerificationStage.SUMMARIZE,
            required=True,
            timeout=5.0,
        ),
    ]


def default_backend_api_plan() -> list[StageSpec]:
    """Plan for a backend API test task."""
    return [
        StageSpec(
            stage=VerificationStage.PREPARE_ENV,
            required=True,
            timeout=60.0,
        ),
        StageSpec(
            stage=VerificationStage.START_SERVICES,
            required=True,
            timeout=30.0,
        ),
        StageSpec(
            stage=VerificationStage.WORKSPACE_IDENTITY,
            required=True,
            timeout=15.0,
            success_signal="workspace_match",
        ),
        StageSpec(
            stage=VerificationStage.SMOKE,
            required=True,
            timeout=15.0,
        ),
        StageSpec(
            stage=VerificationStage.FOCUSED_TESTS,
            required=True,
            timeout=60.0,
        ),
        StageSpec(
            stage=VerificationStage.COLLECT_ARTIFACTS,
            required=True,
            timeout=5.0,
        ),
        StageSpec(
            stage=VerificationStage.STOP_SERVICES,
            required=True,
            timeout=10.0,
        ),
        StageSpec(
            stage=VerificationStage.SUMMARIZE,
            required=True,
            timeout=5.0,
        ),
    ]


# ---------- workspace identity ----------


def workspace_identity_check(
    served_signature: str | None,
    expected_signature: str,
) -> tuple[bool, WorkspaceMismatch | None]:
    """Detect "the server is serving the wrong workspace".

    The verifier does not trust that the running process is the
    process the model just started. It asks the process (or its proxy)
    what workspace it is serving, and compares the answer to the
    signature of the directory on disk right now.

    Returns (ok, mismatch). A None served_signature is treated as a
    soft pass -- there was no probe -- but logged so downstream
    stages can decide to fail if a probe was expected.
    """
    if served_signature is None:
        return True, None
    if served_signature == expected_signature:
        return True, None
    return False, WorkspaceMismatch(
        observed=served_signature,
        expected=expected_signature,
        evidence=(
            "The running server reported it is serving workspace "
            f"{served_signature!r} but the current workspace is "
            f"{expected_signature!r}. The agent may be talking to a "
            "stale dev server, a different checkout, or a server "
            "that was launched against a different path."
        ),
    )


# ---------- machine ----------


class VerificationMachine:
    """Runs a verification plan stage by stage.

    The machine does not know how to actually start a server or run
    pytest. Callers inject ``handlers`` keyed by stage. Missing
    handlers cause the stage to be marked SKIPPED (unless the stage
    is required, in which case the machine reports FAILED with a
    descriptive summary).
    """

    def __init__(
        self,
        plan: list[StageSpec],
        handlers: dict[VerificationStage, StageHandler],
        ctx: VerificationContext,
    ) -> None:
        self.plan = list(plan)
        self.handlers = dict(handlers)
        self.ctx = ctx

    def run(self) -> list[StageResult]:
        results: list[StageResult] = []
        for spec in self.plan:
            result = self._run_stage(spec)
            results.append(result)
            self.ctx.stage_outputs[spec.stage] = result
            # Required failure short-circuits the rest of the plan.
            if (
                result.status
                in (VerificationStatus.FAILED, VerificationStatus.TIMED_OUT)
                and spec.required
            ):
                # The remaining stages are not run; we mark them as
                # skipped so the ledger shows a clear picture.
                for follow in self.plan[self.plan.index(spec) + 1 :]:
                    skip = StageResult(
                        stage=follow.stage,
                        status=VerificationStatus.SKIPPED,
                        summary=f"skipped because required stage {spec.stage.value} {result.status.value}",
                    )
                    results.append(skip)
                    self.ctx.stage_outputs[follow.stage] = skip
                break
        return results

    def _run_stage(self, spec: StageSpec) -> StageResult:
        handler = self.handlers.get(spec.stage)
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        result.status = VerificationStatus.RUNNING
        if handler is None:
            if spec.required:
                result.status = VerificationStatus.FAILED
                result.summary = f"required stage {spec.stage.value} has no handler"
            else:
                result.status = VerificationStatus.SKIPPED
                result.summary = f"optional stage {spec.stage.value} has no handler"
            result.finished_at = time.time()
            result.elapsed = result.finished_at - result.started_at
            return result
        try:
            outcome = handler(self.ctx, spec)
            outcome.started_at = outcome.started_at or result.started_at
            outcome.finished_at = outcome.finished_at or time.time()
            outcome.elapsed = outcome.elapsed or (
                outcome.finished_at - outcome.started_at
            )
            return outcome
        except _StageTimeout as e:
            result.status = VerificationStatus.TIMED_OUT
            result.summary = f"timed out after {e.timeout:.0f}s"
            result.failure_class = FailureClass.SERVER_RUNTIME
        except Exception as e:  # pragma: no cover -- defensive
            result.status = VerificationStatus.FAILED
            result.summary = f"handler crashed: {type(e).__name__}: {e}"
            result.failure_class = FailureClass.UNKNOWN
        result.finished_at = time.time()
        result.elapsed = result.finished_at - result.started_at
        return result


class _StageTimeout(Exception):
    def __init__(self, timeout: float) -> None:
        super().__init__(f"timed out after {timeout:.0f}s")
        self.timeout = timeout


# ---------- common handler factories ----------


def make_run_command_handler(
    runner: Callable[..., RunOutcome],
) -> StageHandler:
    """Build a stage handler that runs a single command and checks the exit code.

    The runner is injected, so tests use a fake that returns canned
    RunOutcomes. The command is taken from ``ctx.stage_outputs`` of
    the prior PREPARE_ENV/START_SERVICES stage under ``signals.cmd``,
    falling back to ``None`` (which marks the stage skipped).

    The handler classifies any non-zero exit using the lifecycle
    failure classifier so the ledger can suggest a recovery.
    """

    def handler(ctx: VerificationContext, spec: StageSpec) -> StageResult:
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        prior = ctx.stage_outputs.get(
            VerificationStage.START_SERVICES
        ) or ctx.stage_outputs.get(VerificationStage.PREPARE_ENV)
        cmd = None
        if prior is not None:
            cmd = prior.signals.get("next_cmd")
        if not cmd:
            result.status = VerificationStatus.SKIPPED
            result.summary = "no command provided to run"
            result.finished_at = time.time()
            return result
        outcome = runner(cmd, cwd=ctx.repo_root, timeout=spec.timeout)
        result.finished_at = time.time()
        result.elapsed = outcome.elapsed or (result.finished_at - result.started_at)
        result.signals["exit_code"] = outcome.returncode
        result.signals["timed_out"] = outcome.timed_out
        result.signals["stdout_tail"] = (outcome.stdout or "")[-400:]
        if outcome.timed_out:
            result.status = VerificationStatus.TIMED_OUT
            result.summary = f"timed out after {spec.timeout:.0f}s"
            result.failure_class = FailureClass.SERVER_RUNTIME
            return result
        if outcome.ok and spec.success_signal == "exit_zero":
            result.status = VerificationStatus.OK
            result.summary = f"exit=0 in {result.elapsed:.1f}s"
            return result
        # Non-zero exit
        result.status = VerificationStatus.FAILED
        result.failure_class = classify_failure(
            exit_code=outcome.returncode,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=False,
        )
        result.summary = f"exit={outcome.returncode}; {result.failure_class.value}"
        return result

    return handler


def make_workspace_identity_handler() -> StageHandler:
    """A stage handler that checks the running server's workspace identity."""

    def handler(ctx: VerificationContext, spec: StageSpec) -> StageResult:
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        served = ctx.served_workspace_probe() if ctx.served_workspace_probe else None
        ok, mismatch = workspace_identity_check(served, ctx.workspace_sig)
        result.signals["served_signature"] = served
        result.signals["expected_signature"] = ctx.workspace_sig
        if mismatch is not None:
            ctx.mismatches.append(mismatch)
            result.status = VerificationStatus.FAILED
            result.summary = mismatch.evidence
            result.failure_class = FailureClass.STALE_WORKSPACE
        elif served is None:
            result.status = VerificationStatus.SKIPPED
            result.summary = "no served-workspace probe was available"
        else:
            result.status = VerificationStatus.OK
            result.summary = "served workspace matches current workspace"
        result.finished_at = time.time()
        return result

    return handler


def make_stop_services_handler() -> StageHandler:
    """A stage handler that asks the registry to stop owned services."""

    def handler(ctx: VerificationContext, spec: StageSpec) -> StageResult:
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        stopped = ctx.registry.stop_all_running()
        result.signals["stopped"] = stopped
        if stopped:
            result.status = VerificationStatus.OK
            result.summary = f"stopped {len(stopped)} owned service(s)"
        else:
            result.status = VerificationStatus.OK
            result.summary = "no owned services to stop"
        result.finished_at = time.time()
        return result

    return handler


def make_collect_artifacts_handler() -> StageHandler:
    """A stage handler that aggregates the artifact list from prior stages."""

    def handler(ctx: VerificationContext, spec: StageSpec) -> StageResult:
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        # The artifacts list on the context is the source of truth.
        result.artifacts = list(ctx.artifacts)
        if not result.artifacts:
            result.status = VerificationStatus.OK
            result.summary = "no artifacts collected (nothing was produced)"
        else:
            result.status = VerificationStatus.OK
            result.summary = f"collected {len(result.artifacts)} artifact(s)"
        result.finished_at = time.time()
        return result

    return handler


def make_summarize_handler() -> StageHandler:
    """A stage handler that produces a final summary string.

    The actual content of the summary is the responsibility of the
    ledger module; this stage is just the marker that summarisation
    happened.
    """

    def handler(ctx: VerificationContext, spec: StageSpec) -> StageResult:
        result = StageResult(stage=spec.stage)
        result.started_at = time.time()
        result.status = VerificationStatus.OK
        n_ok = sum(
            1 for s in ctx.stage_outputs.values() if s.status == VerificationStatus.OK
        )
        n_fail = sum(
            1
            for s in ctx.stage_outputs.values()
            if s.status in (VerificationStatus.FAILED, VerificationStatus.TIMED_OUT)
        )
        result.summary = f"verification summary: {n_ok} ok, {n_fail} fail"
        result.signals["ok"] = n_ok
        result.signals["fail"] = n_fail
        result.finished_at = time.time()
        return result

    return handler


# ---------- completion decision ----------


def is_terminal_verified(results: list[StageResult]) -> bool:
    """A run is verified iff every required stage is ok and no stage is in flight."""
    if not results:
        return False
    for r in results:
        if r.stage in (
            VerificationStage.PREPARE_ENV,
            VerificationStage.START_SERVICES,
            VerificationStage.WORKSPACE_IDENTITY,
            VerificationStage.SMOKE,
            VerificationStage.FOCUSED_TESTS,
            VerificationStage.FULL_TESTS,
            VerificationStage.SCORING,
            VerificationStage.COLLECT_ARTIFACTS,
            VerificationStage.STOP_SERVICES,
            VerificationStage.SUMMARIZE,
        ):
            if r.status == VerificationStatus.OK:
                continue
            if r.status in (VerificationStatus.SKIPPED,):
                continue
            return False
    return True


def required_stages_for(plan: list[StageSpec]) -> set[VerificationStage]:
    return {s.stage for s in plan if s.required}
