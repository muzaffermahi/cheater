"""Strategy tracking and novelty for the Cheater anti-stall system.

The recovery layer (cheater/recovery.py) decides WHEN to escalate.
This module decides WHAT strategy the next worker should try. It
also enforces that a fresh worker's plan is genuinely different
from the previous one, structurally.

Public API:

  Strategy            -- a structured plan: hypothesis + smallest next action
  StrategyKind        -- coarse taxonomy of strategies
  StrategyRecord      -- a record of one worker's strategy
  strategy_differs    -- is strategy A meaningfully different from B?
  switch_strategy_for -- pick a new strategy for a stall reason + playbook
  SwitchKind          -- the type of strategy switch recommended
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from cheater.anti_stall import StallReason
from cheater.lifecycle import FailureClass
from cheater.playbooks import PlaybookKind


# ---------- strategy taxonomy ----------


class StrategyKind(str, Enum):
    """A coarse taxonomy of worker strategies.

    These are deliberately few. The recovery layer uses them to
    pick the next strategy when the current one stalls. Playbooks
    may restrict which kinds are allowed.
    """

    IMPLEMENT = "implement"           # edit / fix the code
    DIAGNOSE = "diagnose"             # read + grep + understand first
    REPRODUCE = "reproduce"           # build the smallest failing test
    EVIDENCE_SEARCH = "evidence_search"  # read docs / search memory
    MINIMAL_PATCH = "minimal_patch"   # one-file, one-line change
    BASELINE_WORKFLOW = "baseline_workflow"  # for snapshot tasks
    DEPENDENCY_INSPECT = "dependency_inspect"  # for missing-dep tasks
    ISOLATE = "isolate"               # smallest reproducible check
    BLOCKED = "blocked"               # honest give-up


class SwitchKind(str, Enum):
    """The kind of strategy switch the recovery layer is recommending."""

    NARROW = "narrow"                 # narrow scope (broad -> focused)
    SHIFT = "shift"                   # shift from one approach to another
    NARROWER_FAILURE = "narrower_failure"  # classify the failure better
    RECLASSIFY = "reclassify"         # the failure class is wrong
    NO_CHANGE = "no_change"           # stay the course but reset state


# ---------- strategy record ----------


@dataclass
class Strategy:
    """A structured plan a worker commits to.

    The harness uses ``hypothesis`` + ``smallest_next_action`` +
    ``verification_target`` to detect "same strategy, different
    words" and reject the new plan.
    """

    kind: StrategyKind
    hypothesis: str = ""
    smallest_next_action: str = ""     # e.g. "read_file cheater/x.py"
    verification_target: str = ""      # e.g. "pytest tests/test_x.py passes"
    evidence_needed: str = ""          # e.g. "the actual error message"
    # The action + args signature of the proposed next step. Used
    # for cheap structural comparison.
    next_args_sig: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "hypothesis": self.hypothesis,
            "smallest_next_action": self.smallest_next_action,
            "verification_target": self.verification_target,
            "evidence_needed": self.evidence_needed,
            "next_args_sig": self.next_args_sig,
        }


@dataclass
class StrategyRecord:
    """A worker's strategy, plus the worker's history of strategies.

    The anti-stall controller keeps the record of all strategies a
    worker has tried so that a fresh worker can be told "these are
    banned, try something genuinely different".
    """

    strategies: list[Strategy] = field(default_factory=list)

    def add(self, strategy: Strategy) -> None:
        self.strategies.append(strategy)

    @property
    def last(self) -> Strategy | None:
        return self.strategies[-1] if self.strategies else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "count": len(self.strategies),
            "last": self.last.to_dict() if self.last else None,
            "kinds_tried": [s.kind.value for s in self.strategies],
        }


# ---------- novelty check ----------


def strategy_differs(
    a: Strategy,
    b: Strategy,
    *,
    same_hypothesis_means_same: bool = False,
) -> bool:
    """Is strategy B meaningfully different from strategy A?

    Used by the recovery layer to reject "fresh" workers that
    propose the same plan with different words. The check is
    structural: kind, hypothesis, smallest_next_action, and the
    args signature all have to align for the strategies to be
    considered the same.

    A strategy is "the same" iff all of the *set* fields
    (next_args_sig, smallest_next_action, verification_target)
    match. The hypothesis is only a tie-breaker when
    ``same_hypothesis_means_same`` is True.
    """
    if a.kind != b.kind:
        return True
    # Behaviour-defining fields. If both are set and they match,
    # the strategies are doing the same thing.
    pairs: list[tuple[str, str]] = [
        (a.next_args_sig, b.next_args_sig),
        (a.smallest_next_action, b.smallest_next_action),
        (a.verification_target, b.verification_target),
    ]
    for x, y in pairs:
        nx, ny = _norm(x), _norm(y)
        if not nx and not ny:
            continue
        if nx and ny and nx == ny:
            continue
        return True
    if same_hypothesis_means_same and _norm(a.hypothesis) and _norm(b.hypothesis):
        return _norm(a.hypothesis) != _norm(b.hypothesis)
    return False


def _norm(s: str) -> str:
    if not s:
        return ""
    return " ".join(s.lower().split())


# ---------- strategy switch heuristics ----------


# Per-stall-reason: which strategy to switch to.
# These are the recommended "what to try next" defaults. The
# recovery layer can override them based on context.
_STALL_TO_STRATEGY: dict[StallReason, tuple[StrategyKind, SwitchKind, str]] = {
    StallReason.REPEATED_COMMAND: (
        StrategyKind.DIAGNOSE,
        SwitchKind.SHIFT,
        "the same command is repeating; pause, read the failure, then re-run with a different argument",
    ),
    StallReason.REPEATED_TOOL_CALL: (
        StrategyKind.DIAGNOSE,
        SwitchKind.SHIFT,
        "the same tool call is repeating; pick a different tool or different arguments",
    ),
    StallReason.REPEATED_FILE_READ: (
        StrategyKind.IMPLEMENT,
        SwitchKind.SHIFT,
        "the same file is being re-read; make an edit to change it, then re-read with a new question",
    ),
    StallReason.REPEATED_TEST_RESULT: (
        StrategyKind.REPRODUCE,
        SwitchKind.NARROW,
        "the same test result is repeating; build the smallest failing repro and inspect the assertion",
    ),
    StallReason.REPEATED_FINISH: (
        StrategyKind.DIAGNOSE,
        SwitchKind.RECLASSIFY,
        "finish is being attempted without new evidence; produce a verified verification record first",
    ),
    StallReason.REPEATED_MODEL_MESSAGE: (
        StrategyKind.EVIDENCE_SEARCH,
        SwitchKind.SHIFT,
        "the model is emitting the same message; search memory / docs for a different angle",
    ),
    StallReason.NO_DIFF_EDIT: (
        StrategyKind.MINIMAL_PATCH,
        SwitchKind.SHIFT,
        "the edit produced no diff; change exactly one identifier or value, not the whole block",
    ),
    StallReason.VERIFY_NO_NEW_HYPOTHESIS: (
        StrategyKind.DIAGNOSE,
        SwitchKind.NARROWER_FAILURE,
        "verification fails with the same hypothesis; reclassify the failure and pick a new hypothesis",
    ),
    StallReason.OSCILLATION: (
        StrategyKind.ISOLATE,
        SwitchKind.SHIFT,
        "the agent is oscillating; isolate the smallest possible check and try only that",
    ),
    StallReason.HANG_NO_OUTPUT: (
        StrategyKind.ISOLATE,
        SwitchKind.NARROW,
        "a command is hanging with no output; cancel and run a smaller, faster check",
    ),
    StallReason.SERVER_NO_VERIFY: (
        StrategyKind.DIAGNOSE,
        SwitchKind.SHIFT,
        "a server was started but not verified; inspect the server log and run a focused curl/test",
    ),
    StallReason.SCORING_SKIPPED: (
        StrategyKind.DIAGNOSE,
        SwitchKind.NARROW,
        "the scoring step was skipped; produce the smallest possible scoring command and run it",
    ),
    StallReason.NO_PROGRESS: (
        StrategyKind.DIAGNOSE,
        SwitchKind.SHIFT,
        "no progress in the last few steps; pause, list what changed, and try a different approach",
    ),
}


# Per-failure-class: which strategy to prefer.
_FAILURE_TO_STRATEGY: dict[FailureClass, StrategyKind] = {
    FailureClass.APP_BUG: StrategyKind.REPRODUCE,
    FailureClass.TEST_BUG: StrategyKind.DIAGNOSE,
    FailureClass.SERVER_RUNTIME: StrategyKind.ISOLATE,
    FailureClass.DEPENDENCY: StrategyKind.DEPENDENCY_INSPECT,
    FailureClass.SNAPSHOT_BASELINE: StrategyKind.BASELINE_WORKFLOW,
    FailureClass.STALE_WORKSPACE: StrategyKind.ISOLATE,
    FailureClass.COMMAND_INVOCATION: StrategyKind.DIAGNOSE,
    FailureClass.UNKNOWN: StrategyKind.DIAGNOSE,
}


# Per-playbook: which switches are valid.
_PLAYBOOK_VALID_KINDS: dict[PlaybookKind, set[StrategyKind]] = {
    PlaybookKind.WEBAPP: {
        StrategyKind.IMPLEMENT, StrategyKind.DIAGNOSE, StrategyKind.REPRODUCE,
        StrategyKind.EVIDENCE_SEARCH, StrategyKind.MINIMAL_PATCH, StrategyKind.ISOLATE,
        StrategyKind.BLOCKED,
    },
    PlaybookKind.FRONTEND_BUILD: {
        StrategyKind.IMPLEMENT, StrategyKind.DIAGNOSE, StrategyKind.REPRODUCE,
        StrategyKind.EVIDENCE_SEARCH, StrategyKind.MINIMAL_PATCH, StrategyKind.ISOLATE,
        StrategyKind.BLOCKED,
    },
    PlaybookKind.BACKEND_API: {
        StrategyKind.IMPLEMENT, StrategyKind.DIAGNOSE, StrategyKind.REPRODUCE,
        StrategyKind.EVIDENCE_SEARCH, StrategyKind.ISOLATE, StrategyKind.BLOCKED,
    },
    PlaybookKind.CLI_PACKAGE: {
        StrategyKind.IMPLEMENT, StrategyKind.DIAGNOSE, StrategyKind.REPRODUCE,
        StrategyKind.EVIDENCE_SEARCH, StrategyKind.MINIMAL_PATCH, StrategyKind.DEPENDENCY_INSPECT,
        StrategyKind.ISOLATE, StrategyKind.BLOCKED,
    },
    PlaybookKind.VISUAL_SNAPSHOT: {
        StrategyKind.DIAGNOSE, StrategyKind.BASELINE_WORKFLOW, StrategyKind.EVIDENCE_SEARCH,
        StrategyKind.ISOLATE, StrategyKind.BLOCKED,
    },
    PlaybookKind.FULLSTACK_DEV: {
        StrategyKind.IMPLEMENT, StrategyKind.DIAGNOSE, StrategyKind.REPRODUCE,
        StrategyKind.EVIDENCE_SEARCH, StrategyKind.ISOLATE, StrategyKind.BLOCKED,
    },
    PlaybookKind.DOCS_OR_API_MIGRATION: {
        StrategyKind.DIAGNOSE, StrategyKind.EVIDENCE_SEARCH, StrategyKind.MINIMAL_PATCH,
        StrategyKind.ISOLATE, StrategyKind.BLOCKED,
    },
    PlaybookKind.GENERIC: {
        StrategyKind.IMPLEMENT, StrategyKind.DIAGNOSE, StrategyKind.REPRODUCE,
        StrategyKind.EVIDENCE_SEARCH, StrategyKind.MINIMAL_PATCH, StrategyKind.ISOLATE,
        StrategyKind.BLOCKED,
    },
}


def switch_strategy_for(
    *,
    reason: StallReason,
    playbook: PlaybookKind | None,
    failure_class: FailureClass | None = None,
) -> Strategy:
    """Pick a new strategy for a stalled worker.

    The selection is two-layered:
      1. The stall reason picks a default kind + switch kind.
      2. The playbook may restrict which kinds are allowed; if the
         default is not allowed, fall back to DIAGNOSE (always
         allowed) or BLOCKED.
      3. If a failure class is provided, prefer the strategy
         suggested by the failure class if it differs.
    """
    default_kind, switch_kind, hint = _STALL_TO_STRATEGY.get(
        reason,
        (StrategyKind.DIAGNOSE, SwitchKind.NO_CHANGE, "no stall reason; diagnose"),
    )
    if failure_class is not None and failure_class in _FAILURE_TO_STRATEGY:
        candidate = _FAILURE_TO_STRATEGY[failure_class]
        if playbook is None or candidate in _PLAYBOOK_VALID_KINDS.get(playbook, set()):
            default_kind = candidate
    valid = _PLAYBOOK_VALID_KINDS.get(playbook or PlaybookKind.GENERIC, set())
    if valid and default_kind not in valid:
        # Prefer DIAGNOSE; fall back to BLOCKED.
        if StrategyKind.DIAGNOSE in valid:
            default_kind = StrategyKind.DIAGNOSE
        else:
            default_kind = StrategyKind.BLOCKED
    return Strategy(
        kind=default_kind,
        hypothesis=hint,
        smallest_next_action=_smallest_action_for(default_kind),
        verification_target=_verification_target_for(default_kind),
        evidence_needed=_evidence_needed_for(default_kind),
    )


def _smallest_action_for(kind: StrategyKind) -> str:
    return {
        StrategyKind.IMPLEMENT: "edit_file on the most likely file",
        StrategyKind.DIAGNOSE: "read_file on the most likely file, then search_code for the error",
        StrategyKind.REPRODUCE: "run_command pytest tests/test_x.py -x -q with the smallest test name",
        StrategyKind.EVIDENCE_SEARCH: "search_memory or memory_recall for the error class",
        StrategyKind.MINIMAL_PATCH: "edit_file with a one-line change and a unique old string",
        StrategyKind.BASELINE_WORKFLOW: "diff the snapshot against HEAD and show the user before updating",
        StrategyKind.DEPENDENCY_INSPECT: "run_command `pip show <pkg>` or `npm ls <pkg>` to inspect the version",
        StrategyKind.ISOLATE: "run_command with the smallest possible curl / import / assertion",
        StrategyKind.BLOCKED: "i_dont_know with a concrete reason and the missing evidence",
    }.get(kind, "")


def _verification_target_for(kind: StrategyKind) -> str:
    return {
        StrategyKind.IMPLEMENT: "the test that previously failed now passes",
        StrategyKind.DIAGNOSE: "the error class is now reclassified to a specific FailureClass",
        StrategyKind.REPRODUCE: "the smallest failing test exists and fails with the expected message",
        StrategyKind.EVIDENCE_SEARCH: "the new evidence is in the working memory and a different strategy is proposed",
        StrategyKind.MINIMAL_PATCH: "the diff is non-empty and the focused test now passes",
        StrategyKind.BASELINE_WORKFLOW: "the user has approved the snapshot baseline update",
        StrategyKind.DEPENDENCY_INSPECT: "the dependency is installed at the version that matches the lockfile",
        StrategyKind.ISOLATE: "the isolated check returns a single, specific failure",
        StrategyKind.BLOCKED: "an honest blocked report is emitted with evidence",
    }.get(kind, "")


def _evidence_needed_for(kind: StrategyKind) -> str:
    return {
        StrategyKind.IMPLEMENT: "the actual failing assertion and the file path",
        StrategyKind.DIAGNOSE: "the call site of the error and the surrounding code",
        StrategyKind.REPRODUCE: "the smallest failing test that reproduces the bug",
        StrategyKind.EVIDENCE_SEARCH: "the memory card or doc paragraph that names the bug class",
        StrategyKind.MINIMAL_PATCH: "a unique substring of the old text and a one-line new text",
        StrategyKind.BASELINE_WORKFLOW: "the diff between the new and old snapshot, with the user's approval",
        StrategyKind.DEPENDENCY_INSPECT: "the lockfile / package.json line that pins the dependency",
        StrategyKind.ISOLATE: "the smallest command that produces the failure",
        StrategyKind.BLOCKED: "the missing evidence that no recovery could gather",
    }.get(kind, "")


def valid_kinds_for(playbook: PlaybookKind | None) -> set[StrategyKind]:
    """Return the set of StrategyKind values allowed for a playbook."""
    return _PLAYBOOK_VALID_KINDS.get(playbook or PlaybookKind.GENERIC, set())
