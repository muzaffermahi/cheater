"""Anti-stall controller: glue between the agent loop and the recovery system.

The anti-stall controller composes with the existing lifecycle
controller (cheater/lifecycle_controller.py) and the watchdog
(cheater/stuck.py). It is the loop-facing surface for everything
the new slice adds.

The controller is responsible for:

  * Recording a StepFingerprint for every step.
  * Detecting stalls via the StallDetector.
  * Escalating through the RecoveryLadder when a stall is found.
  * Enforcing BannedAction: the loop asks ``is_action_allowed`` before
    dispatching a tool call.
  * Producing a compact debug summary (``debug_summary``) the
    developer surface can show.
  * Emitting a final ``AntiStallOutcome`` that downstream code uses.

Public API:

  AntiStallController     -- the controller
  AntiStallOutcome        -- the final outcome
  StrategyNoveltyPolicy   -- how strictly to require strategy novelty
  DebugSnapshot           -- a small debug artifact
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from cheater.anti_stall import (
    StallAssessment,
    StallDetector,
    StallReason,
    StepFingerprint,
    make_fingerprint_from_step,
    compute_test_fingerprint,
    edit_diff_sig,
    tool_args_sig,
)
from cheater.ledger import CompletionLedger
from cheater.lifecycle import FailureClass
from cheater.playbooks import Playbook
from cheater.recovery import (
    BannedActionSet,
    LadderConfig,
    RecoveryAction,
    RecoveryCapsule,
    RecoveryLadder,
    StrategyRecord,
    build_capsule,
    render_capsule_for_model,
)
from cheater.strategy import (
    Strategy,
    StrategyKind,
    strategy_differs,
)
from cheater.stuck import Watchdog


# ---------- outcome ----------


@dataclass
class AntiStallOutcome:
    """The final outcome of the anti-stall controller for one run.

    Stored in the LoopResult so the developer surface can show what
    happened. The outcome is intentionally small.
    """

    final_level: int = 0
    final_level_name: str = "none"
    total_recoveries: int = 0
    stalled: bool = False
    blocked: bool = False
    fresh_workers_spawned: int = 0
    strategies_tried: list[str] = field(default_factory=list)
    banned_count: int = 0
    blocked_report: dict[str, Any] | None = None
    last_assessment: dict[str, Any] | None = None
    capsule: dict[str, Any] | None = None
    debug: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "final_level": self.final_level,
            "final_level_name": self.final_level_name,
            "total_recoveries": self.total_recoveries,
            "stalled": self.stalled,
            "blocked": self.blocked,
            "fresh_workers_spawned": self.fresh_workers_spawned,
            "strategies_tried": list(self.strategies_tried),
            "banned_count": self.banned_count,
            "blocked_report": self.blocked_report,
            "last_assessment": self.last_assessment,
            "capsule": self.capsule,
            "debug": self.debug,
        }


# ---------- strategy novelty policy ----------


@dataclass
class StrategyNoveltyPolicy:
    """How strictly to require a fresh worker to differ from previous.

    ``strict`` means even a kind change must come with a different
    hypothesis or different args signature. ``lenient`` only
    rejects "same kind, same args signature". The default is
    strict: the anti-stall system exists to break loops, not to
    rubber-stamp them.
    """

    require_different_hypothesis: bool = True
    require_different_args_sig: bool = True
    require_different_kind: bool = False
    # If the new strategy is the same as the old, fall back to
    # the next kind in the playbook's valid set.
    fallback_to_next_kind: bool = True


# ---------- debug snapshot ----------


@dataclass
class DebugSnapshot:
    """A small, compact debug artifact the developer surface can show.

    Deliberately not a dump of the full state. The dev surface
    should be readable in a TUI.
    """

    step_count: int = 0
    progress_streak: int = 0
    banned: list[dict[str, Any]] = field(default_factory=list)
    last_assessment: dict[str, Any] | None = None
    strategies_tried: list[str] = field(default_factory=list)
    capsule: dict[str, Any] | None = None
    ladder_attempts: dict[str, int] = field(default_factory=dict)
    fresh_workers_spawned: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_count": self.step_count,
            "progress_streak": self.progress_streak,
            "banned": list(self.banned),
            "last_assessment": self.last_assessment,
            "strategies_tried": list(self.strategies_tried),
            "capsule": self.capsule,
            "ladder_attempts": dict(self.ladder_attempts),
            "fresh_workers_spawned": self.fresh_workers_spawned,
        }


# ---------- controller ----------


@dataclass
class AntiStallController:
    """The loop-facing anti-stall controller.

    The controller is created with an optional LifecycleController.
    When created, the controller pulls the playbook, ledger, and
    watchdog from the lifecycle controller and binds to them. The
    controller is the only thing the agent loop talks to.
    """

    user_goal: str
    playbook: Playbook | None
    ledger: CompletionLedger
    watchdog: Watchdog | None = None
    # Internal machinery
    detector: StallDetector = field(default_factory=StallDetector)
    ladder: RecoveryLadder = field(default_factory=RecoveryLadder)
    banned: BannedActionSet = field(default_factory=BannedActionSet)
    strategy_record: StrategyRecord = field(default_factory=StrategyRecord)
    novelty_policy: StrategyNoveltyPolicy = field(default_factory=StrategyNoveltyPolicy)
    # Counters
    step_count: int = 0
    fresh_workers_spawned: int = 0
    # Last assessment produced (debug / outcome).
    last_assessment: StallAssessment = field(default_factory=lambda: StallAssessment())
    # Cached current capsule, if any.
    last_capsule: RecoveryCapsule | None = None
    # Last recovery action produced.
    last_action: RecoveryAction | None = None
    # History of recovery actions.
    recovery_history: list[RecoveryAction] = field(default_factory=list)
    # Optional strategy the agent committed to at the start.
    initial_strategy: Strategy | None = None
    # The "next verification command" is set by the loop when it
    # knows what the playbook expects to run.
    next_verification_command: str = ""

    # ---- factory ----

    @classmethod
    def for_task(
        cls,
        user_goal: str,
        playbook: Playbook | None,
        ledger: CompletionLedger,
        *,
        watchdog: Watchdog | None = None,
        ladder_config: LadderConfig | None = None,
        novelty_policy: StrategyNoveltyPolicy | None = None,
    ) -> "AntiStallController":
        policy = novelty_policy or StrategyNoveltyPolicy()
        controller = cls(
            user_goal=user_goal,
            playbook=playbook,
            ledger=ledger,
            watchdog=watchdog,
            novelty_policy=policy,
        )
        if ladder_config is not None:
            controller.ladder = RecoveryLadder(ladder_config)
        # Pick an initial strategy from the playbook.
        controller.initial_strategy = controller._initial_strategy()
        if controller.initial_strategy is not None:
            controller.strategy_record.add(controller.initial_strategy)
        return controller

    def _initial_strategy(self) -> Strategy | None:
        if self.playbook is None:
            return None
        return Strategy(
            kind=StrategyKind.IMPLEMENT,
            hypothesis="implement the change described in the user goal",
            smallest_next_action="read_file on the file most likely affected by the goal",
            verification_target="the focused test for the change passes",
            evidence_needed="the file the goal is about",
        )

    # ---- step observation ----

    def observe_step(
        self,
        *,
        action: str,
        args: dict | None = None,
        success: bool = True,
        summary: str = "",
        files_read: list[str] | None = None,
        files_changed: list[str] | None = None,
        commands_run: list[str] | None = None,
        stdout: str = "",
        stderr: str = "",
        artifact_paths: list[str] | None = None,
        failure_class: str = "",
        verification_stage: str = "",
        model_message: str = "",
    ) -> StepFingerprint:
        """Record a step and return the fingerprint."""
        self.step_count += 1
        # Pre-process: a no-diff edit is encoded into test_fp.
        # We use a small trick: if the action is an edit-like action
        # and the user supplied old/new, we use the diff sig. The
        # caller is encouraged to pass those in; we do not have them
        # at this layer, so we rely on the caller using ``edit_diff_sig``
        # directly via the ``note_edit`` helper.
        fp = make_fingerprint_from_step(
            step=self.step_count,
            action=action,
            args=args,
            success=success,
            summary=summary,
            files_read=files_read,
            files_changed=files_changed,
            commands_run=commands_run,
            stdout=stdout,
            stderr=stderr,
            artifact_paths=artifact_paths,
            failure_class=failure_class,
            verification_stage=verification_stage,
            model_message=model_message,
            ledger=self.detector.ledger,
        )
        self.detector.observe(fp)
        # Refresh the assessment.
        self.last_assessment = self.detector.assess()
        return fp

    def note_edit(
        self,
        *,
        action: str,
        args: dict | None,
        old: str,
        new: str,
        success: bool = True,
        summary: str = "",
        files_changed: list[str] | None = None,
        failure_class: str = "",
        model_message: str = "",
    ) -> StepFingerprint:
        """Record an edit step and detect no-diff edits.

        The harness calls this instead of ``observe_step`` for edit
        actions so we can fingerprint the diff itself.
        """
        diff = edit_diff_sig(old, new)
        # Encode the diff into the test_fp so the detector sees
        # "no-diff" as a repeated fingerprint.
        return self.observe_step(
            action=action,
            args=args,
            success=success,
            summary=summary,
            files_changed=files_changed,
            stdout=diff,  # test_fp will be 'no-diff' or the diff hash
            failure_class=failure_class,
            model_message=model_message,
        )

    def note_command_finished(
        self,
        *,
        cmd: str,
        cmd_kind: Any,
        success: bool,
        exit_code: int | None,
        stdout: str = "",
        stderr: str = "",
        elapsed: float = 0.0,
        timed_out: bool = False,
    ) -> None:
        """External signal: a command finished. Updates detector hints."""
        # Surface signals to the detector without recording a step.
        from cheater.lifecycle import CommandKind
        if cmd_kind == CommandKind.DEV_SERVER and success:
            self.detector.note_server_started()
        if cmd_kind in (CommandKind.TEST, CommandKind.VERIFY) and success:
            self.detector.note_verify_attempt()
        if cmd_kind == CommandKind.SCORING:
            self.detector.note_scoring_invoked()
        if cmd_kind == CommandKind.TEST and not timed_out:
            self.detector.note_test_finished()
        # Record the test result fingerprint if we have output.
        if stdout and (cmd_kind == CommandKind.TEST or cmd_kind == CommandKind.VERIFY):
            fp = compute_test_fingerprint(stdout)
            if fp:
                # Synthesize a tiny fingerprint with the test_fp set,
                # so the detector's "repeated test result" heuristic
                # fires on repeated test output.
                self.observe_step(
                    action="run_command",
                    args={"cmd": cmd},
                    success=success,
                    summary=stdout[:200],
                    commands_run=[cmd],
                    stdout=stdout,
                    stderr=stderr,
                    failure_class="" if success else FailureClass.UNKNOWN.value,
                )

    def note_finish_attempt(self) -> None:
        """Bump finish-attempt count and re-assess."""
        # Synthesize a finish step fingerprint so the detector can
        # see it.
        self.observe_step(action="finish", success=True, summary="finish attempt")

    # ---- gating ----

    def is_action_allowed(self, action: str, args: dict | None = None) -> tuple[bool, str]:
        """Should the loop dispatch this action right now?

        Returns (allowed, reason). The loop uses this to short-circuit
        banned actions before sending them to the model or the tool
        registry.
        """
        sig = tool_args_sig(action, args)
        if self.banned.is_banned(action, sig):
            return False, f"action banned: {action} {sig}"
        return True, ""

    def is_finish_allowed(self) -> tuple[bool, str]:
        """A structural ban on finish while there is no verified record."""
        if self.ladder.is_blocked():
            return False, "the ladder has blocked the run; finish is not allowed"
        # Banned explicitly?
        allowed, reason = self.is_action_allowed("finish", None)
        if not allowed:
            return False, reason
        return True, ""

    def strategy_is_novel(self, candidate: Strategy) -> tuple[bool, str]:
        """Check a candidate strategy against the policy + history."""
        last = self.strategy_record.last
        if last is None:
            return True, "no prior strategy"
        if strategy_differs(last, candidate):
            return True, "structurally different"
        # Apply policy.
        policy = self.novelty_policy
        if policy.require_different_kind and candidate.kind != last.kind:
            return True, "kind changed"
        if policy.require_different_hypothesis:
            if candidate.hypothesis and candidate.hypothesis != last.hypothesis:
                return True, "hypothesis changed"
        if policy.require_different_args_sig:
            if candidate.next_args_sig and candidate.next_args_sig != last.next_args_sig:
                return True, "args signature changed"
        return False, "same strategy as previous worker"

    def commit_strategy(self, strategy: Strategy) -> None:
        """Record a strategy the agent (or recovery layer) committed to."""
        self.strategy_record.add(strategy)

    # ---- recovery ----

    def on_stall(self) -> RecoveryAction | None:
        """Called by the loop on every step.

        Returns a RecoveryAction if the controller decided to
        escalate, else None. The loop uses the action to steer
        the worker, switch strategy, or emit a blocked report.
        """
        assessment = self.last_assessment
        if not assessment.is_stalled:
            return None
        if self.ladder.is_blocked():
            return None
        action = self.ladder.escalate(
            assessment=assessment,
            user_goal=self.user_goal,
            playbook=self.playbook,
            ledger=self.ledger,
            detector=self.detector,
            banned=self.banned,
            strategy_record=self.strategy_record,
            next_verification_command=self.next_verification_command,
        )
        self.last_action = action
        self.recovery_history.append(action)
        if action.level.value >= 3:  # FRESH_WORKER and above
            self.fresh_workers_spawned += 1
        # Build a capsule for any future worker to consume.
        # The recovery ladder has already appended the chosen
        # strategy to the strategy_record; pass the *record's*
        # last strategy, not the dict form in the action's
        # extra.
        self.last_capsule = build_capsule(
            user_goal=self.user_goal,
            playbook=self.playbook,
            ledger=self.ledger,
            detector=self.detector,
            banned=self.banned,
            strategy_record=self.strategy_record,
            next_strategy=self.strategy_record.last,
            next_verification_command=self.next_verification_command,
        )
        return action

    def render_capsule(self) -> str:
        """Render the current capsule as a small prompt section."""
        if self.last_capsule is None:
            self.last_capsule = build_capsule(
                user_goal=self.user_goal,
                playbook=self.playbook,
                ledger=self.ledger,
                detector=self.detector,
                banned=self.banned,
                strategy_record=self.strategy_record,
                next_strategy=self.strategy_record.last,
                next_verification_command=self.next_verification_command,
            )
        return render_capsule_for_model(self.last_capsule)

    # ---- finalisation ----

    def outcome(self) -> AntiStallOutcome:
        """Build the final outcome for this run."""
        blocked_report_dict: dict[str, Any] | None = None
        if self.ladder.blocked_report is not None:
            blocked_report_dict = self.ladder.blocked_report.to_dict()
        return AntiStallOutcome(
            final_level=self.ladder.level.value,
            final_level_name=_level_name(self.ladder.level),
            total_recoveries=self.ladder.total_recoveries,
            stalled=self.last_assessment.is_stalled,
            blocked=self.ladder.is_blocked(),
            fresh_workers_spawned=self.fresh_workers_spawned,
            strategies_tried=[s.kind.value for s in self.strategy_record.strategies],
            banned_count=len(self.banned.active()),
            blocked_report=blocked_report_dict,
            last_assessment=self.last_assessment.to_dict() if self.last_assessment else None,
            capsule=self.last_capsule.to_dict() if self.last_capsule is not None else None,
            debug=self.debug_snapshot().to_dict(),
        )

    def debug_snapshot(self) -> DebugSnapshot:
        """A compact debug artifact the developer surface can render."""
        return DebugSnapshot(
            step_count=self.step_count,
            progress_streak=self.detector._progress_streak,
            banned=[b.to_dict() for b in self.banned.active()],
            last_assessment=(
                self.last_assessment.to_dict() if self.last_assessment else None
            ),
            strategies_tried=[s.kind.value for s in self.strategy_record.strategies],
            capsule=self.last_capsule.to_dict() if self.last_capsule is not None else None,
            ladder_attempts=dict(self.ladder.attempts_by_level),
            fresh_workers_spawned=self.fresh_workers_spawned,
        )

    # ---- convenience for tests / dev ----

    def force_stall_for_test(self, reason: StallReason, *, evidence: dict | None = None) -> None:
        """Make the detector fire on the next assess().

        Used by tests. We do this by injecting a synthetic step
        fingerprint that matches the stall reason.
        """
        evidence = evidence or {}
        # Build a fingerprint that makes the detector fire.
        if reason == StallReason.REPEATED_COMMAND:
            for _ in range(self.detector.cfg.repeated_command_count):
                self.detector.observe(StepFingerprint(
                    step=self.step_count,
                    at=time.time(),
                    action="run_command",
                    args_sig="test-sig",
                    success=False,
                    summary="fail",
                    commands_run=["pytest -x tests/test_x.py"],
                ))
        elif reason == StallReason.REPEATED_TOOL_CALL:
            for _ in range(self.detector.cfg.repeated_command_count):
                self.detector.observe(StepFingerprint(
                    step=self.step_count,
                    at=time.time(),
                    action="read_file",
                    args_sig="same-args",
                    success=True,
                    summary="ok",
                    files_read=["cheater/x.py"],
                ))
        elif reason == StallReason.REPEATED_TEST_RESULT:
            for _ in range(self.detector.cfg.repeated_test_count):
                self.detector.observe(StepFingerprint(
                    step=self.step_count,
                    at=time.time(),
                    action="run_command",
                    args_sig="pytest-x",
                    success=False,
                    summary="FAIL tests/test_x.py::test_x",
                    commands_run=["pytest -x tests/test_x.py"],
                    test_fp="same-fp",
                ))
        elif reason == StallReason.NO_PROGRESS:
            for _ in range(self.detector.cfg.stall_window + 1):
                self.detector.observe(StepFingerprint(
                    step=self.step_count,
                    at=time.time(),
                    action="read_file",
                    args_sig="no-progress",
                    success=True,
                    summary="ok",
                ))
        self.last_assessment = self.detector.assess()

    def lift_bans(self) -> None:
        """Lift all bans. Used by the loop when fresh evidence arrives."""
        self.banned.lift_all()


# ---------- helpers ----------


def _level_name(level: Any) -> str:
    try:
        from cheater.recovery import _LEVEL_NAMES, RecoveryLevel
        if isinstance(level, RecoveryLevel):
            return _LEVEL_NAMES[level]
    except Exception:
        pass
    return str(level)
