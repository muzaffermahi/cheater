"""Stuck-state watchdog for the Cheater harness.

A coding harness that lets a small local model drive the loop can
get stuck in many ways that look like progress from the outside but
are not:

  * a command that printed nothing in 5 minutes
  * the same command attempted three times in a row
  * a server that started but the agent never tried to verify it
  * tests that finished but the scoring command was never invoked
  * a verification that failed but no repair attempt was made
  * a "finish" call with no evidence

The watchdog classifies these states and picks a recovery action.
It does not try to repair by itself; the agent loop decides whether
to apply the recovery, ask the user, or give up.

Public API:

  StuckKind               -- enumeration of stuck states
  StuckState              -- the current assessment
  Watchdog                -- the watchdog, fed by the loop via observe()
  observe_loop_event      -- convenience to translate a step into an event
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from cheater.lifecycle import (
    CommandKind,
    FailureClass,
    ProcessRegistry,
    pick_recovery,
)


class StuckKind(str, Enum):
    """A coarse taxonomy of stuck states.

    Kept small on purpose: the recovery layer is the place that
    decides what to do, and it only needs to know which big bucket
    we are in.
    """

    NO_OUTPUT = "no_output"
    REPEATED_COMMAND = "repeated_command"
    INTERACTIVE_PROMPT = "interactive_prompt"
    SERVER_NO_VERIFY = "server_no_verify"
    TESTS_NO_SCORING = "tests_no_scoring"
    VERIFY_NO_REPAIR = "verify_no_repair"
    FINISH_WITHOUT_EVIDENCE = "finish_without_evidence"
    IDLE = "idle"  # the watchdog has nothing to say


# A class of event the loop feeds the watchdog.
# We keep the surface narrow on purpose: anything the loop wants the
# watchdog to know about goes through one of these.
@dataclass
class CommandEvent:
    kind: str  # "command_started" | "command_finished" | "command_no_output_tick"
    cmd: str
    cmd_kind: CommandKind
    cmd_id: str
    started_at: float
    finished_at: float = 0.0
    exit_code: int | None = None
    timed_out: bool = False
    elapsed: float = 0.0
    output_bytes: int = 0
    last_output_at: float = 0.0


@dataclass
class AgentEvent:
    kind: str  # "action" | "finish_attempt" | "i_dont_know" | "ask_user"
    action: str = ""
    args: dict = field(default_factory=dict)
    success: bool = True
    summary: str = ""
    at: float = field(default_factory=time.time)


WatchEvent = CommandEvent | AgentEvent | dict


# ---------- config ----------


# Tunable thresholds. Kept conservative: too aggressive and the
# watchdog becomes noise. The harness can override these via the
# Watchdog() constructor.
@dataclass
class WatchdogConfig:
    no_output_seconds: float = 90.0
    repeated_command_window: int = 4
    server_no_verify_seconds: float = 60.0
    tests_no_scoring_seconds: float = 30.0
    verify_no_repair_window: int = 3  # failures in a row with no repair action


# ---------- state ----------


@dataclass
class StuckState:
    """The watchdog's current assessment of the loop's state."""

    kind: StuckKind = StuckKind.IDLE
    summary: str = ""
    recovery_name: str = ""
    recovery_class: FailureClass | None = None
    details: dict[str, Any] = field(default_factory=dict)
    observed_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["kind"] = self.kind.value
        d["recovery_class"] = self.recovery_class.value if self.recovery_class else None
        return d

    @property
    def is_stuck(self) -> bool:
        return self.kind != StuckKind.IDLE


# ---------- watchdog ----------


class Watchdog:
    """Tracks the lifecycle and reports when the loop is stuck.

    The watchdog is deliberately *additive*. It does not block the
    loop or send messages of its own; it emits a StuckState that the
    loop consults before deciding the next step. This keeps the
    watchdog testable and easy to disable.
    """

    def __init__(
        self,
        registry: ProcessRegistry | None = None,
        cfg: WatchdogConfig | None = None,
        *,
        now: float | None = None,
    ) -> None:
        self.registry = registry
        self.cfg = cfg or WatchdogConfig()
        self._now = now  # injectable clock for tests
        # Recent command events: (cmd, args-sig, started_at, finished_at)
        self._recent_commands: deque[tuple[str, str, float, float]] = deque(maxlen=32)
        # Verification state tracking
        self._last_test_finished_at: float = 0.0
        self._scoring_invoked: bool = False
        self._last_server_started_at: float = 0.0
        self._verify_attempted_at: float = 0.0
        self._consecutive_verify_failures: int = 0
        # Repair attempts: how many "fix" / "edit" actions followed the last failure
        self._actions_since_last_failure: int = 0
        # The most recent finish attempt without evidence
        self._last_finish_attempt_summary: str = ""
        # Last output tick for any long-running command
        self._last_output_at_by_cmd: dict[str, float] = {}

    # ---- clock ----

    def _t(self) -> float:
        return self._now if self._now is not None else time.time()

    # ---- feed events ----

    def observe(self, event: WatchEvent) -> None:
        if isinstance(event, CommandEvent):
            self._observe_command(event)
        elif isinstance(event, AgentEvent):
            self._observe_agent(event)
        elif isinstance(event, dict):
            self._observe_dict(event)

    def _observe_dict(self, event: dict) -> None:
        kind = event.get("kind", "")
        if kind in ("command_started", "command_finished", "command_no_output_tick"):
            try:
                ck = CommandKind(event.get("cmd_kind", "shell"))
            except ValueError:
                ck = CommandKind.SHELL
            self._observe_command(
                CommandEvent(
                    kind=kind,
                    cmd=str(event.get("cmd", "")),
                    cmd_kind=ck,
                    cmd_id=str(event.get("cmd_id", "")),
                    started_at=float(event.get("started_at", self._t())),
                    finished_at=float(event.get("finished_at", 0.0)),
                    exit_code=event.get("exit_code"),
                    timed_out=bool(event.get("timed_out", False)),
                    elapsed=float(event.get("elapsed", 0.0)),
                    output_bytes=int(event.get("output_bytes", 0)),
                    last_output_at=float(event.get("last_output_at", self._t())),
                )
            )
        elif kind in ("action", "finish_attempt", "i_dont_know", "ask_user"):
            self._observe_agent(
                AgentEvent(
                    kind=kind,
                    action=str(event.get("action", "")),
                    args=dict(event.get("args", {}) or {}),
                    success=bool(event.get("success", True)),
                    summary=str(event.get("summary", "")),
                    at=float(event.get("at", self._t())),
                )
            )

    def _observe_command(self, e: CommandEvent) -> None:
        if e.kind == "command_started":
            self._recent_commands.append(
                (e.cmd, _args_sig_from_cmd(e.cmd), e.started_at, 0.0)
            )
            self._last_output_at_by_cmd[e.cmd_id] = e.started_at
            if e.cmd_kind == CommandKind.DEV_SERVER:
                self._last_server_started_at = e.started_at
                self._verify_attempted_at = 0.0  # reset on new server
            if e.cmd_kind == CommandKind.SCORING:
                self._scoring_invoked = True
            if e.cmd_kind == CommandKind.TEST and self._last_test_finished_at == 0.0:
                # remember that tests have started
                pass
        elif e.kind == "command_finished":
            # Mark the most recent matching entry as finished.
            for i in range(len(self._recent_commands) - 1, -1, -1):
                cmd, sig, st, ft = self._recent_commands[i]
                if cmd == e.cmd and ft == 0.0:
                    self._recent_commands[i] = (
                        cmd,
                        sig,
                        st,
                        e.finished_at or self._t(),
                    )
                    break
            if e.cmd_kind == CommandKind.TEST:
                self._last_test_finished_at = e.finished_at or self._t()
                self._scoring_invoked = False  # reset
            # Track verification attempts
            if e.cmd_kind in (CommandKind.VERIFY, CommandKind.TEST):
                self._verify_attempted_at = e.finished_at or self._t()
            # A finished command is no longer in flight; the watchdog
            # should not consider it for "no output" any more.
            self._last_output_at_by_cmd.pop(e.cmd_id, None)
            if e.exit_code != 0 or e.timed_out:
                self._consecutive_verify_failures += 1
                self._actions_since_last_failure = 0
            else:
                self._consecutive_verify_failures = 0
        elif e.kind == "command_no_output_tick":
            self._last_output_at_by_cmd[e.cmd_id] = e.last_output_at

    def _observe_agent(self, e: AgentEvent) -> None:
        if e.kind == "action":
            if e.action in ("edit_file", "create_file", "apply_patch", "run_command"):
                # Any non-read action counts as a repair attempt.
                if self._consecutive_verify_failures > 0:
                    self._actions_since_last_failure += 1
        elif e.kind == "finish_attempt":
            self._last_finish_attempt_summary = e.summary
        elif e.kind == "i_dont_know":
            # Reset consecutive failure counter: the agent gave up.
            self._consecutive_verify_failures = 0
        elif e.kind == "ask_user":
            # Asking the user is also a "repair action".
            if self._consecutive_verify_failures > 0:
                self._actions_since_last_failure += 1

    # ---- classification ----

    def assess(self) -> StuckState:
        """Compute the current stuck state from observed events."""
        now = self._t()

        # 1) Finish without evidence is a stuck state on its own.
        if self._last_finish_attempt_summary and not _looks_like_evidence(
            self._last_finish_attempt_summary
        ):
            return _stuck(
                StuckKind.FINISH_WITHOUT_EVIDENCE,
                "finish called without concrete evidence",
                details={"summary": self._last_finish_attempt_summary},
            )

        # 2) Repeated command attempts: same cmd, last few windows.
        recent = [c for c in self._recent_commands if c[3] > 0]
        if len(recent) >= self.cfg.repeated_command_window:
            cmds = [c[0] for c in recent[-self.cfg.repeated_command_window :]]
            if len(set(cmds)) == 1:
                return _stuck(
                    StuckKind.REPEATED_COMMAND,
                    f"the same command ran {len(cmds)} times in a row: {cmds[0]!r}",
                    recovery_name="collect_diagnostics_and_ask",
                    recovery_class=FailureClass.UNKNOWN,
                )

        # 3) Server started but never verified within window.
        if self._last_server_started_at > 0 and self._verify_attempted_at == 0:
            if now - self._last_server_started_at > self.cfg.server_no_verify_seconds:
                return _stuck(
                    StuckKind.SERVER_NO_VERIFY,
                    "a dev server was started but no verification was attempted",
                    recovery_name="restart_server_against_current_workspace",
                    recovery_class=FailureClass.STALE_WORKSPACE,
                )

        # 4) Tests finished but scoring never invoked.
        if (
            self._last_test_finished_at > 0
            and not self._scoring_invoked
            and now - self._last_test_finished_at > self.cfg.tests_no_scoring_seconds
        ):
            # We only flag this if a scoring command was actually expected.
            # The registry doesn't always know that; the loop sets the
            # expectation via observe({"expect_scoring": True}).
            if getattr(self, "_expect_scoring", False):
                return _stuck(
                    StuckKind.TESTS_NO_SCORING,
                    "tests finished but the scoring command was not invoked",
                    recovery_name="collect_diagnostics_and_ask",
                    recovery_class=FailureClass.UNKNOWN,
                )

        # 5) Verify failed but no repair attempt within window.
        if (
            self._consecutive_verify_failures >= self.cfg.verify_no_repair_window
            and self._actions_since_last_failure == 0
        ):
            return _stuck(
                StuckKind.VERIFY_NO_REPAIR,
                f"verification failed {self._consecutive_verify_failures} times with no repair action",
                recovery_name="collect_diagnostics_and_ask",
                recovery_class=FailureClass.UNKNOWN,
            )

        # 6) No output for a long-running command.
        for cmd_id, last in list(self._last_output_at_by_cmd.items()):
            if now - last > self.cfg.no_output_seconds:
                return _stuck(
                    StuckKind.NO_OUTPUT,
                    f"command {cmd_id!r} produced no output for {now - last:.0f}s",
                    recovery_name="stop_owned_servers_and_retry",
                    recovery_class=FailureClass.SERVER_RUNTIME,
                )

        # 7) Interactive prompt detection: commands ending in '?', '$ ', or '# '
        #    with no follow-up are not classified here because we do not
        #    see terminal input in the loop events. We expose the helper
        #    so the loop can call it explicitly.
        return StuckState(kind=StuckKind.IDLE)

    # ---- config knobs ----

    def expect_scoring(self, value: bool) -> None:
        """Set the expectation that a scoring command will be invoked."""
        self._expect_scoring = bool(value)

    def reset_finish_tracker(self) -> None:
        self._last_finish_attempt_summary = ""


# ---------- interactive prompt helper ----------


_INTERACTIVE_HINTS = (
    "password:",
    "passphrase:",
    "are you sure",
    "[y/n]",
    "(yes/no)",
    "press enter to continue",
    "press any key",
    "login:",
    "sudo ",
)


def looks_like_interactive_prompt(output: str) -> bool:
    """Best-effort detection that a command is waiting for input.

    The loop calls this when a command's last line of output looks
    like a prompt. It is intentionally narrow: false positives would
    cause the watchdog to nuke healthy processes.
    """
    if not output:
        return False
    tail = output.rstrip().splitlines()[-1] if output.rstrip() else ""
    if not tail:
        return False
    low = tail.lower().strip()
    return any(hint in low for hint in _INTERACTIVE_HINTS)


# ---------- helpers ----------


def _stuck(
    kind: StuckKind,
    summary: str,
    *,
    recovery_name: str | None = None,
    recovery_class: FailureClass | None = None,
    details: dict | None = None,
) -> StuckState:
    s = StuckState(
        kind=kind,
        summary=summary,
        details=details or {},
    )
    if recovery_name is None and recovery_class is not None:
        action = pick_recovery(recovery_class)
        s.recovery_name = action.name
        s.recovery_class = action.failure_class
    else:
        s.recovery_name = recovery_name or ""
        s.recovery_class = recovery_class
    return s


def _args_sig_from_cmd(cmd: str) -> str:
    """Tiny command-similarity signature.

    Strips the first token's path and numeric args, so "pytest -x" and
    "pytest -x -v" do not look the same but "pytest -x" and
    "pytest -x" do.
    """
    parts = cmd.strip().split()
    if not parts:
        return ""
    head = parts[0].rsplit("/", 1)[-1]
    tail = [p for p in parts[1:] if not p.startswith("-") and not p.isdigit()]
    return f"{head} {' '.join(tail)}".strip()


def _looks_like_evidence(summary: str) -> bool:
    """Heuristic: does this finish-summary include a concrete signal?

    Mirrors cheater.agent_loop._evidence_is_concrete. We duplicate
    the logic to avoid a cross-module import for the watchdog; the
    rules are stable and small.
    """
    if not summary or len(summary.strip()) < 5:
        return False
    s = summary.lower()
    if "passed" in s or "failed" in s:
        return True
    if "exit " in s or "exit=" in s:
        return True
    if ".py" in s or ".json" in s or ".toml" in s:
        return True
    if "test_" in s or "::" in s:
        return True
    return False
