"""Cheater patch candidate: Phase B scaffolding only.

A PatchCandidate represents one proposed fix. Phase A only defines the data
shape and the scoring function. The actual tournament (generate N candidates,
apply in temp dirs, run focused tests, mutate, pick smallest passing) is
Phase B.

Public API:
  PatchCandidate                 -- the dataclass
  RiskFlag                       -- enum-like str values
  score_candidate(c, ctx)       -- compute a score for a candidate
  ScoredCandidate                -- candidate + score
  validate_candidate(c, ctx)     -- light validation

Scoring rules (deterministic, from the spec):

  + focused tests pass
  + related tests pass
  + smaller diff (fewer changed lines)
  + touches localized files
  - edits tests (unless allow_test_edits)
  - dependency changes (unless allow_dependency_edits)
  - broad refactor (many files, or big diff)
  - unrelated files (files outside the localized set)

A candidate with the same passes/failures as another but with a smaller diff
wins. The score is a float; higher is better.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable


# Strings used to identify test / dependency / config files
_TEST_FILE_PATTERNS = (
    "test_", "_test.", "/tests/", "/test/",
)
_DEPENDENCY_FILES = (
    "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg",
    "package.json", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
    "poetry.lock", "Pipfile", "Pipfile.lock", "yarn.lock", "pnpm-lock.yaml",
)
_CONFIG_FILES = (
    "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
    "package.json", "tsconfig.json", "Makefile",
)


@dataclass
class PatchCandidate:
    """A single proposed fix."""
    id: str
    diff: str
    strategy: str = "edit"          # edit | rewrite | test_tweak | ...
    touched_files: list[str] = field(default_factory=list)
    applies_cleanly: bool = True    # patch applies without conflict
    syntax_ok: bool = True          # all touched files parse
    focused_tests_passed: bool = False
    related_tests_passed: bool = False
    failure_summary: str = ""
    risk_flags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    # ---- derived properties ----

    def diff_size(self) -> int:
        """Approximate diff size: count of '+' / '-' / changed lines."""
        if not self.diff:
            return 0
        n = 0
        for line in self.diff.splitlines():
            if line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
                n += 1
        return n

    def is_test_edit(self) -> bool:
        for f in self.touched_files:
            fl = f.replace("\\", "/")
            if any(pat in fl for pat in _TEST_FILE_PATTERNS):
                return True
        return False

    def is_dependency_change(self) -> bool:
        return any(PathLike(f).name in _DEPENDENCY_FILES for f in self.touched_files)

    def is_broad_refactor(self) -> bool:
        return len(self.touched_files) > 4 or self.diff_size() > 80

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "strategy": self.strategy,
            "touched_files": list(self.touched_files),
            "diff_size": self.diff_size(),
            "applies_cleanly": self.applies_cleanly,
            "syntax_ok": self.syntax_ok,
            "focused_tests_passed": self.focused_tests_passed,
            "related_tests_passed": self.related_tests_passed,
            "failure_summary": self.failure_summary,
            "risk_flags": list(self.risk_flags),
            "metadata": dict(self.metadata),
        }


# Tiny shim to avoid a hard import for Path operations.
class PathLike:
    __slots__ = ("name",)

    def __init__(self, p: str) -> None:
        # Take only the last segment after "/" or "\"
        s = (p or "").replace("\\", "/")
        self.name = s.rsplit("/", 1)[-1]


@dataclass
class ScoredCandidate:
    candidate: PatchCandidate
    score: float
    score_breakdown: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate": self.candidate.to_dict(),
            "score": round(self.score, 4),
            "score_breakdown": {k: round(v, 4) for k, v in self.score_breakdown.items()},
        }


@dataclass
class ScoringContext:
    """Inputs the scorer needs to make decisions."""
    localized_files: set[str] = field(default_factory=set)
    allow_test_edits: bool = False
    allow_dependency_edits: bool = False
    big_diff_threshold: int = 80
    broad_refactor_file_threshold: int = 4

    @classmethod
    def from_localization(cls, result: Any, **overrides: Any) -> "ScoringContext":
        files: set[str] = set()
        if result is not None:
            for sf in getattr(result, "suspected_files", []) or []:
                files.add(sf.path)
        return cls(localized_files=files, **overrides)


# ---------- validation ----------

def validate_candidate(c: PatchCandidate) -> tuple[bool, str]:
    if not c.id:
        return False, "candidate missing id"
    if not c.diff:
        return False, "candidate missing diff"
    if not c.touched_files:
        return False, "candidate touches no files"
    return True, ""


# ---------- scoring ----------

# Reward / penalty constants
R_FOCUSED_PASS = 20.0
R_RELATED_PASS = 8.0
R_LOCALIZED = 6.0
R_DIFF_SIZE = 0.15           # per line; smaller diff -> higher
R_CLEAN = 2.0
R_SYNTAX_OK = 1.0

P_TEST_EDIT = 25.0
P_DEP_EDIT = 30.0
P_BROAD = 10.0
P_UNRELATED = 5.0
P_APPLIES_FAIL = 15.0
P_SYNTAX_FAIL = 8.0


def score_candidate(c: PatchCandidate, ctx: ScoringContext) -> ScoredCandidate:
    """Compute a deterministic score for a candidate. Higher is better."""
    breakdown: dict[str, float] = {}
    score = 0.0
    ok, err = validate_candidate(c)
    if not ok:
        return ScoredCandidate(candidate=c, score=-1e6, score_breakdown={"invalid": -1e6})
    # Hard fail on applies_cleanly / syntax_ok
    if not c.applies_cleanly:
        score -= P_APPLIES_FAIL
        breakdown["applies_failed"] = -P_APPLIES_FAIL
    if not c.syntax_ok:
        score -= P_SYNTAX_FAIL
        breakdown["syntax_failed"] = -P_SYNTAX_FAIL
    # Passes
    if c.focused_tests_passed:
        score += R_FOCUSED_PASS
        breakdown["focused_pass"] = R_FOCUSED_PASS
    if c.related_tests_passed:
        score += R_RELATED_PASS
        breakdown["related_pass"] = R_RELATED_PASS
    # Diff size (smaller = better)
    size = c.diff_size()
    if size > 0:
        reward = min(R_DIFF_SIZE * 40.0, R_DIFF_SIZE * max(0.0, 40.0 - size))
        score += reward
        breakdown["diff_size_reward"] = reward
    if c.applies_cleanly:
        score += R_CLEAN
        breakdown["clean"] = R_CLEAN
    if c.syntax_ok:
        score += R_SYNTAX_OK
        breakdown["syntax_ok"] = R_SYNTAX_OK
    # Localized bonus
    localized_hits = 0
    for f in c.touched_files:
        if f in ctx.localized_files:
            localized_hits += 1
    if localized_hits > 0:
        bonus = R_LOCALIZED * min(localized_hits, 3) / 3.0
        score += bonus
        breakdown["localized_bonus"] = bonus
    else:
        score -= P_UNRELATED
        breakdown["unrelated"] = -P_UNRELATED
    # Penalties
    if c.is_test_edit() and not ctx.allow_test_edits:
        score -= P_TEST_EDIT
        breakdown["test_edit"] = -P_TEST_EDIT
    if c.is_dependency_change() and not ctx.allow_dependency_edits:
        score -= P_DEP_EDIT
        breakdown["dependency_edit"] = -P_DEP_EDIT
    if c.is_broad_refactor():
        score -= P_BROAD
        breakdown["broad_refactor"] = -P_BROAD
    return ScoredCandidate(candidate=c, score=score, score_breakdown=breakdown)


def rank_candidates(
    candidates: Iterable[PatchCandidate],
    ctx: ScoringContext,
) -> list[ScoredCandidate]:
    """Score every candidate and return them sorted, best first."""
    scored = [score_candidate(c, ctx) for c in candidates]
    scored.sort(key=lambda s: s.score, reverse=True)
    return scored
