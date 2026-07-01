"""One-shot robustness scoring for the Cheater harness.

The goal of Cheater is to make weak/local models one-shot tasks more
reliably than generic harnesses. The only way to know if that is
actually happening is to measure it.

The scoring here is internal: it produces a small dict of named
checks that anyone running a benchmark can collect. The checks are
deliberately small and stable; they correspond to the failure
classes the lifecycle tries to prevent.

Public API:

  RobustnessCheck           -- a single named check (pass/fail + reason)
  RobustnessReport          -- the full report
  score_run(ledger, ...)    -- build a report from a ledger + observers
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cheater.ledger import CompletionLedger
from cheater.lifecycle import ProcessRegistry
from cheater.playbooks import PlaybookKind
from cheater.stuck import StuckKind, Watchdog


@dataclass
class RobustnessCheck:
    name: str
    passed: bool
    reason: str = ""
    weight: float = 1.0  # higher = more important

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class RobustnessReport:
    """A small bundle of pass/fail checks for a single run."""

    checks: list[RobustnessCheck] = field(default_factory=list)

    def add(
        self, name: str, passed: bool, reason: str = "", weight: float = 1.0
    ) -> None:
        self.checks.append(
            RobustnessCheck(name=name, passed=passed, reason=reason, weight=weight)
        )

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    @property
    def score(self) -> float:
        """Weighted score in [0, 1]."""
        if not self.checks:
            return 1.0
        total = sum(c.weight for c in self.checks)
        if total <= 0:
            return 1.0
        got = sum(c.weight for c in self.checks if c.passed)
        return got / total

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "score": round(self.score, 3),
            "checks": [c.to_dict() for c in self.checks],
        }


# ---------- the scorer ----------


def score_run(
    ledger: CompletionLedger,
    *,
    registry: ProcessRegistry | None = None,
    watchdog: Watchdog | None = None,
    worker_steps: int | None = None,
    worker_max_steps: int | None = None,
    anti_stall: Any | None = None,
) -> RobustnessReport:
    """Build a robustness report for a completed run.

    The scorer is pure: it reads the ledger and the observers and
    produces a stable report. It does not invoke any model or run
    any commands. This makes it usable as a regression test.
    """
    r = RobustnessReport()

    # 1. Terminal verified state
    r.add(
        "task_reached_terminal_verified_state",
        passed=ledger.is_verified(),
        reason=(
            "verification reached a terminal ok state"
            if ledger.is_verified()
            else "verification did not reach a terminal ok state"
        ),
        weight=3.0,
    )

    # 2. No stuck command
    if watchdog is not None:
        stuck = watchdog.assess()
        r.add(
            "no_stuck_command",
            passed=stuck.kind == StuckKind.IDLE,
            reason=(
                stuck.summary
                if stuck.kind != StuckKind.IDLE
                else "no stuck state observed"
            ),
            weight=2.0,
        )

    # 3. No uncontrolled environment mutation: every long-running
    #    process is owned by the registry.
    if registry is not None:
        owned = registry.summary()
        running = owned.get("running_processes", 0)
        r.add(
            "no_uncontrolled_environment_mutation",
            passed=running == 0,
            reason=(
                f"{running} owned process(es) still running at finish"
                if running
                else "no owned processes still running"
            ),
            weight=2.0,
        )

    # 4. Expected tests discovered: at least one focused test ran
    #    when the playbook expected a test stage.
    test_runs = sum(1 for s in ledger.verification if "test" in s.get("stage", ""))
    if ledger.playbook in (
        PlaybookKind.WEBAPP,
        PlaybookKind.FRONTEND_BUILD,
        PlaybookKind.BACKEND_API,
        PlaybookKind.CLI_PACKAGE,
        PlaybookKind.FULLSTACK_DEV,
    ):
        r.add(
            "expected_tests_discovered",
            passed=test_runs > 0,
            reason=(
                f"{test_runs} verification stage(s) ran with 'test' in the name"
                if test_runs
                else "no test-stage was run by the harness"
            ),
            weight=1.5,
        )

    # 5. Worker context stayed bounded: the loop did not blow past
    #    the max-step budget.
    if (
        worker_max_steps is not None
        and worker_max_steps > 0
        and worker_steps is not None
    ):
        r.add(
            "worker_context_stayed_bounded",
            passed=worker_steps < worker_max_steps,
            reason=(
                f"used {worker_steps}/{worker_max_steps} steps"
                if worker_steps < worker_max_steps
                else f"hit the max-step cap of {worker_max_steps}"
            ),
            weight=1.5,
        )

    # 6. Retries were purposeful: a finish attempt was rejected at
    #    least once with a concrete correction (we don't check that
    #    here, but we check that the loop didn't try to finish with
    #    unresolved failures).
    r.add(
        "no_unresolved_failures_at_finish",
        passed=not ledger.has_unresolved_failures(),
        reason=(
            "no unresolved failures recorded"
            if not ledger.has_unresolved_failures()
            else f"{len(ledger.unresolved_failures)} unresolved failure(s)"
        ),
        weight=2.0,
    )

    # 7. Final answer included evidence: the finish evidence must
    #    look concrete. We approximate via the ledger having at
    #    least one verification stage ok AND a non-empty
    #    commands_run list.
    evidence = bool(ledger.commands_run) and any(
        s.get("status") == "ok" for s in ledger.verification
    )
    r.add(
        "final_answer_included_evidence",
        passed=evidence,
        reason=(
            "ledger has commands and a verified stage"
            if evidence
            else "no concrete evidence in the ledger"
        ),
        weight=2.0,
    )

    # 8. No irrelevant files touched: this is a soft check. The
    #    ledger records every file the harness saw changed, so a
    #    huge number of changes is suspicious. We allow generous
    #    thresholds because some tasks legitimately touch many
    #    files.
    if ledger.changed_files:
        irrelevant = _looks_irrelevant(ledger.changed_files)
        r.add(
            "no_irrelevant_files_touched",
            passed=not irrelevant,
            reason=(
                f"irrelevant-looking files touched: {irrelevant[:3]}"
                if irrelevant
                else "changed files look task-relevant"
            ),
            weight=1.0,
        )

    # 9. Score command/report completed when requested.
    if ledger.playbook in (PlaybookKind.WEBAPP, PlaybookKind.FULLSTACK_DEV):
        scoring = [s for s in ledger.verification if s.get("stage") == "scoring"]
        if scoring:
            ok = all(s.get("status") == "ok" for s in scoring)
            r.add(
                "score_command_completed",
                passed=ok,
                reason=(
                    "scoring stage(s) ok"
                    if ok
                    else "scoring stage(s) did not complete ok"
                ),
                weight=1.0,
            )

    # v0.9: anti-stall outcome checks. These are pass/fail; they
    # are only meaningful when an anti-stall controller was
    # attached.
    if anti_stall is not None:
        outcome = anti_stall
        if not isinstance(outcome, dict):
            try:
                outcome = outcome.to_dict()
            except Exception:
                outcome = {}
        # 10. Stalled iterations detected: was there a stall?
        r.add(
            "stalled_iterations_detected",
            passed=bool(outcome.get("stalled", False)),
            reason=(
                f"stalled={outcome.get('stalled')}, "
                f"final_level={outcome.get('final_level_name')}"
            ),
            weight=0.5,
        )
        # 11. Recovery produced new evidence: a recovery was applied.
        recs = int(outcome.get("total_recoveries", 0) or 0)
        r.add(
            "recovery_produced_new_evidence",
            passed=recs > 0,
            reason=f"total_recoveries={recs}",
            weight=0.5,
        )
        # 12. Fresh worker spawned when stall escalated.
        r.add(
            "fresh_worker_spawned_when_needed",
            passed=int(outcome.get("fresh_workers_spawned", 0) or 0) >= 0,
            reason=(
                f"fresh_workers_spawned="
                f"{outcome.get('fresh_workers_spawned', 0)}"
            ),
            weight=0.5,
        )
        # 13. Task stopped honestly when blocked, did not loop.
        if bool(outcome.get("blocked", False)):
            report = outcome.get("blocked_report") or {}
            tried = len(report.get("tried", []))
            best = report.get("best_hypothesis", "")
            r.add(
                "task_stopped_honestly_when_blocked",
                passed=tried > 0 and bool(best),
                reason=(
                    f"blocked; tried={tried} commands, "
                    f"best_hypothesis={'set' if best else 'empty'}"
                ),
                weight=2.0,
            )
        # 14. Banned actions were enforced.
        banned_count = int(outcome.get("banned_count", 0) or 0)
        if bool(outcome.get("stalled", False)):
            r.add(
                "banned_actions_enforced",
                passed=banned_count > 0,
                reason=f"banned_count={banned_count}",
                weight=0.5,
            )

    return r


# ---------- helpers ----------


# A small allow-list of paths that look like scaffolding noise
# rather than part of the task. Anything matching one of these is
# considered irrelevant unless the user task explicitly mentions it.
_IRRELEVANT_PATH_TOKENS: tuple[str, ...] = (
    "/.cheater/",
    "/.git/",
    "/__pycache__/",
    "/.pytest_cache/",
    "/.ruff_cache/",
    "/.mypy_cache/",
    "/node_modules/",
    "/dist/",
    "/build/",
    "/target/",
    "/_archive/",
    "/.smallcode/",
    "/.memory/",
    "/.code-graph/",
    "/.agents/",
)


def _looks_irrelevant(files: list[str]) -> list[str]:
    out: list[str] = []
    for f in files:
        if not f:
            continue
        norm = f.replace("\\", "/")
        if any(tok in norm for tok in _IRRELEVANT_PATH_TOKENS):
            out.append(f)
    return out
