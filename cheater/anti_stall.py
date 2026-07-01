"""Anti-stall progress ledger and stall detection for Cheater.

The lifecycle layer (cheater/lifecycle.py, cheater/stuck.py) already
detects *coarse* stuck states. This module is the *fine-grained*
counterpart: per-step fingerprints that detect when a worker is no
longer producing real progress, even if the coarse watchdog is still
saying "idle".

Progress is defined structurally. A step counts as progress if it
produces at least one of:

  * a new repo evidence (new file read for a never-read-before path)
  * a new external/docs evidence (search_memory with new hits)
  * a changed file
  * a new test result (different fingerprint from prior results)
  * a narrower failure classification
  * a different recovery strategy (different action + different args)
  * a useful artifact (test-output, log file, ...)
  * a verified completion

If none of these happen across ``stall_window`` consecutive steps,
the worker is no longer useful and the harness must intervene.

Public API:

  StepFingerprint     -- compact, structural summary of one step
  ProgressLedger      -- append-only ledger of StepFingerprints
  ProgressKind        -- which kind of progress a step produced
  StallReason         -- a specific reason the worker is stalling
  StallAssessment     -- the current verdict
  StallDetector       -- the per-step detector
  fingerprints_for    -- factory helpers that build fingerprints
"""
from __future__ import annotations

import hashlib
import re
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any



# ---------- progress taxonomy ----------


class ProgressKind(str, Enum):
    """A coarse taxonomy of what kind of progress a step produced.

    The detector collects one or more of these per step. ``NONE``
    means "no progress of any kind this step".
    """

    NEW_REPO_EVIDENCE = "new_repo_evidence"
    NEW_EXTERNAL_EVIDENCE = "new_external_evidence"
    FILE_CHANGED = "file_changed"
    NEW_TEST_RESULT = "new_test_result"
    NARROWER_FAILURE = "narrower_failure"
    DIFFERENT_STRATEGY = "different_strategy"
    NEW_ARTIFACT = "new_artifact"
    VERIFIED_COMPLETION = "verified_completion"
    NONE = "none"


# ---------- fingerprint ----------


@dataclass
class StepFingerprint:
    """A compact, structural summary of one loop step.

    Used by the detector to recognise repeats. The model never sees
    this object; it is a harness-internal record.
    """

    step: int
    at: float
    # What the worker did
    action: str = ""
    args_sig: str = ""          # normalised (action, key args) hash
    # Outcome
    success: bool = True
    summary: str = ""
    # Evidence
    files_read: list[str] = field(default_factory=list)
    files_changed: list[str] = field(default_factory=list)
    commands_run: list[str] = field(default_factory=list)
    # Result fingerprints
    test_fp: str = ""           # test result fingerprint (see compute_test_fingerprint)
    error_fp: str = ""          # error fingerprint (see _error_fingerprint)
    artifact_paths: list[str] = field(default_factory=list)
    # Classification
    failure_class: str = ""     # FailureClass value, "" if success
    verification_stage: str = ""
    # What kind of progress this step counts as
    progress: list[str] = field(default_factory=list)
    # The model message fingerprint (so we can also catch model
    # "I am stuck in a loop" loops at the message level, not just
    # the tool-call level).
    model_message_fp: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "at": self.at,
            "action": self.action,
            "args_sig": self.args_sig,
            "success": self.success,
            "summary": self.summary,
            "files_read": list(self.files_read),
            "files_changed": list(self.files_changed),
            "commands_run": list(self.commands_run),
            "test_fp": self.test_fp,
            "error_fp": self.error_fp,
            "artifact_paths": list(self.artifact_paths),
            "failure_class": self.failure_class,
            "verification_stage": self.verification_stage,
            "progress": list(self.progress),
            "model_message_fp": self.model_message_fp,
        }


# ---------- fingerprinting helpers ----------


# Words that are too generic to fingerprint meaningfully. Stripped
# before normalising commands and error messages.
_NOISE_WORDS = re.compile(
    r"\b(the|a|an|this|that|these|those|i|we|you|it|of|to|is|are|was|were|"
    r"be|been|being|have|has|had|do|does|did|will|would|should|could|may|might|"
    r"can|could|just|now|then|also|but|and|or|so|if|on|in|at|by|for|with|"
    r"here|there|please|sorry|ok|yes|no|hmm|huh|well|um|uh)\b",
    re.IGNORECASE,
)


def _strip_noise(text: str) -> str:
    if not text:
        return ""
    t = _NOISE_WORDS.sub(" ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", errors="ignore")).hexdigest()[:12]


def command_args_sig(cmd: str) -> str:
    """Normalise a shell command into a stable signature.

    "pytest tests/test_x.py" and "pytest -x tests/test_x.py" differ by
    flags but should hash the same intent. We keep the head and the
    non-numeric, non-flag arguments.
    """
    if not cmd:
        return ""
    parts = cmd.strip().split()
    if not parts:
        return ""
    head = parts[0].rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    sig_parts = [head]
    for p in parts[1:]:
        if p.startswith("-"):
            continue
        if p.isdigit():
            continue
        sig_parts.append(p)
    return _hash(" ".join(sig_parts))


def tool_args_sig(action: str, args: dict | None) -> str:
    """A stable signature for a tool call (action, key args)."""
    if not args:
        return _hash(f"{action}|")
    # Take only the parts of args that change behaviour: drop noisy
    # fields like verbose flags, summary text, etc. The set of
    # "behaviour-defining keys" depends on the action.
    keys = _behaviour_keys_for(action)
    if keys is None:
        # Unknown action: hash everything.
        pairs = sorted(f"{k}={args.get(k)!r}" for k in args)
        return _hash(f"{action}|" + "|".join(pairs))
    pairs = []
    for k in keys:
        v = args.get(k)
        if isinstance(v, str):
            pairs.append(f"{k}={command_args_sig(v)}")
        else:
            pairs.append(f"{k}={v!r}")
    return _hash(f"{action}|" + "|".join(pairs))


# Behaviour-defining arg keys per action. The point is to detect
# "same action, different file" as a different fingerprint, while
# treating "same action, same file, different line_range" as the same
# for read_file (it is just a re-read).
_BEHAVIOUR_KEYS: dict[str, tuple[str, ...]] = {
    "read_file": ("path",),
    "edit_file": ("path", "old", "new"),
    "create_file": ("path",),
    "run_command": ("cmd",),
    "search_code": ("query", "file_glob"),
    "search_memory": ("query",),
    "memory_recall": ("query",),
    "memory_remember": ("text",),
    "memory_forget": ("memory_id",),
    "ask_user": ("question",),
    "finish": ("summary", "evidence"),
    "i_dont_know": ("reason",),
    "list_files": ("glob",),
    "apply_patch": ("path",),
    "run_focused_tests": ("target",),
    "repo_map": (),
    "localize": ("symbol",),
}


def _behaviour_keys_for(action: str) -> tuple[str, ...] | None:
    return _BEHAVIOUR_KEYS.get(action)


# Test output fingerprints collapse the verbose bits so the same
# 50 lines of pytest output collapse to a stable hash. We keep the
# test name, status, and the first error-line.
_TEST_LINE_RE = re.compile(
    r"(PASS|FAIL|ERROR|FAILED)\s+([A-Za-z0-9_./:-]+)", re.IGNORECASE
)
_ERROR_LINE_RE = re.compile(
    r"^(\s*)([A-Z][A-Za-z0-9_]*Error|[A-Z][A-Za-z0-9_]*Exception|"
    r"AssertionError|Error|TypeError|ValueError|KeyError|ImportError)\b"
)


def compute_test_fingerprint(output: str) -> str:
    """Reduce a test output blob to a stable fingerprint.

    Two test runs of the same test with the same outcome hash the
    same, even if timestamps or line numbers differ. A run that
    added or removed tests hashes differently.
    """
    if not output:
        return ""
    test_lines: list[str] = []
    error_lines: list[str] = []
    counts: dict[str, int] = {}
    for raw in output.splitlines():
        m = _TEST_LINE_RE.search(raw)
        if m:
            test_lines.append(f"{m.group(1).upper()}:{m.group(2)}")
        m = _ERROR_LINE_RE.search(raw)
        if m:
            error_lines.append(m.group(2))
    # Counts of "X passed", "X failed" etc.
    for m in re.finditer(r"(\d+)\s+(passed|failed|error|skipped|xfail|xpass)", output):
        counts[m.group(2)] = int(m.group(1))
    parts = [
        f"tests={','.join(sorted(test_lines))}",
        f"errors={','.join(sorted(error_lines))}",
        f"counts={sorted(counts.items())}",
    ]
    return _hash("|".join(parts))


def error_fingerprint(text: str) -> str:
    """Reduce an error message blob to a stable fingerprint.

    Same error text, same fingerprint; different line numbers, same
    fingerprint. New error type, different fingerprint.
    """
    if not text:
        return ""
    # Keep only the first error type and a few distinctive tokens.
    error_type = ""
    m = re.search(r"([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b", text)
    if m:
        error_type = m.group(1)
    # Strip line numbers and the noise words.
    cleaned = re.sub(r":\s*\d+", "", text)
    cleaned = re.sub(r"\bline\s+\d+\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = _strip_noise(cleaned)
    # First 200 chars of cleaned, plus error type.
    return _hash(f"{error_type}|{cleaned[:200]}")


def edit_diff_sig(old: str, new: str) -> str:
    """Fingerprint of an edit. Used to detect "edit produces no diff".

    An edit with identical old and new collapses to a single sentinel
    hash that the detector can recognise as a no-op.
    """
    if old == new:
        return "no-diff"
    if not old:
        return _hash(f"create|{new[:200]}")
    if not new:
        return _hash(f"delete|{old[:200]}")
    return _hash(f"edit|{old[:80]}|{new[:80]}")


def model_message_fingerprint(text: str) -> str:
    """A very small, structural fingerprint of a model message.

    Used to detect "the model keeps saying the same thing". We strip
    the noise words, the leading and trailing punctuation, and hash
    the remainder. Cheap; not a full simhash.
    """
    if not text:
        return ""
    cleaned = _strip_noise(text)
    return _hash(cleaned[:400])


# ---------- progress ledger ----------


@dataclass
class ProgressLedger:
    """Append-only ledger of step fingerprints.

    The detector reads this ledger to decide whether the worker is
    still making progress. The ledger is small: it only keeps
    ``max_steps`` recent fingerprints in memory.
    """

    max_steps: int = 64
    entries: list[StepFingerprint] = field(default_factory=list)
    # Set of files the worker has read at least once.
    files_read_seen: set[str] = field(default_factory=set)
    # Set of (action, args_sig) pairs the worker has already used.
    action_signatures_seen: set[str] = field(default_factory=set)
    # Set of (action, failure_class) pairs the worker has classified.
    failure_classes_seen: set[str] = field(default_factory=set)
    # Set of test fingerprints the worker has seen.
    test_fingerprints_seen: set[str] = field(default_factory=set)
    # Set of error fingerprints the worker has seen.
    error_fingerprints_seen: set[str] = field(default_factory=set)
    # Set of artifact paths the worker has produced.
    artifacts_seen: set[str] = field(default_factory=set)

    def record(self, fp: StepFingerprint) -> None:
        self.entries.append(fp)
        # Trim to the bounded window.
        if len(self.entries) > self.max_steps:
            self.entries = self.entries[-self.max_steps:]
        # Update the cumulative sets.
        for f in fp.files_read:
            self.files_read_seen.add(f)
        if fp.args_sig:
            self.action_signatures_seen.add(fp.args_sig)
        if fp.failure_class:
            self.failure_classes_seen.add(fp.failure_class)
        if fp.test_fp:
            self.test_fingerprints_seen.add(fp.test_fp)
        if fp.error_fp:
            self.error_fingerprints_seen.add(fp.error_fp)
        for a in fp.artifact_paths:
            self.artifacts_seen.add(a)

    def to_dict(self) -> dict[str, Any]:
        return {
            "steps_recorded": len(self.entries),
            "files_read_seen": sorted(self.files_read_seen),
            "action_signatures_seen": sorted(self.action_signatures_seen),
            "failure_classes_seen": sorted(self.failure_classes_seen),
            "test_fingerprints_seen": sorted(self.test_fingerprints_seen),
            "error_fingerprints_seen": sorted(self.error_fingerprints_seen),
            "artifacts_seen": sorted(self.artifacts_seen),
            "entries": [e.to_dict() for e in self.entries[-16:]],
        }


# ---------- stall reasons ----------


class StallReason(str, Enum):
    """A specific reason the worker is stalling.

    The ladder uses this to pick the next recovery level. The
    detector can return more than one reason per assessment; the
    ladder picks the highest-priority one.
    """

    REPEATED_COMMAND = "repeated_command"
    REPEATED_TOOL_CALL = "repeated_tool_call"
    REPEATED_FILE_READ = "repeated_file_read"
    REPEATED_TEST_RESULT = "repeated_test_result"
    REPEATED_FINISH = "repeated_finish"
    REPEATED_MODEL_MESSAGE = "repeated_model_message"
    NO_DIFF_EDIT = "no_diff_edit"
    VERIFY_NO_NEW_HYPOTHESIS = "verify_no_new_hypothesis"
    OSCILLATION = "oscillation"
    HANG_NO_OUTPUT = "hang_no_output"
    SERVER_NO_VERIFY = "server_no_verify"
    SCORING_SKIPPED = "scoring_skipped"
    NO_PROGRESS = "no_progress"  # generic catch-all
    NONE = "none"


# Priority of stall reasons. Higher means "more severe" / "escalate
# further". The detector picks the highest-priority reason.
_STALL_PRIORITY: dict[StallReason, int] = {
    StallReason.NONE: 0,
    StallReason.REPEATED_FINISH: 50,
    StallReason.HANG_NO_OUTPUT: 40,
    StallReason.SERVER_NO_VERIFY: 35,
    StallReason.OSCILLATION: 30,
    StallReason.VERIFY_NO_NEW_HYPOTHESIS: 25,
    StallReason.REPEATED_TEST_RESULT: 20,
    StallReason.REPEATED_COMMAND: 18,
    StallReason.REPEATED_TOOL_CALL: 15,
    StallReason.REPEATED_FILE_READ: 12,
    StallReason.REPEATED_MODEL_MESSAGE: 10,
    StallReason.NO_DIFF_EDIT: 8,
    StallReason.SCORING_SKIPPED: 8,
    StallReason.NO_PROGRESS: 5,
}


# Tunable thresholds. Kept conservative; the harness can override.
@dataclass
class StallConfig:
    # Number of consecutive steps without any progress before
    # the detector fires.
    stall_window: int = 3
    # Same command must appear N times to be "repeated".
    repeated_command_count: int = 3
    # Same file read this many times to count as repeated.
    repeated_file_read_count: int = 3
    # Same test fingerprint this many times to count as repeated.
    repeated_test_count: int = 3
    # Same model message fingerprint this many times to count.
    repeated_model_message_count: int = 3
    # A 2-state oscillation (A B A B ...) counts if it lasts this many steps.
    oscillation_window: int = 6
    # An edit with no diff is a no-op the first time; ignore subsequent
    # no-diff edits within ``no_diff_grace`` steps.
    no_diff_grace: int = 1


# ---------- assessment ----------


@dataclass
class StallAssessment:
    """The detector's current verdict."""

    is_stalled: bool = False
    reason: StallReason = StallReason.NONE
    summary: str = ""
    # Evidence supporting the verdict, used by the recovery layer.
    evidence: dict[str, Any] = field(default_factory=dict)
    # The number of consecutive non-progress steps so far.
    non_progress_streak: int = 0
    # The progress kinds observed in the last ``stall_window`` steps.
    recent_progress: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_stalled": self.is_stalled,
            "reason": self.reason.value,
            "summary": self.summary,
            "non_progress_streak": self.non_progress_streak,
            "recent_progress": list(self.recent_progress),
            "evidence": dict(self.evidence),
        }


# ---------- detector ----------


class StallDetector:
    """Decides whether the worker is still making progress.

    The detector is fed step fingerprints by the loop. It returns a
    ``StallAssessment`` that the recovery layer acts on.

    The detector is deliberately *fine-grained*: it sees repeats that
    the coarse watchdog does not. The two compose; the watchdog
    handles timeouts and server lifecycle, the detector handles
    loop-on-same-output.
    """

    def __init__(self, cfg: StallConfig | None = None) -> None:
        self.cfg = cfg or StallConfig()
        self.ledger = ProgressLedger()
        # Track the last N action signatures for oscillation detection.
        self._recent_actions: deque[str] = deque(maxlen=32)
        # Track the per-fingerprint counts.
        self._command_counts: dict[str, int] = {}
        self._file_read_counts: dict[str, int] = {}
        self._test_fp_counts: dict[str, int] = {}
        self._message_fp_counts: dict[str, int] = {}
        self._finish_attempts: int = 0
        self._no_diff_count: int = 0
        # Track progress kinds per step so we can compute streaks.
        self._progress_streak: int = 0
        # External signal: a recent command that was a server start.
        # We accept this from the lifecycle controller.
        self._last_server_started_at: float = 0.0
        self._last_verify_attempted_at: float = 0.0
        self._last_scoring_invoked: bool = False
        self._last_test_finished_at: float = 0.0

    # ---- feeding ----

    def observe(self, fp: StepFingerprint) -> None:
        """Record a step fingerprint and update derived state.

        The detector classifies the step's progress *before*
        recording it, so the second read of the same file does
        not count as new evidence (the file is in the ledger
        from the first read).
        """
        # Classify progress against the current ledger state (so a
        # second read of the same file is not "new evidence"). If
        # the caller did not pre-populate ``fp.progress``, do it
        # here. If they did, honour the caller's classification
        # (useful for tests and for callers that have richer info
        # than the standard heuristic).
        if not fp.progress:
            fp.progress = _classify_progress(fp, self.ledger)
        self.ledger.record(fp)
        if fp.action:
            self._recent_actions.append(fp.args_sig or fp.action)
        # Update per-fingerprint counts.
        for cmd in fp.commands_run:
            sig = command_args_sig(cmd)
            if not sig:
                continue
            self._command_counts[sig] = self._command_counts.get(sig, 0) + 1
        for path in fp.files_read:
            self._file_read_counts[path] = self._file_read_counts.get(path, 0) + 1
        if fp.test_fp:
            self._test_fp_counts[fp.test_fp] = self._test_fp_counts.get(fp.test_fp, 0) + 1
        if fp.model_message_fp:
            self._message_fp_counts[fp.model_message_fp] = self._message_fp_counts.get(fp.model_message_fp, 0) + 1
        if fp.action == "finish":
            self._finish_attempts += 1
        # No-diff edit is its own repeated action.
        if fp.action in ("edit_file", "create_file", "apply_patch") and fp.test_fp == "no-diff":
            self._no_diff_count += 1
        else:
            self._no_diff_count = 0
        # Update progress streak.
        if fp.progress and any(p != ProgressKind.NONE.value for p in fp.progress):
            self._progress_streak = 0
        else:
            self._progress_streak += 1

    # ---- external signals (composed with the lifecycle controller) ----

    def note_server_started(self, at: float | None = None) -> None:
        self._last_server_started_at = at if at is not None else time.time()
        self._last_verify_attempted_at = 0.0

    def note_verify_attempt(self, at: float | None = None) -> None:
        self._last_verify_attempted_at = at if at is not None else time.time()

    def note_scoring_invoked(self) -> None:
        self._last_scoring_invoked = True

    def note_scoring_skipped(self) -> None:
        self._last_scoring_invoked = False

    def note_test_finished(self, at: float | None = None) -> None:
        self._last_test_finished_at = at if at is not None else time.time()
        # Reset scoring expectation: after a test run, we expect a scoring step.
        self._last_scoring_invoked = False

    # ---- assessment ----

    def assess(self) -> StallAssessment:
        """Return the current verdict without consuming state."""
        a = StallAssessment()
        a.non_progress_streak = self._progress_streak
        a.recent_progress = self._collect_recent_progress(self.cfg.stall_window)

        # Per-pattern checks. Each one populates ``a.evidence`` and
        # sets ``a.reason`` if the priority is higher than the current.
        self._check_repeated_finish(a)
        self._check_repeated_command(a)
        self._check_repeated_tool_call(a)
        self._check_repeated_file_read(a)
        self._check_repeated_test_result(a)
        self._check_repeated_model_message(a)
        self._check_no_diff_edit(a)
        self._check_oscillation(a)
        self._check_server_no_verify(a)
        self._check_scoring_skipped(a)
        self._check_no_progress(a)

        a.is_stalled = a.reason != StallReason.NONE
        if a.is_stalled and not a.summary:
            a.summary = _default_summary(a.reason)
        return a

    # ---- private checks ----

    def _check_repeated_finish(self, a: StallAssessment) -> None:
        if self._finish_attempts >= 2:
            self._maybe_set(
                a,
                StallReason.REPEATED_FINISH,
                f"finish attempted {self._finish_attempts} times without new evidence",
                {"attempts": self._finish_attempts},
            )

    def _check_repeated_command(self, a: StallAssessment) -> None:
        for sig, n in self._command_counts.items():
            if n >= self.cfg.repeated_command_count:
                self._maybe_set(
                    a,
                    StallReason.REPEATED_COMMAND,
                    f"command signature {sig!r} ran {n} times",
                    {"command_sig": sig, "count": n},
                )
                return

    def _check_repeated_tool_call(self, a: StallAssessment) -> None:
        # A repeated tool call is a (action, args_sig) pair that
        # appears in the last N steps and produced the same success.
        if len(self.ledger.entries) < self.cfg.repeated_command_count:
            return
        window = self.ledger.entries[-self.cfg.repeated_command_count:]
        sigs = [(e.action, e.args_sig) for e in window if e.action]
        if len(sigs) < self.cfg.repeated_command_count:
            return
        first = sigs[0]
        if all(s == first for s in sigs):
            self._maybe_set(
                a,
                StallReason.REPEATED_TOOL_CALL,
                f"tool {first[0]!r} called {len(sigs)} times with the same arguments",
                {"action": first[0], "args_sig": first[1], "count": len(sigs)},
            )

    def _check_repeated_file_read(self, a: StallAssessment) -> None:
        for path, n in self._file_read_counts.items():
            if n >= self.cfg.repeated_file_read_count:
                # Cross-reference: is the worker also editing files
                # at all? If yes, we don't fault them for re-reading
                # an evolving file. We look at the most recent
                # ``n`` ledger entries: if ANY of them contains
                # a file change, the worker is not stuck in a
                # pure-read loop.
                window = self.ledger.entries[-n:] if n else []
                if not any(e.files_changed for e in window):
                    self._maybe_set(
                        a,
                        StallReason.REPEATED_FILE_READ,
                        f"file {path!r} read {n} times with no edits",
                        {"path": path, "count": n},
                    )
                    return

    def _check_repeated_test_result(self, a: StallAssessment) -> None:
        for fp, n in self._test_fp_counts.items():
            if n >= self.cfg.repeated_test_count:
                self._maybe_set(
                    a,
                    StallReason.REPEATED_TEST_RESULT,
                    f"the same test result was seen {n} times",
                    {"test_fp": fp, "count": n},
                )
                return

    def _check_repeated_model_message(self, a: StallAssessment) -> None:
        for fp, n in self._message_fp_counts.items():
            if n >= self.cfg.repeated_model_message_count:
                self._maybe_set(
                    a,
                    StallReason.REPEATED_MODEL_MESSAGE,
                    f"the same model message was emitted {n} times",
                    {"message_fp": fp, "count": n},
                )
                return

    def _check_no_diff_edit(self, a: StallAssessment) -> None:
        if self._no_diff_count > self.cfg.no_diff_grace:
            self._maybe_set(
                a,
                StallReason.NO_DIFF_EDIT,
                f"edit produced no diff for {self._no_diff_count} attempts in a row",
                {"no_diff_count": self._no_diff_count},
            )

    def _check_oscillation(self, a: StallAssessment) -> None:
        # A 2-state oscillation: A, B, A, B, A, B ...
        window = list(self._recent_actions)[-self.cfg.oscillation_window:]
        if len(window) < self.cfg.oscillation_window:
            return
        if len(set(window)) == 2 and window[0] == window[2] == window[4]:
            self._maybe_set(
                a,
                StallReason.OSCILLATION,
                f"agent is oscillating between {list(set(window))[0]!r} and {list(set(window))[1]!r}",
                {"states": sorted(set(window))},
            )

    def _check_server_no_verify(self, a: StallAssessment) -> None:
        # The detector is stateless across time. We let the caller
        # feed us "server started" / "verify attempted" via the
        # note_* methods. If the caller fed a server start but no
        # verify within the last few steps, fire.
        if self._last_server_started_at > 0 and self._last_verify_attempted_at == 0:
            self._maybe_set(
                a,
                StallReason.SERVER_NO_VERIFY,
                "a server was started but no verification followed",
                {"server_started_at": self._last_server_started_at},
            )

    def _check_scoring_skipped(self, a: StallAssessment) -> None:
        # If a test run finished and scoring was expected but not invoked,
        # the detector fires. The caller sets _last_scoring_invoked.
        # We only fire if the most recent ledger action was not
        # itself a scoring-style command, so the detector doesn't
        # race with an in-flight scoring call.
        if (
            self._last_test_finished_at > 0
            and not self._last_scoring_invoked
        ):
            # If the most recent ledger action was a scoring
            # invocation, the detector should not fire. We accept
            # that the caller's note_scoring_invoked is the source
            # of truth.
            self._maybe_set(
                a,
                StallReason.SCORING_SKIPPED,
                "tests finished but the scoring step was not invoked",
                {"test_finished_at": self._last_test_finished_at},
            )

    def _check_no_progress(self, a: StallAssessment) -> None:
        if self._progress_streak >= self.cfg.stall_window:
            self._maybe_set(
                a,
                StallReason.NO_PROGRESS,
                f"no progress for {self._progress_streak} consecutive steps",
                {"streak": self._progress_streak},
            )

    # ---- helpers ----

    def _maybe_set(self, a: StallAssessment, reason: StallReason, summary: str, evidence: dict) -> None:
        if _STALL_PRIORITY[reason] > _STALL_PRIORITY[a.reason]:
            a.reason = reason
            a.summary = summary
            a.evidence = evidence

    def _collect_recent_progress(self, window: int) -> list[str]:
        recent = self.ledger.entries[-window:] if window > 0 else self.ledger.entries
        kinds: list[str] = []
        for e in recent:
            kinds.extend(p for p in e.progress if p != ProgressKind.NONE.value)
        return kinds


def _default_summary(reason: StallReason) -> str:
    return {
        StallReason.REPEATED_FINISH: "finish attempted multiple times without new evidence",
        StallReason.HANG_NO_OUTPUT: "command produced no output",
        StallReason.SERVER_NO_VERIFY: "server started but no verification followed",
        StallReason.OSCILLATION: "agent is oscillating between two states",
        StallReason.VERIFY_NO_NEW_HYPOTHESIS: "verification failed repeatedly without a new hypothesis",
        StallReason.REPEATED_TEST_RESULT: "the same test result was seen multiple times",
        StallReason.REPEATED_COMMAND: "the same command was run multiple times",
        StallReason.REPEATED_TOOL_CALL: "the same tool was called multiple times with the same arguments",
        StallReason.REPEATED_FILE_READ: "the same file was read multiple times without edits",
        StallReason.REPEATED_MODEL_MESSAGE: "the model emitted the same message multiple times",
        StallReason.NO_DIFF_EDIT: "an edit attempt produced no diff",
        StallReason.SCORING_SKIPPED: "tests finished but scoring was not invoked",
        StallReason.NO_PROGRESS: "no progress was made in the last few steps",
    }.get(reason, "stalled")


# ---------- factory for fingerprints ----------


def make_fingerprint_from_step(
    *,
    step: int,
    action: str,
    args: dict | None,
    success: bool,
    summary: str,
    files_read: list[str] | None = None,
    files_changed: list[str] | None = None,
    commands_run: list[str] | None = None,
    stdout: str = "",
    stderr: str = "",
    artifact_paths: list[str] | None = None,
    failure_class: str = "",
    verification_stage: str = "",
    model_message: str = "",
    ledger: ProgressLedger | None = None,
    at: float | None = None,
) -> StepFingerprint:
    """Build a fingerprint from raw step inputs.

    Progress classification happens when the fingerprint is passed
    to ``StallDetector.observe()``, not here, so the same
    fingerprint is classified consistently regardless of the
    detector's history.
    """
    fp = StepFingerprint(
        step=step,
        at=at if at is not None else time.time(),
        action=action,
        args_sig=tool_args_sig(action, args),
        success=success,
        summary=summary or "",
        files_read=list(files_read or []),
        files_changed=list(files_changed or []),
        commands_run=list(commands_run or []),
        test_fp=compute_test_fingerprint(stdout) if stdout else "",
        error_fp=error_fingerprint(stderr or stdout) if (stderr or stdout) else "",
        artifact_paths=list(artifact_paths or []),
        failure_class=failure_class or "",
        verification_stage=verification_stage or "",
        model_message_fp=model_message_fingerprint(model_message),
    )
    # The detector classifies progress on observe(); we do not do
    # it here, so that the same fingerprint passed to two different
    # detector instances classifies consistently.
    return fp



def _classify_progress(fp: StepFingerprint, ledger: ProgressLedger | None) -> list[str]:
    """Return the list of ProgressKind values this step counts as."""
    if ledger is None:
        return [ProgressKind.NONE.value]
    out: list[str] = []
    # NEW_REPO_EVIDENCE: read a file that the ledger hasn't seen before.
    for f in fp.files_read:
        if f and f not in ledger.files_read_seen:
            out.append(ProgressKind.NEW_REPO_EVIDENCE.value)
            break
    # FILE_CHANGED: any file changed this step.
    if fp.files_changed:
        out.append(ProgressKind.FILE_CHANGED.value)
    # NEW_TEST_RESULT: a test fingerprint the ledger hasn't seen.
    if fp.test_fp and fp.test_fp not in ledger.test_fingerprints_seen:
        out.append(ProgressKind.NEW_TEST_RESULT.value)
    # NARROWER_FAILURE: failure class the ledger hasn't seen.
    if fp.failure_class and fp.failure_class not in ledger.failure_classes_seen:
        out.append(ProgressKind.NARROWER_FAILURE.value)
    # NEW_ARTIFACT: an artifact path the ledger hasn't seen.
    for a in fp.artifact_paths:
        if a and a not in ledger.artifacts_seen:
            out.append(ProgressKind.NEW_ARTIFACT.value)
            break
    # DIFFERENT_STRATEGY: an args_sig the ledger hasn't seen.
    if fp.args_sig and fp.args_sig not in ledger.action_signatures_seen:
        out.append(ProgressKind.DIFFERENT_STRATEGY.value)
    # NEW_EXTERNAL_EVIDENCE: search_memory or memory_recall with new hits.
    if fp.action in ("search_memory", "memory_recall") and fp.success and fp.summary:
        out.append(ProgressKind.NEW_EXTERNAL_EVIDENCE.value)
    # VERIFIED_COMPLETION: finish attempt with success=True AND no failure.
    if fp.action == "finish" and fp.success and not fp.failure_class:
        out.append(ProgressKind.VERIFIED_COMPLETION.value)
    if not out:
        out.append(ProgressKind.NONE.value)
    return out
