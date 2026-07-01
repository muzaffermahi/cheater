"""Recovery ladder, capsules, and banned actions for Cheater.

When the anti-stall detector (cheater/anti_stall.py) decides a
worker is no longer useful, the recovery layer decides what to do
about it. It does not spin: it escalates through a finite ladder
of meaningful interventions, and only after the ladder is exhausted
does it emit an honest blocked report.

The recovery layer composes with the existing systems:
  * It reads the lifecycle CompletionLedger for "what was tried".
  * It reads the anti-stall ProgressLedger for fingerprints.
  * It picks a new strategy via cheater.strategy.switch_strategy_for.
  * It produces a handoff capsule for a fresh worker.

Public API:

  RecoveryLevel           -- enumeration: NONE | LOCAL_NUDGE | CONTEXT_REBASE | FRESH_WORKER | STRATEGY_SWITCH | ISOLATE | HONEST_BLOCKED
  BannedAction            -- a specific (action, args_sig) banned until new evidence
  BannedActionSet         -- structural banned-action mechanism
  RecoveryCapsule         -- handoff capsule for a fresh worker
  RecoveryAction          -- one recovery step with cost + limits
  RecoveryLadder          -- escalates through levels; emits a blocked report
  BlockedReport           -- the honest-blocked report
  build_capsule           -- build a capsule from ledger + progress + history
  render_capsule_for_model -- render a capsule as a small prompt section
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from cheater.anti_stall import (
    ProgressLedger,
    StallAssessment,
    StallDetector,
    StallReason,
    tool_args_sig,
)
from cheater.ledger import CompletionLedger
from cheater.lifecycle import FailureClass
from cheater.playbooks import Playbook, PlaybookKind
from cheater.strategy import (
    Strategy,
    StrategyRecord,
    strategy_differs,
    switch_strategy_for,
    valid_kinds_for,
)


# ---------- recovery level ----------


class RecoveryLevel(int, Enum):
    """A finite recovery ladder.

    Higher numbers are more invasive. The ladder is bounded; the
    top level (HONEST_BLOCKED) is the only way the harness ever
    gives up.
    """

    NONE = 0
    LOCAL_NUDGE = 1
    CONTEXT_REBASE = 2
    FRESH_WORKER = 3
    STRATEGY_SWITCH = 4
    ISOLATE = 5
    HONEST_BLOCKED = 6


_LEVEL_NAMES: dict[RecoveryLevel, str] = {
    RecoveryLevel.NONE: "none",
    RecoveryLevel.LOCAL_NUDGE: "local_nudge",
    RecoveryLevel.CONTEXT_REBASE: "context_rebase",
    RecoveryLevel.FRESH_WORKER: "fresh_worker",
    RecoveryLevel.STRATEGY_SWITCH: "strategy_switch",
    RecoveryLevel.ISOLATE: "isolate",
    RecoveryLevel.HONEST_BLOCKED: "honest_blocked",
}


# ---------- banned action ----------


@dataclass
class BannedAction:
    """A specific action banned until new evidence appears.

    Banning is structural: the loop asks the controller "is this
    action allowed?" and the controller checks the set. This is
    far less brittle than prose like "don't run pytest".
    """

    action: str
    args_sig: str = ""        # the specific signature; "*" means any args
    reason: str = ""
    banned_at: float = field(default_factory=time.time)
    # If a step produces progress for the *same* action with a
    # *different* args_sig, we lift the ban automatically. The
    # controller can also lift it explicitly.
    lifted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "args_sig": self.args_sig,
            "reason": self.reason,
            "banned_at": self.banned_at,
            "lifted": self.lifted,
        }


@dataclass
class BannedActionSet:
    """The set of currently banned actions.

    Used by the loop to reject a tool call that the harness has
    decided is no longer useful. The set has a maximum size: the
    harness does not maintain a long history of bans, only the
    active ones.
    """

    max_bans: int = 32
    items: list[BannedAction] = field(default_factory=list)

    def ban(self, action: str, args_sig: str = "*", reason: str = "") -> None:
        # De-dup: don't re-ban the same (action, args_sig).
        for item in self.items:
            if item.action == action and item.args_sig == args_sig and not item.lifted:
                return
        self.items.append(BannedAction(action=action, args_sig=args_sig, reason=reason))
        # Trim oldest if we are at the cap.
        if len(self.items) > self.max_bans:
            self.items = self.items[-self.max_bans:]

    def lift_all(self) -> None:
        """Lift every ban. Used when fresh evidence arrives."""
        for item in self.items:
            item.lifted = True

    def is_banned(self, action: str, args_sig: str) -> bool:
        for item in self.items:
            if item.lifted:
                continue
            if item.action != action:
                continue
            if item.args_sig == "*" or item.args_sig == args_sig:
                return True
        return False

    def active(self) -> list[BannedAction]:
        return [b for b in self.items if not b.lifted]

    def to_dict(self) -> dict[str, Any]:
        return {
            "count": len(self.active()),
            "items": [b.to_dict() for b in self.active()],
        }


# ---------- recovery capsule ----------


@dataclass
class RecoveryCapsule:
    """A small, structured handoff for a fresh worker.

    The capsule is the only thing a fresh worker sees about the
    previous worker's history. It is deliberately small: a weak
    model can hold it in context, and it does not dump the full
    conversation.
    """

    user_goal: str
    playbook: PlaybookKind | None
    files_changed: list[str] = field(default_factory=list)
    files_likely_relevant: list[str] = field(default_factory=list)
    commands_tried: list[str] = field(default_factory=list)
    failed_outputs_summary: list[str] = field(default_factory=list)
    banned_actions: list[BannedAction] = field(default_factory=list)
    current_failure_class: str = ""
    invariants: list[str] = field(default_factory=list)
    completion_criteria: list[str] = field(default_factory=list)
    next_verification_command: str = ""
    artifact_paths: list[str] = field(default_factory=list)
    new_strategy: Strategy | None = None
    previous_strategies: list[Strategy] = field(default_factory=list)
    # A short human-readable summary the fresh worker can quote.
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "user_goal": self.user_goal,
            "playbook": self.playbook.value if isinstance(self.playbook, PlaybookKind) else self.playbook,
            "files_changed": list(self.files_changed),
            "files_likely_relevant": list(self.files_likely_relevant),
            "commands_tried": list(self.commands_tried[-20:]),
            "failed_outputs_summary": list(self.failed_outputs_summary[-10:]),
            "banned_actions": [b.to_dict() for b in self.banned_actions],
            "current_failure_class": self.current_failure_class,
            "invariants": list(self.invariants),
            "completion_criteria": list(self.completion_criteria),
            "next_verification_command": self.next_verification_command,
            "artifact_paths": list(self.artifact_paths),
            "new_strategy": self.new_strategy.to_dict() if self.new_strategy else None,
            "previous_strategies": [s.to_dict() for s in self.previous_strategies],
            "summary": self.summary,
        }


def build_capsule(
    *,
    user_goal: str,
    playbook: Playbook | None,
    ledger: CompletionLedger,
    detector: StallDetector,
    banned: BannedActionSet,
    strategy_record: StrategyRecord,
    next_strategy: Strategy | None = None,
    next_verification_command: str = "",
    max_failed_outputs: int = 10,
) -> RecoveryCapsule:
    """Build a handoff capsule from the current state.

    The capsule extracts the relevant bits of the ledger and
    detector, drops the noise, and presents them in a form a fresh
    worker can act on.
    """
    # Failed outputs: take from the ledger entries that look like
    # "failure" rows.
    failed_outputs: list[str] = []
    for entry in ledger.entries:
        if entry.kind == "failure":
            failed_outputs.append(entry.summary)
        if entry.kind == "verification_stage" and "fail" in (entry.extra.get("status") or "").lower():
            failed_outputs.append(
                f"{entry.extra.get('stage', '?')}: {entry.summary}"
            )
    failed_outputs = failed_outputs[-max_failed_outputs:]

    # Current failure class: the last "failure" entry, or the
    # current assessment's evidence.
    current_failure_class = ""
    for entry in reversed(ledger.entries):
        if entry.kind == "failure":
            current_failure_class = entry.extra.get("failure_class", "")
            break

    files_changed = list(ledger.changed_files)
    files_likely_relevant = list(detector.ledger.files_read_seen - set(files_changed))
    # Filter to source files.
    files_likely_relevant = [f for f in files_likely_relevant if f][:20]

    invariants = list(playbook.invariants) if playbook is not None else []
    completion = list(playbook.worker_brief.splitlines()) if playbook is not None else []

    summary = _capsule_summary(
        user_goal=user_goal,
        playbook=playbook,
        files_changed=files_changed,
        commands_tried=ledger.commands_run,
        current_failure_class=current_failure_class,
        next_strategy=next_strategy,
    )

    return RecoveryCapsule(
        user_goal=user_goal,
        playbook=playbook.kind if playbook is not None else None,
        files_changed=files_changed,
        files_likely_relevant=files_likely_relevant,
        commands_tried=list(ledger.commands_run),
        failed_outputs_summary=failed_outputs,
        banned_actions=list(banned.active()),
        current_failure_class=current_failure_class,
        invariants=invariants,
        completion_criteria=completion,
        next_verification_command=next_verification_command,
        artifact_paths=list(ledger.artifacts),
        new_strategy=next_strategy,
        previous_strategies=list(strategy_record.strategies),
        summary=summary,
    )


def _capsule_summary(
    *,
    user_goal: str,
    playbook: Playbook | None,
    files_changed: list[str],
    commands_tried: list[str],
    current_failure_class: str,
    next_strategy: Strategy | None,
) -> str:
    parts: list[str] = []
    parts.append(f"GOAL: {user_goal}")
    if playbook is not None:
        parts.append(f"PLAYBOOK: {playbook.title}")
    if files_changed:
        parts.append(
            "FILES CHANGED: " + ", ".join(files_changed[:8])
        )
    if commands_tried:
        parts.append(
            "COMMANDS TRIED: " + ", ".join(commands_tried[:6])
        )
    if current_failure_class:
        parts.append(f"CURRENT FAILURE CLASS: {current_failure_class}")
    if next_strategy is not None:
        parts.append(
            "NEW STRATEGY: "
            + f"kind={next_strategy.kind.value} "
            + f"hypothesis={next_strategy.hypothesis}"
        )
    return " | ".join(parts)


def render_capsule_for_model(capsule: RecoveryCapsule) -> str:
    """Render a capsule as a small, bounded section for a prompt.

    The model sees this in its system prompt. It is deliberately
    small: no full conversation, no large file dumps, no full logs.
    """
    lines: list[str] = []
    lines.append("=== ANTI-STALL HANDOFF CAPSULE ===")
    lines.append(f"User goal: {capsule.user_goal}")
    if capsule.playbook is not None:
        lines.append(f"Playbook: {capsule.playbook.value}")
    if capsule.files_changed:
        lines.append(
            "Files already changed: " + ", ".join(capsule.files_changed[:8])
        )
    if capsule.files_likely_relevant:
        lines.append(
            "Files likely relevant: " + ", ".join(capsule.files_likely_relevant[:8])
        )
    if capsule.commands_tried:
        lines.append(
            "Commands already tried: " + ", ".join(capsule.commands_tried[-6:])
        )
    if capsule.failed_outputs_summary:
        lines.append("Failed outputs (summarised):")
        for s in capsule.failed_outputs_summary[-5:]:
            lines.append(f"  - {s[:160]}")
    if capsule.banned_actions:
        lines.append("BANNED ACTIONS (do NOT repeat these):")
        for b in capsule.banned_actions:
            sig_part = f" args={b.args_sig!r}" if b.args_sig and b.args_sig != "*" else ""
            lines.append(f"  - {b.action}{sig_part}: {b.reason}")
    if capsule.current_failure_class:
        lines.append(f"Current failure class: {capsule.current_failure_class}")
    if capsule.invariants:
        lines.append("Invariants (must not violate):")
        for inv in capsule.invariants[:5]:
            lines.append(f"  - {inv}")
    if capsule.new_strategy is not None:
        s = capsule.new_strategy
        lines.append(f"NEW STRATEGY: {s.kind.value}")
        if s.hypothesis:
            lines.append(f"  hypothesis: {s.hypothesis}")
        if s.smallest_next_action:
            lines.append(f"  smallest_next_action: {s.smallest_next_action}")
        if s.verification_target:
            lines.append(f"  verification_target: {s.verification_target}")
        if s.evidence_needed:
            lines.append(f"  evidence_needed: {s.evidence_needed}")
    if capsule.next_verification_command:
        lines.append(f"Next verification command: {capsule.next_verification_command}")
    if capsule.artifact_paths:
        lines.append(
            "Artifact paths: " + ", ".join(capsule.artifact_paths[:6])
        )
    if capsule.previous_strategies:
        kinds = sorted({s.kind.value for s in capsule.previous_strategies})
        lines.append(f"Previous strategies tried: {', '.join(kinds)}")
    lines.append("=== END CAPSULE ===")
    return "\n".join(lines)


# ---------- recovery action ----------


@dataclass
class RecoveryAction:
    """A single recovery step the harness is taking.

    The ladder emits one of these per escalation. The cost field
    lets the loop decide whether to apply the action or to stop.
    """

    level: RecoveryLevel
    name: str
    description: str
    cost: str = "cheap"          # cheap | moderate | expensive
    capsule: RecoveryCapsule | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level.value,
            "level_name": _LEVEL_NAMES[self.level],
            "name": self.name,
            "description": self.description,
            "cost": self.cost,
            "capsule": self.capsule.to_dict() if self.capsule else None,
            "extra": dict(self.extra),
        }


# ---------- blocked report ----------


@dataclass
class BlockedReport:
    """An honest-blocked report emitted at the top of the ladder.

    This is what the harness outputs when the ladder is exhausted.
    The model never gets to write this; the harness writes it from
    the data it has collected.
    """

    user_goal: str
    playbook: PlaybookKind | None
    level: RecoveryLevel
    stall_reason: str
    attempts_by_level: dict[str, int] = field(default_factory=dict)
    tried: list[str] = field(default_factory=list)
    failed_outputs: list[str] = field(default_factory=list)
    files_changed: list[str] = field(default_factory=list)
    best_hypothesis: str = ""
    missing_evidence: list[str] = field(default_factory=list)
    unblock_commands: list[str] = field(default_factory=list)
    strategies_tried: list[Strategy] = field(default_factory=list)
    capsule: RecoveryCapsule | None = None
    at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "user_goal": self.user_goal,
            "playbook": self.playbook.value if isinstance(self.playbook, PlaybookKind) else self.playbook,
            "level": self.level.value,
            "level_name": _LEVEL_NAMES[self.level],
            "stall_reason": self.stall_reason,
            "attempts_by_level": dict(self.attempts_by_level),
            "tried": list(self.tried),
            "failed_outputs": list(self.failed_outputs),
            "files_changed": list(self.files_changed),
            "best_hypothesis": self.best_hypothesis,
            "missing_evidence": list(self.missing_evidence),
            "unblock_commands": list(self.unblock_commands),
            "strategies_tried": [s.to_dict() for s in self.strategies_tried],
            "capsule": self.capsule.to_dict() if self.capsule else None,
            "at": self.at,
        }

    def to_human(self) -> str:
        lines: list[str] = []
        lines.append(f"BLOCKED: {self.user_goal}")
        if self.playbook is not None:
            lines.append(f"Playbook: {self.playbook.value}")
        lines.append(f"Stall reason: {self.stall_reason}")
        lines.append(f"Recovery level: {_LEVEL_NAMES[self.level]}")
        if self.attempts_by_level:
            lines.append(
                "Attempts: "
                + ", ".join(
                    f"{k}={v}" for k, v in sorted(self.attempts_by_level.items())
                )
            )
        if self.tried:
            lines.append("Tried:")
            for s in self.tried[:10]:
                lines.append(f"  - {s}")
        if self.files_changed:
            lines.append("Files changed:")
            for f in self.files_changed[:8]:
                lines.append(f"  - {f}")
        if self.best_hypothesis:
            lines.append(f"Best hypothesis: {self.best_hypothesis}")
        if self.missing_evidence:
            lines.append("Missing evidence:")
            for m in self.missing_evidence:
                lines.append(f"  - {m}")
        if self.unblock_commands:
            lines.append("Suggested unblock commands:")
            for u in self.unblock_commands:
                lines.append(f"  - {u}")
        return "\n".join(lines)


# ---------- recovery ladder ----------


@dataclass
class LadderConfig:
    """Configuration for the recovery ladder.

    All values are tunable. The defaults are deliberately modest
    so a fresh agent has room to work; a tighter setting is
    appropriate for benchmarks that want to bound the run time.
    """

    # Maximum number of LOCAL_NUDGE attempts before escalating.
    max_local_nudges: int = 2
    # Maximum number of CONTEXT_REBASE attempts.
    max_context_rebases: int = 1
    # Maximum number of FRESH_WORKER attempts.
    max_fresh_workers: int = 1
    # Maximum number of STRATEGY_SWITCH attempts.
    max_strategy_switches: int = 2
    # Maximum number of ISOLATE attempts.
    max_isolations: int = 1
    # Maximum number of total recovery actions (excluding HONEST_BLOCKED).
    max_total_recoveries: int = 6


class RecoveryLadder:
    """The recovery ladder.

    The ladder is stateful: it tracks the level and how many
    attempts have been made at each level. It does not actually
    run the recovery; it produces a RecoveryAction that the
    anti-stall controller decides whether to apply.

    Escalation is monotonic: the ladder only goes up. The only
    way to drop a level is HONEST_BLOCKED, which is the
    terminal state.
    """

    def __init__(self, cfg: LadderConfig | None = None) -> None:
        self.cfg = cfg or LadderConfig()
        self.level: RecoveryLevel = RecoveryLevel.NONE
        self.attempts_by_level: dict[str, int] = {
            _LEVEL_NAMES[level]: 0
            for level in RecoveryLevel
            if level != RecoveryLevel.NONE
        }
        self.total_recoveries: int = 0
        self.blocked_report: BlockedReport | None = None

    # ---- public ----

    def reset(self) -> None:
        self.level = RecoveryLevel.NONE
        for k in self.attempts_by_level:
            self.attempts_by_level[k] = 0
        self.total_recoveries = 0
        self.blocked_report = None

    def is_blocked(self) -> bool:
        return self.level == RecoveryLevel.HONEST_BLOCKED

    def can_attempt(self, level: RecoveryLevel) -> bool:
        if self.is_blocked():
            return False
        cap = self._cap_for(level)
        if cap is None:
            return False
        name = _LEVEL_NAMES[level]
        return self.attempts_by_level.get(name, 0) < cap and self.total_recoveries < self.cfg.max_total_recoveries

    def escalate(
        self,
        *,
        assessment: StallAssessment,
        user_goal: str,
        playbook: Playbook | None,
        ledger: CompletionLedger,
        detector: StallDetector,
        banned: BannedActionSet,
        strategy_record: StrategyRecord,
        next_verification_command: str = "",
    ) -> RecoveryAction:
        """Pick the next recovery action.

        The action is one level above the current level (or the
        current level, if the worker is still allowed to attempt
        that level). The controller decides whether to apply it.
        """
        # If we are already at HONEST_BLOCKED, return a final
        # "blocked" action that just re-emits the report.
        if self.is_blocked():
            return RecoveryAction(
                level=RecoveryLevel.HONEST_BLOCKED,
                name="already_blocked",
                description="the ladder has already emitted an honest blocked report",
                cost="cheap",
            )

        # If the current level is allowed to attempt again, stay.
        target = self.level
        if target == RecoveryLevel.NONE or not self.can_attempt(target):
            target = self._next_level()
        if target is None or target == RecoveryLevel.HONEST_BLOCKED:
            return self._emit_blocked(
                assessment=assessment,
                user_goal=user_goal,
                playbook=playbook,
                ledger=ledger,
                strategy_record=strategy_record,
            )
        # If we are escalating, the new level becomes the current.
        if int(target) > int(self.level):
            self.level = target
        # Build the action.
        self.attempts_by_level[_LEVEL_NAMES[target]] += 1
        self.total_recoveries += 1
        return self._build_action(
            level=target,
            assessment=assessment,
            user_goal=user_goal,
            playbook=playbook,
            ledger=ledger,
            detector=detector,
            banned=banned,
            strategy_record=strategy_record,
            next_verification_command=next_verification_command,
        )

    # ---- private ----

    def _next_level(self) -> RecoveryLevel | None:
        # Walk up the ladder until we find a level that has
        # remaining attempts, or we reach the top.
        order = [
            RecoveryLevel.LOCAL_NUDGE,
            RecoveryLevel.CONTEXT_REBASE,
            RecoveryLevel.FRESH_WORKER,
            RecoveryLevel.STRATEGY_SWITCH,
            RecoveryLevel.ISOLATE,
            RecoveryLevel.HONEST_BLOCKED,
        ]
        for lvl in order:
            if self.can_attempt(lvl):
                return lvl
        return RecoveryLevel.HONEST_BLOCKED

    def _cap_for(self, level: RecoveryLevel) -> int | None:
        return {
            RecoveryLevel.LOCAL_NUDGE: self.cfg.max_local_nudges,
            RecoveryLevel.CONTEXT_REBASE: self.cfg.max_context_rebases,
            RecoveryLevel.FRESH_WORKER: self.cfg.max_fresh_workers,
            RecoveryLevel.STRATEGY_SWITCH: self.cfg.max_strategy_switches,
            RecoveryLevel.ISOLATE: self.cfg.max_isolations,
            RecoveryLevel.HONEST_BLOCKED: 1,
        }.get(level)

    def _build_action(
        self,
        *,
        level: RecoveryLevel,
        assessment: StallAssessment,
        user_goal: str,
        playbook: Playbook | None,
        ledger: CompletionLedger,
        detector: StallDetector,
        banned: BannedActionSet,
        strategy_record: StrategyRecord,
        next_verification_command: str,
    ) -> RecoveryAction:
        # Build the next strategy for the new level.
        next_strategy = self._pick_strategy(
            assessment=assessment,
            playbook=playbook,
            strategy_record=strategy_record,
        )
        # The capsule is built only at FRESH_WORKER and above.
        capsule = None
        if level.value >= RecoveryLevel.FRESH_WORKER.value:
            capsule = build_capsule(
                user_goal=user_goal,
                playbook=playbook,
                ledger=ledger,
                detector=detector,
                banned=banned,
                strategy_record=strategy_record,
                next_strategy=next_strategy,
                next_verification_command=next_verification_command,
            )
            strategy_record.add(next_strategy)
        # Per-level specific action.
        if level == RecoveryLevel.LOCAL_NUDGE:
            return RecoveryAction(
                level=level,
                name="local_nudge",
                description="tell the same worker what repeated and what new evidence is required",
                cost="cheap",
                extra={
                    "stall_reason": assessment.reason.value,
                    "stall_summary": assessment.summary,
                    "banned_now": self._ban_from_assessment(assessment, banned),
                    "next_strategy": next_strategy.to_dict() if next_strategy else None,
                },
            )
        if level == RecoveryLevel.CONTEXT_REBASE:
            return RecoveryAction(
                level=level,
                name="context_rebase",
                description="compact the conversation; preserve only goal, changes, failures, hypothesis, next action",
                cost="moderate",
                capsule=capsule,
                extra={
                    "next_strategy": next_strategy.to_dict() if next_strategy else None,
                },
            )
        if level == RecoveryLevel.FRESH_WORKER:
            return RecoveryAction(
                level=level,
                name="fresh_worker",
                description="spawn a new worker with the recovery capsule; ban the previously-tried actions",
                cost="expensive",
                capsule=capsule,
                extra={
                    "banned_now": self._ban_from_assessment(assessment, banned),
                    "next_strategy": next_strategy.to_dict() if next_strategy else None,
                },
            )
        if level == RecoveryLevel.STRATEGY_SWITCH:
            return RecoveryAction(
                level=level,
                name="strategy_switch",
                description="switch to a different strategy; the previous one is banned",
                cost="moderate",
                capsule=capsule,
                extra={
                    "switch_kind": next_strategy.kind.value if next_strategy else "",
                    "next_strategy": next_strategy.to_dict() if next_strategy else None,
                    "banned_now": self._ban_from_assessment(assessment, banned),
                },
            )
        if level == RecoveryLevel.ISOLATE:
            return RecoveryAction(
                level=level,
                name="isolate",
                description="run the smallest possible reproducible check; ignore everything else for one step",
                cost="moderate",
                capsule=capsule,
                extra={
                    "next_strategy": next_strategy.to_dict() if next_strategy else None,
                },
            )
        return RecoveryAction(
            level=level,
            name="unknown",
            description="no recovery action for this level",
            cost="cheap",
        )

    def _pick_strategy(
        self,
        *,
        assessment: StallAssessment,
        playbook: Playbook | None,
        strategy_record: StrategyRecord,
    ) -> Strategy:
        # Map stall reason + playbook to a candidate strategy. If
        # the candidate is structurally the same as the worker's
        # last strategy, escalate within the strategy pool.
        pb_kind = playbook.kind if playbook is not None else None
        next_strategy = switch_strategy_for(
            reason=assessment.reason,
            playbook=pb_kind,
            failure_class=_failure_class_from_evidence(assessment.evidence),
        )
        last = strategy_record.last
        if last is not None and not strategy_differs(last, next_strategy):
            # Try a different kind from the same playbook.
            valid = sorted(valid_kinds_for(pb_kind))
            for k in valid:
                if k == last.kind:
                    continue
                candidate = switch_strategy_for(
                    reason=assessment.reason,
                    playbook=pb_kind,
                    failure_class=_failure_class_from_evidence(assessment.evidence),
                )
                # Force the kind.
                candidate.kind = k
                if strategy_differs(last, candidate):
                    next_strategy = candidate
                    break
        return next_strategy

    def _ban_from_assessment(
        self, assessment: StallAssessment, banned: BannedActionSet
    ) -> list[dict[str, Any]]:
        """Translate the assessment into structural bans."""
        banned_now: list[dict[str, Any]] = []
        if assessment.reason == StallReason.REPEATED_COMMAND:
            sig = assessment.evidence.get("command_sig", "*")
            banned.ban("run_command", sig, reason="same command ran too many times")
            banned_now.append({"action": "run_command", "args_sig": sig})
        elif assessment.reason == StallReason.REPEATED_TOOL_CALL:
            action = assessment.evidence.get("action", "")
            sig = assessment.evidence.get("args_sig", "*")
            if action:
                banned.ban(action, sig, reason="same tool call repeated too many times")
                banned_now.append({"action": action, "args_sig": sig})
        elif assessment.reason == StallReason.REPEATED_FILE_READ:
            # Cannot ban a specific read, but we can ban read_file
            # for the specific path until an edit happens.
            # Since the action sig for read_file is the path, we
            # can ban that exact (action, args_sig).
            path = assessment.evidence.get("path", "")
            if path:
                sig = tool_args_sig("read_file", {"path": path})
                banned.ban("read_file", sig, reason="same file read too many times without edits")
                banned_now.append({"action": "read_file", "args_sig": sig})
        elif assessment.reason == StallReason.REPEATED_FINISH:
            banned.ban("finish", "*", reason="finish already attempted; produce new evidence first")
            banned_now.append({"action": "finish", "args_sig": "*"})
        elif assessment.reason == StallReason.REPEATED_MODEL_MESSAGE:
            # No structural ban; the controller should still steer.
            pass
        elif assessment.reason == StallReason.VERIFY_NO_NEW_HYPOTHESIS:
            # No new hypothesis yet; do not let the worker rerun the
            # same verification commands until they have a new plan.
            cmd_sig = assessment.evidence.get("command_sig", "*")
            banned.ban("run_command", cmd_sig, reason="verification ran with no new hypothesis")
            banned_now.append({"action": "run_command", "args_sig": cmd_sig})
        elif assessment.reason == StallReason.SCORING_SKIPPED:
            # The worker is not running the scoring command. We
            # cannot ban "not running" structurally, but we can
            # lift bans on scoring commands.
            banned_now.append({"hint": "lift bans on scoring commands"})
        return banned_now

    def _emit_blocked(
        self,
        *,
        assessment: StallAssessment,
        user_goal: str,
        playbook: Playbook | None,
        ledger: CompletionLedger,
        strategy_record: StrategyRecord,
    ) -> RecoveryAction:
        self.level = RecoveryLevel.HONEST_BLOCKED
        self.attempts_by_level["honest_blocked"] = 1

        # Compose the blocked report from everything we have.
        failed_outputs: list[str] = []
        for entry in ledger.entries:
            if entry.kind == "failure":
                failed_outputs.append(entry.summary)
        last_strategy = strategy_record.last
        best_hypothesis = last_strategy.hypothesis if last_strategy is not None else ""
        missing = []
        if not ledger.changed_files:
            missing.append("no files were changed")
        if not ledger.verification:
            missing.append("no verification record was produced")
        if not ledger.commands_run:
            missing.append("no commands were run")
        unblock: list[str] = []
        if last_strategy is not None and last_strategy.smallest_next_action:
            unblock.append(last_strategy.smallest_next_action)
        if not unblock and playbook is not None:
            # Default: the playbook's first verification command.
            for spec in playbook.plan:
                if getattr(spec, "description", ""):
                    unblock.append(spec.description)
                    break

        capsule = build_capsule(
            user_goal=user_goal,
            playbook=playbook,
            ledger=ledger,
            # detector is not strictly needed at this point, but
            # we accept None defensively.
            detector=type("D", (), {"ledger": ProgressLedger()})(),  # type: ignore[arg-type]
            banned=BannedActionSet(),
            strategy_record=strategy_record,
        )

        report = BlockedReport(
            user_goal=user_goal,
            playbook=playbook.kind if playbook is not None else None,
            level=RecoveryLevel.HONEST_BLOCKED,
            stall_reason=assessment.reason.value,
            attempts_by_level=dict(self.attempts_by_level),
            tried=list(ledger.commands_run)[-20:],
            failed_outputs=failed_outputs[-10:],
            files_changed=list(ledger.changed_files),
            best_hypothesis=best_hypothesis,
            missing_evidence=missing,
            unblock_commands=unblock,
            strategies_tried=list(strategy_record.strategies),
            capsule=capsule,
        )
        self.blocked_report = report
        return RecoveryAction(
            level=RecoveryLevel.HONEST_BLOCKED,
            name="honest_blocked",
            description="ladder is exhausted; emit an honest blocked report and stop",
            cost="cheap",
            capsule=capsule,
            extra={"report": report.to_dict()},
        )


def _failure_class_from_evidence(evidence: dict[str, Any]) -> FailureClass | None:
    cls = evidence.get("failure_class")
    if not cls:
        return None
    try:
        return FailureClass(cls)
    except ValueError:
        return None
