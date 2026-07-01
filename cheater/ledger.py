"""Completion ledger for the Cheater harness.

Every serious task should produce a compact ledger that records what
happened, in a form that is both machine-readable and human-readable.
The ledger prevents fake completion: the agent cannot say "done" if
the ledger does not have evidence.

Public API:

  LedgerEntry            -- one row in the ledger
  CompletionLedger       -- the ledger; the loop appends to it
  is_verified(ledger)    -- a small helper for downstream callers

The ledger is JSON-friendly: every entry has a stable shape.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from cheater.lifecycle import FailureClass
from cheater.playbooks import Playbook, PlaybookKind
from cheater.verification import (
    StageResult,
    VerificationStage,
    VerificationStatus,
    is_terminal_verified,
)


# ---------- entry types ----------


@dataclass
class LedgerEntry:
    """A single ledger row. Each row has a stable shape."""

    kind: str  # command | edit | verification_stage | failure | recovery | note
    at: float
    summary: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------- ledger ----------


@dataclass
class CompletionLedger:
    """A compact, append-only completion ledger for a single task."""

    user_goal: str
    playbook: PlaybookKind | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float = 0.0
    # Compact summaries; full objects go in `entries` and `verification`.
    planned_packets: list[str] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    commands_run: list[str] = field(default_factory=list)
    verification: list[dict[str, Any]] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    unresolved_failures: list[dict[str, Any]] = field(default_factory=list)
    # Free-form rows for the human reading the ledger.
    entries: list[LedgerEntry] = field(default_factory=list)
    # Final state
    confidence: str = "low"  # low | medium | high
    done: bool = False
    done_reason: str = ""

    # ---- mutation ----

    def add_entry(self, kind: str, summary: str = "", **extra: Any) -> LedgerEntry:
        e = LedgerEntry(kind=kind, at=time.time(), summary=summary, extra=dict(extra))
        self.entries.append(e)
        return e

    def record_command(self, cmd: str) -> None:
        if cmd and cmd not in self.commands_run:
            self.commands_run.append(cmd)
        self.add_entry("command", summary=cmd[:200])

    def record_file_change(self, path: str) -> None:
        if path and path not in self.changed_files:
            self.changed_files.append(path)
        self.add_entry("edit", summary=path)

    def record_artifact(self, path: str) -> None:
        if path and path not in self.artifacts:
            self.artifacts.append(path)
        self.add_entry("artifact", summary=path)

    def record_failure(
        self, summary: str, *, failure_class: FailureClass | str = FailureClass.UNKNOWN
    ) -> None:
        cls = (
            failure_class.value
            if isinstance(failure_class, FailureClass)
            else str(failure_class)
        )
        self.unresolved_failures.append({"summary": summary, "failure_class": cls})
        self.add_entry("failure", summary=summary, failure_class=cls)

    def record_recovery(
        self, name: str, *, failure_class: FailureClass | str = ""
    ) -> None:
        cls = (
            failure_class.value
            if isinstance(failure_class, FailureClass)
            else str(failure_class)
        )
        self.add_entry("recovery", summary=name, failure_class=cls)
        # If we recovered, drop the matching unresolved failure.
        if cls:
            self.unresolved_failures = [
                f for f in self.unresolved_failures if f.get("failure_class") != cls
            ]

    def record_verification(self, results: list[StageResult]) -> None:
        self.verification = [r.to_dict() for r in results]
        for r in results:
            self.add_entry(
                "verification_stage",
                summary=f"{r.stage.value}: {r.status.value}",
                stage=r.stage.value,
                status=r.status.value,
                failure_class=r.failure_class.value,
            )

    def set_plan(self, playbook: Playbook | None, packets: list[str]) -> None:
        if playbook is not None:
            self.playbook = playbook.kind
        self.planned_packets = list(packets)

    def finalize(self, *, done: bool, reason: str, confidence: str = "medium") -> None:
        self.finished_at = time.time()
        self.done = bool(done)
        self.done_reason = reason
        self.confidence = confidence
        self.add_entry(
            "done" if done else "not_done", summary=reason, confidence=confidence
        )

    # ---- derivation ----

    def is_verified(self) -> bool:
        """Whether verification reached a known terminal ok state."""
        return is_terminal_verified(
            [_dict_to_stage_result(d) for d in self.verification]
        )

    def has_unresolved_failures(self) -> bool:
        return bool(self.unresolved_failures)

    # ---- serialisation ----

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["playbook"] = (
            self.playbook.value
            if isinstance(self.playbook, PlaybookKind)
            else self.playbook
        )
        d["entries"] = [e.to_dict() for e in self.entries]
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, default=str)

    def save(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_json(), encoding="utf-8")

    # ---- human-readable ----

    def to_human(self, *, max_entries: int = 20) -> str:
        """Render a short, human-readable summary of the ledger.

        Designed for "what did this loop actually do?" - the answer
        a human wants after watching the loop run.
        """
        lines: list[str] = []
        lines.append(f"GOAL: {self.user_goal}")
        if self.playbook is not None:
            pb = (
                self.playbook.value
                if isinstance(self.playbook, PlaybookKind)
                else self.playbook
            )
            lines.append(f"PLAYBOOK: {pb}")
        lines.append(f"CHANGED FILES ({len(self.changed_files)}):")
        if self.changed_files:
            for f in self.changed_files[:20]:
                lines.append(f"  - {f}")
        else:
            lines.append("  (none)")
        lines.append(f"COMMANDS RUN ({len(self.commands_run)}):")
        for c in self.commands_run[:10]:
            lines.append(f"  - {c[:120]}")
        if len(self.commands_run) > 10:
            lines.append(f"  ... and {len(self.commands_run) - 10} more")
        lines.append("VERIFICATION:")
        if self.verification:
            for stage in self.verification:
                mark = {
                    VerificationStatus.OK.value: "[OK]",
                    VerificationStatus.FAILED.value: "[FAIL]",
                    VerificationStatus.TIMED_OUT.value: "[TIMEOUT]",
                    VerificationStatus.SKIPPED.value: "[SKIP]",
                    VerificationStatus.PENDING.value: "[...]",
                    VerificationStatus.RUNNING.value: "[~]",
                }.get(stage.get("status", ""), "[?]")
                lines.append(
                    f"  {mark} {stage.get('stage', '?')}: {stage.get('summary', '')}"
                )
        else:
            lines.append("  (no verification was run)")
        if self.unresolved_failures:
            lines.append(f"UNRESOLVED FAILURES ({len(self.unresolved_failures)}):")
            for f in self.unresolved_failures[:5]:
                lines.append(
                    f"  - [{f.get('failure_class', '?')}] {f.get('summary', '')}"
                )
        if self.artifacts:
            lines.append(f"ARTIFACTS ({len(self.artifacts)}):")
            for a in self.artifacts[:10]:
                lines.append(f"  - {a}")
        status = "DONE" if self.done else "NOT DONE"
        lines.append(
            f"STATUS: {status} ({self.done_reason})  confidence={self.confidence}"
        )
        if len(self.entries) > max_entries:
            lines.append(f"(+{len(self.entries) - max_entries} earlier entries hidden)")
        return "\n".join(lines)


def _dict_to_stage_result(d: dict[str, Any]) -> StageResult:
    return StageResult(
        stage=VerificationStage(d.get("stage", "summarize")),
        status=VerificationStatus(d.get("status", "pending")),
        summary=d.get("summary", ""),
        failure_class=FailureClass(d.get("failure_class", "unknown")),
    )


# ---------- helpers for the loop ----------


def ledger_allows_finish(ledger: CompletionLedger) -> tuple[bool, str]:
    """Whether the ledger is in a state that allows the agent to finish.

    The harness blocks finish attempts when:
      * verification has not reached a terminal ok state
      * there are unresolved failures with a non-zero recovery
        attempt count
      * the ledger has no changed files AND no commands run
        (a totally empty run)
    """
    if not ledger.commands_run and not ledger.changed_files:
        return False, "no work was done; refusing fake completion"
    if ledger.unresolved_failures:
        return (
            False,
            f"unresolved failures: {[f.get('failure_class', '?') for f in ledger.unresolved_failures]}",
        )
    if not ledger.verification:
        return False, "no verification was run; refusing fake completion"
    if not ledger.is_verified():
        # We allow a finish only if the failure was classified as
        # "the harness detected a problem and gave up cleanly".
        # For now: just refuse.
        failed = [
            s
            for s in ledger.verification
            if s.get("status") == VerificationStatus.FAILED.value
        ]
        if failed:
            return False, f"verification not terminal: {len(failed)} stage(s) failed"
        skipped_required = [
            s
            for s in ledger.verification
            if s.get("status") == VerificationStatus.SKIPPED.value
        ]
        if skipped_required:
            return (
                False,
                f"verification not terminal: {len(skipped_required)} required stage(s) skipped",
            )
        return False, "verification did not reach a terminal state"
    return True, "verified"
